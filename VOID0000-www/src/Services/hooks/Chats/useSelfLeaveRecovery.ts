import { useEffect } from 'react';
import { gateway } from '../../Gateway/gateway';
import {
  finalizeSelfLeaveRotation,
  getPendingSelfLeaveRotations,
  type PendingSelfLeaveRotation,
} from '../../Chat/conversationService';
import { SELF_LEAVE_RECOVERY_REQUESTED_EVENT } from '../../Chat/selfLeaveRecoveryEvents';
import { debugLog } from '../../utils/debugLog';

const TRANSIENT_RETRY_DELAY_MS = 45_000;
const MAX_SCHEDULED_RETRIES = 5;
const TERMINAL_ERROR_CODES = new Set([
  'MEMBERSHIP_OPERATION_NOT_FOUND',
  'SELF_LEAVE_FINALIZER_NOT_MEMBER',
  'SELF_LEAVE_ROTATION_NOT_PENDING',
  'SELF_LEAVE_ROTATION_STALE',
]);

interface UseSelfLeaveRecoveryOptions {
  enabled: boolean;
  skipReason?: string | null;
  userId?: string | null;
}

function normalizeRotation(value: unknown): PendingSelfLeaveRotation | null {
  const payload = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const operationId = typeof payload.operation_id === 'string' ? payload.operation_id : '';
  const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id : '';
  const targetUserId = typeof payload.target_user_id === 'string' ? payload.target_user_id : '';
  const pendingKeyVersion = Number(payload.pending_key_version);
  const currentKeyVersion = Number(payload.current_key_version);

  if (
    !operationId ||
    !conversationId ||
    !targetUserId ||
    !Number.isInteger(pendingKeyVersion) ||
    pendingKeyVersion <= 0
  ) {
    return null;
  }

  return {
    operation_id: operationId,
    conversation_id: conversationId,
    conversation_public_id:
      typeof payload.conversation_public_id === 'string'
        ? payload.conversation_public_id
        : null,
    target_user_id: targetUserId,
    target_label: typeof payload.target_label === 'string' ? payload.target_label : null,
    survivor_role: typeof payload.survivor_role === 'string' ? payload.survivor_role : null,
    pending_key_version: pendingKeyVersion,
    current_key_version:
      Number.isInteger(currentKeyVersion) && currentKeyVersion > 0
        ? currentKeyVersion
        : Math.max(1, pendingKeyVersion - 1),
  };
}

function getRecoveryRequestSource(event: Event): string {
  if (!(event instanceof CustomEvent)) return 'external_request';
  const detail = event.detail && typeof event.detail === 'object'
    ? event.detail as Record<string, unknown>
    : {};
  return typeof detail.source === 'string' && detail.source.length > 0
    ? detail.source
    : 'external_request';
}

