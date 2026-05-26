import { ShieldAlert } from 'lucide-react';

interface ConversationSecurityState {
  detail?: string | null;
  status?: string | null;
  reason?: string | null;
}

interface ConversationSecurityBannerProps {
  message: string;
  securityState?: ConversationSecurityState | null;
}

function getEncryptionHint(error: string, securityState?: ConversationSecurityState | null) {
  if (securityState?.detail) {
    return securityState.detail;
  }

  if (error.includes('Preparing secure chat keys') || error.includes('Secure chat keys are not ready')) {
    return 'Account secure keys are being prepared automatically. Retry in a moment if this takes longer than expected.';
  }

  if (error.includes('secure recipient details')) {
    return 'This DM is still loading the recipient identity needed for secure bootstrap. Open the conversation again once it finishes loading.';
  }

  if (error.includes('private keys') || error.includes('not available')) {
    return 'Restore your account secure state with your password or recovery key to read encrypted messages.';
  }

  if (error.includes('distribution')) {
    return 'This account does not have a usable group key yet. Ask the group owner to resend key distribution for your account.';
  }

  if (error.includes('preparing secure chat')) {
    return 'Secure chat is still preparing for this conversation. Retry in a moment.';
  }

  return 'Secure chat is not ready for this conversation yet. Retry in a moment.';
}

function getSecurityBannerClasses(securityState?: ConversationSecurityState | null) {
  if (securityState?.status === 'recovering') {
    return {
      container: 'border-blue-400/25 bg-blue-500/10',
      icon: 'text-blue-300',
    };
  }

  if (
    securityState?.reason === 'conversation_state_missing' ||
    securityState?.reason === 'account_restore_required'
  ) {
    return {
      container: 'border-red-400/25 bg-red-500/10',
      icon: 'text-red-300',
    };
  }

  return {
    container: 'border-orange-400/25 bg-orange-500/10',
    icon: 'text-orange-300',
  };
}

export default function ConversationSecurityBanner({
  message,
  securityState,
}: ConversationSecurityBannerProps) {
  const classes = getSecurityBannerClasses(securityState);

  return (
    <div className={`mx-4 mt-4 rounded-2xl border px-4 py-3 ${classes.container}`}>
      <div className="flex items-start gap-3">
        <ShieldAlert className={`mt-0.5 h-5 w-5 shrink-0 ${classes.icon}`} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-void-text">{message}</p>
          <p className="mt-1 text-xs text-void-text-muted">
            {getEncryptionHint(message, securityState)}
          </p>
        </div>
      </div>
    </div>
  );
}
