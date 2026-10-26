import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function Logo({ className }: { className?: string }) {
  return (
    <Link to="/" className={className ?? 'inline-flex items-center gap-2'}>
      <img src="/favicon.svg" alt="" className="size-7" />
      <span className="text-lg font-semibold tracking-tight text-slate-900">Keyless</span>
    </Link>
  );
}

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-12">
      <Logo />
      <div className="mt-8 w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
      {footer && <div className="mt-6 text-sm text-slate-600">{footer}</div>}
      {import.meta.env.DEV && (
        <Link to="/dev/emails" className="mt-8 text-xs text-slate-400 hover:text-slate-600">
          Dev mailbox
        </Link>
      )}
    </div>
  );
}