export function useSelfLeaveRecovery({
  enabled,
  skipReason,
  userId,
}: UseSelfLeaveRecoveryOptions): void {
  useEffect(() => {
    if (!enabled || !userId) {
      debugLog('[SELF_LEAVE] recovery skipped', {
        reason: !userId ? 'no_user' : skipReason || 'disabled',
      });
      return undefined;
    }

    let cancelled = false;
    let scanPromise: Promise<void> | null = null;
    const retryTimers = new Map<string, number>();
    const inFlightOperationIds = new Set<string>();

    const clearRetryTimer = (operationId: string) => {
      const timer = retryTimers.get(operationId);
      if (timer != null) {
        window.clearTimeout(timer);
        retryTimers.delete(operationId);
      }
    };

    const processRotation = async (
      value: unknown,
      source: string,
      scheduledAttempt = 0,
    ): Promise<void> => {
      const rotation = normalizeRotation(value);
      if (cancelled) {
        debugLog('[SELF_LEAVE] recovery skipped', { reason: 'cancelled' });
        return;
      }
      if (!rotation) {
        debugLog('[SELF_LEAVE] recovery skipped', { reason: 'invalid_rotation' });
        return;
      }
      if (rotation.target_user_id === userId) {
        debugLog('[SELF_LEAVE] recovery skipped', {
          reason: 'leaver_target',
          operation_id: rotation.operation_id,
          conversation_id: rotation.conversation_id,
        });
        return;
      }
      if (inFlightOperationIds.has(rotation.operation_id)) {
        debugLog('[SELF_LEAVE] recovery skipped', {
          reason: 'already_in_flight',
          operation_id: rotation.operation_id,
          conversation_id: rotation.conversation_id,
        });
        return;
      }

      clearRetryTimer(rotation.operation_id);
      inFlightOperationIds.add(rotation.operation_id);
      debugLog('[SELF_LEAVE] finalization started', {
        source,
        operation_id: rotation.operation_id,
        conversation_id: rotation.conversation_id,
      });
      if (rotation.survivor_role === 'member') {
        debugLog('[SELF_LEAVE] member-role survivor starts finalization', {
          operation_id: rotation.operation_id,
          conversation_id: rotation.conversation_id,
        });
      }

      try {
        const result = await finalizeSelfLeaveRotation(rotation, userId);
        debugLog('[SELF_LEAVE] finalization succeeded', {
          source,
          operation_id: rotation.operation_id,
          conversation_id: rotation.conversation_id,
          key_version: result.key_version,
          already_finalized: result.already_finalized,
        });
        if (rotation.survivor_role === 'member') {
          debugLog('[SELF_LEAVE] member-role survivor finalized successfully', {
            operation_id: rotation.operation_id,
            conversation_id: rotation.conversation_id,
            key_version: result.key_version,
          });
        }
      } catch (error) {
        const errorPayload = error && typeof error === 'object'
          ? error as Record<string, unknown>
          : {};
        const errorCode = typeof errorPayload.code === 'string'
          ? errorPayload.code
          : 'TRANSIENT_ERROR';

        debugLog('[SELF_LEAVE] finalization deferred', {
          source,
          operation_id: rotation.operation_id,
          conversation_id: rotation.conversation_id,
          code: errorCode,
        });

        if (
          cancelled ||
          TERMINAL_ERROR_CODES.has(errorCode) ||
          scheduledAttempt >= MAX_SCHEDULED_RETRIES
        ) {
          debugLog('[SELF_LEAVE] recovery skipped', {
            reason: cancelled
              ? 'cancelled'
              : TERMINAL_ERROR_CODES.has(errorCode)
                ? 'terminal_error'
                : 'retry_limit_reached',
            code: errorCode,
            operation_id: rotation.operation_id,
            conversation_id: rotation.conversation_id,
          });
          return;
        }

        const retryDelayMs = errorCode === 'SELF_LEAVE_CLAIM_HELD'
          ? (Math.max(1, Number(errorPayload.retry_after_seconds) || 2) * 1000) + 250
          : TRANSIENT_RETRY_DELAY_MS;
        const timer = window.setTimeout(() => {
          retryTimers.delete(rotation.operation_id);
          if (!cancelled) {
            void processRotation(rotation, 'scheduled_retry', scheduledAttempt + 1);
          }
        }, retryDelayMs);
        retryTimers.set(rotation.operation_id, timer);
      } finally {
        inFlightOperationIds.delete(rotation.operation_id);
      }
    };

    const recoverPendingRotations = (source: string): Promise<void> => {
      if (scanPromise) return scanPromise;

      debugLog('[SELF_LEAVE] recovery scan started', { source });
      const request = getPendingSelfLeaveRotations()
        .then((rotations) => {
          if (cancelled) return;
          debugLog('[SELF_LEAVE] pending rotations found', {
            source,
            count: rotations.length,
          });
          rotations.forEach((rotation) => {
            void processRotation(rotation, source);
          });
        })
        .catch((error) => {
          if (!cancelled) {
            console.warn('[SELF_LEAVE] pending rotation recovery failed', {
              source,
              error: error instanceof Error ? error.message : String(error || ''),
            });
          }
        })
        .finally(() => {
          if (scanPromise === request) scanPromise = null;
        });
      scanPromise = request;
      return request;
    };

    const handleRotationRequired = (value: unknown) => {
      void processRotation(value, 'gateway_event');
    };
    const handleGatewayReady = () => {
      void recoverPendingRotations('gateway_ready');
    };
    const handleGatewayResumed = () => {
      void recoverPendingRotations('gateway_resumed');
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void recoverPendingRotations('document_visible');
      }
    };
    const handleFocus = () => {
      void recoverPendingRotations('window_focus');
    };
    const handleOnline = () => {
      void recoverPendingRotations('browser_online');
    };
    const handleConversationUpdate = (value: unknown) => {
      const payload = value && typeof value === 'object'
        ? value as Record<string, unknown>
        : {};
      const conversation = payload.conversation && typeof payload.conversation === 'object'
        ? payload.conversation as Record<string, unknown>
        : {};
      if (conversation.type === 'group') {
        void recoverPendingRotations('group_conversation_update');
      }
    };
    const handleRecoveryRequested = (event: Event) => {
      void recoverPendingRotations(getRecoveryRequestSource(event));
    };

    gateway.on('SELF_LEAVE_ROTATION_REQUIRED', handleRotationRequired);
    gateway.on('READY', handleGatewayReady);
    gateway.on('RESUMED', handleGatewayResumed);
    gateway.on('CONVERSATION_UPDATE', handleConversationUpdate);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', handleOnline);
    window.addEventListener(SELF_LEAVE_RECOVERY_REQUESTED_EVENT, handleRecoveryRequested);
    void recoverPendingRotations('initial_load');

    return () => {
      cancelled = true;
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      retryTimers.clear();
      inFlightOperationIds.clear();
      gateway.off('SELF_LEAVE_ROTATION_REQUIRED', handleRotationRequired);
      gateway.off('READY', handleGatewayReady);
      gateway.off('RESUMED', handleGatewayResumed);
      gateway.off('CONVERSATION_UPDATE', handleConversationUpdate);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener(SELF_LEAVE_RECOVERY_REQUESTED_EVENT, handleRecoveryRequested);
    };
  }, [enabled, skipReason, userId]);
}
