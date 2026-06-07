import { keyManager } from '../Crypto/keyManager';
import { fetchKeyPackageReserveStatus } from '../Crypto/mls/mlsApi';
import { mlsStore } from '../Crypto/mls/mlsStore';
import type { MlsBackupData } from '../Crypto/mls/mlsTypes';
import { chatCryptoProtocolService } from '../Crypto/protocols/chatCryptoProtocolService';
import {
  backupAccountMlsStateToServer,
  backupKeyToServer,
  backupRecoveryKeyToServer,
  fetchKeyBackup,
} from '../Chat/chatService';
import { debugLog } from '../utils/debugLog';
import {
  hasAccountMlsBackupPayload,
  hasMlsBackupPayload,
  hasRecoveryMlsBackupPayload,
  restoreMlsStateFromBackup,
} from './mlsRecovery';

export interface SecureKeyBackupPayload {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
  mls_state_encrypted?: string;
  mls_state_iv?: string;
  mls_state_salt?: string;
  mls_key_package_refs?: string[];
}

export interface RecoveryKeyBackupPayload {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
  recovery_mls_state_encrypted?: string;
  recovery_mls_state_iv?: string;
  recovery_mls_state_salt?: string;
  mls_key_package_refs?: string[];
}

export interface AccountMlsBackupPayload {
  account_mls_state_encrypted: string;
  account_mls_state_iv: string;
  account_mls_state_key_id: string;
  mls_key_package_refs: string[];
}

export interface AccountSecureKeysReadinessResult {
  ready: boolean;
  claimableKeyPackagesCount: number;
  stagedKeyPackagesCount: number;
  backedUpKeyPackageRefsCount: number;
  activatedKeyPackageRefsCount: number;
}

export interface EnsureAccountSecureKeysReadyOptions {
  password?: string | null;
  restoreBackup?: boolean;
  forceBootstrap?: boolean;
  source?: string;
  attempts?: number;
}

export interface ScheduleAccountMlsMaintenanceOptions extends EnsureAccountSecureKeysReadyOptions {
  urgent?: boolean;
  immediate?: boolean;
  skipRecentSuccess?: boolean;
  debounceMs?: number;
}

const ACCOUNT_KEY_READINESS_BACKOFF_MS = [0, 450, 1200];
const ACCOUNT_MLS_MAINTENANCE_NORMAL_DEBOUNCE_MS = 2_000;
const ACCOUNT_MLS_MAINTENANCE_URGENT_DEBOUNCE_MS = 250;
const ACCOUNT_MLS_MAINTENANCE_RECENT_SUCCESS_SKIP_MS = 10 * 60 * 1000;
const accountKeyReadinessJobs = new Map<string, Promise<AccountSecureKeysReadinessResult>>();

interface AccountMlsMaintenanceWaiter {
  resolve: (result: AccountSecureKeysReadinessResult | null) => void;
  reject: (error: unknown) => void;
}

interface PendingAccountMlsMaintenance {
  reasons: Set<string>;
  options: EnsureAccountSecureKeysReadyOptions;
  urgent: boolean;
  immediate: boolean;
  skipRecentSuccess: boolean;
  waiters: AccountMlsMaintenanceWaiter[];
}

interface AccountMlsMaintenanceSchedulerState {
  timerId: number | null;
  timerDueAt: number | null;
  pending: PendingAccountMlsMaintenance | null;
  inFlight: Promise<AccountSecureKeysReadinessResult> | null;
  lastSuccessAt: number;
  runSequence: number;
}

const accountMlsMaintenanceSchedulers = new Map<string, AccountMlsMaintenanceSchedulerState>();

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getAccountMlsMaintenanceScheduler(userId: string): AccountMlsMaintenanceSchedulerState {
  const existing = accountMlsMaintenanceSchedulers.get(userId);
  if (existing) {
    return existing;
  }

  const created: AccountMlsMaintenanceSchedulerState = {
    timerId: null,
    timerDueAt: null,
    pending: null,
    inFlight: null,
    lastSuccessAt: 0,
    runSequence: 0,
  };
  accountMlsMaintenanceSchedulers.set(userId, created);
  return created;
}

function summarizeMaintenanceReasons(reasons: Set<string>): string {
  const list = Array.from(reasons);
  if (list.length === 0) {
    return 'unspecified';
  }
  if (list.length === 1) {
    return list[0]!;
  }

  const visibleReasons = list.slice(0, 5).join(',');
  return `coalesced:${visibleReasons}${list.length > 5 ? `,+${list.length - 5}` : ''}`;
}

