// src/Services/Chat/chatSync.ts
//
// Sync layer: coordinates between the server and the local IndexedDB store.
// - loadConversation: read local first, return cached immediately + background sync promise
// - readLocal: direct read from IndexedDB
// - storeIncomingMessage: persist a WS-delivered message
// - handleEdit / handleDelete: apply mutations to the local store

import { messageStore, LocalMessage } from './chatStore';
import {
  getMessages,
  resolveMessageCryptoMetadata,
  type MessageDecryptionContext,
} from './chatService';
import { MESSAGE_PAGE_SIZE } from './chatConstants';

interface SyncResult {
  newMessages: LocalMessage[];
  hasMore: boolean;
}

interface LoadConversationOptions extends MessageDecryptionContext {
  forceSync?: boolean;
  preferSessionCache?: boolean;
  initialLimit?: number;
  syncLimit?: number;
}

function hasUndecryptablePlaceholder(messages: LocalMessage[]): boolean {
  return messages.some((message) => message.content === '[unable to decrypt]');
}

const CACHE_TTL_MS = 60 * 1000;

class MessageSync {
  private sessionValidatedConversations = new Set<string>();

  // ============== Load Conversation ==============

  async loadConversation(
    conversationId: string,
    encryptionKey: CryptoKey,
    options?: LoadConversationOptions
  ): Promise<{
    cached: { messages: LocalMessage[]; has_more: boolean };
    syncPromise: Promise<SyncResult>;
  }> {
    const initialLimit = options?.initialLimit ?? MESSAGE_PAGE_SIZE;
    const cached = await messageStore.getMessages(conversationId, { limit: initialLimit });
    const cursor = await messageStore.getSyncCursor(conversationId);
    const hasSessionValidation = this.sessionValidatedConversations.has(conversationId);
    const shouldPreferSessionCache = options?.preferSessionCache ?? false;
    const hasStaleUndecryptableMessage = hasUndecryptablePlaceholder(cached.messages);

    const isFreshByTtl = !!(
      cached.messages.length > 0 &&
      cursor?.last_synced_at &&
      Date.now() - new Date(cursor.last_synced_at).getTime() < CACHE_TTL_MS
    );

    const shouldSync = options?.forceSync === true
      ? true
      : hasStaleUndecryptableMessage
        ? true
      : shouldPreferSessionCache && !hasSessionValidation
        ? true
        : !isFreshByTtl;

    let syncPromise: Promise<SyncResult>;

    if (shouldSync) {
      syncPromise = this._syncFromServer(
        conversationId,
        encryptionKey,
        cached,
        options?.syncLimit ?? MESSAGE_PAGE_SIZE,
        options
      )
        .then((result) => {
          this.sessionValidatedConversations.add(conversationId);
          return result;
        });
    } else {
      syncPromise = Promise.resolve({ newMessages: [], hasMore: cached.has_more });
    }

    return { cached, syncPromise };
  }

  private async _syncFromServer(
    conversationId: string,
    encryptionKey: CryptoKey,
    cached: { messages: LocalMessage[]; has_more: boolean },
    syncLimit: number,
    decryptContext?: MessageDecryptionContext
  ): Promise<SyncResult> {
    try {
      const { messages: serverMsgs, has_more } = await getMessages(
        conversationId,
        encryptionKey,
        { limit: syncLimit, ...decryptContext }
      );
      const hasMore = has_more || serverMsgs.length >= syncLimit;

      // FIX: Always update the sync cursor so the 60-second timer resets, 
      // even if the server says there are zero new messages.
      // FIX: Guarantee a string fallback so TypeScript stops yelling
      const newestId = (serverMsgs.length > 0 
        ? serverMsgs[0]?.message_id 
        : cached.messages[0]?.message_id) || '';
        
      await messageStore.setSyncCursor(conversationId, newestId);

      if (serverMsgs.length === 0) {
        return { newMessages: [], hasMore };
      }

      const localMsgs: LocalMessage[] = serverMsgs.map((msg) => {
        const cryptoMetadata = resolveMessageCryptoMetadata(msg);
        return {
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
          protocol: cryptoMetadata.protocol,
          protocol_version: cryptoMetadata.protocol_version,
        };
      });

      // Protect locally-cached plaintext from being overwritten by failed re-decryptions.
      // During protocol transitions, old payloads may no longer decrypt after a reload.
      // Preserve locally-readable plaintext when a freshly fetched message yields placeholders.
      const PLACEHOLDER_CONTENTS = new Set([
        '[unable to decrypt]',
        '[legacy message unavailable]',
        '[encrypted]',
      ]);

      const staleIndexes: number[] = [];
      localMsgs.forEach((msg, i) => {
        if (msg.content && PLACEHOLDER_CONTENTS.has(msg.content)) {
          staleIndexes.push(i);
        }
      });

      if (staleIndexes.length > 0) {
        const existingLookups = await Promise.all(
          staleIndexes.map((i) => {
            const msg = localMsgs[i]!;
            return messageStore.getMessage(msg.conversation_id, msg.message_id);
          })
        );

        for (let j = 0; j < existingLookups.length; j++) {
          const existing = existingLookups[j];
          const idx = staleIndexes[j]!;
          if (existing?.content && !PLACEHOLDER_CONTENTS.has(existing.content)) {
            localMsgs[idx] = { ...localMsgs[idx]!, content: existing.content };
          }
        }
      }

      await messageStore.putMessages(localMsgs);

      const cachedIds = new Set(cached.messages.map((m) => m.message_id));
      const newMessages = localMsgs.filter((m) => !cachedIds.has(m.message_id));

      return { newMessages, hasMore };
    } catch (err) {
      console.error('Background sync failed:', err);
      return { newMessages: [], hasMore: false };
    }
  }

  // ============== Read Local ==============

  async readLocal(
    conversationId: string,
    options?: { before?: string; after?: string; limit?: number }
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
