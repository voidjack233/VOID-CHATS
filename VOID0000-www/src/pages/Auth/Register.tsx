import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authService } from '../../Services/Auth/authServiceApi';
import PasswordInput from '../../components/Auth/PasswordInput';
import AuthContainer from '../../components/Auth/AuthContainer';
import CaptchaModal from '../../components/Auth/CaptchaModal';

export default function Register() {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: ''
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [captchaRequired, setCaptchaRequired] = useState<boolean | null>(null);
  const navigate = useNavigate();

  // Check if captcha is needed on mount
  useEffect(() => {
    const check = async () => {
      const result = await authService.checkCaptchaRequired('register');
      setCaptchaRequired(result.captchaRequired);
    };
    check();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    const noSpaceFields = ['email', 'username', 'password', 'confirmPassword'];
    const sanitized = noSpaceFields.includes(name) ? value.replace(/ /g, '') : value;
    setFormData({ ...formData, [name]: sanitized });
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setError('');

    if (captchaRequired === false) {
      await doRegister();
    } else {
      setShowCaptcha(true);
    }
  };

  const handleCaptchaVerified = async (captchaId: string, captchaAnswer: string) => {
    setShowCaptcha(false);
    await doRegister(captchaId, captchaAnswer);
  };

  const doRegister = async (captchaId?: string, captchaAnswer?: string) => {
    setLoading(true);

    try {
      const payload: any = {
        username: formData.username,
        email: formData.email,
        password: formData.password,
      };
      if (captchaId && captchaAnswer) {
        payload.captchaId = captchaId;
        payload.captchaAnswer = captchaAnswer;
      }

      const response = await authService.register(payload);

      if (!response.success) throw new Error(response.message);

      navigate(`/auth?view=email-verification&vtoken=${response.verificationToken}`);
    } catch (err: any) {
      if (err?.code === 'CAPTCHA_REQUIRED') {
        setCaptchaRequired(true);
        setShowCaptcha(true);
        setLoading(false);
        return;
      }
      if (err?.code === 'CAPTCHA_WRONG' || err?.code === 'CAPTCHA_EXPIRED' || err?.code === 'CAPTCHA_INVALID' || err?.code === 'CAPTCHA_MAX_ATTEMPTS') {
        setError(err.message || 'Captcha verification failed.');
      } else {
        setError(err instanceof Error ? err.message : 'Registration failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthContainer>
      <div className="space-y-5 sm:space-y-6">
        <div className="text-center">
          <h2 className="mb-2 text-3xl font-bold text-white">Create Account</h2>
          <p className="text-gray-400">Join our community</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <label htmlFor="username" className="block text-sm font-medium text-gray-300">
              Username
            </label>
            <input
              id="username"
              type="text"
              name="username"
              value={formData.username}
              onChange={handleChange}
              className="w-full px-4 py-3.5 text-base bg-gray-700/50 border border-gray-600 rounded-xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent sm:py-3"
              required
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="email" className="block text-sm font-medium text-gray-300">
              Email
            </label>
            <input
              id="email"
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              className="w-full px-4 py-3.5 text-base bg-gray-700/50 border border-gray-600 rounded-xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent sm:py-3"
              required
              disabled={loading}
            />
          </div>

          <PasswordInput
            name="password"
            value={formData.password}
            onChange={handleChange}
            disabled={loading}
            label="Password"
          />

          <PasswordInput
            name="confirmPassword"
            value={formData.confirmPassword}
            onChange={handleChange}
            disabled={loading}
            label="Confirm Password"
          />

          {error && (
            <p className="rounded-lg border border-red-800/50 bg-red-900/20 p-3 text-center text-sm text-red-300">
              {error}
            </p>
          )}

          <p className="text-center text-xs leading-6 text-gray-400">
            By signing up, you agree to the{' '}
            <Link to="/terms" className="text-blue-400 hover:text-blue-300">
              Terms
            </Link>{' '}
            and{' '}
            <Link to="/privacy" className="text-blue-400 hover:text-blue-300">
              Privacy Policy
            </Link>
            .
          </p>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-emerald-600 text-white py-3.5 rounded-xl font-semibold hover:bg-emerald-700 disabled:opacity-50 sm:py-3"
          >
            {loading ? 'Creating Account...' : 'Create Account'}
          </button>
        </form>

        <div className="mt-7 text-center sm:mt-6">
          <p className="text-sm text-gray-400 sm:text-base">
            Already have an account?{' '}
            <button
              onClick={() => navigate('/auth?view=login')}
              type="button"
              className="text-blue-400 hover:text-blue-300 font-medium transition-colors">
              Sign in
            </button>
          </p>
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
