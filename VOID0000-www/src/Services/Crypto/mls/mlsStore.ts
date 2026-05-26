import type {
  MlsAccountStateRecord,
  MlsBackupData,
  MlsCommitRecord,
  MlsGroupStateRecord,
  MlsKeyPackageRecord,
  MlsWelcomeRecord,
} from './mlsTypes';

const DB_NAME = 'void_mls';
// Keep this at 4 because the temporary OpenMLS build upgraded live browsers.
// IndexedDB cannot be opened at a lower version once a user has seen v4.
const DB_VERSION = 4;
const ACCOUNT_STORE = 'accounts';
const GROUP_STORE = 'groups';
const KEY_PACKAGE_STORE = 'key_packages';
const WELCOME_STORE = 'welcomes';
const COMMIT_STORE = 'commits';

function buildAccountKey(userId: string) {
  return `account:${userId}`;
}

function buildGroupKey(conversationId: string) {
  return `group:${conversationId}`;
}

function buildKeyPackageKey(userId: string, packageRef: string) {
  return `key_package:${userId}:${packageRef}`;
}

function buildWelcomeKey(userId: string, welcomeRef: string) {
  return `welcome:${userId}:${welcomeRef}`;
}

function buildCommitKey(conversationId: string, commitRef: string) {
  return `commit:${conversationId}:${commitRef}`;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ACCOUNT_STORE)) {
        db.createObjectStore(ACCOUNT_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(GROUP_STORE)) {
        db.createObjectStore(GROUP_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(KEY_PACKAGE_STORE)) {
        db.createObjectStore(KEY_PACKAGE_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(WELCOME_STORE)) {
        db.createObjectStore(WELCOME_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(COMMIT_STORE)) {
        db.createObjectStore(COMMIT_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putRow<T extends { id: string }>(storeName: string, row: T): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(row);
  await transactionComplete(tx);
}

async function getRow<T>(storeName: string, id: string): Promise<T | null> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  const result = await requestToPromise(tx.objectStore(storeName).get(id));
  await transactionComplete(tx);
  return (result as T | undefined) ?? null;
}

async function getAllRows<T>(storeName: string): Promise<T[]> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  const result = await requestToPromise(tx.objectStore(storeName).getAll());
  await transactionComplete(tx);
  return (result as T[] | undefined) ?? [];
}

async function deleteRow(storeName: string, id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(id);
  await transactionComplete(tx);
}

export const mlsStore = {
  async getAccountState(userId: string): Promise<MlsAccountStateRecord | null> {
    return getRow<MlsAccountStateRecord>(ACCOUNT_STORE, buildAccountKey(userId));
  },

  async putAccountState(state: MlsAccountStateRecord): Promise<void> {
    await putRow(ACCOUNT_STORE, {
      id: buildAccountKey(state.userId),
      ...state,
    });
  },

  async getGroupState(conversationId: string): Promise<MlsGroupStateRecord | null> {
    return getRow<MlsGroupStateRecord>(GROUP_STORE, buildGroupKey(conversationId));
  },

  async listGroupStates(): Promise<MlsGroupStateRecord[]> {
    return getAllRows<MlsGroupStateRecord & { id?: string }>(GROUP_STORE);
  },

  async putGroupState(state: MlsGroupStateRecord): Promise<void> {
    await putRow(GROUP_STORE, {
      id: buildGroupKey(state.conversationId),
      ...state,
    });
  },

  async deleteGroupState(conversationId: string): Promise<void> {
    await deleteRow(GROUP_STORE, buildGroupKey(conversationId));
  },

  async putKeyPackage(record: MlsKeyPackageRecord): Promise<void> {
    await putRow(KEY_PACKAGE_STORE, {
      id: buildKeyPackageKey(record.userId, record.packageRef),
      ...record,
    });
  },

  async getKeyPackage(userId: string, packageRef: string): Promise<MlsKeyPackageRecord | null> {
    return getRow<MlsKeyPackageRecord>(KEY_PACKAGE_STORE, buildKeyPackageKey(userId, packageRef));
  },

  async listKeyPackages(userId: string): Promise<MlsKeyPackageRecord[]> {
    const rows = await getAllRows<MlsKeyPackageRecord & { id?: string }>(KEY_PACKAGE_STORE);
    return rows.filter((row) => row.userId === userId);
  },

  async listUnpublishedKeyPackages(userId: string): Promise<MlsKeyPackageRecord[]> {
    const rows = await this.listKeyPackages(userId);
    return rows.filter((row) => !row.publishedAt);
  },

  async markKeyPackagePublished(userId: string, packageRef: string): Promise<void> {
    const key = buildKeyPackageKey(userId, packageRef);
    const existing = await getRow<MlsKeyPackageRecord>(KEY_PACKAGE_STORE, key);
    if (!existing) return;
    await putRow(KEY_PACKAGE_STORE, {
      id: key,
      ...existing,
      publishedAt: new Date().toISOString(),
      claimableAt: null,
    });
  },

  async markKeyPackageClaimable(userId: string, packageRef: string): Promise<void> {
    const key = buildKeyPackageKey(userId, packageRef);
    const existing = await getRow<MlsKeyPackageRecord>(KEY_PACKAGE_STORE, key);
    if (!existing) return;
    await putRow(KEY_PACKAGE_STORE, {
      id: key,
      ...existing,
      claimableAt: new Date().toISOString(),
    });
  },

  async markKeyPackageConsumed(userId: string, packageRef: string): Promise<void> {
    const key = buildKeyPackageKey(userId, packageRef);
    const existing = await getRow<MlsKeyPackageRecord>(KEY_PACKAGE_STORE, key);
    if (!existing) return;
    await putRow(KEY_PACKAGE_STORE, {
      id: key,
      ...existing,
      consumedAt: new Date().toISOString(),
    });
  },

  async putWelcome(record: MlsWelcomeRecord): Promise<void> {
    const id = buildWelcomeKey(record.userId, record.welcomeRef);
    const existing = await getRow<MlsWelcomeRecord>(WELCOME_STORE, id);
    await putRow(WELCOME_STORE, {
      id,
      ...record,
      consumedAt: record.consumedAt ?? existing?.consumedAt ?? null,
      failureCode: record.failureCode ?? existing?.failureCode ?? null,
      failedAt: record.failedAt ?? existing?.failedAt ?? null,
      attemptedKeyPackageRefs:
        record.attemptedKeyPackageRefs ?? existing?.attemptedKeyPackageRefs ?? [],
    });
  },

  async listWelcomes(userId: string): Promise<MlsWelcomeRecord[]> {
    const rows = await getAllRows<MlsWelcomeRecord & { id?: string }>(WELCOME_STORE);
    return rows.filter((row) => row.userId === userId);
  },

  async listUnconsumedWelcomes(userId: string): Promise<MlsWelcomeRecord[]> {
    const rows = await this.listWelcomes(userId);
    return rows.filter((row) => !row.consumedAt);
  },

  async markWelcomeConsumed(userId: string, welcomeRef: string): Promise<void> {
    const key = buildWelcomeKey(userId, welcomeRef);
    const existing = await getRow<MlsWelcomeRecord>(WELCOME_STORE, key);
    if (!existing) return;
    await putRow(WELCOME_STORE, {
      id: key,
      ...existing,
      consumedAt: new Date().toISOString(),
    });
  },

  async markWelcomeFailedNoMatchingKeyPackage(
    userId: string,
    welcomeRef: string,
    attemptedKeyPackageRefs: string[],
  ): Promise<void> {
    const key = buildWelcomeKey(userId, welcomeRef);
    const existing = await getRow<MlsWelcomeRecord>(WELCOME_STORE, key);
    if (!existing) return;
    await putRow(WELCOME_STORE, {
      id: key,
      ...existing,
      failureCode: 'no_matching_key_package',
      failedAt: new Date().toISOString(),
      attemptedKeyPackageRefs: [...new Set(attemptedKeyPackageRefs)],
    });
  },

  async clearWelcomeFailure(userId: string, welcomeRef: string): Promise<void> {
    const key = buildWelcomeKey(userId, welcomeRef);
    const existing = await getRow<MlsWelcomeRecord>(WELCOME_STORE, key);
    if (!existing) return;
    await putRow(WELCOME_STORE, {
      id: key,
      ...existing,
      failureCode: null,
      failedAt: null,
      attemptedKeyPackageRefs: [],
    });
  },

  async putCommit(record: MlsCommitRecord): Promise<void> {
    const id = buildCommitKey(record.conversationId, record.commitRef);
    const existing = await getRow<MlsCommitRecord>(COMMIT_STORE, id);
    await putRow(COMMIT_STORE, {
      id,
      ...record,
      appliedAt: record.appliedAt ?? existing?.appliedAt ?? null,
    });
  },

  async listCommits(conversationId?: string): Promise<MlsCommitRecord[]> {
    const rows = await getAllRows<MlsCommitRecord & { id?: string }>(COMMIT_STORE);
    if (!conversationId) return rows;
    return rows.filter((row) => row.conversationId === conversationId);
  },

  async listUnappliedCommits(conversationId?: string): Promise<MlsCommitRecord[]> {
    const rows = await this.listCommits(conversationId);
    return rows.filter((row) => !row.appliedAt);
  },

  async markCommitApplied(conversationId: string, commitRef: string): Promise<void> {
    const key = buildCommitKey(conversationId, commitRef);
    const existing = await getRow<MlsCommitRecord>(COMMIT_STORE, key);
    if (!existing) return;
    await putRow(COMMIT_STORE, {
      id: key,
      ...existing,
      appliedAt: new Date().toISOString(),
    });
  },

  async exportForBackup(userId: string): Promise<Omit<MlsBackupData, 'groupKeys'>> {
    const accountState = await this.getAccountState(userId);
    const groups = await this.listGroupStates();
    const keyPackages = await this.listKeyPackages(userId);
    return {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      accounts: accountState ? [accountState] : [],
      groups,
      keyPackages,
    };
  },
};
