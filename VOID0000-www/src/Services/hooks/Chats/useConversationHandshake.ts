// src/Services/hooks/Chats/useConversationHandshake.ts
//
// Owns the MLS handshake lifecycle for the active conversation.
//
// Responsibilities:
//   - Manages members, encryptionKey, keyVersion, encryptionError, and
//     handshakeRetryToken state.
//   - Runs the full handshake effect: cache-hit fast-path, member fetch,
//     key resolution with retry loop, DM bootstrap fallback, and
//     durable sync retry for groups.
//   - Exposes retryHandshake, updateKey for useMessageStream's resolveMessageKey
//     and attemptDecryption; resetCryptoState for useChatManager's resetLiveChatState.
//   - Exposes getConversationKeyScopeId, getConversationKeyScopePublicId,
//     getKeyLookupConversation for useMessageStream's resolveMessageKey and attemptDecryption.
//   - Uses callback refs for onHydrateDm and onPatchConversation so that the
//     handshake effect's dependency array does not need to include them.

import { useState, useEffect, useMemo, useRef } from 'react';
import { debugLog } from '../../utils/debugLog';
import {
  Conversation,
  getEncryptionKey,
  bootstrapDmKey,
} from '../../Chat/chatService';
import {
  type ConversationSecurityState,
  createConversationSecurityState,
  getReadyConversationSecurityState,
} from '../../Chat/conversationSecurityState';
import { chatCryptoProtocolService } from '../../Crypto/protocols/chatCryptoProtocolService';
import { fetchWithAuth } from '../../Auth/authServiceApi';
import { useUser } from '../../Auth/UserContext';
import { ConversationDetails } from '../../Chat/chatTypes';
import { getConversationDetails, storeConversationDetails } from '../../Chat/conversationCache';
import {
  getHandshakeEntry,
  setHandshakeEntry,
  deleteHandshakeEntry,
} from '../../Chat/handshakeKeyCache';
import { keyManager } from '../../Crypto/keyManager';
import { mlsStore } from '../../Crypto/mls/mlsStore';
import { gateway } from '../../Gateway/gateway';

interface UseConversationHandshakeProps {
  activeConversation: Conversation | null;
  activeGroup: Conversation | null;
  user: { id: string } | null | undefined;
  onHydrateDm: (updater: (prev: Conversation | null) => Conversation | null) => void;
  onPatchConversation: (conversation: Conversation) => void;
}

export interface UseConversationHandshakeResult {
  members: Record<string, any>;
  encryptionKey: CryptoKey | null;
  keyVersion: number;
  encryptionError: string | null;
  conversationSecurityState: ConversationSecurityState;
  retryHandshake: () => void;
  updateKey: (key: CryptoKey, version: number) => void;
  resetCryptoState: () => void;
  getConversationKeyScopeId: (conversation: Conversation | null | undefined) => string | null;
  getConversationKeyScopePublicId: (
    conversation: Conversation | null | undefined,
  ) => string | null;
  getKeyLookupConversation: (conversation: Conversation) => Conversation;
}