function mergeMaintenanceOptions(
  current: EnsureAccountSecureKeysReadyOptions,
  next: EnsureAccountSecureKeysReadyOptions,
): EnsureAccountSecureKeysReadyOptions {
  const password = current.password?.trim()
    ? current.password
    : next.password?.trim()
      ? next.password
      : current.password ?? next.password;
  const attempts = Math.max(current.attempts ?? 0, next.attempts ?? 0) || undefined;
  return {
    ...current,
    ...next,
    password,
    restoreBackup: current.restoreBackup === true || next.restoreBackup === true,
    forceBootstrap: current.forceBootstrap === true || next.forceBootstrap === true,
    attempts,
  };
}

function settleMaintenanceWaiters(
  waiters: AccountMlsMaintenanceWaiter[],
  result: AccountSecureKeysReadinessResult | null,
) {
  waiters.forEach((waiter) => waiter.resolve(result));
}

function rejectMaintenanceWaiters(
  waiters: AccountMlsMaintenanceWaiter[],
  error: unknown,
) {
  waiters.forEach((waiter) => waiter.reject(error));
}

function schedulePendingAccountMlsMaintenanceRun(
  userId: string,
  state: AccountMlsMaintenanceSchedulerState,
  delayMs: number,
) {
  const dueAt = Date.now() + delayMs;
  if (state.timerId != null && state.timerDueAt != null && state.timerDueAt <= dueAt) {
    return;
  }

  if (state.timerId != null) {
    window.clearTimeout(state.timerId);
  }

  state.timerDueAt = dueAt;
  state.timerId = window.setTimeout(() => {
    state.timerId = null;
    state.timerDueAt = null;
    flushAccountMlsMaintenance(userId, state);
  }, delayMs);
}

function flushAccountMlsMaintenance(
  userId: string,
  state: AccountMlsMaintenanceSchedulerState,
) {
  if (state.inFlight || !state.pending) {
    return;
  }

  const pending = state.pending;
  state.pending = null;
  const source = summarizeMaintenanceReasons(pending.reasons);
  const now = Date.now();

  if (
    !pending.urgent &&
    pending.skipRecentSuccess &&
    state.lastSuccessAt > 0 &&
    now - state.lastSuccessAt < ACCOUNT_MLS_MAINTENANCE_RECENT_SUCCESS_SKIP_MS
  ) {
    debugLog('[MLS_ACCOUNT_KEYS] maintenance skipped after recent success', {
      user_id: userId,
      source,
      reasons: Array.from(pending.reasons),
      ms_since_success: now - state.lastSuccessAt,
      recent_success_skip_ms: ACCOUNT_MLS_MAINTENANCE_RECENT_SUCCESS_SKIP_MS,
    });
    settleMaintenanceWaiters(pending.waiters, null);
    return;
  }

  const runId = state.runSequence + 1;
  state.runSequence = runId;
  const runOptions: EnsureAccountSecureKeysReadyOptions = {
    ...pending.options,
    source,
  };

  debugLog('[MLS_ACCOUNT_KEYS] maintenance started', {
    user_id: userId,
    source,
    reasons: Array.from(pending.reasons),
    urgent: pending.urgent,
    restore_backup: runOptions.restoreBackup === true,
    run_id: runId,
  });

  const job = ensureAccountSecureKeysReady(userId, runOptions);
  state.inFlight = job;

  job
    .then((result) => {
      if (result.ready) {
        state.lastSuccessAt = Date.now();
      }
      debugLog('[MLS_ACCOUNT_KEYS] maintenance finished', {
        user_id: userId,
        source,
        run_id: runId,
        ready: result.ready,
        claimable_key_packages_count: result.claimableKeyPackagesCount,
        staged_key_packages_count: result.stagedKeyPackagesCount,
        backed_up_key_package_refs_count: result.backedUpKeyPackageRefsCount,
        activated_key_package_refs_count: result.activatedKeyPackageRefsCount,
      });
      settleMaintenanceWaiters(pending.waiters, result);
    })
    .catch((error) => {
      console.warn('[MLS_ACCOUNT_KEYS] maintenance failed', {
        user_id: userId,
        source,
        run_id: runId,
        error: error instanceof Error ? error.message : String(error || ''),
      });
      rejectMaintenanceWaiters(pending.waiters, error);
    })
    .finally(() => {
      if (state.inFlight === job) {
        state.inFlight = null;
      }
      if (state.pending) {
        schedulePendingAccountMlsMaintenanceRun(userId, state, 0);
      }
    });
}

