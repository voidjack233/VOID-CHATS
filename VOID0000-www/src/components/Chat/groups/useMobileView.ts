import { useEffect, useState } from 'react';

export function useMobileView(resetKey?: string | number) {
  const [mobileView, setMobileView] = useState<'menu' | 'detail'>(() =>
    window.innerWidth >= 768 ? 'detail' : 'menu'
  );

  useEffect(() => {
    const syncMobileView = () => {
      setMobileView(window.innerWidth >= 768 ? 'detail' : 'menu');
    };

    syncMobileView();
    window.addEventListener('resize', syncMobileView);

    return () => {
      window.removeEventListener('resize', syncMobileView);
    };
  }, []);

  useEffect(() => {
    if (resetKey === undefined) return;
    setMobileView(window.innerWidth >= 768 ? 'detail' : 'menu');
  }, [resetKey]);

  return { mobileView, setMobileView };
}
