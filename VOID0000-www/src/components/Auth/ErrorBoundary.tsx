import { Component, ReactNode } from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

function isLikelyChunkLoadFailure(error: Error | null): boolean {
  const message = error?.message?.toLowerCase() || '';
  const name = error?.name?.toLowerCase() || '';
  return (
    message.includes('failed to fetch dynamically imported module') ||
    message.includes('importing a module script failed') ||
    message.includes('loading chunk') ||
    message.includes('chunkloaderror') ||
    name.includes('chunkloaderror')
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (isLikelyChunkLoadFailure(this.state.error)) {
        return (
          <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center px-6">
            <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 text-center shadow-2xl backdrop-blur">
              <h1 className="text-2xl font-semibold tracking-tight">Website Not Available</h1>
              <p className="mt-3 text-sm leading-6 text-white/70">
                The app files could not be reached. The server may be offline, asleep,
                or still starting up.
              </p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="mt-5 inline-flex items-center justify-center rounded-lg bg-white px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-white/90"
              >
                Try Again
              </button>
            </div>
          </div>
        );
      }

      return (
        <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center px-6">
          <div className="w-full max-w-md rounded-2xl border border-red-500/20 bg-red-500/10 p-6 text-center shadow-2xl">
            <h1 className="text-2xl font-semibold tracking-tight text-red-300">Something Went Wrong</h1>
            <p className="mt-3 text-sm leading-6 text-red-100/80">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 inline-flex items-center justify-center rounded-lg border border-red-400/30 bg-red-500/15 px-4 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/25"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
