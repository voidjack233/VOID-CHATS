export const MESSAGE_NEAR_BOTTOM_THRESHOLD_PX = 120;

export function isNearMessageBottom(
  container: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  thresholdPx = MESSAGE_NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= thresholdPx;
}
