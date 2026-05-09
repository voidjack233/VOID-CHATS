import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface PasswordInputProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  name?: string;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export default function PasswordInput({
  value,
  onChange,
  name = 'password',
  label = 'Password',
  placeholder = '••••••••',
  disabled = false,
  id,
  className = ''
}: PasswordInputProps) {
  const [showPassword, setShowPassword] = useState(false);

  // fallback: if no id is passed, use the name
  const inputId = id || name;

  return (
    <div className={`space-y-2 ${className}`}>
      <label htmlFor={inputId} className="block text-sm font-medium text-gray-300">
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          type={showPassword ? 'text' : 'password'}
          name={name}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className="w-full pl-4 pr-12 py-3.5 text-base bg-gray-700/50 border border-gray-600 rounded-xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 sm:py-3"
          required
          disabled={disabled}
          autoComplete="current-password"
        />
        <button
          type="button"
          onClick={() => setShowPassword(!showPassword)}
          className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-300"
          aria-label={showPassword ? 'Hide password' : 'Show password'}
          disabled={disabled}
        >
          {showPassword ? (
            <EyeOff className="w-5 h-5" />
          ) : (
            <Eye className="w-5 h-5" />
          )}
        </button>
      </div>
    </div>
  );
}
