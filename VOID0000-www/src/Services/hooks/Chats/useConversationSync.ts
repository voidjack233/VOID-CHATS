// src/Services/hooks/Chats/useConversationSync.ts
//
// Owns the gateway-driven sync effects for the active conversation:
//   - CONVERSATION_UPDATE: patches state inline.
//   - MEMBER_LEAVE: purges caches and navigates away when the current user
//     is removed from the active conversation or group.
//
// State ownership stays in useChatManager. This hook only reacts to events
// and calls back into coordinator handlers via explicit callbacks.

import { useEffect, useRef } from 'react';
import { debugLog } from '../../utils/debugLog';
import { Conversation } from '../../Chat/chatService';
import { gateway } from '../../Gateway/gateway';
import { messageStore } from '../../Chat/chatStore';
import { messageSync } from '../../Chat/chatSync';
import { deleteConversationDetails } from '../../Chat/conversationCache';
import { deleteHandshakeEntry } from '../../Chat/handshakeKeyCache';
import { normalizeKeyVersion } from '../../Chat/chatUtils';
import { matchesConversationIdentifier } from '../../Chat/utils/conversationUtils';
import { keyManager } from '../../Crypto/keyManager';
import { mlsStore } from '../../Crypto/mls/mlsStore';
import { chatCryptoProtocolService } from '../../Crypto/protocols/chatCryptoProtocolService';

interface UseConversationSyncParams {
  activeConversation: Conversation | null;
  activeGroup: Conversation | null;
  user: { id: string } | null | undefined;
  onPatchConversation: (conversation: Conversation) => void;
  onBackToMe: () => void;
  retryHandshake: () => void;
}

