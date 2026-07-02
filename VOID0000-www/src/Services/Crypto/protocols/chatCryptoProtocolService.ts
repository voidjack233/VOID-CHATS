import type { Conversation } from '../../Chat/chatService';
import type { MlsDistributeKeyResult, MlsInboxSyncResult } from '../mls/mlsTypes';
import { mlsService } from '../mls/mlsService';

export type ChatSupportedProtocol = 'mls';

export interface DistributeGroupKeyInput {
  userId: string;
  conversation: Conversation;
  memberUserIds: string[];
  allowFreshGroupBootstrap?: boolean;
  forceFreshGroupBootstrap?: boolean;
  forceReaddMemberUserIds?: string[];
  forceKeyVersionBump?: boolean;
  stageOnly?: boolean;
}

export interface ChatCryptoProtocolService {
  readonly protocolId: 'mls';
  readonly protocolVersion: 1;
  getSupportedProtocols(): ChatSupportedProtocol[];
  isProtocolEnabled(protocol: ChatSupportedProtocol): boolean;
  bootstrapAccount(userId: string, force?: boolean): Promise<void>;
  ensureServerKeyPackageReserve(userId: string): Promise<{ published: number; serverCount: number }>;
  preWarmForDm(userId: string, peerUserId: string): Promise<void>;
  syncInbox(
    userId: string,
    force?: boolean,
    options?: { forceArchiveSync?: boolean },
  ): Promise<MlsInboxSyncResult>;
  isDmMessageType(messageType: string | null | undefined): boolean;
  distributeGroupKey(input: DistributeGroupKeyInput): Promise<MlsDistributeKeyResult>;
  preflightGroupRemove(userId: string, conversation: Conversation, removeMemberIds: string[]): Promise<{ requiresFreshBootstrap: boolean }>;
  reuploadGroupState(conversationId: string): Promise<boolean>;
  getLocalGroupMemberUserIds(conversationId: string): Promise<string[] | null>;
  discardLocalGroupState(conversationId: string): Promise<void>;
}

class MlsChatCryptoProtocolService implements ChatCryptoProtocolService {
  readonly protocolId = 'mls' as const;
  readonly protocolVersion = 1 as const;

  getSupportedProtocols(): ChatSupportedProtocol[] {
    return ['mls'];
  }

  isProtocolEnabled(protocol: ChatSupportedProtocol): boolean {
    return protocol === 'mls';
  }

  async bootstrapAccount(userId: string, force = false): Promise<void> {
    await mlsService.bootstrapAccount(userId, force);
  }

  async ensureServerKeyPackageReserve(userId: string): Promise<{ published: number; serverCount: number }> {
    return mlsService.ensureServerKeyPackageReserve(userId);
  }

  async preWarmForDm(userId: string, _peerUserId: string): Promise<void> {
    void _peerUserId;
    await mlsService.bootstrapAccount(userId, true);
  }

  async syncInbox(
    userId: string,
    force = false,
    options: { forceArchiveSync?: boolean } = {},
  ): Promise<MlsInboxSyncResult> {
    return mlsService.syncInbox(userId, force, options);
  }

  isDmMessageType(messageType: string | null | undefined): boolean {
    return mlsService.isMlsMessageType(messageType);
  }

  async distributeGroupKey(input: DistributeGroupKeyInput): Promise<MlsDistributeKeyResult> {
    return mlsService.distributeGroupSenderKey({
      userId: input.userId,
      conversation: input.conversation,
      memberUserIds: input.memberUserIds,
      allowFreshGroupBootstrap: input.allowFreshGroupBootstrap,
      forceFreshGroupBootstrap: input.forceFreshGroupBootstrap,
      forceReaddMemberUserIds: input.forceReaddMemberUserIds,
      forceKeyVersionBump: input.forceKeyVersionBump,
      stageOnly: input.stageOnly,
    });
  }

  async preflightGroupRemove(
    userId: string,
    conversation: Conversation,
    removeMemberIds: string[],
  ): Promise<{ requiresFreshBootstrap: boolean }> {
    return mlsService.preflightGroupRemove(userId, conversation, removeMemberIds);
  }

  async reuploadGroupState(conversationId: string): Promise<boolean> {
    return mlsService.reuploadGroupState(conversationId);
  }

  async getLocalGroupMemberUserIds(conversationId: string): Promise<string[] | null> {
    return mlsService.getLocalGroupMemberUserIds(conversationId);
  }

  async discardLocalGroupState(conversationId: string): Promise<void> {
    await mlsService.discardLocalGroupState(conversationId);
  }
}

export const chatCryptoProtocolService: ChatCryptoProtocolService =
  new MlsChatCryptoProtocolService();
