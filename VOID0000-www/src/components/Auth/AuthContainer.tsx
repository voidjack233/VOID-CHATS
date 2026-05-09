import { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export default function AuthContainer({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh overflow-y-auto bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-white sm:flex sm:min-h-screen sm:items-center sm:justify-center sm:p-4">
      <div className="flex min-h-dvh w-full flex-col px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-[calc(1.25rem+env(safe-area-inset-top))] sm:min-h-0 sm:max-w-md sm:px-0 sm:pb-0 sm:pt-0">
        <div className="flex w-full flex-1 items-center py-4 sm:block sm:flex-none sm:py-0">
          <div className="w-full bg-transparent p-0 shadow-none sm:bg-gray-800/50 sm:backdrop-blur-xl sm:border sm:border-gray-700/50 sm:rounded-2xl sm:shadow-2xl sm:p-8">
            {children}
          </div>
        </div>

        <div className="mt-auto flex items-center justify-center gap-4 pt-6 text-xs text-gray-500 sm:mt-4 sm:pt-0">
          <Link to="/terms" className="transition-colors hover:text-gray-300">
            Terms of Use
          </Link>
          <span className="text-gray-700">/</span>
          <Link to="/privacy" className="transition-colors hover:text-gray-300">
            Privacy Policy
          </Link>
        </div>
      </div>
    </main>
  );
}
