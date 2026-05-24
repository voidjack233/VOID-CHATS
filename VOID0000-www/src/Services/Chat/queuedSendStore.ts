// src/Services/Chat/queuedSendStore.ts
//
// Lightweight IndexedDB store for queued secure-send messages.
// These are messages the user pressed Send on in a fresh DM, but the
// recipient had no usable key material yet.  They survive conversation
// switch, refresh, and crash, and are retried automatically when the
// encryption key becomes available.

import type { LinkPreviewMetadata } from './chatTypes';

const DB_NAME = 'void_queued_sends';
const DB_VERSION = 1;
const STORE_NAME = 'queued_sends';

export interface QueuedSendRecord {
  conversation_id: string;
  local_client_id: string;
  sender_id: string;
  text: string;
  uploaded_urls: string[];
  reply_to_id: string | null;
  link_preview?: LinkPreviewMetadata | null;
  mentions?: Array<{
    user_id: string;
    username: string;
  }>;
  created_at: string;
}

class QueuedSendStore {
  private db: IDBDatabase | null = null;
  private dbReady: Promise<IDBDatabase>;

  constructor() {
    this.dbReady = this.open();
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, {
            keyPath: ['conversation_id', 'local_client_id'],
          });
          store.createIndex('by_conversation', 'conversation_id', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve(this.db);
      };

      request.onerror = () => {
        console.error('[QUEUED_SEND_STORE] Failed to open IndexedDB');
        reject(request.error);
      };
    });
  }

  private async getDb(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    return this.dbReady;
  }

  async put(record: QueuedSendRecord): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async remove(conversationId: string, localClientId: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete([conversationId, localClientId]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getByConversation(conversationId: string): Promise<QueuedSendRecord[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const index = tx.objectStore(STORE_NAME).index('by_conversation');
      const request = index.getAll(IDBKeyRange.only(conversationId));
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getAll(): Promise<QueuedSendRecord[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }
}

export const queuedSendStore = new QueuedSendStore();
