import { useEffect } from 'react';
import {
  X,
  ShieldCheck,
  ShieldAlert,
  Smartphone,
  Mail,
  ArrowLeft,
  Copy,
  CheckCircle2,
  KeyRound,
  Lock,
} from 'lucide-react';
import { use2FA } from '../../../../Services/hooks/Auth/use2FA';

interface TwoFactorModalProps {
  onClose: () => void;
}

export default function TwoFactorModal({ onClose }: TwoFactorModalProps) {
  const {
    view, isLoading, status, error, success,
    qrCode, secret, password, setupMethod, disableMethod,
    backupCodes, copied, code, inputs,
    hasTotp, hasEmail, hasAny2FA,
    setPassword,
    fetchStatus, handleCodeChange, handleCodePaste, handleKeyDown,
    promptSetup, handlePasswordSubmit, handleVerifySetup,
    promptDisable, handleDisable,
    copyBackupCodes, confirmBackupCodesSaved,
    resetAndGoBack, getTitle,
  } = use2FA();

  useEffect(() => {
    fetchStatus();
  }, []);

  // --- Sub-renders ---

  const renderOTPInputs = () => (
    <div className="mx-auto flex w-full max-w-[320px] justify-center gap-1.5 sm:gap-2">
      {code.map((digit, index) => (
        <input
          key={index}
          type="text"
          maxLength={1}
          value={digit}
          onChange={(e) => handleCodeChange(e.target.value, index)}
          onPaste={(e) => {
            e.preventDefault();
            handleCodePaste(e.clipboardData.getData('text'), index);
          }}
          onKeyDown={(e) => handleKeyDown(e, index)}
          ref={(el) => { inputs.current[index] = el; }}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          className="flex-1 min-w-0 max-w-[3rem] aspect-square text-xl sm:text-2xl text-center text-void-text bg-void-bg-hover/70 border border-void-border rounded-lg focus:outline-none focus:ring-2 focus:ring-void-accent transition-all"
          disabled={isLoading}
          autoFocus={index === 0}
        />
      ))}
    </div>
  );

  const renderStatus = () => (
    <div className="space-y-6">
      <div className="flex items-center gap-4 bg-void-bg-main/55 p-4 rounded-xl border border-void-border">
        <div className={`p-3 rounded-full ${hasAny2FA ? 'bg-emerald-900/30 text-emerald-400' : 'bg-yellow-900/30 text-yellow-400'}`}>
          {hasAny2FA ? <ShieldCheck className="w-6 h-6" /> : <ShieldAlert className="w-6 h-6" />}
        </div>
        <div>
          <h4 className="text-void-text font-medium">2FA is {hasAny2FA ? 'Enabled' : 'Disabled'}</h4>
          <p className="text-sm text-void-text-muted">
            {hasAny2FA
              ? 'Your account is protected with an extra layer of security.'
              : 'Add an extra layer of security to your account.'}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <h4 className="text-xs font-semibold text-void-text-muted uppercase tracking-wider">Authentication Methods</h4>

        <div className="flex items-center justify-between p-4 bg-void-bg-main/50 border border-void-border rounded-xl transition-colors hover:bg-void-bg-hover/60">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-void-accent/15 text-void-accent rounded-lg"><Smartphone className="w-5 h-5" /></div>
            <div>
              <p className="text-sm font-medium text-void-text">Authenticator App</p>
              <p className="text-xs text-void-text-muted">Use apps like Google Auth or Authy</p>
            </div>
          </div>
          <button
            onClick={() => hasTotp ? promptDisable('totp') : promptSetup('totp')}
            disabled={isLoading}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50 ${hasTotp ? 'bg-void-accent' : 'bg-void-bg-hover'}`}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${hasTotp ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        <div className="flex items-center justify-between p-4 bg-void-bg-main/50 border border-void-border rounded-xl transition-colors hover:bg-void-bg-hover/60">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-void-accent/15 text-void-accent rounded-lg"><Mail className="w-5 h-5" /></div>
            <div>
              <p className="text-sm font-medium text-void-text">Email Authentication</p>
              <p className="text-xs text-void-text-muted">Receive verification codes via email</p>
            </div>
          </div>
          <button
            onClick={() => hasEmail ? promptDisable('email') : promptSetup('email')}
            disabled={isLoading}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50 ${hasEmail ? 'bg-void-accent' : 'bg-void-bg-hover'}`}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${hasEmail ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
      </div>

      {hasAny2FA && (
        <div className="pt-4 border-t border-void-border">
          <button className="w-full flex items-center justify-between p-4 bg-void-bg-main/55 hover:bg-void-bg-hover border border-void-border rounded-xl transition-colors">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-yellow-900/20 text-yellow-400 rounded-lg"><KeyRound className="w-5 h-5" /></div>
              <div className="text-left">
                <p className="text-sm font-medium text-void-text">Backup Codes</p>
                <p className="text-xs text-void-text-muted">{status?.backupCodesRemaining || 0} codes remaining</p>
              </div>
            </div>
          </button>
        </div>
      )}
    </div>
  );

  const renderPasswordPrompt = () => (
    <form onSubmit={(e) => { e.preventDefault(); handlePasswordSubmit(); }} className="space-y-6">
      <div className="text-center space-y-2">
        <div className="inline-flex p-4 rounded-full bg-void-accent/15 text-void-accent mb-2">
          <Lock className="w-8 h-8" />
        </div>
        <p className="text-sm text-void-text">
          Enter your password to set up {setupMethod === 'totp' ? 'Authenticator App' : 'Email Authentication'}.
        </p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm text-void-text">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter your password"
          className="w-full px-4 py-3 bg-void-bg-main/60 border border-void-border rounded-xl text-void-text placeholder-void-text-muted focus:outline-none focus:ring-2 focus:ring-void-accent transition-all"
          required
          autoFocus
        />
      </div>

      <button
        type="submit"
        disabled={isLoading || !password}
        className="w-full py-3 bg-void-accent hover:bg-void-accent-hover text-white rounded-xl font-medium transition-colors disabled:opacity-50"
      >
        {isLoading ? 'Verifying...' : 'Continue'}
      </button>
    </form>
  );

  const renderSetupTOTP = () => (
    <form onSubmit={(e) => { e.preventDefault(); handleVerifySetup(); }} className="space-y-6">
      <div className="text-center space-y-4">
        <p className="text-sm text-void-text">1. Scan this QR code with your authenticator app.</p>
        {qrCode && (
          <div className="flex justify-center bg-white p-4 rounded-xl w-fit mx-auto">
            <img src={qrCode} alt="2FA QR Code" className="w-40 h-40" />
          </div>
        )}
        <div className="text-xs text-void-text-muted">
          <p>Or enter this code manually:</p>
          <code className="block mt-1 p-2 bg-void-bg-main/70 rounded border border-void-border select-all text-void-accent font-mono text-sm">{secret}</code>
        </div>
      </div>

      <div className="space-y-4 pt-4 border-t border-void-border">
        <label className="block text-sm text-void-text text-center">2. Enter the 6-digit code from your app</label>
        {renderOTPInputs()}
      </div>

      <button type="submit" disabled={isLoading || code.join('').length < 6} className="w-full py-3 bg-void-accent hover:bg-void-accent-hover text-white rounded-xl font-medium transition-colors disabled:opacity-50">
        {isLoading ? 'Verifying...' : 'Verify and Enable'}
      </button>
    </form>
  );

  const renderSetupEmail = () => (
    <form onSubmit={(e) => { e.preventDefault(); handleVerifySetup(); }} className="space-y-6">
      <div className="text-center space-y-2 mb-6">
        <div className="inline-flex p-4 rounded-full bg-void-accent/15 text-void-accent mb-2"><Mail className="w-8 h-8" /></div>
        <p className="text-sm text-void-text">We've sent a 6-digit verification code to your email.</p>
      </div>
      <div className="space-y-4">
        <label className="block text-sm text-void-text text-center">Enter the code</label>
        {renderOTPInputs()}
      </div>
      <button type="submit" disabled={isLoading || code.join('').length < 6} className="w-full py-3 bg-void-accent hover:bg-void-accent-hover text-white rounded-xl font-medium transition-colors disabled:opacity-50">
        {isLoading ? 'Verifying...' : 'Verify and Enable'}
      </button>
    </form>
  );

  const renderDisable = () => (
    <form onSubmit={(e) => { e.preventDefault(); handleDisable(); }} className="space-y-6">
      <div className="bg-red-900/20 border border-red-800/50 p-4 rounded-xl">
        <p className="text-sm text-red-300">
          Disabling <span className="font-semibold">{disableMethod === 'totp' ? 'Authenticator App' : 'Email Authentication'}</span> will make your account less secure.
        </p>
      </div>
      <div className="space-y-2">
        <label className="block text-sm text-void-text">Current Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" className="w-full px-4 py-3 bg-void-bg-main/60 border border-void-border rounded-xl text-void-text placeholder-void-text-muted focus:outline-none focus:ring-2 focus:ring-red-500 transition-all" required autoFocus />
      </div>
      <button type="submit" disabled={isLoading || !password} className="w-full py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl font-medium transition-colors disabled:opacity-50">
        {isLoading ? 'Disabling...' : 'Confirm Disable'}
      </button>
    </form>
  );

  const renderBackupCodes = () => (
    <div className="space-y-6">
      <div className="bg-yellow-900/20 border border-yellow-800/50 p-4 rounded-xl">
        <h4 className="text-yellow-400 font-medium mb-1 flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> Save these backup codes!</h4>
        <p className="text-sm text-yellow-200/70">Each code can only be used once. Keep them safe.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 p-4 bg-void-bg-main/70 rounded-xl border border-void-border">
        {backupCodes.map((backupCode, index) => (
          <code key={index} className="text-center font-mono text-void-accent tracking-wider">{backupCode}</code>
        ))}
      </div>
      <button onClick={copyBackupCodes} className="w-full flex items-center justify-center gap-2 py-3 bg-void-bg-hover hover:bg-void-bg-hover/80 text-void-text rounded-xl font-medium transition-colors">
        {copied ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
        {copied ? 'Copied to Clipboard' : 'Copy Codes'}
      </button>
      <button onClick={confirmBackupCodesSaved} className="w-full py-3 bg-void-accent hover:bg-void-accent-hover text-white rounded-xl font-medium transition-colors">
        I have saved them
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-void-bg-sec border border-void-border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-void-border bg-void-bg-main/35 relative">
          {view !== 'status' && view !== 'backup-codes' && (
            <button onClick={resetAndGoBack} className="absolute left-4 p-2 rounded-full hover:bg-void-bg-hover text-void-text-muted hover:text-void-text transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <h3 className="text-lg font-semibold text-void-text w-full text-center">{getTitle()}</h3>
          <button onClick={onClose} className="absolute right-4 p-2 rounded-full hover:bg-void-bg-hover text-void-text-muted hover:text-void-text transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          {error && <div className="mb-6 p-4 bg-red-900/20 border border-red-800/50 rounded-lg text-red-400 text-sm">{error}</div>}
          {success && view === 'status' && <div className="mb-6 p-4 bg-emerald-900/20 border border-emerald-800/50 rounded-lg text-emerald-400 text-sm">{success}</div>}

          {isLoading && view === 'status' ? (
            <div className="text-center text-void-text-muted py-8 animate-pulse">Loading settings...</div>
          ) : (
            <>
              {view === 'status' && renderStatus()}
              {view === 'password-prompt' && renderPasswordPrompt()}
              {view === 'setup-totp' && renderSetupTOTP()}
              {view === 'setup-email' && renderSetupEmail()}
              {view === 'disable' && renderDisable()}
              {view === 'backup-codes' && renderBackupCodes()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
