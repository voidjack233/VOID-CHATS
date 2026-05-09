import { useState } from 'react';
import { User, Mail } from 'lucide-react';
import PasswordInput from '../../components/Auth/PasswordInput';
import AuthContainer from '../../components/Auth/AuthContainer';
import CaptchaModal from '../../components/Auth/CaptchaModal';
import { useLogin } from '../../Services/hooks/Auth/useLogin';
import { useNavigate } from 'react-router-dom';
import { authService } from '../../Services/Auth/authServiceApi';
import TwoFactorVerify from '../../components/Auth/TwoFactorVerify';

export default function Login() {
  const navigate = useNavigate();
  const {
    formData,
    errorMessage,
    isLoading,
    cooldown,
    unverifiedEmail,
    showCaptcha,
    setShowCaptcha,
    handleInputChange,
    handleSubmit,
    handleCaptchaVerified,
    // Add these to your useLogin hook if they aren't there already
    twoFactorData,
    setTwoFactorData,
    handle2FAVerified,
  } = useLogin();

  const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [showResendCaptcha, setShowResendCaptcha] = useState(false);

  const handleResendCaptchaVerified = async (captchaId: string, captchaAnswer: string) => {
    if (!unverifiedEmail) return;

    setShowResendCaptcha(false);
    setResendStatus('sending');

    try {
      const result = await authService.resendVerification(unverifiedEmail, {
        captchaId,
        captchaAnswer,
      });

      if (result.success) {
        setResendStatus('sent');
        if (result.verificationToken) {
          setGeneratedToken(result.verificationToken);
        }
      } else {
        setResendStatus('error');
      }
    } catch (error) {
      console.error('Failed to resend:', error);
      setResendStatus('error');
    }
  };

  return (
    <AuthContainer>
      {twoFactorData ? (
        <TwoFactorVerify
          twoFactorData={twoFactorData}
          onVerified={handle2FAVerified}
          onCancel={() => setTwoFactorData(null)}
          errorMessage={errorMessage}
          isLoading={isLoading}
        />
      ) : (
        <>
          <div className="mb-7 text-center sm:mb-8">
            <h2 className="mb-2 text-3xl font-bold text-white">Sign In</h2>
            <p className="text-gray-400">Sign in to your account</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5 sm:space-y-6" noValidate>
            <div className="space-y-2">
              <label htmlFor="identifier" className="block text-sm font-medium text-gray-300">
                Email or Username
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  id="identifier"
                  type="text"
                  name="identifier"
                  value={formData.identifier}
                  onChange={handleInputChange}
                  placeholder="Email or Username"
                  className="w-full pl-10 pr-4 py-3.5 text-base bg-gray-700/50 border border-gray-600 rounded-xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 sm:py-3"
                  required
                  disabled={isLoading}
                />
              </div>
            </div>

            <PasswordInput
              value={formData.password}
              onChange={handleInputChange}
              name="password"
              disabled={isLoading}
            />

            {errorMessage && (
              <div className="rounded-lg bg-red-900/20 border border-red-800/50 p-4">
                {unverifiedEmail ? (
                  <div className="flex items-start gap-3">
                    <Mail className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm text-red-300">
                        Please verify your email{' '}
                        <span className="font-semibold text-red-200">{unverifiedEmail}</span>{' '}
                        before logging in.{' '}
                        <button
                          type="button"
                          onClick={() => setShowResendCaptcha(true)}
                          className="text-blue-400 hover:text-blue-300 underline font-medium transition-colors disabled:opacity-50"
                          disabled={isLoading || resendStatus === 'sending' || resendStatus === 'sent'}>
                          {resendStatus === 'sending' ? 'Sending...' :
                           resendStatus === 'sent' ? 'Email Sent!' :
                           resendStatus === 'error' ? 'Try Again' :
                           'Resend Verification'}
                        </button>
                      </p>

                      {resendStatus === 'sent' && (
                        <div className="mt-3 p-3 bg-emerald-900/20 border border-emerald-800/50 rounded-lg">
                          <p className="text-sm text-emerald-400 mb-2">
                            Verification email sent! Check your inbox.
                          </p>
                          {generatedToken && (
                            <button
                              type="button"
                              onClick={() => navigate(`/auth?view=email-verification&vtoken=${generatedToken}`)}
                              className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors">
                              Go to Verification Page
                            </button>
                          )}
                        </div>
                      )}

                      {resendStatus === 'error' && (
                        <p className="text-xs text-red-400 mt-1">
                          Failed to send. Please try again.
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-red-400">{errorMessage}</p>
                )}
              </div>
            )}

            <div className="flex items-center justify-between">
              <button
                onClick={() => navigate('/auth?view=forgot')}
                type="button"
                className="py-1 text-sm text-blue-400 hover:text-blue-300 transition-colors"
                disabled={isLoading}
              >
                Forgot password?
              </button>
            </div>

            <button
              type="submit"
              className="w-full bg-gradient-to-r from-gray-800 to-gray-700 text-white py-3.5 rounded-xl font-semibold hover:from-gray-900 hover:to-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-600 focus:ring-offset-2 focus:ring-offset-gray-800 transition-all duration-200 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed sm:py-3"
              disabled={isLoading || cooldown !== null}
            >
              {cooldown
                ? `Retry in ${cooldown >= 60
                  ? `${Math.floor(cooldown / 60)}:${String(cooldown % 60).padStart(2, '0')}`
                  : `${cooldown}s`}`
                : isLoading
                  ? 'Signing In...'
                  : 'Sign In'}
            </button>
          </form>

          <div className="mt-7 text-center sm:mt-6">
            <p className="text-sm text-gray-400 sm:text-base">
              Don't have an account?{' '}
              <button
                onClick={() => navigate('/auth?view=register')}
                type="button"
                className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
                disabled={isLoading}
              >
                Sign up
              </button>
            </p>
          </div>

          {/* Login captcha modal */}
          <CaptchaModal
            isOpen={showCaptcha}
            onVerified={handleCaptchaVerified}
            onClose={() => setShowCaptcha(false)}
          />

          {/* Resend verification captcha modal */}
          <CaptchaModal
            isOpen={showResendCaptcha}
            onVerified={handleResendCaptchaVerified}
            onClose={() => setShowResendCaptcha(false)}
          />
        </>
      )}
    </AuthContainer>
  );
}