export function scheduleAccountMlsMaintenance(
  userId: string,
  reason: string,
  options: ScheduleAccountMlsMaintenanceOptions = {},
): Promise<AccountSecureKeysReadinessResult | null> {
  const trimmedReason = reason.trim() || 'unspecified';
  const {
    urgent = false,
    immediate = false,
    skipRecentSuccess = true,
    debounceMs,
    ...readinessOptions
  } = options;
  const state = getAccountMlsMaintenanceScheduler(userId);
  const now = Date.now();

  if (
    !urgent &&
    !immediate &&
    skipRecentSuccess &&
    state.lastSuccessAt > 0 &&
    now - state.lastSuccessAt < ACCOUNT_MLS_MAINTENANCE_RECENT_SUCCESS_SKIP_MS
  ) {
    debugLog('[MLS_ACCOUNT_KEYS] maintenance request skipped after recent success', {
      user_id: userId,
      reason: trimmedReason,
      ms_since_success: now - state.lastSuccessAt,
      recent_success_skip_ms: ACCOUNT_MLS_MAINTENANCE_RECENT_SUCCESS_SKIP_MS,
    });
    return Promise.resolve(null);
  }

  const shouldQueueAfterCurrentRun =
    Boolean(state.inFlight) &&
    (urgent || immediate || readinessOptions.restoreBackup === true || skipRecentSuccess === false);

  if (state.inFlight && !shouldQueueAfterCurrentRun) {
    debugLog('[MLS_ACCOUNT_KEYS] maintenance request coalesced into active run', {
      user_id: userId,
      reason: trimmedReason,
    });
    return state.inFlight;
  }

  return new Promise<AccountSecureKeysReadinessResult | null>((resolve, reject) => {
    const waiter: AccountMlsMaintenanceWaiter = { resolve, reject };
    if (!state.pending) {
      state.pending = {
        reasons: new Set([trimmedReason]),
        options: readinessOptions,
        urgent,
        immediate,
        skipRecentSuccess,
        waiters: [waiter],
      };
    } else {
      state.pending.reasons.add(trimmedReason);
      state.pending.options = mergeMaintenanceOptions(state.pending.options, readinessOptions);
      state.pending.urgent = state.pending.urgent || urgent;
      state.pending.immediate = state.pending.immediate || immediate;
      state.pending.skipRecentSuccess = state.pending.skipRecentSuccess && skipRecentSuccess;
      state.pending.waiters.push(waiter);
    }

    debugLog('[MLS_ACCOUNT_KEYS] maintenance request scheduled', {
      user_id: userId,
      reason: trimmedReason,
      pending_reasons: Array.from(state.pending.reasons),
      urgent: state.pending.urgent,
      immediate: state.pending.immediate,
      in_flight: Boolean(state.inFlight),
    });

    if (state.inFlight) {
      return;
    }

    const pending = state.pending;
    const nextDelayMs =
      typeof debounceMs === 'number'
        ? Math.max(0, debounceMs)
        : pending.immediate
          ? 0
          : pending.urgent
            ? ACCOUNT_MLS_MAINTENANCE_URGENT_DEBOUNCE_MS
            : ACCOUNT_MLS_MAINTENANCE_NORMAL_DEBOUNCE_MS;
    schedulePendingAccountMlsMaintenanceRun(userId, state, nextDelayMs);
  });
}

export async function buildMlsBackupFields(
  userId: string,
  password: string
): Promise<Pick<SecureKeyBackupPayload, 'mls_state_encrypted' | 'mls_state_iv' | 'mls_state_salt' | 'mls_key_package_refs'> | null> {
  try {
    const mlsData = await mlsStore.exportForBackup(userId);
    const groupKeys = await keyManager.exportGroupKeys();
    const payload: MlsBackupData = { ...mlsData, groupKeys };
    const { encrypted, iv, salt } = await keyManager.encryptDataWithPassword(payload, password);
    return {
      mls_state_encrypted: encrypted,
      mls_state_iv: iv,
      mls_state_salt: salt,
      mls_key_package_refs: mlsData.keyPackages
        .filter((record) => Boolean(record.privateData) && !record.consumedAt)
        .map((record) => record.packageRef),
    };
  } catch (err) {
    console.warn('🔑 MLS state export failed (non-critical):', err);
    return null;
  }
}

