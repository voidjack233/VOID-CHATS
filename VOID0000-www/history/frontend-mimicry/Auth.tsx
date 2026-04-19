import React, { Component, useRef, useState, ReactNode, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Mail, Lock, User } from 'lucide-react';

// Types
type AuthView = 'login' | 'register' | 'forgot' | 'email-verification' | 'reset-password';

interface AuthProps {
  setCurrentView: (view: AuthView) => void;
}

interface ApiResponse {
  success: boolean;
  message?: string;
  token?: string;
}

// Error Boundary
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="text-center text-red-500 p-4">
          <h1>Something went wrong</h1>
          <p>{this.state.error?.message || 'An unexpected error occurred'}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

//SecretHAHAHA
const API_BASE_URL = import.meta.env.VITE_API_URL;

interface PasswordInputProps {
  showPassword: boolean;
  togglePassword: () => void;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  name: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  label?: string;
}

const PasswordInput: React.FC<PasswordInputProps> = ({
  showPassword,
  togglePassword,
  value,
  onChange,
  name,
  placeholder = '••••••••',
  disabled = false,
  id = 'password',
  label = 'Password',
}) => (
  <div className="space-y-2">
    <label htmlFor={id} className="block text-sm font-medium text-gray-300">
      {label}
    </label>
    <div className="relative">
      <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
      <input
        id={id}
        type={showPassword ? 'text' : 'password'}
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full pl-10 pr-12 py-3 bg-gray-700/50 border border-gray-600 rounded-xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200"
        required
        disabled={disabled}
        aria-describedby={id + '-error'}
      />
      <button
        type="button"
        onClick={togglePassword}
        className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-300"
        aria-label={showPassword ? 'Hide password' : 'Show password'}
      >
        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
      </button>
    </div>
  </div>
);

const AuthContainer = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-4">
    <div className="w-full max-w-md">
      <div className="bg-gray-800/50 backdrop-blur-xl border border-gray-700/50 rounded-2xl shadow-2xl p-8">
        {children}
      </div>
    </div>
  </div>
);

const Login = ({ setCurrentView }: AuthProps) => {
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({ identifier: '', password: '' });
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  //  Redirect if already logged in
  useEffect(() => {
  const token = localStorage.getItem('authToken');
  if (token) {
    try {
      const parts = token.split('.');
      const base64Payload = parts[1];

      if (!base64Payload) throw new Error('Invalid token format');

      const decodedPayloadJson = atob(base64Payload);
      const payload = JSON.parse(decodedPayloadJson);

      if (payload.exp && Date.now() < payload.exp * 1000) {
        navigate('/Home');
      }
    } catch (err) {
      console.error('Token check failed:', err);
      localStorage.removeItem('authToken');
    }
  }
}, [navigate]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setErrorMessage('');
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage('');
    setIsLoading(true);

    if (!formData.identifier || !formData.password) {
      setErrorMessage('Please enter both email and password');
      setIsLoading(false);
      return;
    }

    try {
      console.log('Fetching:', `${API_BASE_URL}/api/auth/login`);
      const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: formData.identifier,
          password: formData.password
        }),
        credentials: 'include',
      });

      const result: ApiResponse = await response.json();

      if (!response.ok) throw new Error(result.message || 'Login failed');
      if (!result.success) throw new Error(result.message || 'Invalid credentials');

      if (result.token) {
        localStorage.setItem('authToken', result.token);
        console.log('Login successful, navigating to /Home');
        navigate('/Home');
      }
    } catch (error) {
      console.error('Login error:', error);
      setErrorMessage(error instanceof Error ? error.message : 'Authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthContainer>
      <div className="text-center mb-8">
        <h2 className="text-3xl font-bold text-white mb-2">Sign In</h2>
        <p className="text-gray-400">Sign in to your account</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6" noValidate>
        <div className="space-y-2">
          <label htmlFor="email" className="block text-sm font-medium text-gray-300">
            Email or Username
          </label>
          <div className="relative">
            <User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              id="email"
              type="text"
              name="identifier"
              value={formData.identifier}
              onChange={handleInputChange}
              placeholder="Email or Username"
              className="w-full pl-10 pr-4 py-3 bg-gray-700/50 border border-gray-600 rounded-xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200"
              required
              disabled={isLoading}
              aria-describedby={errorMessage ? 'email-error' : undefined}
            />
          </div>
        </div>

        <PasswordInput
          showPassword={showPassword}
          togglePassword={() => setShowPassword(!showPassword)}
          value={formData.password}
          onChange={handleInputChange}
          name="password"
          disabled={isLoading}
        />

        {errorMessage && (
          <p id="error-message" className="text-red-400 text-sm mt-1 ml-1" role="alert" aria-live="assertive">
            {errorMessage}
          </p>
        )}

        <div className="flex items-center justify-between">
          <label className="flex items-center">
            <input
              type="checkbox"
              className="w-4 h-4 text-blue-500 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
              disabled={isLoading}
            />
            <span className="ml-2 text-sm text-gray-400">Remember me</span>
          </label>
          <button
            onClick={() => setCurrentView('forgot')}
            type="button"
            className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            disabled={isLoading}
          >
            Forgot password?
          </button>
        </div>

        <button
          type="submit"
          className="w-full bg-gradient-to-r from-gray-800 to-gray-700 text-white py-3 rounded-xl font-semibold hover:from-gray-900 hover:to-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-600 focus:ring-offset-2 focus:ring-offset-gray-800 transition-all duration-200 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={isLoading}
        >
          {isLoading ? 'Signing In...' : 'Sign In'}
        </button>
      </form>

      <div className="mt-6 text-center">
        <p className="text-gray-400">
          Don't have an account?{' '}
          <button
            onClick={() => setCurrentView('register')}
            type="button"
            className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
            disabled={isLoading}
          >
            Sign up
          </button>
        </p>
      </div>
    </AuthContainer>
  );
};