export const useConversationSync = ({
  activeConversation,
  activeGroup,
  user,
  onPatchConversation,
  onBackToMe,
  retryHandshake,
}: UseConversationSyncParams) => {
  // Callback refs: keep the latest function references without adding them
  // to effect dep arrays, matching the pattern in useConversationHandshake.
  const onPatchConversationRef = useRef(onPatchConversation);
  useEffect(() => { onPatchConversationRef.current = onPatchConversation; });

  const onBackToMeRef = useRef(onBackToMe);
  useEffect(() => { onBackToMeRef.current = onBackToMe; });

  const retryHandshakeRef = useRef(retryHandshake);
  useEffect(() => { retryHandshakeRef.current = retryHandshake; });

  const activeConversationRef = useRef(activeConversation);
  useEffect(() => { activeConversationRef.current = activeConversation; });

  const activeGroupRef = useRef(activeGroup);
  useEffect(() => { activeGroupRef.current = activeGroup; });

  const recoveringKeyVersionRef = useRef<Record<string, number>>({});

  // CONVERSATION_UPDATE: patch state inline. The patch updates activeGroup
  // with the new current_key_version / member_count, which is enough for the
  // handshake hook to re-derive encryption keys. No full reload needed —
  // forcing forceReload here caused redundant API fetches and UI thrashing
  // (skeleton flash) on every member add/kick/promote.
  useEffect(() => {
    if (!user?.id) return;

    const handleConversationUpdate = (data: any) => {
      const updatedConversation = data?.conversation as Conversation | undefined;
      if (!updatedConversation) return;
      const updatedIdentifier = updatedConversation.public_id || updatedConversation.id;
      const activeConversationSnapshot = activeConversationRef.current;
      const activeGroupSnapshot = activeGroupRef.current;
      const matchedActiveConversation =
        (matchesConversationIdentifier(activeConversationSnapshot, updatedIdentifier)
          ? activeConversationSnapshot
          : null) ||
        (matchesConversationIdentifier(activeGroupSnapshot, updatedIdentifier)
          ? activeGroupSnapshot
          : null);
      const previousKeyVersion = matchedActiveConversation
        ? normalizeKeyVersion(matchedActiveConversation.current_key_version, 1)
        : null;
      const nextKeyVersion = normalizeKeyVersion(
        updatedConversation.current_key_version,
        previousKeyVersion ?? 1,
      );

      onPatchConversationRef.current(updatedConversation);

      if (!matchedActiveConversation || previousKeyVersion == null || nextKeyVersion <= previousKeyVersion) {
        return;
      }

      const recoveryConversationId = matchedActiveConversation.id;
      if (recoveringKeyVersionRef.current[recoveryConversationId] === nextKeyVersion) {
        return;
      }
      recoveringKeyVersionRef.current[recoveryConversationId] = nextKeyVersion;

      messageSync.invalidateConversation(recoveryConversationId);

      [
        matchedActiveConversation.id,
        matchedActiveConversation.public_id,
        updatedConversation.id,
        updatedConversation.public_id,
      ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .forEach((identifier) => {
          deleteHandshakeEntry(identifier);
        });

      debugLog('[MLS_KEY_BUMP] proactive recovery after conversation update', {
        conversation_id: recoveryConversationId,
        previous_key_version: previousKeyVersion,
        next_key_version: nextKeyVersion,
      });

      void (async () => {
        const retryDelays = [0, 750, 2_500];
        let lastError: unknown = null;

        for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
          const retryDelay = retryDelays[attempt] ?? 0;
          if (retryDelay > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
          }

          try {
            await chatCryptoProtocolService.syncInbox(user.id, true);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
          }
        }

        if (lastError) {
          console.warn('[MLS_KEY_BUMP] proactive sync failed', {
            conversation_id: recoveryConversationId,
            next_key_version: nextKeyVersion,
            error: lastError instanceof Error ? lastError.message : String(lastError || ''),
          });
        }

        try {
          const currentActiveConversation = activeConversationRef.current;
          const currentActiveGroup = activeGroupRef.current;
          const stillActive =
            matchesConversationIdentifier(currentActiveConversation, updatedIdentifier) ||
            matchesConversationIdentifier(currentActiveGroup, updatedIdentifier);

          if (stillActive) {
            retryHandshakeRef.current();
          }
        } finally {
          delete recoveringKeyVersionRef.current[recoveryConversationId];
        }
      })();
    };

    gateway.on('CONVERSATION_UPDATE', handleConversationUpdate);
    return () => gateway.off('CONVERSATION_UPDATE', handleConversationUpdate);
  }, [user?.id]);

  // MEMBER_LEAVE: purge caches and navigate away when the current user is
  // removed from the active conversation or group.
  useEffect(() => {
    if (!user?.id) return;

    const handleMemberLeave = (data: any) => {
      const conversationId = data?.conversation_id;
      const conversationPublicId = data?.conversation_public_id || null;
      if (!conversationId) return;

      const affectedUserId =
        data?.user_id ||
        data?.member_user_id ||
        data?.target_user_id ||
        data?.removed_user_id ||
        null;

      // Only force-close when this current user is the one removed.
      if (affectedUserId && String(affectedUserId) !== String(user.id)) {
        return;
      }

      // Purge all stale caches so that if the user re-joins later
      // they start fresh — no old messages, no stale handshake keys.
      const identifiers = [conversationId, conversationPublicId].filter(Boolean) as string[];
      identifiers.forEach((id) => {
        deleteHandshakeEntry(id);
        deleteConversationDetails(id);
      });

      debugLog('[MLS_MEMBER_REMOVE] clearing local conversation caches after removal', {
        conversation_id: conversationId,
        conversation_public_id: conversationPublicId,
        affected_user_id: affectedUserId || user.id,
      });

      // Clear the local IndexedDB message cache for this conversation so
      // the user won't see pre-kick messages if they rejoin.
      messageStore.clearConversation(conversationId).catch(() => {});
      messageSync.invalidateConversation(conversationId);

      void (async () => {
        try {
          const deletedKeyVersions = await keyManager.deleteAllGroupKeys(conversationId);
          await mlsStore.deleteGroupState(conversationId);
          debugLog('[MLS_MEMBER_REMOVE] cleared local MLS state after removal', {
            conversation_id: conversationId,
            deleted_group_key_versions: deletedKeyVersions,
          });
        } catch (err) {
          console.warn('[MLS_MEMBER_REMOVE] failed to clear local MLS state after removal', {
            conversation_id: conversationId,
            error: err instanceof Error ? err.message : String(err || ''),
          });
        }
      })();

      if (
        matchesConversationIdentifier(activeConversation, conversationId) ||
        matchesConversationIdentifier(activeGroup, conversationId)
      ) {
        onBackToMeRef.current();
      }
    };

    gateway.on('MEMBER_LEAVE', handleMemberLeave);
    return () => gateway.off('MEMBER_LEAVE', handleMemberLeave);
  }, [activeConversation?.id, activeConversation?.public_id, activeGroup?.id, activeGroup?.public_id, user?.id]);
};
