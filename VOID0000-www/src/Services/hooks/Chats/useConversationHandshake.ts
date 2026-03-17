// src/Services/hooks/Chats/useConversationHandshake.ts
//
// Owns the MLS handshake lifecycle for the active conversation.
//
// Responsibilities:
//   - Manages members, encryptionKey, keyVersion, encryptionError, and
//     handshakeRetryToken state.
//   - Runs the full handshake effect: cache-hit fast-path, member fetch,
//     key resolution with retry loop, DM bootstrap fallback, group
//     self-heal fallback.
//   - Exposes retryHandshake, updateKey for useMessageStream's resolveMessageKey
//     and attemptDecryption; resetCryptoState for useChatManager's resetLiveChatState.
//   - Exposes getConversationKeyScopeId, getConversationKeyScopePublicId,
//     getKeyLookupConversation for useMessageStream's resolveMessageKey and attemptDecryption.
//   - Uses callback refs for onHydrateDm and onPatchConversation so that the
//     handshake effect's dependency array does not need to include them.

import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Conversation,
  getEncryptionKey,
  ensureGroupKeyDistribution,
  ownerSelfHealGroupKey,
  bootstrapDmKey,
} from '../../Chat/chatService';
import { chatCryptoProtocolService } from '../../Crypto/protocols/chatCryptoProtocolService';
import { fetchWithAuth } from '../../Auth/authServiceApi';
import { ConversationDetails } from '../../Chat/chatTypes';
import { getConversationDetails, storeConversationDetails } from '../../Chat/conversationCache';
import {
  getHandshakeEntry,
  setHandshakeEntry,
  deleteHandshakeEntry,
} from '../../Chat/handshakeKeyCache';

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
  const [members, setMembers] = useState<Record<string, any>>({});
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null);
  const [keyVersion, setKeyVersion] = useState(1);
  const [encryptionError, setEncryptionError] = useState<string | null>(null);
  const [handshakeRetryToken, setHandshakeRetryToken] = useState(0);

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

  const requiredConversationKeyVersion = useMemo(() => {
    if (!activeConversation || activeConversation.type === 'dm') {
      return null;
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

  // Handshake setup
  useEffect(() => {
    let ignore = false;

    const setupConversation = async () => {
      if (!activeConversation || !user?.id) return;
      const requiredGroupVersion = requiredConversationKeyVersion;
      const keyScopeId = getConversationKeyScopeId(activeConversation) || activeConversation.id;
      const keyScopePublicId = getConversationKeyScopePublicId(activeConversation);
      const keyLookupConversation = getKeyLookupConversation(activeConversation);

      const cached = getHandshakeEntry(keyScopeId);
      if (cached && (!requiredGroupVersion || cached.version === requiredGroupVersion)) {
        setEncryptionError(null);
        setMembers(cached.members);
        setEncryptionKey(cached.key);
        setKeyVersion(cached.version);
        return;
      }

      const staleHandshake = cached && requiredGroupVersion && cached.version !== requiredGroupVersion;
      if (staleHandshake) {
        deleteHandshakeEntry(keyScopeId);
      }

      // Ensure key packages are published early so the owner's distribution
      // pass can add us to the MLS group even on the very first open.
      if (activeConversation.type !== 'dm') {
        void chatCryptoProtocolService.bootstrapAccount(user.id);
      }

      let resolvedMemberIds: string[] = [];

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
                  conversationDetails.dm_display_name || peer?.display_name || null,
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
        setMembers(memberMap);
        resolvedMemberIds = Object.keys(memberMap);

        const peerId =
          activeConversation.type === 'dm'
            ? (
                activeConversation.dm_user_id ||
                hydratedConversationDetails.dm_user_id ||
                hydratedMembers.find((m: any) => m.user_id !== user.id)?.user_id
              )
            : undefined;

        if (activeConversation.type === 'dm' && !peerId) {
          throw new Error('Could not resolve DM peer');
        }

        let keyResult: { key: CryptoKey; version: number } | null = null;
        let lastKeyError: Error | null = null;

        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            keyResult = await getEncryptionKey(
              user.id,
              keyLookupConversation,
              requiredGroupVersion || undefined,
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

        if (!keyResult) {
          throw lastKeyError || new Error('Failed to resolve conversation encryption key');
        }

        const { key, version } = keyResult;

        if (ignore) return;

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
        setEncryptionKey(key);
        setKeyVersion(version);

        // Pre-warm DM crypto bootstrap so that first send doesn't
        // incur setup and capability-check latency.
        if (activeConversation.type === 'dm' && peerId) {
          void chatCryptoProtocolService.preWarmForDm(user.id, peerId);
        }

        // Auto-redistribution: any member who already has the MLS group
        // state can add missing members and fan out welcomes/commits.
        // This ensures new members get keys as soon as ANY existing member
        // opens the conversation — not just the owner.
        const ownerConversation = activeGroup || activeConversation;
        if (ownerConversation && ownerConversation.type !== 'dm') {
          ensureGroupKeyDistribution(ownerConversation, user.id, resolvedMemberIds).catch(
            () => {},
          );
        }
      } catch (err: any) {
        if (ignore) return;
        console.error('Handshake Error:', err);
        setEncryptionKey(null);
        const reason = err instanceof Error ? err.message : String(err || '');

        if (reason.includes('Identity keys missing')) {
          setEncryptionError('Your private keys are not available on this device yet.');
          return;
        }

        const isGroupKeyError =
          reason.includes('No group key available') ||
          reason.includes('No group sender key available') ||
          reason.includes('Group key version') ||
          reason.includes('not decryptable') ||
          reason.includes('OperationError');

        if (isGroupKeyError) {
          // DM bootstrap: no MLS group exists yet for this conversation.
          // Create one now (with the peer if they have key packages, solo
          // otherwise). The peer joins automatically via syncInbox welcome
          // when they next come online.
          if (activeConversation?.type === 'dm') {
            const dmPeerId =
              activeConversation.dm_user_id ||
              resolvedMemberIds.find((id) => id !== user.id);
            try {
              const result = await bootstrapDmKey(activeConversation, user.id, dmPeerId);
              if (!ignore) {
                setEncryptionError(null);
                setEncryptionKey(result.key);
                setKeyVersion(result.version);
              }
              return;
            } catch (dmBootstrapErr) {
              console.error('DM key bootstrap failed:', dmBootstrapErr);
            }
          }

          // Member self-heal: any member (owner or not) who lacks local MLS
          // state can create a fresh group and redistribute keys to everyone.
          // This handles new-device logins where IndexedDB is empty.
          const ownerConversation = activeGroup || activeConversation;
          if (
            ownerConversation &&
            ownerConversation.type !== 'dm' &&
            resolvedMemberIds.length > 0
          ) {
            try {
              const result = await ownerSelfHealGroupKey(
                ownerConversation,
                user.id,
                resolvedMemberIds,
              );
              if (!ignore) {
                setEncryptionError(null);
                setEncryptionKey(result.key);
                setKeyVersion(result.version);
                onPatchConversationRef.current({
                  ...ownerConversation,
                  current_key_version: result.version,
                });
              }
              return;
            } catch (healErr) {
              console.error('Member key self-heal failed:', healErr);
            }
          }

          setEncryptionError('Unable to decrypt group keys');
          return;
        }

        setEncryptionError('Failed to load encryption keys for this chat.');
      }
    };

    setupConversation();
    return () => {
      ignore = true;
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
    user?.id,
  ]);

  const retryHandshake = () => {
    setEncryptionKey(null);
    setHandshakeRetryToken((t) => t + 1);
  };

  const updateKey = (key: CryptoKey, version: number) => {
    setEncryptionKey(key);
    setKeyVersion(version);
  };

  const resetCryptoState = () => {
    setEncryptionKey(null);
    setEncryptionError(null);
  };

  return {
    members,
    encryptionKey,
    keyVersion,
    encryptionError,
    retryHandshake,
    updateKey,
    resetCryptoState,
    getConversationKeyScopeId,
    getConversationKeyScopePublicId,
    getKeyLookupConversation,
  };
};
