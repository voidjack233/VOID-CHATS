export const SELF_LEAVE_RECOVERY_REQUESTED_EVENT = 'void:self-leave-recovery-requested';

export function requestSelfLeaveRecoveryScan(source: string): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent(SELF_LEAVE_RECOVERY_REQUESTED_EVENT, {
    detail: { source },
  }));
}