export const useConversationHandshake = ({
  activeConversation,
  activeGroup,
  user,
  onHydrateDm,
  onPatchConversation,
}: UseConversationHandshakeProps): UseConversationHandshakeResult => {
  const { mlsRecoveryGate } = useUser();
  const [members, setMembers] = useState<Record<string, any>>({});
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null);
  const [keyVersion, setKeyVersion] = useState(1);
  const [encryptionError, setEncryptionError] = useState<string | null>(null);
  const [conversationSecurityState, setConversationSecurityState] = useState<ConversationSecurityState>(
    () => getReadyConversationSecurityState(),
  );
  const [handshakeRetryToken, setHandshakeRetryToken] = useState(0);
  const preparingRetryAttemptsRef = useRef<Record<string, number>>({});

  // Callback refs: keep the latest callbacks without adding them to the
  // handshake effect's dep array, which would trigger spurious re-runs.
  const onHydrateDmRef = useRef(onHydrateDm);
  useEffect(() => {
    onHydrateDmRef.current = onHydrateDm;
  });

  const onPatchConversationRef = useRef(onPatchConversation);
  useEffect(() => {
    onPatchConversationRef.current = onPatchConversation;
  });

  const normalizeRequiredVersion = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return null;
  };

  const isTransientGroupKeyError = (message: string) =>
    message.includes('No group key available') ||
    message.includes('No group sender key available') ||
    message.includes('is unavailable') ||
    message.includes('not decryptable') ||
    message.includes('OperationError');

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    });

  const inspectLocalConversationRecoveryState = async (
    conversationId: string,
    userId: string,
    requestedVersion: number | null,
  ) => {
    const [exactKey, anyKey, groupState, welcomes, commits] = await Promise.all([
      requestedVersion != null
        ? keyManager.getGroupKey(conversationId, requestedVersion)
        : Promise.resolve(null),
      keyManager.findAnyGroupKey(conversationId),
      mlsStore.getGroupState(conversationId),
      mlsStore.listUnconsumedWelcomes(userId),
      mlsStore.listUnappliedCommits(conversationId),
    ]);

    const matchingWelcomes = welcomes.filter(
      (welcome) => welcome.conversationId === conversationId,
    );
    const hasFailedWelcome = matchingWelcomes.some(
      (welcome) => welcome.failureCode === 'no_matching_key_package',
    );

    return {
      hasExactRequestedKey: Boolean(exactKey),
      hasAnyGroupKey: Boolean(anyKey),
      anyGroupKeyVersion: anyKey?.version ?? null,
      hasLocalGroupState: Boolean(groupState),
      localGroupStateKeyVersion: groupState?.keyVersion ?? null,
      hasPendingWelcome: matchingWelcomes.some((welcome) => !welcome.failureCode),
      hasFailedWelcome,
      hasPendingCommit: commits.length > 0,
    };
  };

  const requiredConversationKeyVersion = useMemo(() => {
    if (!activeConversation) {
      return null;
    }

    if (activeConversation.type === 'dm') {
      return normalizeRequiredVersion(activeConversation.current_key_version ?? null);
    }

    return normalizeRequiredVersion(
      activeGroup?.current_key_version ?? activeConversation.current_key_version ?? null,
    );
  }, [
    activeConversation?.id,
    activeConversation?.type,
    activeConversation?.current_key_version,
    activeGroup?.current_key_version,
  ]);

  const getConversationKeyScopeId = (conversation: Conversation | null | undefined) => {
    if (!conversation) return null;
    if (conversation.type === 'dm') return conversation.id;
    return conversation.parent_conversation_id || activeGroup?.id || conversation.id;
  };

  const getConversationKeyScopePublicId = (conversation: Conversation | null | undefined) => {
    if (!conversation) return null;
    if (conversation.type === 'dm') return conversation.public_id || null;
    return (
      conversation.parent_public_id ||
      activeGroup?.public_id ||
      conversation.public_id ||
      null
    );
  };

  const getConversationDetailsLookupId = (conversation: Conversation) => {
    if (conversation.type !== 'channel') {
      return conversation.public_id || conversation.id;
    }

    return (
      conversation.parent_public_id ||
      activeGroup?.public_id ||
      conversation.parent_conversation_id ||
      activeGroup?.id ||
      conversation.public_id ||
      conversation.id
    );
  };

  const getKeyLookupConversation = (conversation: Conversation): Conversation => {
    if (conversation.type !== 'channel') {
      return conversation;
    }

    const parentConversationId =
      conversation.parent_conversation_id || activeGroup?.id || null;
    const parentPublicId =
      conversation.parent_public_id || activeGroup?.public_id || null;

    if (
      parentConversationId === conversation.parent_conversation_id &&
      parentPublicId === conversation.parent_public_id
    ) {
      return conversation;
    }

    return {
      ...conversation,
      parent_conversation_id: parentConversationId,
      parent_public_id: parentPublicId,
    };
  };

  const patchCachedConversationNickname = (
    identifier: string | null | undefined,
    targetUserId: string,
    nickname: string | null,
  ) => {
    if (!identifier) return;

    const cachedConversation = getConversationDetails(identifier);
    if (!cachedConversation?.members?.length) {
      return;
    }

    const hasTarget = cachedConversation.members.some(
      (member) => member.user_id === targetUserId,
    );

    if (!hasTarget) {
      return;
    }

    storeConversationDetails({
      ...cachedConversation,
      members: cachedConversation.members.map((member) =>
        member.user_id === targetUserId
          ? { ...member, nickname }
          : member,
      ),
    });
  };

  // Handshake setup
  useEffect(() => {
    let ignore = false;
    let scheduledPrepareRetry: number | null = null;
    let keySetupTimeout: number | null = null;

    const clearKeySetupTimeout = () => {
      if (keySetupTimeout != null) {
        window.clearTimeout(keySetupTimeout);
        keySetupTimeout = null;
      }
    };

    const setupConversation = async () => {
      if (!activeConversation || !user?.id) return;
      const requiredGroupVersion = requiredConversationKeyVersion;
      const keyScopeId = getConversationKeyScopeId(activeConversation) || activeConversation.id;
      const keyScopePublicId = getConversationKeyScopePublicId(activeConversation);
      const keyLookupConversation = getKeyLookupConversation(activeConversation);
      const preparingRetryKey = `${keyScopeId}:${requiredGroupVersion || 'none'}`;

      setEncryptionError(null);
      setConversationSecurityState(createConversationSecurityState({
        status: 'recovering',
        reason: 'preparing',
        message: 'Preparing secure chat...',
        detail: 'Messages and sending will unlock once encryption keys are ready.',
        canSend: false,
        canRetry: false,
        showCachedHistoryFallback: true,
      }));
      clearKeySetupTimeout();
      keySetupTimeout = window.setTimeout(() => {
        if (ignore) return;
        setConversationSecurityState(createConversationSecurityState({
          status: 'blocked',
          reason: 'key_load_failed',
          message: 'Secure chat is taking longer than expected.',
          detail: 'Check your connection, or close and reopen this conversation to retry key setup.',
          canSend: false,
          canRetry: true,
          showCachedHistoryFallback: true,
        }));
        setEncryptionError('Secure chat is taking longer than expected.');
      }, 12_000);

      debugLog('[HANDSHAKE] starting conversation handshake', {
        conversation_id: activeConversation.id,
        conversation_type: activeConversation.type,
        required_group_version: requiredGroupVersion,
        key_scope_id: keyScopeId,
      });

      const cached = getHandshakeEntry(keyScopeId);
      const cachedSatisfiesRequiredVersion =
        !requiredGroupVersion ||
        (activeConversation.type === 'dm'
          ? cached?.version === requiredGroupVersion
          : (cached?.version ?? 0) >= requiredGroupVersion);
      if (cached && cachedSatisfiesRequiredVersion) {
        debugLog('[HANDSHAKE] using cached handshake entry', {
          conversation_id: activeConversation.id,
          key_scope_id: keyScopeId,
          key_version: cached.version,
          required_group_version: requiredGroupVersion ?? null,
        });
        clearKeySetupTimeout();
        setEncryptionError(null);
        setConversationSecurityState(getReadyConversationSecurityState());
        setMembers(cached.members);
        setEncryptionKey(cached.key);
        setKeyVersion(cached.version);
        return;
      }

      const staleHandshake =
        !!cached &&
        !!requiredGroupVersion &&
        (
          activeConversation.type === 'dm'
            ? cached.version !== requiredGroupVersion
            : cached.version < requiredGroupVersion
        );
      if (staleHandshake) {
        console.warn('[HANDSHAKE] evicting stale cached handshake', {
          conversation_id: activeConversation.id,
          key_scope_id: keyScopeId,
          cached_version: cached.version,
          required_group_version: requiredGroupVersion,
        });
        deleteHandshakeEntry(keyScopeId);
      }

      // Ensure key packages are published early so the owner's distribution
      // pass can add us to the MLS group even on the very first open.
      if (activeConversation.type !== 'dm') {
        void chatCryptoProtocolService.bootstrapAccount(user.id);
      }


      try {
        let conversationDetails = staleHandshake
          ? null
          : (
              getConversationDetails(activeConversation.id) ||
              getConversationDetails(activeConversation.public_id) ||
              getConversationDetails(keyScopeId) ||
              getConversationDetails(keyScopePublicId) ||
              getConversationDetails(activeGroup?.id) ||
              getConversationDetails(activeGroup?.public_id) ||
              null
            );

        if (!conversationDetails || !conversationDetails.members) {
          const lookupId = getConversationDetailsLookupId(activeConversation);
          const res = await fetchWithAuth(`/api/conversations/${lookupId}`);
          const data = await res.json();

          if (ignore) return;
          if (!data.success) throw new Error('Could not load members');

          conversationDetails = storeConversationDetails(data.conversation as ConversationDetails);
        }

        if (ignore) return;
        if (!conversationDetails) {
          throw new Error('Could not load conversation details');
        }

        const conversationMembers = conversationDetails.members || [];
        const peer = conversationMembers.find((member: any) => member.user_id !== user.id);
        const hydratedConversationDetails: ConversationDetails =
          conversationDetails.type === 'dm'
            ? storeConversationDetails({
                ...conversationDetails,
                dm_user_id: conversationDetails.dm_user_id || peer?.user_id,
                dm_username: conversationDetails.dm_username || peer?.username || null,
                dm_display_name:
                  conversationDetails.dm_display_name ||
                  peer?.nickname ||
                  peer?.display_name ||
                  peer?.username ||
                  null,
                dm_avatar_url: conversationDetails.dm_avatar_url || peer?.avatar_url || null,
              })
            : conversationDetails;

        onHydrateDmRef.current((prev) => {
          if (!prev || prev.id !== activeConversation.id) {
            return prev;
          }

          const needsHydration =
            prev.dm_user_id !== hydratedConversationDetails.dm_user_id ||
            prev.dm_username !== hydratedConversationDetails.dm_username ||
            prev.dm_display_name !== hydratedConversationDetails.dm_display_name ||
            prev.dm_avatar_url !== hydratedConversationDetails.dm_avatar_url;

          if (!needsHydration) {
            return prev;
          }

          return {
            ...prev,
            ...hydratedConversationDetails,
          };
        });

        const hydratedMembers = hydratedConversationDetails.members || [];
        const memberMap: Record<string, any> = {};
        hydratedMembers.forEach((m: any) => {
          memberMap[m.user_id] = m;
        });
        const joinedKeyVersionFloor = normalizeRequiredVersion(
          memberMap[user.id]?.joined_key_version ?? null,
        );
        setMembers(memberMap);
        const ownerConversation = activeGroup || activeConversation;

        const peerId =
          activeConversation.type === 'dm'
            ? (
                activeConversation.dm_user_id ||
                hydratedConversationDetails.dm_user_id ||
                hydratedMembers.find((m: any) => m.user_id !== user.id)?.user_id
              )
            : undefined;

        if (activeConversation.type === 'dm' && !peerId) {
          clearKeySetupTimeout();
          setConversationSecurityState(createConversationSecurityState({
            status: 'blocked',
            reason: 'recipient_details_missing',
            message: 'This conversation is still loading secure recipient details.',
            detail: 'Open the conversation again once the recipient identity finishes loading.',
            canSend: false,
            canRetry: true,
          }));
          throw new Error('Could not resolve DM peer');
        }

        let keyResult: { key: CryptoKey; version: number } | null = null;
        let lastKeyError: Error | null = null;
        const acceptsNewerGroupVersion = activeConversation.type !== 'dm';

        debugLog('[HANDSHAKE] derived group version requirement', {
          conversation_id: activeConversation.id,
          conversation_type: activeConversation.type,
          current_key_version: activeConversation.current_key_version ?? null,
          active_group_key_version: activeGroup?.current_key_version ?? null,
          joined_key_version_floor: joinedKeyVersionFloor,
          required_group_version: requiredGroupVersion ?? null,
          accepts_newer_group_version: acceptsNewerGroupVersion,
        });

        if (activeConversation.type === 'dm') {
          // DM: try cached/synced key once, then bootstrap directly.
          // No retry loop — avoids the 3-attempt + delay handshake theater
          // that wastes ~2s on brand-new DMs where no state exists yet.
          try {
            keyResult = await getEncryptionKey(
              user.id,
              keyLookupConversation,
              requiredGroupVersion || undefined,
            );
          } catch {
            if (ignore) return;
            // Cache + sync didn't resolve it — bootstrap the MLS group directly.
            // This handles both cases:
            //   - Initiator (new DM): creates group, adds peer, sends welcome
            //   - Receiver (including one with an unreadable Welcome): re-bootstraps
            try {
              debugLog('[DM_BOOTSTRAP] direct bootstrap from handshake', {
                conversation_id: activeConversation.id,
                peer_user_id: peerId || null,
              });
              keyResult = await bootstrapDmKey(activeConversation, user.id, peerId);
            } catch (dmErr) {
              if (ignore) return;
              const dmReason = dmErr instanceof Error ? dmErr.message : String(dmErr || '');
              if (dmReason.includes('DM peer account secure keys are still preparing')) {
                clearKeySetupTimeout();
                const dmReadinessRetryKey = `${preparingRetryKey}:peer-account-keys`;
                const nextAttempt = (preparingRetryAttemptsRef.current[dmReadinessRetryKey] || 0) + 1;
                preparingRetryAttemptsRef.current[dmReadinessRetryKey] = nextAttempt;
                if (nextAttempt <= 3) {
                  scheduledPrepareRetry = window.setTimeout(() => {
                    if (!ignore) {
                      retryHandshake();
                    }
                  }, 1200 * nextAttempt);
                  setConversationSecurityState(createConversationSecurityState({
                    status: 'recovering',
                    reason: 'peer_not_ready',
                    message: 'Preparing secure chat keys...',
                    detail: "Waiting for this account's secure setup keys to become available.",
                    canSend: false,
                    canRetry: true,
                  }));
                  setEncryptionError('Preparing secure chat keys...');
                  return;
                }

                setConversationSecurityState(createConversationSecurityState({
                  status: 'blocked',
                  reason: 'peer_not_ready',
                  message: 'Secure chat keys are not ready yet.',
                  detail: "This account's secure setup keys could not finish preparing automatically. Retry in a moment.",
                  canSend: false,
                  canRetry: true,
                }));
                setEncryptionError('Secure chat keys are not ready yet.');
                return;
              }
              if (dmReason.includes('DM peer could not be resolved')) {
                clearKeySetupTimeout();
                setConversationSecurityState(createConversationSecurityState({
                  status: 'blocked',
                  reason: 'recipient_details_missing',
                  message: 'This conversation is still loading secure recipient details.',
                  detail: 'Open the conversation again once the recipient identity finishes loading.',
                  canSend: false,
                  canRetry: true,
                }));
                setEncryptionError('This conversation is still loading secure recipient details.');
                return;
              }
              throw dmErr;
            }
          }
        } else {
          // Groups/channels: retry loop with transient-error tolerance.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              debugLog('[HANDSHAKE] resolving encryption key', {
                conversation_id: activeConversation.id,
                conversation_type: activeConversation.type,
                attempt: attempt + 1,
                requested_version: requiredGroupVersion || null,
                joined_key_version_floor: joinedKeyVersionFloor,
              });
              keyResult = await getEncryptionKey(
                user.id,
                keyLookupConversation,
                requiredGroupVersion || undefined,
                {
                  allowNewerGroupVersion: acceptsNewerGroupVersion,
                },
              );
              lastKeyError = null;
              break;
            } catch (err) {
              const nextError = err instanceof Error ? err : new Error(String(err || ''));
              lastKeyError = nextError;

              if (attempt < 2 && isTransientGroupKeyError(nextError.message)) {
                await wait(450 * (attempt + 1));
                continue;
              }

              throw nextError;
            }
          }
        }

        if (!keyResult) {
          throw lastKeyError || new Error('Failed to resolve conversation encryption key');
        }

        const { key, version } = keyResult;

        if (ignore) return;
        clearKeySetupTimeout();

        debugLog('[HANDSHAKE] resolved encryption key', {
          conversation_id: activeConversation.id,
          conversation_type: activeConversation.type,
          key_version: version,
          required_group_version: requiredGroupVersion ?? null,
        });
        delete preparingRetryAttemptsRef.current[preparingRetryKey];

        const ownerCurrentKeyVersion = ownerConversation
          ? normalizeRequiredVersion(ownerConversation.current_key_version) ?? 0
          : 0;
        if (ownerConversation && version > ownerCurrentKeyVersion) {
          debugLog('[HANDSHAKE] accepted newer version than conversation metadata', {
            conversation_id: ownerConversation.id,
            conversation_type: ownerConversation.type,
            metadata_key_version: ownerCurrentKeyVersion || null,
            resolved_key_version: version,
          });
          onPatchConversationRef.current({
            ...ownerConversation,
            current_key_version: version,
          });
        }

        if (key) {
          setHandshakeEntry(keyScopeId, {
            members: memberMap,
            key,
            version,
            keysByVersion: {
              [version]: key,
            },
          });
        }

        setEncryptionError(null);
        setConversationSecurityState(getReadyConversationSecurityState());
        setEncryptionKey(key);
        setKeyVersion(version);

        // Pre-warm DM crypto bootstrap so that first send doesn't
        // incur setup and capability-check latency.
        if (activeConversation.type === 'dm' && peerId) {
          void chatCryptoProtocolService.preWarmForDm(user.id, peerId);
        }

      } catch (err: any) {
        if (ignore) return;
        clearKeySetupTimeout();
        console.error('[HANDSHAKE] failed', {
          conversation_id: activeConversation?.id,
          conversation_type: activeConversation?.type,
          error: err instanceof Error ? err.message : String(err || ''),
        });
        setEncryptionKey(null);
        const reason = err instanceof Error ? err.message : String(err || '');

        if (reason.includes('Identity keys missing')) {
          setConversationSecurityState(createConversationSecurityState({
            status: 'blocked',
            reason: 'identity_missing',
            message: 'Your secure account keys are not available in this browser yet.',
            detail: 'Sign in again with your account password or recovery key before opening secure chats.',
            canSend: false,
            canRetry: false,
            showCachedHistoryFallback: activeConversation?.type !== 'dm',
          }));
          setEncryptionError('Your secure account keys are not available in this browser yet.');
          return;
        }

        if (reason.includes('Could not resolve DM peer')) {
          setEncryptionError('This conversation is still loading secure recipient details.');
          return;
        }

        const isGroupKeyError =
          reason.includes('No group key available') ||
          reason.includes('No group sender key available') ||
          reason.includes('Group key version') ||
          reason.includes('not decryptable') ||
          reason.includes('OperationError');

        if (isGroupKeyError) {
          const ownerConversation = activeGroup || activeConversation;
          if (ownerConversation && ownerConversation.type !== 'dm') {
            const recoveryState = await inspectLocalConversationRecoveryState(
              keyScopeId,
              user.id,
              requiredGroupVersion,
            );
            if (recoveryState.hasFailedWelcome) {
              setConversationSecurityState(createConversationSecurityState({
                status: 'blocked',
                reason: 'welcome_key_package_missing',
                message: 'Secure membership setup cannot be restored for this account yet.',
                detail: 'Restore account secure state from backup, or ask a group owner to resend the membership key distribution.',
                canSend: false,
                canRetry: true,
                showCachedHistoryFallback: true,
              }));
              setEncryptionError('Secure membership setup cannot be restored for this account yet.');
              return;
            }

            const canRecoverInPlace =
              recoveryState.hasLocalGroupState ||
              recoveryState.hasPendingWelcome ||
              recoveryState.hasPendingCommit;

            if (mlsRecoveryGate.active) {
              setConversationSecurityState(createConversationSecurityState({
                status: 'blocked',
                reason: 'account_restore_required',
                message: 'Secure chat recovery must finish before this conversation can decrypt again.',
                detail: 'Your account needs a secure restore with your password or recovery key before group history can reopen.',
                canSend: false,
                canRetry: false,
                showCachedHistoryFallback: true,
              }));
              setEncryptionError('Secure chat recovery must finish before this conversation can decrypt again.');
              return;
            }

            if (!canRecoverInPlace) {
              const hasOlderSecureState =
                recoveryState.hasAnyGroupKey || recoveryState.hasLocalGroupState;
              const blockedState = hasOlderSecureState
                ? createConversationSecurityState({
                    status: 'blocked',
                    reason: 'distribution_missing',
                    message: 'The latest secure group state is unavailable for this conversation.',
                    detail: 'Older secure state still exists locally, but the latest durable recovery artifacts are missing. Ask the group owner to resend the membership change or key distribution.',
                    canSend: false,
                    canRetry: true,
                    showCachedHistoryFallback: true,
                  })
                : createConversationSecurityState({
                    status: 'blocked',
                    reason: 'conversation_state_missing',
                    message: 'The secure conversation state needed for this group is unavailable.',
                    detail: 'Restore it from your account backup, or ask the group owner to resend the membership change or key distribution.',
                    canSend: false,
                    canRetry: false,
                    showCachedHistoryFallback: true,
                  });

              setConversationSecurityState(blockedState);
              setEncryptionError(blockedState.message);
              return;
            }

            const nextAttempt = (preparingRetryAttemptsRef.current[preparingRetryKey] || 0) + 1;
            preparingRetryAttemptsRef.current[preparingRetryKey] = nextAttempt;
            debugLog('[GROUP_RECOVERY] deferring to durable sync-retry path', {
              conversation_id: ownerConversation.id,
              current_user_id: user.id,
              required_group_version: requiredGroupVersion ?? null,
              preparing_retry_attempt: nextAttempt,
            });
            if (nextAttempt <= 3) {
              const retryDelayMs = 1200 * nextAttempt;
              scheduledPrepareRetry = window.setTimeout(() => {
                void chatCryptoProtocolService.syncInbox(user.id, true)
                  .then((syncResult) => {
                    debugLog('[GROUP_PREPARE] background retry after rejoin', {
                      conversation_id: ownerConversation.id,
                      required_group_version: requiredGroupVersion ?? null,
                      attempt: nextAttempt,
                      retry_delay_ms: retryDelayMs,
                      synced_group_states: syncResult.syncedGroupStates,
                      synced_welcomes: syncResult.syncedWelcomes,
                      synced_commits: syncResult.syncedCommits,
                    });
                  })
                  .catch((retryErr) => {
                    console.warn('[GROUP_PREPARE] background retry sync failed', {
                      conversation_id: ownerConversation.id,
                      required_group_version: requiredGroupVersion ?? null,
                      attempt: nextAttempt,
                      error: retryErr instanceof Error ? retryErr.message : String(retryErr || ''),
                    });
                  })
                  .finally(() => {
                    if (!ignore) {
                      retryHandshake();
                    }
                  });
              }, retryDelayMs);
              setConversationSecurityState(createConversationSecurityState({
                status: 'recovering',
                reason: 'preparing',
                message: 'Secure chat is still preparing for this conversation.',
                detail: 'Recoverable secure state exists for this thread and the latest epoch is syncing now.',
                canSend: false,
                canRetry: true,
                showCachedHistoryFallback: true,
              }));
              setEncryptionError('Secure chat is still preparing for this conversation. Retry in a moment.');
            } else {
              console.error('[GROUP_RECOVERY] exhausted sync-retry attempts with no recovery artifacts', {
                conversation_id: ownerConversation.id,
                current_user_id: user.id,
                required_group_version: requiredGroupVersion ?? null,
                  attempts_exhausted: nextAttempt,
              });
              setConversationSecurityState(createConversationSecurityState({
                status: 'blocked',
                reason: 'distribution_missing',
                message: 'Unable to recover the latest group encryption state for this conversation.',
                detail: 'Older secure state exists locally, but the server does not have enough durable recovery data for the latest version yet. Ask the group owner to resend the membership change or key distribution.',
                canSend: false,
                canRetry: true,
                showCachedHistoryFallback: true,
              }));
              setEncryptionError('Unable to recover group encryption keys. The group owner may need to resend a key distribution.');
            }
            return;
          }

          setConversationSecurityState(createConversationSecurityState({
            status: 'blocked',
            reason: 'key_load_failed',
            message: 'Unable to decrypt group keys.',
            detail: 'This conversation is missing the secure key material needed to load right now.',
            canSend: false,
            canRetry: true,
            showCachedHistoryFallback: true,
          }));
          setEncryptionError('Unable to decrypt group keys');
          return;
        }

        setConversationSecurityState(createConversationSecurityState({
          status: 'blocked',
          reason: 'key_load_failed',
          message: 'Failed to load encryption keys for this chat.',
          detail: 'Secure chat could not finish loading for this conversation yet.',
          canSend: false,
          canRetry: true,
          showCachedHistoryFallback: activeConversation?.type !== 'dm',
        }));
        setEncryptionError('Failed to load encryption keys for this chat.');
      }
    };

    setupConversation();
    return () => {
      ignore = true;
      if (scheduledPrepareRetry != null) {
        window.clearTimeout(scheduledPrepareRetry);
      }
      clearKeySetupTimeout();
    };
  }, [
    activeConversation?.id,
    activeConversation?.public_id,
    activeConversation?.parent_conversation_id,
    activeConversation?.parent_public_id,
    activeGroup?.id,
    activeGroup?.public_id,
    requiredConversationKeyVersion,
    handshakeRetryToken,
    mlsRecoveryGate.active,
    user?.id,
  ]);

  useEffect(() => {
    if (!user?.id) return;

    const refreshMembershipDetails = async (
      activeConversationSnapshot: Conversation,
      activeGroupSnapshot: Conversation | null,
    ) => {
      const lookupId =
        activeConversationSnapshot.type !== 'channel'
          ? activeConversationSnapshot.public_id || activeConversationSnapshot.id
          : (
              activeConversationSnapshot.parent_public_id ||
              activeGroupSnapshot?.public_id ||
              activeConversationSnapshot.parent_conversation_id ||
              activeGroupSnapshot?.id ||
              activeConversationSnapshot.public_id ||
              activeConversationSnapshot.id
            );

      const res = await fetchWithAuth(`/api/conversations/${lookupId}`);
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Could not refresh conversation members');
      }

      const conversationDetails = storeConversationDetails(data.conversation as ConversationDetails);
      const refreshedMembers = conversationDetails.members || [];
      const nextMembers: Record<string, any> = {};
      refreshedMembers.forEach((member: any) => {
        nextMembers[member.user_id] = member;
      });

      setMembers(nextMembers);

      const keyScopeId =
        activeConversationSnapshot.type === 'dm'
          ? activeConversationSnapshot.id
          : (
              activeConversationSnapshot.parent_conversation_id ||
              activeGroupSnapshot?.id ||
              activeConversationSnapshot.id
            );
      const handshakeEntry = getHandshakeEntry(keyScopeId);
      if (handshakeEntry) {
        setHandshakeEntry(keyScopeId, {
          ...handshakeEntry,
          members: nextMembers,
        });
      }
    };

    const handleConversationUpdate = (data: any) => {
      const updatedConversation = data?.conversation as Conversation | undefined;
      if (!updatedConversation?.id) {
        return;
      }

      const activeConversationSnapshot = activeConversation;
      const activeGroupSnapshot = activeGroup;
      if (!activeConversationSnapshot) {
        return;
      }

      const membershipConversationId =
        activeConversationSnapshot.type === 'channel'
          ? activeConversationSnapshot.parent_conversation_id || activeGroupSnapshot?.id || null
          : activeGroupSnapshot?.id || activeConversationSnapshot.id;
      const membershipConversationPublicId =
        activeConversationSnapshot.type === 'channel'
          ? activeConversationSnapshot.parent_public_id || activeGroupSnapshot?.public_id || null
          : activeGroupSnapshot?.public_id || activeConversationSnapshot.public_id || null;

      const matchesMembershipConversation =
        String(updatedConversation.id) === String(membershipConversationId) ||
        (updatedConversation.public_id && membershipConversationPublicId
          ? String(updatedConversation.public_id) === String(membershipConversationPublicId)
          : false);

      if (!matchesMembershipConversation) {
        return;
      }

      const membershipSnapshot = activeGroupSnapshot || activeConversationSnapshot;
      const previousMemberCount = membershipSnapshot.member_count ?? null;
      const nextMemberCount =
        typeof updatedConversation.member_count === 'number'
          ? updatedConversation.member_count
          : previousMemberCount;
      const previousKeyVersion =
        normalizeRequiredVersion(membershipSnapshot.current_key_version) ?? 0;
      const nextKeyVersion =
        normalizeRequiredVersion(updatedConversation.current_key_version) ?? previousKeyVersion;
      const previousRole =
        typeof membershipSnapshot.role === 'string' ? membershipSnapshot.role : null;
      const nextRole =
        typeof updatedConversation.role === 'string' ? updatedConversation.role : previousRole;

      const membershipChanged =
        nextMemberCount !== previousMemberCount ||
        nextKeyVersion > previousKeyVersion ||
        nextRole !== previousRole;

      if (!membershipChanged) {
        return;
      }

      void refreshMembershipDetails(activeConversationSnapshot, activeGroupSnapshot).catch((error) => {
        console.warn('[GROUP_MEMBERS] failed to refresh active membership details', {
          conversation_id: membershipConversationId,
          error: error instanceof Error ? error.message : String(error || ''),
        });
      });
    };

    gateway.on('CONVERSATION_UPDATE', handleConversationUpdate);
    const handleMemberNicknameUpdate = (data: any) => {
      const targetUserId = data?.user_id;
      const eventConversationId = data?.conversation_id;
      const eventConversationPublicId = data?.conversation_public_id || null;
      const nickname =
        typeof data?.nickname === 'string' && data.nickname.trim().length > 0
          ? data.nickname.trim()
          : null;

      if (!targetUserId || !eventConversationId) {
        return;
      }

      const activeConversationSnapshot = activeConversation;
      const activeGroupSnapshot = activeGroup;
      if (!activeConversationSnapshot) {
        return;
      }

      const membershipConversationId =
        activeConversationSnapshot.type === 'channel'
          ? activeConversationSnapshot.parent_conversation_id || activeGroupSnapshot?.id || null
          : activeGroupSnapshot?.id || activeConversationSnapshot.id;
      const membershipConversationPublicId =
        activeConversationSnapshot.type === 'channel'
          ? activeConversationSnapshot.parent_public_id || activeGroupSnapshot?.public_id || null
          : activeGroupSnapshot?.public_id || activeConversationSnapshot.public_id || null;

      const matchesMembershipConversation =
        String(eventConversationId) === String(membershipConversationId) ||
        (eventConversationPublicId && membershipConversationPublicId
          ? String(eventConversationPublicId) === String(membershipConversationPublicId)
          : false);

      if (!matchesMembershipConversation) {
        return;
      }

      setMembers((current) => {
        const member = current[targetUserId];
        if (!member || member.nickname === nickname) {
          return current;
        }

        return {
          ...current,
          [targetUserId]: {
            ...member,
            nickname,
          },
        };
      });

      patchCachedConversationNickname(activeConversationSnapshot.id, targetUserId, nickname);
      patchCachedConversationNickname(activeConversationSnapshot.public_id, targetUserId, nickname);
      patchCachedConversationNickname(activeGroupSnapshot?.id, targetUserId, nickname);
      patchCachedConversationNickname(activeGroupSnapshot?.public_id, targetUserId, nickname);
      patchCachedConversationNickname(eventConversationId, targetUserId, nickname);
      patchCachedConversationNickname(eventConversationPublicId, targetUserId, nickname);

      if (
        activeConversationSnapshot.type === 'dm' &&
        user?.id &&
        targetUserId !== user.id
      ) {
        const cachedConversation =
          getConversationDetails(activeConversationSnapshot.id) ||
          getConversationDetails(activeConversationSnapshot.public_id) ||
          getConversationDetails(eventConversationId) ||
          getConversationDetails(eventConversationPublicId) ||
          null;
        const cachedPeer = cachedConversation?.members?.find(
          (member) => member.user_id === targetUserId,
        );
        const nextDmDisplayName =
          nickname ||
          cachedPeer?.display_name ||
          cachedPeer?.username ||
          activeConversationSnapshot.dm_username ||
          activeConversationSnapshot.dm_display_name ||
          'Direct Message';

        onPatchConversationRef.current({
          ...activeConversationSnapshot,
          dm_display_name: nextDmDisplayName,
        });
      }

      const keyScopeId = getConversationKeyScopeId(activeConversationSnapshot);
      if (keyScopeId) {
        const handshakeEntry = getHandshakeEntry(keyScopeId);
        const cachedMember = handshakeEntry?.members?.[targetUserId];
        if (handshakeEntry && cachedMember) {
          setHandshakeEntry(keyScopeId, {
            ...handshakeEntry,
            members: {
              ...handshakeEntry.members,
              [targetUserId]: {
                ...cachedMember,
                nickname,
              },
            },
          });
        }
      }
    };

    gateway.on('MEMBER_NICKNAME_UPDATE', handleMemberNicknameUpdate);
    return () => {
      gateway.off('CONVERSATION_UPDATE', handleConversationUpdate);
      gateway.off('MEMBER_NICKNAME_UPDATE', handleMemberNicknameUpdate);
    };
  }, [
    activeConversation,
    activeGroup,
    user?.id,
  ]);

  const retryHandshake = () => {
    setEncryptionKey(null);
    setEncryptionError(null);
    setConversationSecurityState(createConversationSecurityState({
      status: 'recovering',
      reason: 'preparing',
      message: 'Preparing secure chat...',
      detail: 'Messages and sending will unlock once encryption keys are ready.',
      canSend: false,
      canRetry: false,
      showCachedHistoryFallback: true,
    }));
    setHandshakeRetryToken((t) => t + 1);
  };

  const updateKey = (key: CryptoKey, version: number) => {
    setEncryptionError(null);
    setConversationSecurityState(getReadyConversationSecurityState());
    setEncryptionKey(key);
    setKeyVersion(version);
  };

  const resetCryptoState = () => {
    setMembers({});
    setEncryptionKey(null);
    setEncryptionError(null);
    setConversationSecurityState(getReadyConversationSecurityState());
  };

  return {
    members,
    encryptionKey,
    keyVersion,
    encryptionError,
    conversationSecurityState,
    retryHandshake,
    updateKey,
    resetCryptoState,
    getConversationKeyScopeId,
    getConversationKeyScopePublicId,
    getKeyLookupConversation,
  };
};
