import { useEffect, useState } from 'react';

const MOBILE_KEYBOARD_HEIGHT_THRESHOLD = 120;

export function useMobileKeyboardOpen() {
  const [isMobileKeyboardOpen, setIsMobileKeyboardOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      return;
    }

    const viewport = window.visualViewport;
    const updateKeyboardState = () => {
      const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
      const hiddenViewportHeight = window.innerHeight - viewport.height - viewport.offsetTop;
      setIsMobileKeyboardOpen(coarsePointer && hiddenViewportHeight > MOBILE_KEYBOARD_HEIGHT_THRESHOLD);
    };

    updateKeyboardState();
    viewport.addEventListener('resize', updateKeyboardState);
    viewport.addEventListener('scroll', updateKeyboardState);

    return () => {
      viewport.removeEventListener('resize', updateKeyboardState);
      viewport.removeEventListener('scroll', updateKeyboardState);
    };
  }, []);

  return isMobileKeyboardOpen;
}
