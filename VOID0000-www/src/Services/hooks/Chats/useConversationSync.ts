// src/Services/hooks/Chats/useConversationSync.ts
//
// Owns the three gateway-driven sync effects for the active conversation:
//   - Channel guard / auto-select: when activeGroup changes and the current
//     activeConversation is not one of its channels, auto-selects the fallback.
//   - CONVERSATION_UPDATE: patches state and triggers a group reload when the
//     key version or member count changes.
//   - MEMBER_LEAVE: purges caches and navigates away when the current user
//     is removed from the active conversation or group.
//
// State ownership stays in useChatManager. This hook only reacts to events
// and calls back into coordinator handlers via explicit callbacks.

import { useEffect, useRef } from 'react';
import { Conversation } from '../../Chat/chatService';
import { gateway } from '../../Gateway/gateway';
import { messageStore } from '../../Chat/chatStore';
import { deleteConversationDetails } from '../../Chat/conversationCache';
import { deleteHandshakeEntry } from '../../Chat/handshakeKeyCache';
import { matchesConversationIdentifier, pickInitialChannel } from '../../Chat/utils/conversationUtils';

interface UseConversationSyncParams {
  activeConversation: Conversation | null;
  activeGroup: Conversation | null;
  user: { id: string } | null | undefined;
  lastActiveChannelRef: React.MutableRefObject<{ id: string; public_id?: string | null } | null>;
  onPatchConversation: (conversation: Conversation) => void;
  onRefreshActiveGroup: (preferredChannelId?: string | null) => void;
  onBackToMe: () => void;
  onResetLiveChatState: () => void;
  onSetActiveConversation: (conversation: Conversation) => void;
  getPreferredChannelIdentifier: (preferredChannelId?: string | null) => string | null;
}

export const useConversationSync = ({
  activeConversation,
  activeGroup,
  user,
  lastActiveChannelRef,
  onPatchConversation,
  onRefreshActiveGroup,
  onBackToMe,
  onResetLiveChatState,
  onSetActiveConversation,
  getPreferredChannelIdentifier,
}: UseConversationSyncParams) => {
  // Callback refs: keep the latest function references without adding them
  // to effect dep arrays, matching the pattern in useConversationHandshake.
  const onPatchConversationRef = useRef(onPatchConversation);
  useEffect(() => { onPatchConversationRef.current = onPatchConversation; });

  const onRefreshActiveGroupRef = useRef(onRefreshActiveGroup);
  useEffect(() => { onRefreshActiveGroupRef.current = onRefreshActiveGroup; });

  const onBackToMeRef = useRef(onBackToMe);
  useEffect(() => { onBackToMeRef.current = onBackToMe; });

  const onResetLiveChatStateRef = useRef(onResetLiveChatState);
  useEffect(() => { onResetLiveChatStateRef.current = onResetLiveChatState; });

  const onSetActiveConversationRef = useRef(onSetActiveConversation);
  useEffect(() => { onSetActiveConversationRef.current = onSetActiveConversation; });

  const getPreferredChannelIdentifierRef = useRef(getPreferredChannelIdentifier);
  useEffect(() => { getPreferredChannelIdentifierRef.current = getPreferredChannelIdentifier; });

  // Channel guard: when the active group changes and the current conversation
  // is not one of its channels, auto-select the preferred fallback channel.
  useEffect(() => {
    if (!activeGroup) return;

    const channels = activeGroup.channels || [];
    if (channels.length === 0) return;

    const activeIsChannelInGroup = !!(
      activeConversation &&
      activeConversation.type === 'channel' &&
      channels.some((channel) =>
        matchesConversationIdentifier(channel, activeConversation.id) || (
          activeConversation.public_id && matchesConversationIdentifier(channel, activeConversation.public_id)
        )
      )
    );

    if (activeIsChannelInGroup) {
      return;
    }

    const preferredIdentifier =
      getPreferredChannelIdentifierRef.current(null) ||
      activeGroup.default_channel_public_id ||
      activeGroup.default_channel_id ||
      null;
    const fallbackChannel = pickInitialChannel(activeGroup, preferredIdentifier);

    if (fallbackChannel.type !== 'channel') {
      return;
    }

    if (activeConversation?.id === fallbackChannel.id) {
      return;
    }

    onResetLiveChatStateRef.current();
    onSetActiveConversationRef.current(fallbackChannel);
  }, [
    activeConversation?.id,
    activeConversation?.public_id,
    activeConversation?.type,
    activeGroup?.id,
    activeGroup?.public_id,
    activeGroup?.default_channel_id,
    activeGroup?.default_channel_public_id,
    activeGroup?.channels,
  ]);

  // CONVERSATION_UPDATE: patch state; reload the group when key version or
  // member count changes so crypto is refreshed immediately.
  useEffect(() => {
    if (!user?.id) return;

    const handleConversationUpdate = (data: any) => {
      const updatedConversation = data?.conversation as Conversation | undefined;
      if (!updatedConversation) return;

      const conversationIdentifier = updatedConversation.public_id || updatedConversation.id;
      const touchesActiveGroup = matchesConversationIdentifier(activeGroup, conversationIdentifier);
      const keyVersionChanged =
        touchesActiveGroup &&
        updatedConversation.current_key_version != null &&
        updatedConversation.current_key_version !== activeGroup?.current_key_version;
      const memberCountChanged =
        touchesActiveGroup &&
        updatedConversation.member_count != null &&
        updatedConversation.member_count !== activeGroup?.member_count;

      onPatchConversationRef.current(updatedConversation);

      if (touchesActiveGroup && (keyVersionChanged || memberCountChanged)) {
        const preferredChannelId =
          lastActiveChannelRef.current?.public_id ||
          lastActiveChannelRef.current?.id ||
          activeConversation?.public_id ||
          activeConversation?.id;
        void onRefreshActiveGroupRef.current(preferredChannelId);
      }
    };

    gateway.on('CONVERSATION_UPDATE', handleConversationUpdate);
    return () => gateway.off('CONVERSATION_UPDATE', handleConversationUpdate);
  }, [
    activeConversation?.id,
    activeConversation?.public_id,
    activeGroup?.current_key_version,
    activeGroup?.id,
    activeGroup?.member_count,
    activeGroup?.public_id,
    user?.id,
  ]);

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

      // Clear the local IndexedDB message cache for this conversation
      // (and its channels if it was a group) so the user won't see
      // pre-kick messages if they rejoin.
      messageStore.clearConversation(conversationId).catch(() => {});
      if (activeGroup && matchesConversationIdentifier(activeGroup, conversationId)) {
        (activeGroup.channels || []).forEach((channel) => {
          messageStore.clearConversation(channel.id).catch(() => {});
          if (channel.public_id) {
            deleteHandshakeEntry(channel.public_id);
            deleteConversationDetails(channel.public_id);
          }
          deleteHandshakeEntry(channel.id);
          deleteConversationDetails(channel.id);
        });
      }

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
