import { useEffect, useState } from 'react';
import { BellRing, Check, X } from 'lucide-react';
import {
  dismissBrowserPushSoftPrompt,
  getBrowserPushStatus,
  permanentlyDismissBrowserPushSoftPrompt,
  shouldShowBrowserPushSoftPrompt,
  subscribeToBrowserPush,
  type BrowserPushStatus,
} from '../../../Services/Notifications/pushNotificationService';

const PushNotificationPrompt = () => {
  const [status, setStatus] = useState<BrowserPushStatus | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = async () => {
    const nextStatus = await getBrowserPushStatus();
    setStatus(nextStatus);
    setVisible(shouldShowBrowserPushSoftPrompt(nextStatus));
    return nextStatus;
  };

  useEffect(() => {
    let cancelled = false;

    getBrowserPushStatus()
      .then((nextStatus) => {
        if (cancelled) return;
        setStatus(nextStatus);
        setVisible(shouldShowBrowserPushSoftPrompt(nextStatus));
      })
      .catch(() => {
        if (!cancelled) {
          setVisible(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleDismiss = () => {
    dismissBrowserPushSoftPrompt();
    setVisible(false);
  };

  const handleEnable = async () => {
    setBusy(true);
    setError(null);

    try {
      await subscribeToBrowserPush();
      await refreshStatus();
      setVisible(false);
    } catch (err) {
      const permission = typeof Notification !== 'undefined' ? Notification.permission : 'default';

      if (permission === 'denied' || permission === 'default') {
        permanentlyDismissBrowserPushSoftPrompt();
        setVisible(false);
      } else {
        setError(err instanceof Error ? err.message : 'Could not enable browser push.');
        await refreshStatus().catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  };

  if (!visible || !status) {
    return null;
  }

  return (
    <div className="mx-3 mb-2 mt-2 rounded-2xl border border-void-accent/25 bg-void-bg-sec/85 p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-void-accent/12 text-void-accent">
          <BellRing className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-void-text">Turn on notifications?</p>
              <p className="mt-1 text-xs leading-relaxed text-void-text-muted">
                Get alerts for DMs and mentions. Message contents stay hidden.
              </p>
            </div>
            <button
              type="button"
              onClick={handleDismiss}
              className="shrink-0 rounded-lg p-1 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
              aria-label="Dismiss notification prompt"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {error && (
            <p className="mt-2 text-xs font-medium text-red-300">{error}</p>
          )}

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => {
                void handleEnable();
              }}
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-void-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-void-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Check className="h-3.5 w-3.5" />
              {busy ? 'Opening...' : 'Enable'}
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              disabled={busy}
              className="inline-flex items-center justify-center rounded-xl border border-void-bg-hover bg-void-bg-main/60 px-3 py-2 text-xs font-semibold text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text disabled:cursor-not-allowed disabled:opacity-60"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PushNotificationPrompt;
