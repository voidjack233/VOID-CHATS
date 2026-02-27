import { useNavigate } from 'react-router-dom';
import AuthContainer from '../../components/Auth/AuthContainer';
import CaptchaModal from '../../components/Auth/CaptchaModal';
import { useForgotPassword } from '../../Services/hooks/Auth/useForgotPassword';

export default function ForgotPassword() {
  const navigate = useNavigate();
  const {
    email,
    errorMessage,
    isLoading,
    cooldown,
    success,
    showCaptcha,
    setShowCaptcha,
    handleInputChange,
    handleSubmit,
    handleCaptchaVerified,
  } = useForgotPassword();

  return (
    <AuthContainer>
      <div className="space-y-6">
        <div className="text-center">
          <h2 className="text-3xl font-bold text-white mb-2">Reset Password</h2>
          <p className="text-gray-400">Enter your email to receive a reset link</p>
        </div>

        {success ? (
          <div className="text-center">
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 mb-4">
              <p className="text-emerald-400">
                Reset link has been sent to your email
              </p>
            </div>
            <button
              onClick={() => navigate('/auth?view=login')}
              type="button"
              className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
            >
              Back to login
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="email" className="block text-sm font-medium text-gray-300">
                Email
              </label>
              <input
                id="email"
                type="email"
                name="email"
                value={email}
                onChange={handleInputChange}
                placeholder="Enter your email address"
                className="w-full px-4 py-3 bg-gray-700/50 border border-gray-600 rounded-xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 disabled:opacity-50"
                required
                disabled={isLoading || cooldown !== null}
              />
            </div>

            {errorMessage && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3">
                <p className="text-red-400 text-sm text-center">{errorMessage}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading || cooldown !== null}
              className="w-full bg-gradient-to-r from-gray-800 to-gray-700 text-white py-3 rounded-xl font-semibold hover:from-gray-900 hover:to-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-600 focus:ring-offset-2 focus:ring-offset-gray-800 transition-all duration-200 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cooldown
                ? `Retry in ${cooldown >= 60
                  ? `${Math.floor(cooldown / 60)}:${String(cooldown % 60).padStart(2, '0')}`
                  : `${cooldown}s`}`
                : isLoading
                ? 'Sending...'
                : 'Send Reset Link'}
            </button>
          </form>
        )}

        <div className="text-center text-sm text-gray-400">
          Remember your password?{' '}
          <button
            onClick={() => navigate('/auth?view=login')}
            type="button"
            className="text-blue-400 hover:text-blue-300 font-medium transition-colors">
            Sign in
          </button>
        </div>
      </div>

      <CaptchaModal
        isOpen={showCaptcha}
        onVerified={handleCaptchaVerified}
        onClose={() => setShowCaptcha(false)}
      />
    </AuthContainer>
  );
}