import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Clock3, Hash, Settings2, Shield, Trash2, X } from 'lucide-react';
import {
  Conversation,
  deleteConversation,
  updateConversation,
} from '../../../Services/Chat/chatService';
import { useScrollLock } from '../../../Services/hooks/common/useScrollLock';

type ChannelSettingsTab = 'overview' | 'permissions' | 'delete';

interface ChannelSettingsModalProps {
  channel: Conversation;
  onClose: () => void;
  onSaved: (channel: Conversation) => Promise<void> | void;
  onDeleted: (channel: Conversation) => Promise<void> | void;
}

const SLOWMODE_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];

const formatSlowmodeLabel = (seconds: number) => {
  if (seconds === 0) return 'Off';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${seconds / 60}m`;
  return `${seconds / 3600}h`;
};

export default function ChannelSettingsModal({
  channel,
  onClose,
  onSaved,
  onDeleted,
}: ChannelSettingsModalProps) {
  useScrollLock();

  const [activeTab, setActiveTab] = useState<ChannelSettingsTab>('overview');
  const [name, setName] = useState(channel.name || '');
  const [topic, setTopic] = useState(channel.topic || '');
  const [slowmodeSeconds, setSlowmodeSeconds] = useState(channel.slowmode_seconds || 0);
  const [isAgeRestricted, setIsAgeRestricted] = useState(!!channel.is_age_restricted);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setActiveTab('overview');
    setName(channel.name || '');
    setTopic(channel.topic || '');
    setSlowmodeSeconds(channel.slowmode_seconds || 0);
    setIsAgeRestricted(!!channel.is_age_restricted);
    setError('');
  }, [channel.id, channel.name, channel.topic, channel.slowmode_seconds, channel.is_age_restricted]);

  const slowmodeIndex = useMemo(() => {
    const index = SLOWMODE_OPTIONS.indexOf(slowmodeSeconds || 0);
    return index >= 0 ? index : 0;
  }, [slowmodeSeconds]);

  const normalizedName = useMemo(
    () => name.trim().toLowerCase().replace(/\s+/g, '-'),
    [name]
  );

  const trimmedTopic = topic.trim();
  const isDirty =
    normalizedName !== (channel.name || '') ||
    trimmedTopic !== (channel.topic || '') ||
    (slowmodeSeconds || 0) !== (channel.slowmode_seconds || 0) ||
    isAgeRestricted !== !!channel.is_age_restricted;

  const handleSave = async () => {
    if (!normalizedName) {
      setError('Channel name is required.');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const { conversation } = await updateConversation(channel.public_id || channel.id, {
        name: normalizedName,
        topic: trimmedTopic || null,
        slowmode_seconds: slowmodeSeconds,
        is_age_restricted: isAgeRestricted,
      });
      await onSaved(conversation);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to update channel');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const channelName = channel.name || 'this channel';
    if (!window.confirm(`Delete #${channelName}? This cannot be undone.`)) {
      return;
    }

    setDeleting(true);
    setError('');

    try {
      await deleteConversation(channel.public_id || channel.id);
      await onDeleted(channel);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to delete channel');
    } finally {
      setDeleting(false);
    }
  };

  const tabs = [
    { id: 'overview' as ChannelSettingsTab, label: 'Overview', icon: <Settings2 className="h-4 w-4" /> },
    { id: 'permissions' as ChannelSettingsTab, label: 'Permissions', icon: <Shield className="h-4 w-4" /> },
    { id: 'delete' as ChannelSettingsTab, label: 'Delete Channel', icon: <Trash2 className="h-4 w-4" /> },
  ];

  return (
    <div className="fixed inset-0 z-[320] bg-black/55 backdrop-blur-sm">
      <div className="flex h-full items-center justify-center p-4">
        <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-void-bg-hover bg-void-bg-sec shadow-2xl md:h-[640px] md:flex-row">
          <div className="hidden w-64 flex-shrink-0 border-r border-void-bg-hover bg-void-bg-main/50 md:flex md:flex-col">
            <div className="border-b border-void-bg-hover px-6 py-5">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-void-text-muted">Channel Settings</p>
              <div className="mt-3 flex items-center gap-2 text-void-text">
                <Hash className="h-4 w-4 text-void-text-muted" />
                <span className="truncate font-semibold">{channel.name || 'channel'}</span>
              </div>
            </div>

            <nav className="flex-1 space-y-1 p-4">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? tab.id === 'delete'
                        ? 'bg-red-500/15 text-red-400'
                        : 'bg-void-accent text-white'
                      : tab.id === 'delete'
                        ? 'text-red-400 hover:bg-red-500/10'
                        : 'text-void-text-muted hover:bg-void-bg-hover hover:text-void-text'
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-void-bg-hover bg-void-bg-sec px-5 py-4 md:px-6">
              <div>
                <h2 className="text-lg font-semibold text-void-text">
                  {tabs.find((tab) => tab.id === activeTab)?.label}
                </h2>
                <p className="text-sm text-void-text-muted">Manage #{channel.name || 'channel'}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-void-bg-main/80 p-2 text-void-text-muted transition-colors hover:bg-void-bg-main hover:text-void-text"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 md:p-6">
              <div className="mb-4 flex gap-2 overflow-x-auto md:hidden">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                      activeTab === tab.id
                        ? tab.id === 'delete'
                          ? 'bg-red-500/15 text-red-400'
                          : 'bg-void-accent text-white'
                        : tab.id === 'delete'
                          ? 'text-red-400 ring-1 ring-red-500/20'
                          : 'bg-void-bg-main text-void-text-muted'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {activeTab === 'overview' && (
                <div className="space-y-6">
                  <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-5">
                    <div className="mb-4">
                      <h3 className="text-sm font-semibold text-void-text">Overview</h3>
                      <p className="mt-1 text-sm text-void-text-muted">
                        Adjust how this text channel appears and behaves.
                      </p>
                    </div>

                    <div className="space-y-5">
                      <div>
                        <label className="mb-2 block text-sm font-medium text-void-text-muted">Channel Name</label>
                        <input
                          type="text"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          maxLength={100}
                          className="w-full rounded-xl border border-void-bg-hover bg-void-bg-hover px-4 py-3 text-sm text-void-text outline-none transition-colors focus:border-void-accent"
                          placeholder="general"
                        />
                        <p className="mt-2 text-xs text-void-text-muted">
                          Spaces will be converted to dashes to keep channel names consistent.
                        </p>
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-medium text-void-text-muted">Channel Topic</label>
                        <textarea
                          value={topic}
                          onChange={(event) => setTopic(event.target.value)}
                          maxLength={1024}
                          rows={4}
                          className="w-full resize-none rounded-xl border border-void-bg-hover bg-void-bg-hover px-4 py-3 text-sm text-void-text outline-none transition-colors focus:border-void-accent"
                          placeholder="Tell people what this channel is for."
                        />
                        <div className="mt-2 flex items-center justify-between text-xs text-void-text-muted">
                          <span>This appears in the channel settings only for now.</span>
                          <span>{topic.length}/1024</span>
                        </div>
                      </div>

                      <div>
                        <div className="mb-2 flex items-center justify-between gap-4">
                          <div>
                            <label className="block text-sm font-medium text-void-text-muted">Slowmode</label>
                            <p className="mt-1 text-xs text-void-text-muted">
                              Limit how often members can send a message in this channel.
                            </p>
                          </div>
                          <div className="inline-flex items-center gap-2 rounded-full bg-void-bg-hover px-3 py-1 text-sm font-semibold text-void-text">
                            <Clock3 className="h-4 w-4 text-void-text-muted" />
                            <span>{formatSlowmodeLabel(slowmodeSeconds)}</span>
                          </div>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={SLOWMODE_OPTIONS.length - 1}
                          step={1}
                          value={slowmodeIndex}
                          onChange={(event) => {
                            setSlowmodeSeconds(SLOWMODE_OPTIONS[Number(event.target.value)] || 0);
                          }}
                          className="h-2 w-full cursor-pointer appearance-none rounded-full bg-void-bg-hover accent-void-accent"
                        />
                        <div className="mt-3 flex flex-wrap gap-2">
                          {SLOWMODE_OPTIONS.map((seconds) => (
                            <button
                              key={seconds}
                              type="button"
                              onClick={() => setSlowmodeSeconds(seconds)}
                              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                                slowmodeSeconds === seconds
                                  ? 'bg-void-accent text-white'
                                  : 'bg-void-bg-hover text-void-text-muted hover:text-void-text'
                              }`}
                            >
                              {formatSlowmodeLabel(seconds)}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-xl border border-void-bg-hover bg-void-bg-sec p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <h4 className="text-sm font-semibold text-void-text">Age-Restricted Channel</h4>
                            <p className="mt-1 text-sm text-void-text-muted">
                              Mark this channel as 18+ so it can be treated as sensitive content.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setIsAgeRestricted((prev) => !prev)}
                            className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition-colors ${
                              isAgeRestricted ? 'bg-red-500' : 'bg-void-bg-hover'
                            }`}
                            aria-pressed={isAgeRestricted}
                          >
                            <span
                              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                                isAgeRestricted ? 'translate-x-6' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              )}

              {activeTab === 'permissions' && (
                <section className="rounded-2xl border border-void-bg-hover bg-void-bg-main/40 p-5">
                  <div className="mb-4 flex items-center gap-3">
                    <Shield className="h-5 w-5 text-void-accent" />
                    <div>
                      <h3 className="text-sm font-semibold text-void-text">Permissions</h3>
                      <p className="mt-1 text-sm text-void-text-muted">
                        Channel-specific permissions are not wired yet.
                      </p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-dashed border-void-bg-hover bg-void-bg-sec p-4 text-sm text-void-text-muted">
                    This tab is reserved for the next phase. The owner-only entry point is in place now, but the actual role overrides still need backend support.
                  </div>
                </section>
              )}

              {activeTab === 'delete' && (
                <section className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400" />
                    <div>
                      <h3 className="text-sm font-semibold text-red-400">Delete Channel</h3>
                      <p className="mt-1 text-sm text-void-text-muted">
                        Deleting <span className="font-semibold text-void-text">#{channel.name || 'channel'}</span> removes it for everyone in the group.
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 rounded-xl border border-red-500/20 bg-void-bg-sec p-4">
                    <p className="text-sm text-void-text-muted">
                      This action is permanent. Messages in this channel will no longer be accessible once it is deleted.
                    </p>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="mt-4 inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" />
                      <span>{deleting ? 'Deleting...' : 'Delete Channel'}</span>
                    </button>
                  </div>
                </section>
              )}

              {error && (
                <p className="mt-4 text-sm text-red-400">{error}</p>
              )}
            </div>

            {activeTab === 'overview' && (
              <div className="border-t border-void-bg-hover bg-void-bg-sec px-5 py-4 md:px-6">
                <div className="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm font-medium text-void-text-muted transition-colors hover:text-void-text"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !isDirty}
                    className="rounded-lg bg-void-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-void-accent-hover disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
