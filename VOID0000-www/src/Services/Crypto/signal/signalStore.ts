import type {
  SignalDeviceIdentityRecord,
  SignalDmSessionRecord,
  SignalGroupSenderKeyRecord,
  SignalLocalBootstrapMaterial,
} from './signalTypes';

const DB_NAME = 'void_signal';
const DB_VERSION = 1;
const META_STORE = 'meta';
const SESSION_STORE = 'sessions';
const SENDER_KEY_STORE = 'sender_keys';

interface DmSessionRow extends SignalDmSessionRecord {
  id: string;
}

interface GroupSenderKeyRow extends SignalGroupSenderKeyRecord {
  id: string;
}

function buildIdentityKey(userId: string) {
  return `identity:${userId}`;
}

function buildBootstrapMaterialKey(userId: string) {
  return `bootstrap:${userId}`;
}

function buildDmSessionKey(userId: string, peerUserId: string, peerDeviceId: string) {
  return `dm:${userId}:${peerUserId}:${peerDeviceId}`;
}

function buildInboxCursorKey(userId: string, deviceId: string) {
  return `inbox:${userId}:${deviceId}`;
}

function buildSenderKey(conversationId: string, senderDeviceId: string) {
  return `group:${conversationId}:${senderDeviceId}`;
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
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SENDER_KEY_STORE)) {
        db.createObjectStore(SENDER_KEY_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putMetaRow<T extends { id: string }>(row: T): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(META_STORE, 'readwrite');
  tx.objectStore(META_STORE).put(row);
  await transactionComplete(tx);
}

async function getMetaRow<T>(id: string): Promise<T | null> {
  const db = await openDB();
  const tx = db.transaction(META_STORE, 'readonly');
  const result = await requestToPromise(tx.objectStore(META_STORE).get(id));
  await transactionComplete(tx);
  return (result as T | undefined) ?? null;
}

async function putSessionRow(row: DmSessionRow): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(SESSION_STORE, 'readwrite');
  tx.objectStore(SESSION_STORE).put(row);
  await transactionComplete(tx);
}

async function getSessionRow(id: string): Promise<DmSessionRow | null> {
  const db = await openDB();
  const tx = db.transaction(SESSION_STORE, 'readonly');
  const result = await requestToPromise(tx.objectStore(SESSION_STORE).get(id));
  await transactionComplete(tx);
  return (result as DmSessionRow | undefined) ?? null;
}

async function getAllSessionRows(): Promise<DmSessionRow[]> {
  const db = await openDB();
  const tx = db.transaction(SESSION_STORE, 'readonly');
  const result = await requestToPromise(tx.objectStore(SESSION_STORE).getAll());
  await transactionComplete(tx);
  return (result as DmSessionRow[] | undefined) ?? [];
}

async function putSenderKeyRow(row: GroupSenderKeyRow): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(SENDER_KEY_STORE, 'readwrite');
  tx.objectStore(SENDER_KEY_STORE).put(row);
  await transactionComplete(tx);
}

async function getSenderKeyRow(id: string): Promise<GroupSenderKeyRow | null> {
  const db = await openDB();
  const tx = db.transaction(SENDER_KEY_STORE, 'readonly');
  const result = await requestToPromise(tx.objectStore(SENDER_KEY_STORE).get(id));
  await transactionComplete(tx);
  return (result as GroupSenderKeyRow | undefined) ?? null;
}

async function clearStore(storeName: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).clear();
  await transactionComplete(tx);
}

