import { useState, useEffect, useRef } from 'react';
import { Smartphone, Mail, KeyRound, ChevronRight } from 'lucide-react';
import { authService } from '../../Services/Auth/authServiceApi';

interface TwoFactorVerifyProps {
  twoFactorData: {
    twoFactorToken: string;
    methods: string[];
    defaultMethod: string;
  };
  onVerified: (code: string, method: string) => Promise<void>;
  onCancel: () => void;
  errorMessage: string;
  isLoading: boolean;
}

export default function TwoFactorVerify({
  twoFactorData,
  onVerified,
  onCancel,
  errorMessage,
  isLoading,
}: TwoFactorVerifyProps) {
  const [activeMethod, setActiveMethod] = useState(twoFactorData.defaultMethod);
  const [showMethodSelector, setShowMethodSelector] = useState(false);
  
  // Input States
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [backupCode, setBackupCode] = useState('');
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  // Email States
  const [emailSent, setEmailSent] = useState(false);
  const [emailSending, setEmailSending] = useState(false);
  const [emailCooldown, setEmailCooldown] = useState<number | null>(null);

  // Send email code when explicitly clicked
  const sendEmailCode = async () => {
    if (emailSending || emailCooldown !== null) return;
    setEmailSending(true);

    try {
      const result = await authService.send2FAEmailCode(twoFactorData.twoFactorToken);
      if (result.success) {
        setEmailSent(true);
        setEmailCooldown(60);
      }
    } catch (err) {
      console.error('Failed to send email code:', err);
    } finally {
      setEmailSending(false);
    }
  };

  // Email cooldown timer
  useEffect(() => {
    if (emailCooldown === null) return;
    const timer = setInterval(() => {
      setEmailCooldown(prev => {
        if (prev === null) return null;
        if (prev > 1) return prev - 1;
        return null;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [emailCooldown]);

  // --- OTP Handlers ---
  const handleCodeChange = (value: string, index: number) => {
    const digits = value.replace(/\D/g, '');
    if (!digits) {
      const newCode = [...code];
      newCode[index] = '';
      setCode(newCode);
      return;
    }

    if (digits.length > 1) {
      handleCodePaste(digits, index);
      return;
    }

    const newCode = [...code];
    newCode[index] = digits;
    setCode(newCode);

    if (digits && index < 5) {
      inputs.current[index + 1]?.focus();
    }
  };

  const handleCodePaste = (value: string, startIndex = 0) => {
    const digits = value.replace(/\D/g, '').slice(0, 6 - startIndex);
    if (!digits) return;

    const newCode = [...code];
    digits.split('').forEach((digit, offset) => {
      newCode[startIndex + offset] = digit;
    });
    setCode(newCode);

    inputs.current[Math.min(startIndex + digits.length, 5)]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    } else if (e.key === 'Enter') {
      handleSubmit();
    }
  };

  const handleSubmit = async () => {
    const finalCode = activeMethod === 'backup' ? backupCode : code.join('');
    if (!finalCode.trim() || isLoading) return;
    await onVerified(finalCode.trim(), activeMethod);
  };

  const switchMethod = (method: string) => {
    setCode(['', '', '', '', '', '']); 
    setBackupCode(''); 
    setActiveMethod(method);
    setShowMethodSelector(false); // Hide the menu and go back to the input view
  };

  // --- Render Views ---

  if (showMethodSelector) {
    return (
      <div className="text-center space-y-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">Choose another way</h2>
          <p className="text-gray-400 text-sm">Select one of the options below to verify your identity.</p>
        </div>

        <div className="space-y-3 text-left mt-6">
          {twoFactorData.methods.includes('totp') && activeMethod !== 'totp' && (
            <button
              onClick={() => switchMethod('totp')}
              className="w-full flex items-center justify-between p-4 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl transition-colors group"
            >
              <div className="flex items-center gap-4">
                <div className="p-2 bg-blue-900/30 text-blue-400 rounded-lg">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-sm font-medium text-white group-hover:text-blue-400 transition-colors">Authenticator App</p>
                  <p className="text-xs text-gray-400">Get a code from your authenticator app</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-500 group-hover:text-blue-400" />
            </button>
          )}

          {twoFactorData.methods.includes('email') && activeMethod !== 'email' && (
            <button
              onClick={() => switchMethod('email')}
              className="w-full flex items-center justify-between p-4 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl transition-colors group"
            >
              <div className="flex items-center gap-4">
                <div className="p-2 bg-blue-900/30 text-blue-400 rounded-lg">
                  <Mail className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-sm font-medium text-white group-hover:text-blue-400 transition-colors">Email Verification</p>
                  <p className="text-xs text-gray-400">Get a verification code sent to your email</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-500 group-hover:text-blue-400" />
            </button>
          )}

          {activeMethod !== 'backup' && (
            <button
              onClick={() => switchMethod('backup')}
              className="w-full flex items-center justify-between p-4 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl transition-colors group"
            >
              <div className="flex items-center gap-4">
                <div className="p-2 bg-yellow-900/20 text-yellow-400 rounded-lg">
                  <KeyRound className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-sm font-medium text-white group-hover:text-yellow-400 transition-colors">Backup Code</p>
                  <p className="text-xs text-gray-400">Enter one of your 8-digit backup codes</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-500 group-hover:text-yellow-400" />
            </button>
          )}
        </div>

        <button
          onClick={() => setShowMethodSelector(false)}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors mt-4 block w-full"
        >
          Cancel
        </button>
      </div>
    );
  }

  // Main Input View
  return (
    <div className="text-center space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-white mb-2">Two-Factor Authentication</h2>
        <p className="text-gray-400">
          {activeMethod === 'totp'
            ? 'Enter the code from your authenticator app'
            : activeMethod === 'email'
              ? emailSent
                ? 'Enter the 6-digit code sent to your email'
                : 'Click below to send a verification code to your email'
              : 'Enter an 8-digit backup code'}
        </p>
      </div>

      {/* Conditional UI: If Email method is selected but NOT sent yet, show Send button */}
      {activeMethod === 'email' && !emailSent ? (
        <button
          onClick={sendEmailCode}
          disabled={emailSending}
          className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors sm:py-3"
        >
          {emailSending ? 'Sending...' : 'Send Verification Code'}
        </button>
      ) : (
        <>
          {/* Input UI */}
          {activeMethod === 'backup' ? (
            <input
              type="text"
              value={backupCode}
              onChange={e => setBackupCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              placeholder="Enter 8-digit backup code"
              maxLength={8}
              inputMode="numeric"
              pattern="[0-9]*"
              className="w-full px-4 py-3.5 bg-gray-700/50 border border-gray-600 rounded-xl text-white text-center text-2xl tracking-widest placeholder:text-base placeholder:tracking-normal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all sm:py-3"
              autoFocus
              disabled={isLoading}
            />
          ) : (
            <div className="mx-auto mb-6 grid w-full max-w-[22rem] grid-cols-6 gap-1.5 sm:gap-2">
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
                  ref={(el) => {
                    inputs.current[index] = el;
                  }}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete={index === 0 ? 'one-time-code' : 'off'}
                  className="h-12 min-w-0 rounded-xl border border-gray-600 bg-gray-700/70 text-center text-xl font-semibold text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all sm:h-12 sm:text-2xl"
                  disabled={isLoading}
                  autoFocus={index === 0}
                />
              ))}
            </div>
          )}

          {/* Error Message */}
          {errorMessage && (
            <p className="text-red-500 text-sm">{errorMessage}</p>
          )}

          {/* Resend Email Button */}
          {activeMethod === 'email' && emailSent && (
            <div className="pb-2">
              <button
                onClick={sendEmailCode}
                disabled={emailSending || emailCooldown !== null}
                className="text-sm text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
              >
                {emailCooldown !== null
                  ? `Resend in ${emailCooldown}s`
                  : emailSending
                    ? 'Sending...'
                    : 'Resend code'}
              </button>
            </div>
          )}

          {/* Verify Button */}
          <button
            onClick={handleSubmit}
            disabled={isLoading || (activeMethod === 'backup' ? backupCode.length < 8 : code.join('').length < 6)}
            className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors sm:py-3"
          >
            {isLoading ? 'Verifying...' : 'Verify'}
          </button>
        </>
      )}

      {/* Try Another Way Link */}
      <div className="pt-2">
        <button
          onClick={() => setShowMethodSelector(true)}
          className="text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors"
          disabled={isLoading}
        >
          Try another way
        </button>
      </div>

      {/* Cancel Button */}
      <button
        onClick={onCancel}
        className="text-sm text-gray-500 hover:text-gray-300 transition-colors mt-4 block w-full"
      >
        Cancel and go back
      </button>
    </div>
  );
}
