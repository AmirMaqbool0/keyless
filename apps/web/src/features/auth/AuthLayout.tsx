import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function Logo({ className }: { className?: string }) {
  return (
    <Link to="/" className={className ?? 'inline-flex items-center gap-3 group'}>
      <img
        src="/logo.png"
        alt="Keyless Logo"
        className="h-8 w-auto object-contain transition-transform group-hover:scale-105"
      />
      <div className="flex flex-col">
        <span className="text-xl font-bold tracking-tight text-slate-900 group-hover:text-brand-600 transition-colors">
          Keyless
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 -mt-1">
          Order AI
        </span>
      </div>
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
    <div className="relative flex min-h-full flex-col items-center justify-center px-4 py-16 bg-gradient-to-b from-slate-50 via-indigo-50/20 to-slate-100/60">
      {/* Decorative background glow */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
        <div className="size-[500px] rounded-full bg-gradient-to-tr from-indigo-200/40 to-brand-300/30 blur-3xl" />
      </div>

      <div className="relative z-10 flex flex-col items-center">
        <Logo />

        <div className="mt-8 w-full max-w-md rounded-2xl border border-slate-200/80 bg-white/95 p-8 shadow-[0_8px_30px_rgb(0,0,0,0.06)] backdrop-blur-md">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>

        {footer && <div className="mt-6 text-sm text-slate-600 font-medium">{footer}</div>}
        {import.meta.env.DEV && (
          <Link
            to="/dev/emails"
            className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-slate-100/80 px-3 py-1 text-xs text-slate-500 hover:text-slate-800 transition"
          >
            <span>✉️</span>
            <span>Developer In-Memory Mailbox</span>
          </Link>
        )}
      </div>
    </div>
  );
}

