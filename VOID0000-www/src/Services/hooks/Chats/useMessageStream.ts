// src/Services/hooks/Chats/useMessageStream.ts
//
// Owns the live message stream for the active conversation:
//   - append-only messageEvents / messageUpdate / messageDelete state
//   - pendingMessages buffer (retry queue when key isn't ready yet)
//   - Buffer flush effect (drains queue once encryptionKey arrives)
//   - MESSAGE_CREATE / MESSAGE_UPDATE / MESSAGE_DELETE gateway effects
//   - resolveMessageKey  — fetches historical key versions on demand
//   - tryDmDecrypt       — DM fast-path (no healer)
//   - attemptDecryption  — AES-GCM path with auto-healer on failure
//
// Conversation sync logic (CONVERSATION_UPDATE, MEMBER_LEAVE, channel guard)
// lives in useConversationSync.

import { useCallback, useState, useEffect, useRef } from 'react';
import { debugLog } from '../../utils/debugLog';
import type { ConversationSecurityState } from '../../Chat/conversationSecurityState';
import { Conversation, Message, getEncryptionKey, tryActivateDmDecryptHealer } from '../../Chat/chatService';
import { gateway } from '../../Gateway/gateway';
import { decryptMessage } from '../../Crypto/messageEncryption';
import { getHandshakeEntry, setHandshakeEntry, deleteHandshakeEntry } from '../../Chat/handshakeKeyCache';
import { deleteConversationDetails } from '../../Chat/conversationCache';
import {
  resolveDecryptedLinkPreviewPayload,
  resolveDecryptedMessagePayload,
} from '../../Chat/messageEnvelope';
import { keyManager } from '../../Crypto/keyManager';
import type { MessageStreamEvent, MessageUpdate } from './MessageList/messageListTypes';