export async function buildRecoveryMlsBackupFields(
  userId: string,
  recoveryKey: string
): Promise<Pick<RecoveryKeyBackupPayload, 'recovery_mls_state_encrypted' | 'recovery_mls_state_iv' | 'recovery_mls_state_salt' | 'mls_key_package_refs'> | null> {
  try {
    const mlsData = await mlsStore.exportForBackup(userId);
    const groupKeys = await keyManager.exportGroupKeys();
    const payload: MlsBackupData = { ...mlsData, groupKeys };
    const { encrypted, iv, salt } = await keyManager.encryptDataWithRecoveryPhrase(payload, recoveryKey);
    return {
      recovery_mls_state_encrypted: encrypted,
      recovery_mls_state_iv: iv,
      recovery_mls_state_salt: salt,
      mls_key_package_refs: mlsData.keyPackages
        .filter((record) => Boolean(record.privateData) && !record.consumedAt)
        .map((record) => record.packageRef),
    };
  } catch (err) {
    console.warn('🔑 Recovery MLS state export failed (non-critical):', err);
    return null;
  }
}

export async function buildAccountMlsBackupFields(
  userId: string
): Promise<AccountMlsBackupPayload> {
  const mlsData = await mlsStore.exportForBackup(userId);
  const groupKeys = await keyManager.exportGroupKeys();
  const payload: MlsBackupData = { ...mlsData, groupKeys };
  const { encrypted, iv, keyId } = await keyManager.encryptDataWithAccountIdentity(userId, payload);
  return {
    account_mls_state_encrypted: encrypted,
    account_mls_state_iv: iv,
    account_mls_state_key_id: keyId,
    mls_key_package_refs: mlsData.keyPackages
      .filter((record) => Boolean(record.privateData) && !record.consumedAt)
      .map((record) => record.packageRef),
  };
}

export async function prepareSecureBackup(
  userId: string,
  password: string
): Promise<SecureKeyBackupPayload> {
  const keyBackup = await keyManager.prepareBackup(userId, password);
  const mlsFields = await buildMlsBackupFields(userId, password);
  return {
    ...keyBackup,
    ...(mlsFields || {}),
  };
}

export async function uploadSecureBackups(userId: string, password: string): Promise<string[]> {
  const activatedRefs = await backupKeyToServer(await prepareSecureBackup(userId, password));
  await Promise.all(activatedRefs.map((packageRef) => mlsStore.markKeyPackageClaimable(userId, packageRef)));
  return activatedRefs;
}

export async function prepareRecoverySecureBackup(
  userId: string,
  recoveryKey: string
): Promise<RecoveryKeyBackupPayload> {
  const keyBackup = await keyManager.prepareRecoveryBackup(userId, recoveryKey);
  const mlsFields = await buildRecoveryMlsBackupFields(userId, recoveryKey);
  return {
    ...keyBackup,
    ...(mlsFields || {}),
  };
}

export async function uploadRecoverySecureBackups(userId: string, recoveryKey: string): Promise<string[]> {
  const activatedRefs = await backupRecoveryKeyToServer(await prepareRecoverySecureBackup(userId, recoveryKey));
  await Promise.all(activatedRefs.map((packageRef) => mlsStore.markKeyPackageClaimable(userId, packageRef)));
  return activatedRefs;
}

export async function uploadAccountMlsBackup(userId: string): Promise<string[]> {
  const activatedRefs = await backupAccountMlsStateToServer(await buildAccountMlsBackupFields(userId));
  await Promise.all(activatedRefs.map((packageRef) => mlsStore.markKeyPackageClaimable(userId, packageRef)));
  return activatedRefs;
}

