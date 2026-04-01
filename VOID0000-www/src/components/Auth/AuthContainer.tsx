import { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export default function AuthContainer({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-4">
      <div className="w-full max-w-md">
        <div className="bg-gray-800/50 backdrop-blur-xl border border-gray-700/50 rounded-2xl shadow-2xl p-8">
          {children}
        </div>
        <div className="mt-4 flex items-center justify-center gap-4 text-xs text-gray-500">
          <Link to="/terms" className="transition-colors hover:text-gray-300">
            Terms of Use
          </Link>
          <span className="text-gray-700">/</span>
          <Link to="/privacy" className="transition-colors hover:text-gray-300">
            Privacy Policy
          </Link>
        </div>
      </div>
    </div>
  );
}
