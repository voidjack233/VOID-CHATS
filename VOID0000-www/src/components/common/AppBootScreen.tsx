import { Loader2 } from 'lucide-react';

interface AppBootScreenProps {
  title?: string;
  subtitle?: string | null;
}

const AppBootScreen = ({
  title = 'Loading',
  subtitle = null,
}: AppBootScreenProps) => {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-void-bg-main px-6 py-10 text-void-text">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-[-12rem] h-[24rem] w-[24rem] -translate-x-1/2 rounded-full bg-void-accent/10 blur-3xl" />
        <div className="absolute bottom-[-8rem] right-[-4rem] h-[16rem] w-[16rem] rounded-full bg-sky-500/8 blur-3xl" />
      </div>

      <div className="relative flex w-full max-w-xs flex-col items-center text-center">
        <div className="relative flex h-16 w-16 items-center justify-center">
          <div className="absolute inset-0 rounded-full border border-white/8 bg-void-bg-sec/50 backdrop-blur-sm" />
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-void-bg-sec/80 text-void-accent shadow-[0_0_26px_rgba(83,177,241,0.2)]">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        </div>

        <h1 className="mt-5 text-base font-semibold text-void-text">
          {title}
        </h1>

        {subtitle ? (
          <p className="mt-2 max-w-[18rem] text-sm leading-6 text-void-text-muted">
            {subtitle}
          </p>
        ) : null}
      </div>
    </div>
  );
};

export default AppBootScreen;
