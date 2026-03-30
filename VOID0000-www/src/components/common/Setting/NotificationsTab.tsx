import { useEffect, useState } from 'react';
import { BellRing, Volume2, Check, Info } from 'lucide-react';
import {
  primeIncomingMessageSound,
  testIncomingMessageSound,
} from '../../../Services/Chat/messageNotificationSound';

const NotificationsTab = () => {
  const [isTesting, setIsTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'success'>('idle');

  useEffect(() => {
    primeIncomingMessageSound();
  }, []);

  const handleTestSound = async () => {
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

  return (
    <div className="space-y-8 pb-24">
      <div>
        <h2 className="text-lg font-bold text-void-text mb-4">Notifications</h2>
        <p className="text-sm text-void-text-muted mb-6">
          Control message alert behavior and make sure incoming chat sounds are working on this device.
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
                  <Volume2 className="h-4 w-4 text-void-accent" />
                  Notification Sound
                </div>
                <p className="mt-1 text-xs text-void-text-muted">
                  Use the test button once so your browser can allow message sounds on this page.
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  void handleTestSound();
                }}
                disabled={isTesting}
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
