import clsx from 'clsx';
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
  loading?: boolean;
};

export function Button({
  variant = 'primary',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-150 active:scale-[0.98]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100',
        {
          primary:
            'bg-gradient-to-r from-brand-600 to-indigo-600 text-white shadow-sm hover:from-brand-700 hover:to-indigo-700 hover:shadow',
          secondary:
            'border border-slate-200 bg-white text-slate-700 shadow-xs hover:border-slate-300 hover:bg-slate-50/80 hover:text-slate-900',
          danger:
            'bg-gradient-to-r from-red-600 to-rose-600 text-white shadow-sm hover:from-red-700 hover:to-rose-700',
          ghost: 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900',
          success:
            'bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-sm hover:from-emerald-700 hover:to-teal-700',
        }[variant],
        className,
      )}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={clsx('animate-spin', className ?? 'size-5')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

type FieldProps = { label: string; error?: string; hint?: string };

export const TextField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & FieldProps
>(function TextField({ label, error, hint, className, id, ...rest }, ref) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={className}>
      <label htmlFor={inputId} className="block text-xs font-semibold uppercase tracking-wider text-slate-600">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined}
        className={clsx(
          'mt-1.5 block w-full rounded-lg border bg-white px-3.5 py-2 text-sm text-slate-800 shadow-xs transition placeholder:text-slate-400',
          'focus:border-brand-500 focus:outline-none focus:ring-3 focus:ring-brand-500/15',
          error ? 'border-red-400 bg-red-50/20' : 'border-slate-200 hover:border-slate-300',
        )}
        {...rest}
      />
      {error ? (
        <p id={`${inputId}-err`} className="mt-1 text-xs text-red-600 font-medium">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

export const SelectField = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> &
    FieldProps & { options: { value: string; label: string }[] }
>(function SelectField({ label, error, options, className, id, ...rest }, ref) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className={className}>
      <label htmlFor={selectId} className="block text-xs font-semibold uppercase tracking-wider text-slate-600">
        {label}
      </label>
      <select
        ref={ref}
        id={selectId}
        className="mt-1.5 block w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-800 shadow-xs transition hover:border-slate-300 focus:border-brand-500 focus:outline-none focus:ring-3 focus:ring-brand-500/15"
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-red-600 font-medium">{error}</p>}
    </div>
  );
});

export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.03),0_4px_12px_rgba(0,0,0,0.02)] transition-shadow duration-200', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-slate-100 px-6 py-4">
          <div className="flex-1 min-w-0">
            {title && <div className="text-base font-semibold text-slate-900 tracking-tight">{title}</div>}
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      <div className="px-6 py-5">{children}</div>
    </section>
  );
}

export function Badge({
  children,
  tone = 'slate',
  dot = false,
}: {
  children: ReactNode;
  tone?: 'slate' | 'green' | 'amber' | 'red' | 'brand' | 'blue' | 'purple';
  dot?: boolean;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium tracking-wide',
        {
          slate: 'bg-slate-100 text-slate-700 ring-1 ring-slate-200/70',
          green: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/80',
          amber: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200/80',
          red: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200/80',
          brand: 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200/80',
          blue: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200/80',
          purple: 'bg-purple-50 text-purple-700 ring-1 ring-purple-200/80',
        }[tone],
      )}
    >
      {dot && (
        <span
          className={clsx('size-1.5 rounded-full', {
            slate: 'bg-slate-400',
            green: 'bg-emerald-500',
            amber: 'bg-amber-500',
            red: 'bg-rose-500',
            brand: 'bg-indigo-500',
            blue: 'bg-sky-500',
            purple: 'bg-purple-500',
          }[tone])}
        />
      )}
      {children}
    </span>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-white shadow-xs ring-1 ring-slate-200 text-slate-400">
        {icon ?? (
          <svg className="size-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
          </svg>
        )}
      </div>
      <p className="mt-3 text-sm font-semibold text-slate-900">{title}</p>
      {children && <div className="mt-1 max-w-sm text-xs text-slate-500">{children}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  badge,
  actions,
}: {
  title: string;
  description?: string;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-slate-200/70 pb-5">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
          {badge}
        </div>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}

export function FullPageSpinner() {
  return (
    <div
      className="flex min-h-screen items-center justify-center text-brand-600"
      role="status"
      aria-label="Loading"
    >
      <Spinner className="size-8" />
    </div>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {message}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  maxWidth = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  maxWidth?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
      <div
        className={clsx(
          'relative w-full rounded-xl bg-white shadow-2xl border border-slate-200 overflow-hidden',
          maxWidth,
        )}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close dialog"
            title="Close dialog"
          >
            <svg className="size-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
