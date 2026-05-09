import AuthContainer from '../../components/Auth/AuthContainer';
import CaptchaModal from '../../components/Auth/CaptchaModal';
import { useEmailVerification } from '../../Services/hooks/Auth/useEmailVerification';

export default function EmailVerification() {
  const {
    code,
    error,
    loading,
    isVerified,
    tokenValid,
    codeSent,
    sendingCode,
    userEmail,
    cooldown,
    showCaptcha,
    setShowCaptcha,
    inputs,
    handleChange,
    handlePaste,
    handleKeyDown,
    handleSubmit,
    handleSendCode,
    handleResendCode,
    handleCaptchaVerified,
    goToRegister,
    goToLogin,
  } = useEmailVerification();

  // Loading state - validating token
  if (tokenValid === null) {
    return (
      <AuthContainer>
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-400">Validating access...</p>
        </div>
      </AuthContainer>
    );
  }

  // Invalid token
  if (!tokenValid) {
    return (
      <AuthContainer>
        <div className="text-center">
          <h2 className="text-3xl font-bold text-white mb-4">Invalid Access</h2>
          <p className="text-red-500 mb-6">{error}</p>
          <button
            onClick={goToRegister}
            className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-semibold hover:bg-blue-700 sm:py-3"
          >
            Go to Register
          </button>
        </div>
      </AuthContainer>
    );
  }

  // Verified successfully
  if (isVerified) {
    return (
      <AuthContainer>
        <div className="text-center">
          <h2 className="text-3xl font-bold text-white mb-4">Email Verified!</h2>
          <p className="text-gray-400 mb-6">Your email has been successfully verified.</p>
          <p className="text-blue-400">Redirecting to login...</p>
        </div>
      </AuthContainer>
    );
  }

  // STEP 1: Send code (code not yet sent)
  if (!codeSent) {
    return (
      <AuthContainer>
        <div className="text-center">
          <h2 className="text-3xl font-bold text-white mb-4">Verify Your Email</h2>
          <p className="text-gray-400 mb-6">
            Click below to send a verification code to your email
            {userEmail && <span className="text-blue-400 block mt-1">{userEmail}</span>}
          </p>

          {error && (
            <p className="text-red-500 mb-4" role="alert">{error}</p>
          )}

          <button
            onClick={handleSendCode}
            disabled={sendingCode}
            className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-50 mb-4 sm:py-3"
          >
            {sendingCode ? 'Sending...' : 'Send Verification Code'}
          </button>

          <div className="text-sm text-gray-400 font-medium text-center">
            <button onClick={goToLogin} className="hover:text-gray-200">
              Back to Login
            </button>
          </div>

          <CaptchaModal
            isOpen={showCaptcha}
            onVerified={handleCaptchaVerified}
            onClose={() => setShowCaptcha(false)}
          />
        </div>
      </AuthContainer>
    );
  }

  // STEP 2: Enter code (code has been sent)
  return (
    <AuthContainer>
      <div className="text-center">
        <h2 className="text-3xl font-bold text-white mb-4">Enter Verification Code</h2>
        <p className="text-gray-400 mb-6 text-sm sm:text-base">
          Enter the 6-digit code sent to your email
          {userEmail && <span className="text-blue-400 block mt-1 break-all">{userEmail}</span>}
        </p>

        <div className="mx-auto mb-6 grid w-full max-w-[22rem] grid-cols-6 gap-1.5 sm:gap-2">
          {code.map((digit, index) => (
            <input
              key={index}
              type="text"
              maxLength={1}
              value={digit}
              onChange={(e) => handleChange(e.target.value, index)}
              onPaste={(e) => {
                e.preventDefault();
                handlePaste(e.clipboardData.getData('text'), index);
              }}
              onKeyDown={(e) => handleKeyDown(e, index)}
              ref={(el) => {
                inputs.current[index] = el;
              }}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete={index === 0 ? 'one-time-code' : 'off'}
              className="h-12 min-w-0 rounded-xl border border-gray-600 bg-gray-700/70 text-center text-xl font-semibold text-white focus:outline-none focus:ring-2 focus:ring-blue-500 sm:h-12 sm:text-2xl"
              disabled={loading}
              aria-label={`Verification code digit ${index + 1}`}
            />
          ))}
        </div>

        {error && (
          <p className="text-red-500 mb-4 text-sm sm:text-base" role="alert">{error}</p>
        )}

        <button
          onClick={handleSubmit}
          disabled={loading}
          className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-50 mb-4 sm:py-3"
        >
          {loading ? 'Verifying...' : 'Verify Email'}
        </button>

        <div className="flex justify-center gap-4 text-sm text-gray-400 font-medium">
          <button
            onClick={handleResendCode}
            disabled={sendingCode || cooldown !== null}
            className="hover:text-gray-200 disabled:opacity-50 transition-colors"
          >
            {cooldown !== null
              ? `Resend in ${cooldown}s`
              : sendingCode
                ? 'Sending...'
                : 'Resend Code'}
          </button>
          <span className="text-gray-600">|</span>
          <button onClick={goToLogin} className="hover:text-gray-200 transition-colors" disabled={loading}>
            Back to Login
          </button>
        </div>

        <CaptchaModal
          isOpen={showCaptcha}
          onVerified={handleCaptchaVerified}
          onClose={() => setShowCaptcha(false)}
        />
      </div>
    </AuthContainer>
  );
}