// Register Component
const Register = ({ setCurrentView }: AuthProps) => {
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setErrorMessage('');
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage('');
    setIsLoading(true);

    if (!formData.name || !formData.email || !formData.password || !formData.confirmPassword) {
      setErrorMessage('Please fill all fields');
      setIsLoading(false);
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setErrorMessage('Passwords do not match');
      setIsLoading(false);
      return;
    }

    try {
      console.log('Fetching:', `${API_BASE_URL}/api/auth/register`);
      const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: formData.name,
          email: formData.email,
          password: formData.password,
        }),
      });

      const result: ApiResponse = await response.json();

      if (!response.ok) throw new Error(result.message || 'Registration failed');
      if (!result.success) throw new Error(result.message || 'Registration failed');

      setCurrentView('email-verification');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Registration failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthContainer>
      <div className="text-center mb-8">
        <h2 className="text-3xl font-bold text-white mb-2">Create Account</h2>
        <p className="text-gray-400">Join us today</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6" noValidate>
        <div className="space-y-2">
          <label htmlFor="name" className="block text-sm font-medium text-gray-300">
            Username
          </label>
          <div className="relative">
            <User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              id="name"
              type="text"
              name="name"
              value={formData.name}
              onChange={handleInputChange}
              placeholder="Username"
              className="w-full pl-10 pr-4 py-3 bg-gray-700/50 border border-gray-600 rounded-xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all duration-200"
              required
              disabled={isLoading}
              aria-describedby={errorMessage ? 'name-error' : undefined}
            />
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="email" className="block text-sm font-medium text-gray-300">
            Email
          </label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              id="email"
              type="email"
              name="email"
              value={formData.email}
              onChange={handleInputChange}
              placeholder="you@example.com"
              className="w-full pl-10 pr-4 py-3 bg-gray-700/50 border border-gray-600 rounded-xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all duration-200"
              required
              disabled={isLoading}
              aria-describedby={errorMessage ? 'email-error' : undefined}
            />
          </div>
        </div>

        <PasswordInput
          showPassword={showPassword}
          togglePassword={() => setShowPassword(!showPassword)}
          value={formData.password}
          onChange={handleInputChange}
          name="password"
          disabled={isLoading}
        />

        <PasswordInput
          showPassword={showConfirmPassword}
          togglePassword={() => setShowConfirmPassword(!showConfirmPassword)}
          value={formData.confirmPassword}
          onChange={handleInputChange}
          name="confirmPassword"
          label="Confirm Password"
          id="confirmPassword"
          disabled={isLoading}
        />

        {errorMessage && (
          <p id="error-message" className="text-red-400 text-sm mt-1 ml-1" role="alert" aria-live="assertive">
            {errorMessage}
          </p>
        )}

        <div className="flex items-start">
          <input
            id="terms"
            type="checkbox"
            className="w-4 h-4 mt-1 text-emerald-500 bg-gray-700 border-gray-600 rounded focus:ring-emerald-500 flex-shrink-0"
            required
            disabled={isLoading}
          />
          <label htmlFor="terms" className="ml-2 text-sm text-gray-400 leading-relaxed">
            I accept{' '}
            <button type="button" className="text-emerald-400 hover:text-emerald-300 transition-colors">
              Terms of Service
            </button>{' '}
            and{' '}
            <button type="button" className="text-emerald-400 hover:text-emerald-300 transition-colors">
              Privacy Policy
            </button>
          </label>
        </div>

        <button
          type="submit"
          className="w-full bg-gradient-to-r from-emerald-600 to-emerald-500 text-white py-3 rounded-xl font-semibold hover:from-emerald-700 hover:to-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-gray-800 transition-all duration-200 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={isLoading}
        >
          {isLoading ? 'Creating Account...' : 'Create Account'}
        </button>
      </form>

      <div className="mt-6 text-center">
        <p className="text-gray-400">
          Already have an account?{' '}
          <button
            type="button"
            onClick={() => setCurrentView('login')}
            className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
            disabled={isLoading}
          >
            Sign in
          </button>
        </p>
      </div>
    </AuthContainer>
  );
};

