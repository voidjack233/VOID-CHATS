import type { Conversation } from '../../Chat/chatService';
import { mlsService } from '../mls/mlsService';

export type ChatSupportedProtocol = 'mls';

export interface DistributeGroupKeyInput {
  userId: string;
  conversation: Conversation;
  memberUserIds: string[];
  keyVersion: number;
  groupKey: CryptoKey;
}

export interface ChatCryptoProtocolService {
  readonly protocolId: 'mls';
  readonly protocolVersion: 1;
  getSupportedProtocols(): ChatSupportedProtocol[];
  isProtocolEnabled(protocol: ChatSupportedProtocol): boolean;
  bootstrapAccount(userId: string): Promise<void>;
  preWarmForDm(userId: string, peerUserId: string): Promise<void>;
  syncInbox(userId: string): Promise<void>;
  isDmMessageType(messageType: string | null | undefined): boolean;
  distributeGroupKey(input: DistributeGroupKeyInput): Promise<void>;
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

  async bootstrapAccount(userId: string): Promise<void> {
    await mlsService.bootstrapAccount(userId);
  }

  async preWarmForDm(userId: string, _peerUserId: string): Promise<void> {
    await mlsService.bootstrapAccount(userId);
  }

  async syncInbox(userId: string): Promise<void> {
    await mlsService.syncInbox(userId);
  }

  isDmMessageType(messageType: string | null | undefined): boolean {
    return mlsService.isMlsMessageType(messageType);
  }

  async distributeGroupKey(input: DistributeGroupKeyInput): Promise<void> {
    await mlsService.distributeGroupSenderKey({
      userId: input.userId,
      conversation: input.conversation,
      memberUserIds: input.memberUserIds,
      keyVersion: input.keyVersion,
      groupKey: input.groupKey,
    });
  }
}

export const chatCryptoProtocolService: ChatCryptoProtocolService =
  new MlsChatCryptoProtocolService();
