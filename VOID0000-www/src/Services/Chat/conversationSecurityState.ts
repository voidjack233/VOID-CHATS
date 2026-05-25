export type ConversationSecurityStatus = 'ready' | 'recovering' | 'blocked';

export type ConversationSecurityReason =
  | null
  | 'preparing'
  | 'account_restore_required'
  | 'conversation_state_missing'
  | 'distribution_missing'
  | 'identity_missing'
  | 'peer_not_ready'
  | 'welcome_key_package_missing'
  | 'recipient_details_missing'
  | 'key_load_failed';

export interface ConversationSecurityState {
  status: ConversationSecurityStatus;
  reason: ConversationSecurityReason;
  message: string | null;
  detail: string | null;
  canSend: boolean;
  canRetry: boolean;
  showCachedHistoryFallback: boolean;
}

const readyState: ConversationSecurityState = {
  status: 'ready',
  reason: null,
  message: null,
  detail: null,
  canSend: true,
  canRetry: false,
  showCachedHistoryFallback: false,
};

export function getReadyConversationSecurityState(): ConversationSecurityState {
  return readyState;
}

export function createConversationSecurityState(
  state: Partial<ConversationSecurityState> & Pick<ConversationSecurityState, 'status'>,
): ConversationSecurityState {
  return {
    ...readyState,
    ...state,
  };
}
