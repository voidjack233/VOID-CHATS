import { useEffect, useState } from 'react';
import { BellRing, Volume2, Check, Info, Send } from 'lucide-react';
import {
  primeIncomingMessageSound,
  testIncomingMessageSound,
} from '../../../Services/Chat/messageNotificationSound';
import { useTheme } from '../../../Services/hooks/Settings/useTheme';
import {
  getBrowserPushStatus,
  sendBrowserPushTest,
  subscribeToBrowserPush,
  unsubscribeFromBrowserPush,
  type BrowserPushStatus,
} from '../../../Services/Notifications/pushNotificationService';

const NotificationsTab = () => {
  const { messageNotificationsEnabled, setMessageNotificationsEnabled } = useTheme();
  const [isTesting, setIsTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'success'>('idle');
  const [pushStatus, setPushStatus] = useState<BrowserPushStatus | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushTestStatus, setPushTestStatus] = useState<'idle' | 'success'>('idle');
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushErrorDetail, setPushErrorDetail] = useState<string | null>(null);

  useEffect(() => {
    primeIncomingMessageSound();
  }, []);

  useEffect(() => {
    let cancelled = false;

    getBrowserPushStatus()
      .then((status) => {
        if (!cancelled) {
          setPushStatus(status);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPushError(error instanceof Error ? error.message : 'Could not check browser push status.');
          setPushErrorDetail(error instanceof Error && 'detail' in error ? String(error.detail) : null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleNotifications = async () => {
    const nextEnabled = !messageNotificationsEnabled;
    await setMessageNotificationsEnabled(nextEnabled);

    if (!nextEnabled) {
      setTestStatus('idle');
    }
  };

  const handleTestSound = async () => {
    if (!messageNotificationsEnabled) return;
    setIsTesting(true);
    setTestStatus('idle');

    try {
      primeIncomingMessageSound();
      const played = await testIncomingMessageSound();
      setTestStatus(played ? 'success' : 'idle');
    } finally {
      setIsTesting(false);
    }
  };

  const refreshPushStatus = async () => {
    const nextStatus = await getBrowserPushStatus();
    setPushStatus(nextStatus);
    return nextStatus;
  };

  const handleTogglePush = async () => {
    setPushBusy(true);
    setPushError(null);
    setPushErrorDetail(null);
    setPushTestStatus('idle');

    try {
      if (pushStatus?.subscribed) {
        await unsubscribeFromBrowserPush();
      } else {
        await subscribeToBrowserPush();
      }
      await refreshPushStatus();
    } catch (error) {
      setPushError(error instanceof Error ? error.message : 'Browser push setup failed.');
      setPushErrorDetail(error instanceof Error && 'detail' in error ? String(error.detail) : null);
      await refreshPushStatus().catch(() => undefined);
    } finally {
      setPushBusy(false);
    }
  };

  const handleTestPush = async () => {
    if (!pushStatus?.subscribed) return;
    setPushBusy(true);
    setPushError(null);
    setPushErrorDetail(null);
    setPushTestStatus('idle');

    try {
      await sendBrowserPushTest();
      setPushTestStatus('success');
    } catch (error) {
      setPushError(error instanceof Error ? error.message : 'Could not send test push.');
      setPushErrorDetail(error instanceof Error && 'detail' in error ? String(error.detail) : null);
    } finally {
      setPushBusy(false);
    }
  };

  const pushStatusLabel = !pushStatus
    ? 'Checking'
    : pushStatus.subscribed
      ? 'ON'
      : pushStatus.permission === 'denied'
        ? 'BLOCKED'
        : 'OFF';

  return (
    <div className="space-y-8 pb-24">
      <div>
        <h2 className="text-lg font-bold text-void-text mb-4">Notifications</h2>
        <p className="text-sm text-void-text-muted mb-6">
          Control message alert behavior in this browser and make sure incoming chat sounds are working here.
        </p>
      </div>

      <div className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-5">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-void-accent/12 text-void-accent">
            <BellRing className="h-5 w-5" />
          </div>

          <div className="min-w-0 flex-1 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-void-text">Message Received</h3>
              <p className="mt-1 text-sm text-void-text-muted">
                Plays when another person sends you a new message.
              </p>
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-void-bg-hover bg-void-bg-sec/80 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-void-text">
                  <BellRing className="h-4 w-4 text-void-accent" />
                  Message Sound
                </div>
                <p className="mt-1 text-xs text-void-text-muted">
                  Turn incoming message sound alerts on or off on this device.
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <span
                  className={`text-xs font-semibold uppercase tracking-[0.18em] ${
                    messageNotificationsEnabled ? 'text-void-accent' : 'text-void-text-muted'
                  }`}
                >
                  {messageNotificationsEnabled ? 'ON' : 'OFF'}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={messageNotificationsEnabled}
                  aria-label="Toggle message notifications"
                  onClick={() => {
                    void handleToggleNotifications();
                  }}
                  className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-transparent transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-void-accent/40 focus:ring-offset-2 focus:ring-offset-void-bg-sec ${
                    messageNotificationsEnabled
                      ? 'bg-void-accent shadow-[0_0_0_4px_rgba(99,102,241,0.12)]'
                      : 'bg-void-bg-hover'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
                      messageNotificationsEnabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-void-bg-hover bg-void-bg-sec/80 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-void-text">
                  <Volume2 className="h-4 w-4 text-void-accent" />
                  Notification Sound
                </div>
                <p className="mt-1 text-xs text-void-text-muted">
                  {messageNotificationsEnabled
                    ? 'Use the test button once so your browser can allow message sounds on this page.'
                    : 'Turn message notifications on first if you want incoming sounds to play.'}
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  void handleTestSound();
                }}
                disabled={isTesting || !messageNotificationsEnabled}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-void-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-void-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {testStatus === 'success' && !isTesting ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
                {isTesting ? 'Testing...' : testStatus === 'success' ? 'Played' : 'Test Sound'}
              </button>
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-void-bg-hover bg-void-bg-sec/80 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium text-void-text">
                    <BellRing className="h-4 w-4 text-void-accent" />
                    Browser Push
                  </div>
                  <p className="mt-1 text-xs text-void-text-muted">
                    Sends E2EE-safe alerts when this browser is closed or in the background. Message text is never included.
                  </p>
                  {pushStatus?.reason && (
                    <p className="mt-2 text-xs text-void-text-muted">{pushStatus.reason}</p>
                  )}
                  {pushError && (
                    <p className="mt-2 text-xs font-medium text-red-300">{pushError}</p>
                  )}
                  {pushErrorDetail && (
                    <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-red-400/20 bg-red-950/20 p-2 text-[11px] leading-relaxed text-red-100/80">
                      {pushErrorDetail}
                    </pre>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <span
                    className={`text-xs font-semibold uppercase tracking-[0.18em] ${
                      pushStatus?.subscribed ? 'text-void-accent' : 'text-void-text-muted'
                    }`}
                  >
                    {pushStatusLabel}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(pushStatus?.subscribed)}
                    aria-label="Toggle browser push notifications"
                    onClick={() => {
                      void handleTogglePush();
                    }}
                    disabled={pushBusy || !pushStatus?.supported || !pushStatus?.configured || pushStatus.permission === 'denied'}
                    className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-transparent transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-void-accent/40 focus:ring-offset-2 focus:ring-offset-void-bg-sec disabled:cursor-not-allowed disabled:opacity-60 ${
                      pushStatus?.subscribed
                        ? 'bg-void-accent shadow-[0_0_0_4px_rgba(99,102,241,0.12)]'
                        : 'bg-void-bg-hover'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
                        pushStatus?.subscribed ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  void handleTestPush();
                }}
                disabled={pushBusy || !pushStatus?.subscribed}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-void-bg-hover bg-void-bg-main/60 px-4 py-2.5 text-sm font-semibold text-void-text transition-colors hover:bg-void-bg-hover disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:self-end"
              >
                {pushTestStatus === 'success' && !pushBusy ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {pushBusy ? 'Working...' : pushTestStatus === 'success' ? 'Push Sent' : 'Test Push'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-void-bg-hover bg-void-bg-main/35 p-4">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-void-text-muted" />
          <p className="text-sm text-void-text-muted">
            Browsers usually block sound until you interact with the page at least once. Testing the sound here is the safest way to make sure incoming message audio can play afterward.
          </p>
        </div>
      </div>
    </div>
  );
};

export default NotificationsTab;
