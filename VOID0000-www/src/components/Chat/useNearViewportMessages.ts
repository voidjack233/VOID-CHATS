import { useLayoutEffect, useState } from 'react';

const ATTACHMENT_LOAD_ROOT_MARGIN = '320px 0px';

const getMessageElements = (node: Node): HTMLElement[] => {
  if (!(node instanceof Element)) {
    return [];
  }

  const elements: HTMLElement[] = [];
  if (node instanceof HTMLElement && node.matches('[data-message-id]')) {
    elements.push(node);
  }
  elements.push(...node.querySelectorAll<HTMLElement>('[data-message-id]'));
  return elements;
};

export function useNearViewportMessages(
  scroller: HTMLDivElement | null,
  resetKey: string,
): ReadonlySet<string> {
  const [nearViewportIds, setNearViewportIds] = useState<Set<string>>(() => new Set());

  useLayoutEffect(() => {
    setNearViewportIds(new Set());
    if (!scroller) {
      return undefined;
    }

    const observedElements = new Map<HTMLElement, string>();
    const updateIds = (updates: Array<{ messageId: string; isNear: boolean }>) => {
      setNearViewportIds((current) => {
        const next = new Set(current);
        let changed = false;

        updates.forEach(({ messageId, isNear }) => {
          if (isNear && !next.has(messageId)) {
            next.add(messageId);
            changed = true;
          } else if (!isNear && next.delete(messageId)) {
            changed = true;
          }
        });

        return changed ? next : current;
      });
    };

    const intersectionObserver = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            updateIds(entries.flatMap((entry) => {
              const messageId = observedElements.get(entry.target as HTMLElement);
              return messageId
                ? [{ messageId, isNear: entry.isIntersecting }]
                : [];
            }));
          },
          {
            root: scroller,
            rootMargin: ATTACHMENT_LOAD_ROOT_MARGIN,
            threshold: 0,
          },
        );

    const observeElement = (element: HTMLElement) => {
      const messageId = element.dataset.messageId;
      if (!messageId || observedElements.has(element)) {
        return;
      }

      observedElements.set(element, messageId);
      if (intersectionObserver) {
        intersectionObserver.observe(element);
      } else {
        updateIds([{ messageId, isNear: true }]);
      }
    };

    const unobserveElement = (element: HTMLElement) => {
      const messageId = observedElements.get(element);
      if (!messageId) {
        return;
      }

      intersectionObserver?.unobserve(element);
      observedElements.delete(element);
      updateIds([{ messageId, isNear: false }]);
    };

    getMessageElements(scroller).forEach(observeElement);

    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            mutation.removedNodes.forEach((node) => {
              getMessageElements(node).forEach(unobserveElement);
            });
            mutation.addedNodes.forEach((node) => {
              getMessageElements(node).forEach(observeElement);
            });
          });
        });

    mutationObserver?.observe(scroller, { childList: true, subtree: true });

    return () => {
      mutationObserver?.disconnect();
      intersectionObserver?.disconnect();
      observedElements.clear();
    };
  }, [resetKey, scroller]);

  return nearViewportIds;
}
