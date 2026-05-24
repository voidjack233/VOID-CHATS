// src/Services/Storage/MessageStore.ts
//
// Local-first message store using IndexedDB.
// All message reads come from here. Server is the sync source, not the read source.
//
// Schema:
//   messages: { conversation_id, message_id, sender_id, content, message_type,
//               reply_to, is_edited, edited_at, is_deleted, created_at, reactions,
//               protocol, protocol_version }
//   sync_cursors: { conversation_id, last_message_id, last_synced_at }
//   conversations_meta: { conversation_id, encryption_key_hash, last_opened_at }

import { MESSAGE_PAGE_SIZE } from './chatConstants';

const DB_NAME = 'void_messages';
const DB_VERSION = 3;

export interface LocalMessage {
  conversation_id: string;
  message_id: string;
  sender_id: string;
  content: string | null;
  key_version?: number | null;
  message_type: string;
  reply_to: string | null;
  is_edited: boolean;
  edited_at: string | null;
  is_deleted: boolean;
  created_at: string;
  reactions: Record<string, string[]>;
  attachments?: string[];
  forwarded?: {
    original_message_id?: string | null;
    original_sender_id?: string | null;
    original_sender_name?: string | null;
    original_conversation_id?: string | null;
    original_conversation_name?: string | null;
  } | null;
  mentions?: Array<{
    user_id: string;
    username: string;
  }>;
  link_preview?: {
    url: string;
    title?: string | null;
    description?: string | null;
    image?: string | null;
    site_name?: string | null;
    favicon?: string | null;
  } | null;
  protocol?: 'legacy_aes' | 'mls' | null;
  protocol_version?: number | null;
}

export interface SyncCursor {
  conversation_id: string;
  last_message_id: string | null;
  last_synced_at: string;
}

class MessageStore {
  private db: IDBDatabase | null = null;
  private dbReady: Promise<IDBDatabase>;

  constructor() {
    this.dbReady = this.open();
  }