export const signalStore = {
  async getDeviceIdentity(userId: string): Promise<SignalDeviceIdentityRecord | null> {
    return getMetaRow<SignalDeviceIdentityRecord>(buildIdentityKey(userId));
  },

  async putDeviceIdentity(record: SignalDeviceIdentityRecord): Promise<void> {
    await putMetaRow({
      id: buildIdentityKey(record.userId),
      ...record,
    });
  },

  async getBootstrapMaterial(userId: string): Promise<SignalLocalBootstrapMaterial | null> {
    return getMetaRow<SignalLocalBootstrapMaterial>(buildBootstrapMaterialKey(userId));
  },

  async putBootstrapMaterial(record: SignalLocalBootstrapMaterial): Promise<void> {
    await putMetaRow({
      id: buildBootstrapMaterialKey(record.userId),
      ...record,
    });
  },

  async upsertDmSession(session: SignalDmSessionRecord): Promise<void> {
    await putSessionRow({
      id: buildDmSessionKey(session.userId, session.peerUserId, session.peerDeviceId),
      ...session,
    });
  },

  async getDmSession(
    userId: string,
    peerUserId: string,
    peerDeviceId: string
  ): Promise<SignalDmSessionRecord | null> {
    const targetId = buildDmSessionKey(userId, peerUserId, peerDeviceId);
    const row = await getSessionRow(targetId);
    if (!row) return null;
    return {
      userId: row.userId,
      peerUserId: row.peerUserId,
      peerDeviceId: row.peerDeviceId,
      lastEstablishedAt: row.lastEstablishedAt,
      sessionVersion: row.sessionVersion,
      sessionKey: row.sessionKey ?? null,
      rootKey: row.rootKey ?? null,
      sendChainKey: row.sendChainKey ?? null,
      receiveChainKey: row.receiveChainKey ?? null,
      localRatchetPublicKey: row.localRatchetPublicKey ?? null,
      localRatchetPrivateKey: row.localRatchetPrivateKey ?? null,
      remoteRatchetPublicKey: row.remoteRatchetPublicKey ?? null,
      previousChainLength: row.previousChainLength ?? 0,
      pendingRatchet: Boolean(row.pendingRatchet),
      skippedMessageKeys: row.skippedMessageKeys ?? null,
      sendCounter: row.sendCounter ?? 0,
      receiveCounter: row.receiveCounter ?? 0,
    };
  },

  async listDmSessions(userId: string, peerUserId: string): Promise<SignalDmSessionRecord[]> {
    const rows = await getAllSessionRows();
    return rows
      .filter((row) => row.userId === userId && row.peerUserId === peerUserId)
      .map((row) => ({
        userId: row.userId,
        peerUserId: row.peerUserId,
        peerDeviceId: row.peerDeviceId,
        lastEstablishedAt: row.lastEstablishedAt,
        sessionVersion: row.sessionVersion,
        sessionKey: row.sessionKey ?? null,
        rootKey: row.rootKey ?? null,
        sendChainKey: row.sendChainKey ?? null,
        receiveChainKey: row.receiveChainKey ?? null,
        localRatchetPublicKey: row.localRatchetPublicKey ?? null,
        localRatchetPrivateKey: row.localRatchetPrivateKey ?? null,
        remoteRatchetPublicKey: row.remoteRatchetPublicKey ?? null,
        previousChainLength: row.previousChainLength ?? 0,
        pendingRatchet: Boolean(row.pendingRatchet),
        skippedMessageKeys: row.skippedMessageKeys ?? null,
        sendCounter: row.sendCounter ?? 0,
        receiveCounter: row.receiveCounter ?? 0,
      }));
  },

  async listEstablishedDmSessions(userId: string, peerUserId: string): Promise<SignalDmSessionRecord[]> {
    const sessions = await this.listDmSessions(userId, peerUserId);
    return sessions.filter((session) => session.sessionVersion > 0);
  },

  async putGroupSenderKey(record: SignalGroupSenderKeyRecord): Promise<void> {
    await putSenderKeyRow({
      id: buildSenderKey(record.conversationId, record.senderDeviceId),
      ...record,
    });
  },

  async getGroupSenderKey(
    conversationId: string,
    senderDeviceId: string
  ): Promise<SignalGroupSenderKeyRecord | null> {
    const row = await getSenderKeyRow(buildSenderKey(conversationId, senderDeviceId));
    if (!row) return null;
    return {
      conversationId: row.conversationId,
      senderDeviceId: row.senderDeviceId,
      senderKeyVersion: row.senderKeyVersion,
      lastRotatedAt: row.lastRotatedAt,
    };
  },

  async getInboxCursor(userId: string, deviceId: string): Promise<string | null> {
    const row = await getMetaRow<{ cursor?: string }>(buildInboxCursorKey(userId, deviceId));
    if (!row || typeof row.cursor !== 'string' || row.cursor.length === 0) {
      return null;
    }
    return row.cursor;
  },

  async putInboxCursor(userId: string, deviceId: string, cursor: string): Promise<void> {
    await putMetaRow({
      id: buildInboxCursorKey(userId, deviceId),
      cursor,
      updatedAt: new Date().toISOString(),
    });
  },

  async clearAll(): Promise<void> {
    await clearStore(META_STORE);
    await clearStore(SESSION_STORE);
    await clearStore(SENDER_KEY_STORE);
  },
};
