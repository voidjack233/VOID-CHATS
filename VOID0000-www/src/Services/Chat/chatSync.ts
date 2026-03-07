// src/Services/Chat/chatSync.ts
//
// Sync layer: coordinates between the server and the local IndexedDB store.
// - loadConversation: read local first, return cached immediately + background sync promise
// - readLocal: direct read from IndexedDB
// - storeIncomingMessage: persist a WS-delivered message
// - handleEdit / handleDelete: apply mutations to the local store

import { messageStore, LocalMessage } from './chatStore';
import { getMessages } from './chatService';

interface SyncResult {
  newMessages: LocalMessage[];
  hasMore: boolean;
}

// 60-second cooldown before asking the server for messages again
const CACHE_TTL_MS = 60 * 1000; 

class MessageSync {
  // ============== Load Conversation ==============

  async loadConversation(
    conversationId: string,
    encryptionKey: CryptoKey
  ): Promise<{
    cached: { messages: LocalMessage[]; has_more: boolean };
    syncPromise: Promise<SyncResult>;
  }> {
    const cached = await messageStore.getMessages(conversationId);
    const cursor = await messageStore.getSyncCursor(conversationId);

    let shouldSync = true;

    // If we have messages AND we synced recently, skip the network request!
    if (cached.messages.length > 0 && cursor && cursor.last_synced_at) {
      const lastSynced = new Date(cursor.last_synced_at).getTime();
      const now = Date.now();
      
      if (now - lastSynced < CACHE_TTL_MS) {
        shouldSync = false;
      }
    }

    let syncPromise: Promise<SyncResult>;

    if (shouldSync) {
      syncPromise = this._syncFromServer(conversationId, encryptionKey, cached);
    } else {
      // Fake the server response to instantly resolve the UI loading states
      syncPromise = Promise.resolve({ newMessages: [], hasMore: cached.has_more });
    }

    return { cached, syncPromise };
  }

  private async _syncFromServer(
    conversationId: string,
    encryptionKey: CryptoKey,
    cached: { messages: LocalMessage[]; has_more: boolean }
  ): Promise<SyncResult> {
    try {
      const { messages: serverMsgs, has_more } = await getMessages(
        conversationId,
        encryptionKey
      );

      // FIX: Always update the sync cursor so the 60-second timer resets, 
      // even if the server says there are zero new messages.
      // FIX: Guarantee a string fallback so TypeScript stops yelling
      const newestId = (serverMsgs.length > 0 
        ? serverMsgs[0]?.message_id 
        : cached.messages[0]?.message_id) || '';
        
      await messageStore.setSyncCursor(conversationId, newestId);

      if (serverMsgs.length === 0) {
        return { newMessages: [], hasMore: has_more };
      }

      const localMsgs: LocalMessage[] = serverMsgs.map((msg) => ({
        conversation_id: msg.conversation_id,
        message_id: msg.message_id,
        sender_id: msg.sender_id,
        content: msg.content ?? null,
        message_type: msg.message_type,
        reply_to: msg.reply_to,
        is_edited: msg.is_edited,
        edited_at: msg.edited_at,
        is_deleted: msg.is_deleted,
        created_at: msg.created_at,
        reactions: (msg as any).reactions || {},
        attachments: msg.attachments,
      }));

      await messageStore.putMessages(localMsgs);

      const cachedIds = new Set(cached.messages.map((m) => m.message_id));
      const newMessages = localMsgs.filter((m) => !cachedIds.has(m.message_id));

      return { newMessages, hasMore: has_more };
    } catch (err) {
      console.error('Background sync failed:', err);
      return { newMessages: [], hasMore: false };
    }
  }

  // ============== Read Local ==============

  async readLocal(
    conversationId: string,
    options?: { before?: string; limit?: number }
  ): Promise<{ messages: LocalMessage[]; has_more: boolean }> {
    return messageStore.getMessages(conversationId, options);
  }

  // ============== Mutations ==============

  async storeIncomingMessage(message: LocalMessage): Promise<void> {
    await messageStore.putMessage(message);
  }

  async handleEdit(
    conversationId: string,
    messageId: string,
    content: string,
    editedAt: string
  ): Promise<void> {
    await messageStore.updateMessage(conversationId, messageId, {
      content,
      is_edited: true,
      edited_at: editedAt,
    });
  }

  async handleDelete(conversationId: string, messageId: string): Promise<void> {
    await messageStore.markDeleted(conversationId, messageId);
  }
}

export const messageSync = new MessageSync();