async function runAccountSecureKeysReadiness(
  userId: string,
  options: EnsureAccountSecureKeysReadyOptions,
): Promise<AccountSecureKeysReadinessResult> {
  const password = options.password?.trim() || null;
  const recoveryKey = await keyManager.getStoredRecoveryKeyForBackup(userId);
  const source = options.source || 'unspecified';

  if (options.restoreBackup !== false) {
    const backup = await fetchKeyBackup().catch(() => null);
    let restoredAccountBackup = false;
    if (backup && hasAccountMlsBackupPayload(backup)) {
      const result = await restoreMlsStateFromBackup(userId, backup, null, 'account_identity');
      restoredAccountBackup = result.outcome !== 'failed';
    }
    if (!restoredAccountBackup && backup && password && hasMlsBackupPayload(backup)) {
      await restoreMlsStateFromBackup(userId, backup, password);
    } else if (
      !restoredAccountBackup &&
      backup &&
      recoveryKey &&
      hasRecoveryMlsBackupPayload(backup)
    ) {
      await restoreMlsStateFromBackup(userId, backup, recoveryKey, 'recovery_key');
    }
  }

  const maxAttempts = Math.max(1, options.attempts ?? ACCOUNT_KEY_READINESS_BACKOFF_MS.length);
  let latestResult: AccountSecureKeysReadinessResult = {
    ready: false,
    claimableKeyPackagesCount: 0,
    stagedKeyPackagesCount: 0,
    backedUpKeyPackageRefsCount: 0,
    activatedKeyPackageRefsCount: 0,
  };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await delay(ACCOUNT_KEY_READINESS_BACKOFF_MS[Math.min(attempt, ACCOUNT_KEY_READINESS_BACKOFF_MS.length - 1)] ?? 0);

    let reserveCount: number | null = null;
    if (attempt === 0 && options.forceBootstrap === true) {
      await chatCryptoProtocolService.bootstrapAccount(userId, true);
    } else {
      const reserveResult = await chatCryptoProtocolService.ensureServerKeyPackageReserve(userId);
      reserveCount = reserveResult.serverCount;
    }

    const localKeyPackages = await mlsStore.listKeyPackages(userId);
    const backedUpRefs = localKeyPackages
      .filter((record) => Boolean(record.privateData) && !record.consumedAt)
      .map((record) => record.packageRef);
    const stagedCount = localKeyPackages.filter(
      (record) => Boolean(record.privateData) && Boolean(record.publishedAt) && !record.claimableAt && !record.consumedAt,
    ).length;

    const activatedRefs = new Set<string>();
    let didUploadEncryptedMlsBackup = false;
    try {
      const refs = await uploadAccountMlsBackup(userId);
      refs.forEach((packageRef) => activatedRefs.add(packageRef));
      didUploadEncryptedMlsBackup = true;
    } catch (error) {
      console.warn('[MLS_ACCOUNT_KEYS] account-wrapped MLS backup upload failed', {
        user_id: userId,
        source,
        error: error instanceof Error ? error.message : String(error || ''),
      });
    }
    if (password) {
      const refs = await uploadSecureBackups(userId, password);
      refs.forEach((packageRef) => activatedRefs.add(packageRef));
      didUploadEncryptedMlsBackup = true;
    }
    if (!didUploadEncryptedMlsBackup && recoveryKey) {
      const refs = await uploadRecoverySecureBackups(userId, recoveryKey);
      refs.forEach((packageRef) => activatedRefs.add(packageRef));
      didUploadEncryptedMlsBackup = true;
    }

    const status = activatedRefs.size > 0 || reserveCount === null
      ? await fetchKeyPackageReserveStatus(userId)
      : { availableCount: reserveCount };
    latestResult = {
      ready: (status?.availableCount ?? 0) > 0,
      claimableKeyPackagesCount: status?.availableCount ?? 0,
      stagedKeyPackagesCount: stagedCount,
      backedUpKeyPackageRefsCount: didUploadEncryptedMlsBackup ? backedUpRefs.length : 0,
      activatedKeyPackageRefsCount: activatedRefs.size,
    };

    debugLog('[MLS_ACCOUNT_KEYS] readiness pass', {
      user_id: userId,
      source,
      attempt: attempt + 1,
      staged_key_packages_count: latestResult.stagedKeyPackagesCount,
      claimable_key_packages_count: latestResult.claimableKeyPackagesCount,
      backed_up_key_package_refs_count: latestResult.backedUpKeyPackageRefsCount,
      activated_key_package_refs_count: latestResult.activatedKeyPackageRefsCount,
      encrypted_backup_available: didUploadEncryptedMlsBackup,
    });

    if (latestResult.ready) {
      return latestResult;
    }
  }

  console.warn('[MLS_ACCOUNT_KEYS] secure setup keys are still preparing', {
    user_id: userId,
    source,
    staged_key_packages_count: latestResult.stagedKeyPackagesCount,
    claimable_key_packages_count: latestResult.claimableKeyPackagesCount,
    backed_up_key_package_refs_count: latestResult.backedUpKeyPackageRefsCount,
    activated_key_package_refs_count: latestResult.activatedKeyPackageRefsCount,
  });
  return latestResult;
}

export function ensureAccountSecureKeysReady(
  userId: string,
  options: EnsureAccountSecureKeysReadyOptions = {},
): Promise<AccountSecureKeysReadinessResult> {
  const currentJob = accountKeyReadinessJobs.get(userId);
  if (currentJob) {
    return currentJob;
  }

  const job = runAccountSecureKeysReadiness(userId, options).finally(() => {
    accountKeyReadinessJobs.delete(userId);
  });
  accountKeyReadinessJobs.set(userId, job);
  return job;
}
