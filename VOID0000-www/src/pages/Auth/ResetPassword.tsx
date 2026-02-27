import PasswordInput from '../../components/Auth/PasswordInput';
import AuthContainer from '../../components/Auth/AuthContainer';
import { useResetPassword } from '../../Services/hooks/Auth/useResetPassword';

export default function ResetPassword() {
  const {
    password,
    setPassword,
    confirmPassword,
    setConfirmPassword,
    error,
    success,
    loading,
    handleSubmit,
    token,
  } = useResetPassword();

  return (
    <AuthContainer>
      <div className="space-y-6">
        <div className="text-center">
          <h2 className="text-3xl font-bold text-white mb-2">Reset Password</h2>
          <p className="text-gray-400">Enter your new password below</p>
        </div>

        {success ? (
          <div className="text-center">
            <p className="text-emerald-400">Password reset successfully! Redirecting...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <p className="text-red-500 text-center">{error}</p>}

            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              label="New Password"
              name="password"
            />

            <PasswordInput
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={loading}
              label="Confirm New Password"
              name="confirmPassword"
            />

            <button
              type="submit"
              disabled={loading || !token}
              className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? 'Resetting...' : 'Reset Password'}
            </button>
          </form>
        )}
      </div>
    </AuthContainer>
  );
}
