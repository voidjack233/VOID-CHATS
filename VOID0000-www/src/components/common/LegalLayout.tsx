import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface LegalLayoutProps {
  title: string;
  subtitle: string;
  lastUpdated: string;
  active: 'terms' | 'privacy';
  children: ReactNode;
}

function LegalNavLink({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={[
        'rounded-full border px-4 py-2 text-sm font-medium transition-colors',
        active
          ? 'border-blue-400 bg-blue-500/15 text-blue-200'
          : 'border-gray-700 bg-gray-800/70 text-gray-300 hover:border-gray-600 hover:text-white',
      ].join(' ')}
    >
      {children}
    </Link>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <div className="space-y-3 text-sm leading-7 text-gray-300">{children}</div>
    </section>
  );
}

function BulletList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-2 pl-5 text-sm leading-7 text-gray-300 list-disc">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

export function LegalSection(props: { title: string; children: ReactNode }) {
  return <Section {...props} />;
}

export function LegalBulletList(props: { items: ReactNode[] }) {
  return <BulletList {...props} />;
}

export default function LegalLayout({
  title,
  subtitle,
  lastUpdated,
  active,
  children,
}: LegalLayoutProps) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 px-4 py-10 text-white">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <Link
            to="/auth"
            className="inline-flex items-center rounded-full border border-gray-700 bg-gray-900/70 px-4 py-2 text-sm text-gray-300 transition-colors hover:border-gray-600 hover:text-white"
          >
            Back to Auth
          </Link>

          <div className="flex flex-wrap items-center gap-2">
            <LegalNavLink to="/terms" active={active === 'terms'}>
              Terms of Use
            </LegalNavLink>
            <LegalNavLink to="/privacy" active={active === 'privacy'}>
              Privacy Policy
            </LegalNavLink>
          </div>
        </div>

        <div className="overflow-hidden rounded-3xl border border-gray-800 bg-gray-900/85 shadow-2xl">
          <div className="border-b border-gray-800 bg-gradient-to-r from-gray-900 via-gray-900 to-blue-950/40 px-6 py-8 sm:px-10">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-blue-300">
              VOID Legal
            </p>
            <h1 className="text-3xl font-bold text-white sm:text-4xl">{title}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-gray-300">{subtitle}</p>
            <p className="mt-4 text-xs uppercase tracking-[0.18em] text-gray-500">
              Last updated: {lastUpdated}
            </p>
          </div>

          <div className="space-y-8 px-6 py-8 sm:px-10 sm:py-10">{children}</div>
        </div>
      </div>
    </div>
  );
}