  // ============== Database Setup ==============

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains('messages')) {
          const msgStore = db.createObjectStore('messages', {
            keyPath: ['conversation_id', 'message_id'],
          });
          msgStore.createIndex('by_conversation', 'conversation_id', { unique: false });
          msgStore.createIndex('by_conv_time', ['conversation_id', 'created_at', 'message_id'], { unique: true });
        } else {
          const tx = (event.target as IDBOpenDBRequest).transaction;
          const msgStore = tx?.objectStore('messages');
          if (msgStore) {
            if (msgStore.indexNames.contains('by_conv_time')) {
              msgStore.deleteIndex('by_conv_time');
            }
            msgStore.createIndex('by_conv_time', ['conversation_id', 'created_at', 'message_id'], { unique: true });
            if (!msgStore.indexNames.contains('by_conversation')) {
              msgStore.createIndex('by_conversation', 'conversation_id', { unique: false });
            }
          }
        }

        if (!db.objectStoreNames.contains('sync_cursors')) {
          db.createObjectStore('sync_cursors', { keyPath: 'conversation_id' });
        }

        if (!db.objectStoreNames.contains('conversations_meta')) {
          db.createObjectStore('conversations_meta', { keyPath: 'conversation_id' });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve(this.db);
      };

      request.onerror = () => {
        console.error('Failed to open MessageStore IndexedDB');
        reject(request.error);
      };
    });
  }

  private async getDb(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    return this.dbReady;
  }

  // ============== Message Operations ==============

  async putMessages(messages: LocalMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');

      for (const msg of messages) {
        store.put(msg);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async putMessage(message: LocalMessage): Promise<void> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      store.put(message);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getMessages(
    conversationId: string,
    options?: { before?: string; after?: string; limit?: number }
  ): Promise<{ messages: LocalMessage[]; has_more: boolean }> {
    const db = await this.getDb();
    const limit = options?.limit || MESSAGE_PAGE_SIZE;
    const anchorId = options?.before || options?.after;
    const anchorMessage = anchorId
      ? await this.getMessage(conversationId, anchorId)
      : null;

    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readonly');
      const store = tx.objectStore('messages');
      const index = store.index('by_conv_time');

      const messages: LocalMessage[] = [];

      if (options?.after) {
        if (!anchorMessage) {
          resolve({ messages: [], has_more: false });
          return;
        }

        // Fetch NEWER messages: ascending from after cursor
        const lower = [conversationId, anchorMessage.created_at, anchorMessage.message_id];
        const upper = [conversationId, '\uffff', '\uffff'];
        const range = IDBKeyRange.bound(lower, upper, true, false);
        const cursorReq = index.openCursor(range, 'next');

        cursorReq.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (!cursor || messages.length >= limit) {
            // Reverse to keep newest-first order consistent with 'before' queries
            messages.reverse();
            resolve({ messages, has_more: !!cursor });
            return;
          }
          messages.push(cursor.value as LocalMessage);
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      } else {
        const upper = anchorMessage
          ? [conversationId, anchorMessage.created_at, anchorMessage.message_id]
          : [conversationId, '\uffff', '\uffff'];
        const lower = [conversationId, '', ''];

        // Fetch OLDER messages (or latest): descending
        const range = IDBKeyRange.bound(lower, upper, false, !!options?.before);
        const cursorReq = index.openCursor(range, 'prev');

        cursorReq.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (!cursor || messages.length >= limit) {
            resolve({ messages, has_more: !!cursor });
            return;
          }
          messages.push(cursor.value as LocalMessage);
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      }
    });
  }

  async getMessage(conversationId: string, messageId: string): Promise<LocalMessage | null> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readonly');
      const store = tx.objectStore('messages');
      const request = store.get([conversationId, messageId]);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async updateMessage(
    conversationId: string,
    messageId: string,
    updates: Partial<LocalMessage>
  ): Promise<void> {
    const existing = await this.getMessage(conversationId, messageId);
    if (!existing) return;

    const updated = { ...existing, ...updates };
    await this.putMessage(updated);
  }

  async markDeleted(conversationId: string, messageId: string): Promise<void> {
    await this.updateMessage(conversationId, messageId, {
      is_deleted: true,
      content: '[deleted]',
    });
  }

  async updateReactions(
    conversationId: string,
    messageId: string,
    reactions: Record<string, string[]>
  ): Promise<void> {
    await this.updateMessage(conversationId, messageId, { reactions });
  }

  async getMessageCount(conversationId: string): Promise<number> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readonly');
      const store = tx.objectStore('messages');
      const index = store.index('by_conversation');
      const countReq = index.count(IDBKeyRange.only(conversationId));

      countReq.onsuccess = () => resolve(countReq.result);
      countReq.onerror = () => reject(countReq.error);
    });
  }

  async pruneConversation(
    conversationId: string,
    options?: {
      maxMessages?: number;
      protectedMessageIds?: string[];
    },
  ): Promise<void> {
    const db = await this.getDb();
    const maxMessages = Math.max(0, options?.maxMessages ?? 500);
    const protectedIds = new Set((options?.protectedMessageIds || []).map(String));

    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      const index = store.index('by_conv_time');
      const range = IDBKeyRange.bound(
        [conversationId, '', ''],
        [conversationId, '\uffff', '\uffff'],
        false,
        false,
      );
      const cursorReq = index.openCursor(range, 'prev');
      let keptCount = 0;

      cursorReq.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (!cursor) {
          return;
        }

        const message = cursor.value as LocalMessage;
        const messageId = String(message.message_id);
        const isProtected = protectedIds.has(messageId);
        if (isProtected || keptCount < maxMessages) {
          keptCount += 1;
        } else {
          cursor.delete();
        }
        cursor.continue();
      };

      cursorReq.onerror = () => reject(cursorReq.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ============== Sync Cursor Operations ==============

  async getSyncCursor(conversationId: string): Promise<SyncCursor | null> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync_cursors', 'readonly');
      const store = tx.objectStore('sync_cursors');
      const request = store.get(conversationId);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async setSyncCursor(conversationId: string, lastMessageId: string): Promise<void> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync_cursors', 'readwrite');
      const store = tx.objectStore('sync_cursors');
      store.put({
        conversation_id: conversationId,
        last_message_id: lastMessageId,
        last_synced_at: new Date().toISOString(),
      });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ============== Cache Invalidation ==============

  async clearConversation(conversationId: string): Promise<void> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['messages', 'sync_cursors'], 'readwrite');
      const msgStore = tx.objectStore('messages');
      const cursorStore = tx.objectStore('sync_cursors');

      const index = msgStore.index('by_conversation');
      const range = IDBKeyRange.only(conversationId);
      const cursorReq = index.openCursor(range);

      cursorReq.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      cursorStore.delete(conversationId);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearAll(): Promise<void> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['messages', 'sync_cursors', 'conversations_meta'], 'readwrite');
      tx.objectStore('messages').clear();
      tx.objectStore('sync_cursors').clear();
      tx.objectStore('conversations_meta').clear();

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async destroy(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

export const messageStore = new MessageStore();
