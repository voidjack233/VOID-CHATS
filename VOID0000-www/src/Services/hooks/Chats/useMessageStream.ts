// src/Services/hooks/Chats/useMessageStream.ts
//
// Owns the live message stream for the active conversation:
//   - newMessage / messageUpdate / messageDelete state
//   - pendingMessages buffer (retry queue when key isn't ready yet)
//   - Buffer flush effect (drains queue once encryptionKey arrives)
//   - MESSAGE_CREATE / MESSAGE_UPDATE / MESSAGE_DELETE gateway effects
//   - resolveMessageKey  — fetches historical key versions on demand
//   - tryDmDecrypt       — DM fast-path (no healer)
//   - attemptDecryption  — AES-GCM path with auto-healer on failure
//
// Conversation sync logic (CONVERSATION_UPDATE, MEMBER_LEAVE, channel guard)
// lives in useConversationSync.

import { useState, useEffect, useRef } from 'react';
import { Conversation, Message, getEncryptionKey } from '../../Chat/chatService';
import { gateway } from '../../Gateway/gateway';
import { decryptMessage } from '../../Crypto/messageEncryption';
import { getHandshakeEntry, setHandshakeEntry, deleteHandshakeEntry } from '../../Chat/handshakeKeyCache';
import { deleteConversationDetails } from '../../Chat/conversationCache';
import { keyManager } from '../../Crypto/keyManager';

interface UseMessageStreamParams {
  activeConversation: Conversation | null;
  activeGroup: Conversation | null;
  user: { id: string } | null | undefined;
  encryptionKey: CryptoKey | null;
  keyVersion: number;
  members: Record<string, any>;
  clearUserTyping: (userId: string) => void;
  retryHandshake: () => void;
  updateKey: (key: CryptoKey, version: number) => void;
  getConversationKeyScopeId: (conversation: Conversation | null | undefined) => string | null;
  getConversationKeyScopePublicId: (conversation: Conversation | null | undefined) => string | null;
  getKeyLookupConversation: (conversation: Conversation) => Conversation;
}

