import { Lock, UserRound, X } from 'lucide-react';
import type {
  Conversation,
  ConversationMember,
} from '../../Services/Chat/chatService';

interface DirectConversationSettingsProps {
  conversation: Conversation;
  currentUserId: string;
  members: ConversationMember[];
  onClose: () => void;
}

const dmModeMeta = {
  label: 'MLS',
  description: 'MLS mode is enforced for DMs.',
};

const dmModeBadgeClassName = 'bg-amber-500/15 text-amber-300 ring-amber-500/30';

export default function DirectConversationSettings({
  conversation,
  currentUserId,
  members,
  onClose,
}: DirectConversationSettingsProps) {
  const dmPeerUserId =
    conversation.dm_user_id ||
    members.find((member) => member.user_id !== currentUserId)?.user_id ||
    null;

  return (
    <div className="fixed inset-0 z-[320] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-void-bg-hover bg-void-bg-sec shadow-2xl">
        <div className="flex items-center justify-between border-b border-void-bg-hover px-5 py-4">
          <h2 className="font-semibold text-void-text">Conversation Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="flex items-center gap-3 rounded-xl bg-void-bg-main p-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-void-accent/20 text-void-accent">
              <UserRound className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-semibold text-void-text">
                {conversation.dm_display_name || conversation.dm_username || 'Direct Message'}
              </p>
              <p className="text-xs text-void-text-muted">Direct Message</p>
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-void-bg-hover bg-void-bg-main/60 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-void-text">Encryption Mode</p>
                <p className="mt-1 text-xs text-void-text-muted">{dmModeMeta.description}</p>
              </div>
              <span
                className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${dmModeBadgeClassName}`}
              >
                {dmModeMeta.label}
              </span>
            </div>

            <div className="rounded-lg border border-void-bg-hover bg-void-bg-sec px-3 py-2 text-sm text-void-text">
              Message Security: MLS
            </div>

            {!dmPeerUserId && (
              <p className="text-xs text-rose-300">
                Unable to resolve DM peer identity for this thread.
              </p>
            )}
          </div>

          <div className="flex items-start gap-3 rounded-xl border border-void-bg-hover bg-void-bg-main/40 p-4">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-void-accent/10 text-void-accent">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-void-text">Encrypted by Default</h3>
              <p className="mt-1 text-sm leading-relaxed text-void-text-muted">
                Direct messages use the same MLS transport path as the rest of the app, so there
                is nothing extra to configure here.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