// Email Verification Component
const EmailVerificationCodeInput = ({ onBackToLogin }: { onBackToLogin: () => void }) => {
  const [code, setCode] = useState<string[]>(Array(6).fill(''));
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isVerified, setIsVerified] = useState(false);
  const inputs = useRef<(HTMLInputElement | null)[]>(Array(6).fill(null));

  const handleChange = (value: string, index: number) => {
    if (!/^\d?$/.test(value)) return;
    const newCode = [...code];
    newCode[index] = value;
    setCode(newCode);
    setErrorMessage('');

    if (value && index < 5 && inputs.current[index + 1]) {
      inputs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === 'Backspace' && !code[index] && index > 0 && inputs.current[index - 1]) {
      inputs.current[index - 1]?.focus();
    }
  };

  const handleSubmit = async () => {
    setErrorMessage('');
    setIsLoading(true);

    try {
      const enteredCode = code.join('');
      if (enteredCode.length !== 6) throw new Error('Please enter a 6-digit code');
      const response = await fetch(`${API_BASE_URL}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: enteredCode }),
      });

      const result: ApiResponse = await response.json();

      if (!response.ok) throw new Error(result.message || 'Verification failed');
      if (!result.success) throw new Error(result.message || 'Invalid verification code');

      console.log('Verification successful'); // Debug
      setIsVerified(true); // Set verification status to true
    } catch (error) {
      console.error('Verification error:', error); // Debug
      setErrorMessage(error instanceof Error ? error.message : 'Verification failed');
    } finally {
      setIsLoading(false);
    }
  };

  if (isVerified) {
    return (
      <AuthContainer>
        <div className="text-center">
          <h2 className="text-3xl font-bold text-white mb-4">Email Verified Successfully!</h2>
          <p className="text-gray-400 mb-6">Your email has been successfully verified.</p>
          
          <button
            onClick={onBackToLogin}
            className="w-full bg-gradient-to-r from-blue-600 to-blue-500 text-white py-3 rounded-xl font-semibold hover:from-blue-700 hover:to-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-800 transition-all duration-200 shadow-lg mb-4">
            Back to Login
          </button>
        </div>
      </AuthContainer>
    );
  }

  return (
    <AuthContainer>
      <div className="text-center">
        <h2 className="text-3xl font-bold text-white mb-4">Enter Verification Code</h2>
        <p className="text-gray-400 mb-6">We've sent a 6-digit verification code to your email.</p>

        <div className="flex justify-center gap-2 mb-6">
          {code.map((digit, index) => (
            <input
              key={index}
              type="text"
              maxLength={1}
              value={digit}
              onChange={(e) => handleChange(e.target.value, index)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              ref={(el) => {
                inputs.current[index] = el;
              }}
              className="w-12 h-12 text-2xl text-center text-white bg-gray-700/70 border border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isLoading}
              aria-label={`Verification code digit ${index + 1}`}
            />
          ))}
        </div>

        {errorMessage && (
          <p id="error-message" className="text-red-400 text-sm mb-4" role="alert" aria-live="assertive">
            {errorMessage}
          </p>
        )}

        <button
          onClick={handleSubmit}
          className="w-full bg-gradient-to-r from-blue-600 to-blue-500 text-white py-3 rounded-xl font-semibold hover:from-blue-700 hover:to-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-800 transition-all duration-200 shadow-lg mb-4 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={isLoading}>
          {isLoading ? 'Verifying...' : 'Verify Code'}
        </button>

        <button
          onClick={onBackToLogin}
          className="text-sm text-gray-400 hover:text-gray-200 transition"
          disabled={isLoading}>
          Back to Login
        </button>
      </div>
    </AuthContainer> 
  );
};

// Forgot Password Component
const ForgotPassword = ({ setCurrentView }: AuthProps) => {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus('');
    setIsLoading(true);

    if (!email) {
      setStatus('Please enter your email');
      setIsLoading(false);
      return;
    }

    try {
      console.log('Fetching:', `${API_BASE_URL}/api/auth/forgot-password`); // Debug
      const response = await fetch(`${API_BASE_URL}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const result: ApiResponse = await response.json();

      if (!response.ok) throw new Error(result.message || 'Failed to send reset email');
      if (!result.success) throw new Error(result.message || 'Failed to send reset email');

      setStatus('Password reset email sent. Please check your inbox.');
    } catch (error) {
      console.error('Forgot password error:', error); // Debug
      setStatus(error instanceof Error ? error.message : 'Failed to send reset email');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthContainer>
      <div className="text-center mb-8">
        <h2 className="text-3xl font-bold text-white mb-2">Reset Password</h2>
        <p className="text-gray-400">Enter your email to receive a reset link</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6" noValidate>
        <div className="space-y-2">
          <label htmlFor="email" className="block text-sm font-medium text-gray-300">
            Email
          </label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full pl-10 pr-4 py-3 bg-gray-700/50 border border-gray-600 rounded-xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200"
              required
              disabled={isLoading}
              aria-describedby={status && !status.includes('sent') ? 'email-error' : undefined}
            />
          </div>
        </div>

        {status && (
          <p
            id="status-message"
            className={`text-center text-sm ${status.includes('sent') ? 'text-emerald-400' : 'text-red-400'} mt-2`}
            role="alert"
            aria-live="assertive"
          >
            {status}
          </p>
        )}

        <button
          type="submit"
          className="w-full bg-gradient-to-r from-blue-600 to-blue-500 text-white py-3 rounded-xl font-semibold hover:from-blue-700 hover:to-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-800 transition-all duration-200 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={isLoading}
        >
          {isLoading ? 'Sending...' : 'Send Reset Email'}
        </button>

        <div className="mt-6 text-center">
          <p className="text-gray-400">
            Remembered your password?{' '}
            <button
              type="button"
              onClick={() => setCurrentView('login')}
              className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
              disabled={isLoading}
            >
              Sign in
            </button>
          </p>
        </div>
      </form>
    </AuthContainer>
  );
};

//Reset-Password Component
const ResetPassword = ({ setCurrentView }: AuthProps) => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('');

    if (!newPassword || newPassword.length < 6) {
      setStatus('Password must be at least 6 characters');
      return;
    }

    if (newPassword !== confirmPassword) {
      setStatus('Passwords do not match');
      return;
    }

    if (!token) {
      setStatus('Missing or invalid token');
      return;
    }

    try {
      setIsLoading(true);
      const response = await fetch(`${API_BASE_URL}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      });

      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.message || 'Failed to reset password');
      }

      setResetSuccess(true);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthContainer>
      {resetSuccess ? (
        <div className="text-center space-y-6">
          {/* Checkmark icon */}
          <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-emerald-500/20">
            <svg
              className="h-10 w-10 text-emerald-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          
          {/* Success message */}
          <h2 className="text-2xl font-bold text-white">Password changed successfully!</h2>
          <p className="text-gray-400">You can now sign in with your new password</p>
          
          {/* Back to sign in button */}
          <button
            onClick={() => setCurrentView('login')}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-800 transition-all duration-200 shadow-lg">
            Back to Sign In
          </button>
        </div>
      ) : (
        <>
          <div className="text-center mb-8">
            <h2 className="text-3xl font-bold text-white mb-2">Reset Password</h2>
            <p className="text-gray-400">Enter your new password</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6" noValidate>
            <PasswordInput
              showPassword={showPassword}
              togglePassword={() => setShowPassword(!showPassword)}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              name="newPassword"
              label="New Password"
              id="newPassword"
              disabled={isLoading}
            />

            <PasswordInput
              showPassword={showConfirmPassword}
              togglePassword={() => setShowConfirmPassword(!showConfirmPassword)}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              name="confirmPassword"
              label="Confirm Password"
              id="confirmPassword"
              disabled={isLoading}
            />

            {status && (
              <p
                className={`text-center text-sm ${
                  status.includes('successfully') ? 'text-emerald-400' : 'text-red-400'
                }`}
                role="alert"
                aria-live="assertive"
              >
                {status}
              </p>
            )}

            <button
              type="submit"
              className="w-full bg-gradient-to-r from-blue-600 to-blue-500 text-white py-3 rounded-xl font-semibold hover:from-blue-700 hover:to-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-800 transition-all duration-200 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isLoading}
            >
              {isLoading ? 'Resetting...' : 'Reset Password'}
            </button>
          </form>
        </>
      )}
    </AuthContainer>
  );
};


//2FA enabled
//Soon

// Main Auth Component
const Auth = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const token = searchParams.get('token');
  const viewParam = searchParams.get('view') as AuthView | null;

  // Track if we're coming from a successful reset
  const [fromSuccessfulReset, setFromSuccessfulReset] = useState(false);

  // Determine initial view
  const [currentView, setCurrentView] = useState<AuthView>(() => {
    if (token && !fromSuccessfulReset) return 'reset-password';
    return viewParam || 'login';
  });

  // Handle view changes
  const handleSetCurrentView = (view: AuthView, isFromReset = false) => {
  setFromSuccessfulReset(isFromReset);
  
  const newSearchParams = new URLSearchParams(searchParams);

  if (view === 'login') {
    newSearchParams.delete('view');
    newSearchParams.delete('token');

    // Reset the full view state when going back to login
    setCurrentView('login');
    navigate(`?`, { replace: true }); // Clear query entirely
  } else {
    newSearchParams.set('view', view);
    setCurrentView(view);
    navigate(`?${newSearchParams.toString()}`, { replace: true });
  }
};


  // Sync view when URL params change
  useEffect(() => {
    if (token && !fromSuccessfulReset) {
      setCurrentView('reset-password');
    } else if (viewParam && viewParam !== currentView) {
      setCurrentView(viewParam);
    }
  }, [token, viewParam, currentView, fromSuccessfulReset]);

  return (
    <ErrorBoundary>
      <div role="main">
        {currentView === 'login' && <Login setCurrentView={handleSetCurrentView} />}
        {currentView === 'register' && <Register setCurrentView={handleSetCurrentView} />}
        {currentView === 'forgot' && <ForgotPassword setCurrentView={handleSetCurrentView} />}
        {currentView === 'email-verification' && (
          <EmailVerificationCodeInput onBackToLogin={() => handleSetCurrentView('login')} />
        )}
        {currentView === 'reset-password' && (
          <ResetPassword 
            setCurrentView={(view) => handleSetCurrentView(view, true)} 
          />
        )}
      </div>
    </ErrorBoundary>
  );
};

export default Auth;