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
import { Conversation } from '../../Chat/chatService';
import { gateway } from '../../Gateway/gateway';
import { messageStore } from '../../Chat/chatStore';
import { messageSync } from '../../Chat/chatSync';
import { deleteConversationDetails } from '../../Chat/conversationCache';
import { deleteHandshakeEntry } from '../../Chat/handshakeKeyCache';
import { matchesConversationIdentifier } from '../../Chat/utils/conversationUtils';
import { keyManager } from '../../Crypto/keyManager';
import { mlsStore } from '../../Crypto/mls/mlsStore';

interface UseConversationSyncParams {
  activeConversation: Conversation | null;
  activeGroup: Conversation | null;
  user: { id: string } | null | undefined;
  onPatchConversation: (conversation: Conversation) => void;
  onBackToMe: () => void;
}

export const useConversationSync = ({
  activeConversation,
  activeGroup,
  user,
  onPatchConversation,
  onBackToMe,
}: UseConversationSyncParams) => {
  // Callback refs: keep the latest function references without adding them
  // to effect dep arrays, matching the pattern in useConversationHandshake.
  const onPatchConversationRef = useRef(onPatchConversation);
  useEffect(() => { onPatchConversationRef.current = onPatchConversation; });

  const onBackToMeRef = useRef(onBackToMe);
  useEffect(() => { onBackToMeRef.current = onBackToMe; });

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

      onPatchConversationRef.current(updatedConversation);
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

      console.log('[MLS_MEMBER_REMOVE] clearing local conversation caches after removal', {
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
          console.log('[MLS_MEMBER_REMOVE] cleared local MLS state after removal', {
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