interface UseMessageStreamParams {
  activeConversation: Conversation | null;
  activeGroup: Conversation | null;
  user: { id: string } | null | undefined;
  encryptionKey: CryptoKey | null;
  keyVersion: number;
  conversationSecurityState?: ConversationSecurityState;
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
  conversationSecurityState,
  members,
  clearUserTyping,
  retryHandshake,
  updateKey,
  getConversationKeyScopeId,
  getConversationKeyScopePublicId,
  getKeyLookupConversation,
}: UseMessageStreamParams) => {
  const [messageEvents, setMessageEvents] = useState<MessageStreamEvent[]>([]);
  const [messageUpdate, setMessageUpdate] = useState<MessageUpdate | null>(null);
  const [messageDelete, setMessageDelete] = useState<{ message_id: string } | null>(null);

  const pendingMessages = useRef<any[]>([]);
  const messageEventSequenceRef = useRef(0);
  const normalizeLiveMessageShape = useCallback((data: any): Message => ({
    ...data,
    local_client_id: data?.local_client_id ?? data?.client_message_id ?? undefined,
    client_message_id: data?.client_message_id ?? data?.local_client_id ?? undefined,
  }), []);
  const pushMessageEvent = useCallback((message: Message) => {
    const sequence = messageEventSequenceRef.current + 1;
    messageEventSequenceRef.current = sequence;
    setMessageEvents((previous) => [...previous, { sequence, message }]);
  }, []);
  const shouldAutoRecover =
    !conversationSecurityState ||
    conversationSecurityState.status === 'ready' ||
    conversationSecurityState.status === 'recovering' ||
    // Allow the healer to run for DMs blocked because the peer had no keys
    // when the DM was first opened. The peer may now be online with keys,
    // so a retry can succeed and repair the conversation.
    (conversationSecurityState.status === 'blocked' &&
      conversationSecurityState.reason === 'peer_not_ready' &&
      activeConversation?.type === 'dm');

  // Refs for values used inside WS handlers so the effects don't re-register
  // when these values change (e.g. during key rotation). This prevents the
  // brief teardown gap that can drop WS events (like the owner's system
  // message after a kick).
  const encryptionKeyRef = useRef(encryptionKey);
  encryptionKeyRef.current = encryptionKey;
  const shouldAutoRecoverRef = useRef(shouldAutoRecover);
  shouldAutoRecoverRef.current = shouldAutoRecover;

  const resolveMessageKey = async (data: any, fallbackKey: CryptoKey): Promise<CryptoKey> => {
    if (!activeConversation || !user?.id) {
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
  // Returns null on failure so attemptDecryption's throttled healer can run.
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
      return await decryptMessage(
        data.encrypted_content,
        data.iv,
        await resolveMessageKey(data, key),
      );
    } catch (err) {
      // Return null — not '[unable to decrypt]' — so the healer in
      // attemptDecryption can schedule one bounded repair attempt.
      console.warn('[DM_DECRYPT] key mismatch, routing to healer', {
        conversation_id: data.conversation_id,
        sender_id: data.sender_id,
        key_version: data.key_version,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  // Auto-healer: if decryption fails, invalidate stale state and re-handshake.
  // DM activation is throttled because several failed ciphertexts can arrive
  // together while one repair attempt is already in progress.
  const attemptDecryption = async (data: any, key: CryptoKey, isUpdate = false) => {
    if (data.message_type === 'system' && !data.iv) {
      const content = data.content || data.encrypted_content || 'System event';
      if (isUpdate) {
        setMessageUpdate({ message_id: data.message_id, content, is_edited: true, edited_at: data.edited_at });
      } else {
        pushMessageEvent({ ...data, content });
      }
      return;
    }

    const dmContent = await tryDmDecrypt(data, key);
    if (dmContent !== null) {
      const resolvedPayload = resolveDecryptedMessagePayload(dmContent, data.attachments);
      if (isUpdate) {
        setMessageUpdate({
          message_id: data.message_id,
          content: resolvedPayload.content || '',
          is_edited: true,
          edited_at: data.edited_at,
          message_type: data.message_type ?? null,
          forwarded: resolvedPayload.forwarded ?? undefined,
          mentions: resolvedPayload.mentions ?? undefined,
          link_preview: resolvedPayload.link_preview ?? undefined,
        });
      } else {
        pushMessageEvent(normalizeLiveMessageShape({ ...data, ...resolvedPayload }));
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
      const resolvedPayload = typeof content === 'string'
        ? resolveDecryptedMessagePayload(content, data.attachments)
        : {
            content,
            attachments: data.attachments,
            forwarded: undefined,
            mentions: undefined,
            link_preview: undefined,
          };

      if (isUpdate) {
        setMessageUpdate({
          message_id: data.message_id,
          content: resolvedPayload.content || '',
          is_edited: true,
          edited_at: data.edited_at,
          message_type: data.message_type ?? null,
          forwarded: resolvedPayload.forwarded ?? undefined,
          mentions: resolvedPayload.mentions ?? undefined,
          link_preview: resolvedPayload.link_preview ?? undefined,
        });
      } else {
        pushMessageEvent(normalizeLiveMessageShape({ ...data, ...resolvedPayload }));
      }
    } catch (err) {
      if (!shouldAutoRecover) {
        console.warn('[DECRYPT_HEALER] skipping auto-recovery for blocked conversation state', {
          conversation_id: activeConversation?.id,
          conversation_type: activeConversation?.type,
          key_version: (data as any)?.key_version,
          reason: conversationSecurityState?.reason ?? null,
        });
        return;
      }

      const bufferPendingMessage = () => {
        const isAlreadyBuffered = pendingMessages.current.some(
          (pending) =>
            pending.message_id === data.message_id &&
            pending.conversation_id === data.conversation_id &&
            pending.edited_at === data.edited_at,
        );
        if (!isAlreadyBuffered) {
          pendingMessages.current.push(data);
        }
      };
      const keyScopeId = getConversationKeyScopeId(activeConversation);
      const keyScopePublicId = getConversationKeyScopePublicId(activeConversation);

      if (activeConversation?.type === 'dm' && keyScopeId) {
        const healer = tryActivateDmDecryptHealer(keyScopeId);
        if (!healer.activated) {
          console.warn('[DECRYPT_HEALER] DM repair cooldown active; buffering without another cache wipe', {
            conversation_id: keyScopeId,
            key_version: data?.key_version,
            retry_after_ms: healer.retryAfterMs,
          });
          bufferPendingMessage();
          return;
        }
      }

      console.warn('[DECRYPT_HEALER] activating — wiping cache and retrying handshake', {
        conversation_id: activeConversation?.id,
        conversation_type: activeConversation?.type,
        key_version: (data as any)?.key_version,
        sender_id: (data as any)?.sender_id,
        error: err instanceof Error ? err.message : String(err),
      });

      // Wipe the memory cache so the handshake runs fresh
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
        const failedKeyVersion =
          Number.isInteger(data?.key_version) && data.key_version > 0
            ? data.key_version
            : keyVersion;
        const staleVersions = [...new Set([keyVersion, failedKeyVersion])];
        void Promise.all(
          staleVersions.map((version) => keyManager.deleteGroupKey(keyScopeId, version).catch(() => {}))
        ).catch(() => {});
        debugLog('[DECRYPT_HEALER] deleted stale DM group key from IndexedDB', {
          keyScopeId,
          keyVersions: staleVersions,
        });
      }

      // Explicit retry token guarantees the handshake effect runs again.
      retryHandshake();

      // Buffer the message to try again once the new key arrives
      bufferPendingMessage();
    }
  };

  const attemptPreviewUpdateDecryption = async (data: any, key: CryptoKey) => {
    if (!data.encrypted_link_preview || !data.link_preview_iv) {
      return;
    }

    const previewKeyVersion =
      Number.isInteger(data?.link_preview_key_version) && data.link_preview_key_version > 0
        ? data.link_preview_key_version
        : data.key_version;
    const previewDecryptable = {
      ...data,
      encrypted_content: data.encrypted_link_preview,
      iv: data.link_preview_iv,
      key_version: previewKeyVersion,
      is_deleted: false,
    };

    try {
      const decryptedPreview = await decryptMessage(
        data.encrypted_link_preview,
        data.link_preview_iv,
        await resolveMessageKey(previewDecryptable, key),
      );
      const linkPreview = resolveDecryptedLinkPreviewPayload(decryptedPreview);
      if (!linkPreview) {
        return;
      }

      setMessageUpdate({
        message_id: data.message_id,
        link_preview: linkPreview,
        encrypted_link_preview: data.encrypted_link_preview,
        link_preview_iv: data.link_preview_iv,
        link_preview_key_version: previewKeyVersion ?? null,
      });
    } catch (err) {
      console.warn('[LINK_PREVIEW] failed to decrypt live preview update', {
        conversation_id: data.conversation_id,
        message_id: data.message_id,
        key_version: previewKeyVersion,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Buffer Flush: drains pendingMessages once encryptionKey becomes available
  useEffect(() => {
    if (!encryptionKey || !activeConversation?.id || pendingMessages.current.length === 0) return;

    const flush = async () => {
      debugLog('[DECRYPT_FLUSH] draining pending messages', {
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
  // Refs are used for encryptionKey and shouldAutoRecover so this effect only
  // re-registers when the conversation or user changes — NOT on key rotation.
  // This eliminates the brief teardown gap that dropped WS events (e.g. the
  // owner's system message arriving right after a kick triggered key rotation).
  useEffect(() => {
    if (!user?.id) return;
    const handleMessage = async (data: any) => {
      if (data.conversation_id === activeConversation?.id) {
        if (data.sender_id) {
          clearUserTyping(String(data.sender_id));
        }

        // Plaintext system messages (no iv) don't need decryption — handle
        // them immediately so they aren't dropped during key rotation when
        // encryptionKey is briefly changing references.
        if (data.message_type === 'system' && !data.iv) {
          const content = data.content || data.encrypted_content || 'System event';
          pushMessageEvent(normalizeLiveMessageShape({ ...data, content }));
        } else if (encryptionKeyRef.current) {
          await attemptDecryption(data, encryptionKeyRef.current);
        } else if (shouldAutoRecoverRef.current) {
          pendingMessages.current.push(data);
        }
      }
    };
    gateway.on('MESSAGE_CREATE', handleMessage);
    return () => gateway.off('MESSAGE_CREATE', handleMessage);
    // encryptionKey and conversationSecurityState are accessed via refs so
    // key rotation does not tear down and re-register this handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id, normalizeLiveMessageShape, user?.id]);

  // Message Edits
  useEffect(() => {
    if (!user?.id) return;
    const handleUpdate = async (data: any) => {
      if (data.conversation_id === activeConversation?.id && encryptionKeyRef.current) {
        if (data.encrypted_link_preview && data.link_preview_iv && !data.encrypted_content) {
          await attemptPreviewUpdateDecryption(data, encryptionKeyRef.current);
          return;
        }

        await attemptDecryption(data, encryptionKeyRef.current, true);
      }
    };
    gateway.on('MESSAGE_UPDATE', handleUpdate);
    return () => gateway.off('MESSAGE_UPDATE', handleUpdate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id, user?.id]);

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
    setMessageEvents([]);
    setMessageUpdate(null);
    setMessageDelete(null);
    messageEventSequenceRef.current = 0;
    pendingMessages.current = [];
  };

  return {
    messageEvents,
    messageUpdate,
    messageDelete,
    pushMessageEvent,
    setMessageUpdate,
    resetMessageStream,
  };
};