export const useMessageStream = ({
  activeConversation,
  activeGroup,
  user,
  encryptionKey,
  keyVersion,
  members,
  clearUserTyping,
  retryHandshake,
  updateKey,
  getConversationKeyScopeId,
  getConversationKeyScopePublicId,
  getKeyLookupConversation,
}: UseMessageStreamParams) => {
  const [newMessage, setNewMessage] = useState<Message | null>(null);
  const [messageUpdate, setMessageUpdate] = useState<{
    message_id: string;
    content: string;
    is_edited: boolean;
    edited_at: string;
  } | null>(null);
  const [messageDelete, setMessageDelete] = useState<{ message_id: string } | null>(null);

  const pendingMessages = useRef<any[]>([]);

  const resolveMessageKey = async (data: any, fallbackKey: CryptoKey): Promise<CryptoKey> => {
    if (!activeConversation || !user?.id || activeConversation.type === 'dm') {
      return fallbackKey;
    }

    const requestedVersion =
      Number.isInteger(data?.key_version) && data.key_version > 0
        ? data.key_version
        : keyVersion;

    if (requestedVersion === keyVersion) {
      return fallbackKey;
    }

    const keyScopeId = getConversationKeyScopeId(activeConversation) || activeConversation.id;
    const keyLookupConversation = getKeyLookupConversation(activeConversation);
    const cacheEntry = getHandshakeEntry(keyScopeId);
    const cachedKey = cacheEntry?.keysByVersion?.[requestedVersion];
    if (cachedKey) {
      return cachedKey;
    }

    const { key, version } = await getEncryptionKey(
      user.id,
      keyLookupConversation,
      requestedVersion,
    );

    // In-place cache update: mutates the existing entry object directly.
    // Safe because Map stores references — getHandshakeEntry returns the same
    // object that is in the Map, so the write is immediately visible to any
    // subsequent getHandshakeEntry call without a setHandshakeEntry round-trip.
    const activeCache = getHandshakeEntry(keyScopeId);
    if (activeCache) {
      activeCache.keysByVersion = {
        ...activeCache.keysByVersion,
        [version]: key,
      };

      if (version > activeCache.version) {
        activeCache.key = key;
        activeCache.version = version;
      }
    } else {
      setHandshakeEntry(keyScopeId, {
        members,
        key,
        version,
        keysByVersion: {
          [version]: key,
        },
      });
    }

    if (version > keyVersion) {
      updateKey(key, version);
    }

    return key;
  };

  // DM decrypt path.
  // DMs use MLS-tagged payloads encrypted with the conversation key.
  // Returns null on failure so attemptDecryption's auto-healer can run.
  // Previously returned '[unable to decrypt]' which was treated as a
  // successful decrypt (non-null) and permanently bypassed recovery.
  const tryDmDecrypt = async (data: any, key: CryptoKey): Promise<string | null> => {
    if (activeConversation?.type !== 'dm') {
      return null;
    }

    if (data.is_deleted) {
      return '[deleted]';
    }

    if (!data.encrypted_content) {
      return data.content || '[encrypted]';
    }

    if (!data.iv) {
      return '[encrypted]';
    }

    try {
      return await decryptMessage(data.encrypted_content, data.iv, key);
    } catch (err) {
      // Return null — not '[unable to decrypt]' — so the healer in
      // attemptDecryption wipes the cache and re-runs syncInbox.
      console.warn('[DM_DECRYPT] key mismatch, routing to healer', {
        conversation_id: data.conversation_id,
        sender_id: data.sender_id,
        key_version: data.key_version,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  // Auto-healer: if decryption fails, wipes the cache and forces a re-fetch.
  // tryDmDecrypt returns null on failure so DM failures also reach the healer.
  const attemptDecryption = async (data: any, key: CryptoKey, isUpdate = false) => {
    const dmContent = await tryDmDecrypt(data, key);
    if (dmContent !== null) {
      if (isUpdate) {
        setMessageUpdate({
          message_id: data.message_id,
          content: dmContent,
          is_edited: true,
          edited_at: data.edited_at,
        });
      } else {
        setNewMessage({ ...data, content: dmContent });
      }
      return;
    }

    // Legacy AES-GCM path (healer enabled)
    try {
      const content = data.encrypted_content
        ? await decryptMessage(
            data.encrypted_content,
            data.iv,
            await resolveMessageKey(data, key),
          )
        : data.content;

      if (isUpdate) {
        setMessageUpdate({ message_id: data.message_id, content, is_edited: true, edited_at: data.edited_at });
      } else {
        setNewMessage({ ...data, content });
      }
    } catch (err) {
      console.warn('[DECRYPT_HEALER] activating — wiping cache and retrying handshake', {
        conversation_id: activeConversation?.id,
        conversation_type: activeConversation?.type,
        key_version: (data as any)?.key_version,
        sender_id: (data as any)?.sender_id,
        error: err instanceof Error ? err.message : String(err),
      });

      // Wipe the memory cache so the handshake runs fresh
      const keyScopeId = getConversationKeyScopeId(activeConversation);
      const keyScopePublicId = getConversationKeyScopePublicId(activeConversation);

      if (keyScopeId) {
        deleteHandshakeEntry(keyScopeId);
      }

      [
        data.conversation_id,
        activeConversation?.id,
        activeConversation?.public_id,
        keyScopeId,
        keyScopePublicId,
        activeGroup?.id,
        activeGroup?.public_id,
      ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .forEach((identifier) => {
          deleteConversationDetails(identifier);
        });

      // For DMs: delete the wrong IndexedDB key so getEncryptionKey falls
      // through to syncInbox on the next attempt instead of returning the
      // locally-bootstrapped key that short-circuits recovery.
      if (activeConversation?.type === 'dm' && keyScopeId) {
        void keyManager.deleteGroupKey(keyScopeId, keyVersion).catch(() => {});
        console.log('[DECRYPT_HEALER] deleted stale DM group key from IndexedDB', {
          keyScopeId,
          keyVersion,
        });
      }

      // Explicit retry token guarantees the handshake effect runs again.
      retryHandshake();

      // Buffer the message to try again once the new key arrives
      const isAlreadyBuffered = pendingMessages.current.some(
        (pending) =>
          pending.message_id === data.message_id &&
          pending.conversation_id === data.conversation_id &&
          pending.edited_at === data.edited_at,
      );
      if (!isAlreadyBuffered) {
        pendingMessages.current.push(data);
      }
    }
  };

  // Buffer Flush: drains pendingMessages once encryptionKey becomes available
  useEffect(() => {
    if (!encryptionKey || !activeConversation?.id || pendingMessages.current.length === 0) return;

    const flush = async () => {
      console.log('[DECRYPT_FLUSH] draining pending messages', {
        count: pendingMessages.current.length,
        conversation_id: activeConversation?.id,
      });
      const toProcess = [...pendingMessages.current];
      pendingMessages.current = [];

      for (const data of toProcess) {
        if (data.conversation_id !== activeConversation.id) continue;
        await attemptDecryption(data, encryptionKey);
      }
    };
    flush();
  }, [encryptionKey, activeConversation?.id]);

  // New Messages
  useEffect(() => {
    if (!user?.id) return;
    const handleMessage = async (data: any) => {
      if (data.conversation_id === activeConversation?.id) {
        if (data.sender_id) {
          clearUserTyping(String(data.sender_id));
        }

        if (encryptionKey) {
          await attemptDecryption(data, encryptionKey);
        } else {
          pendingMessages.current.push(data);
        }
      }
    };
    gateway.on('MESSAGE_CREATE', handleMessage);
    return () => gateway.off('MESSAGE_CREATE', handleMessage);
  }, [activeConversation?.id, encryptionKey, user?.id]);

  // Message Edits
  useEffect(() => {
    if (!user?.id) return;
    const handleUpdate = async (data: any) => {
      if (data.conversation_id === activeConversation?.id && encryptionKey) {
        await attemptDecryption(data, encryptionKey, true);
      }
    };
    gateway.on('MESSAGE_UPDATE', handleUpdate);
    return () => gateway.off('MESSAGE_UPDATE', handleUpdate);
  }, [activeConversation?.id, encryptionKey, user?.id]);

  // Message Deletions
  useEffect(() => {
    if (!user?.id) return;
    const handleDeleteEvent = (data: any) => {
      if (data.conversation_id === activeConversation?.id) {
        setMessageDelete({ message_id: data.message_id });
      }
    };
    gateway.on('MESSAGE_DELETE', handleDeleteEvent);
    return () => gateway.off('MESSAGE_DELETE', handleDeleteEvent);
  }, [activeConversation?.id, user?.id]);

  const resetMessageStream = () => {
    setNewMessage(null);
    setMessageUpdate(null);
    setMessageDelete(null);
    pendingMessages.current = [];
  };

  return {
    newMessage,
    messageUpdate,
    messageDelete,
    setNewMessage,
    setMessageUpdate,
    resetMessageStream,
  };
};
