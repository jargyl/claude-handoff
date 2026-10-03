import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { Link } from 'react-router';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  GitFork,
  LoaderCircle,
  Plus,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { SyncStatus } from '../../shared/types';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

// ------------------------------------------------------------------ buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'signal';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink text-surface hover:bg-ink/85 border border-ink',
  secondary: 'bg-raised text-ink border border-line-strong hover:border-ink-3 hover:bg-surface',
  ghost: 'text-ink-2 hover:text-ink hover:bg-sunken border border-transparent',
  danger: 'bg-raised text-bad border border-line-strong hover:border-bad hover:bg-bad-wash',
  signal: 'bg-signal text-signal-ink border border-signal-line hover:brightness-95',
};
const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-sm gap-1.5 rounded-[6px]',
  md: 'h-9 px-3.5 text-base gap-2 rounded-[7px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-colors disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : Icon ? <Icon className="size-4" aria-hidden /> : null}
      {children}
    </button>
  );
});

export function IconButton({ label, icon: Icon, className, size = 'md', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: LucideIcon; size?: Size }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-[6px] text-ink-2 transition-colors hover:bg-sunken hover:text-ink disabled:opacity-40',
        size === 'sm' ? 'size-7' : 'size-9',
        className,
      )}
      {...rest}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

// ------------------------------------------------------------------ badges

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'signal';
const TONES: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-2 border-line',
  good: 'bg-good-wash text-good border-transparent',
  warn: 'bg-warn-wash text-warn border-transparent',
  bad: 'bg-bad-wash text-bad border-transparent',
  info: 'bg-info-wash text-info border-transparent',
  signal: 'bg-signal-wash text-ink border-signal-line/40',
};

export function Badge({ tone = 'neutral', icon: Icon, children, className, title }: { tone?: Tone; icon?: LucideIcon; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border px-1.5 text-xs font-medium', TONES[tone], className)}>
      {Icon && <Icon className="size-3" aria-hidden />}
      {children}
    </span>
  );
}

const STATUS: Record<SyncStatus, { tone: Tone; label: string; icon: LucideIcon; help: string }> = {
  new: { tone: 'info', label: 'New here', icon: Plus, help: "This device doesn't have this session yet." },
  missing: { tone: 'neutral', label: 'Only here', icon: ArrowUpFromLine, help: 'Only this device has this session.' },
  same: { tone: 'good', label: 'In sync', icon: CircleCheck, help: 'Both copies are identical.' },
  'incoming-ahead': { tone: 'signal', label: 'Newer there', icon: ArrowDownToLine, help: 'The other copy continues where yours stops. Pulling updates yours.' },
  'local-ahead': { tone: 'neutral', label: 'Newer here', icon: ArrowUpFromLine, help: 'Your copy continues where the other one stops.' },
  diverged: { tone: 'warn', label: 'Diverged', icon: GitFork, help: 'Both copies continued separately. Pulling keeps both as separate sessions.' },
};

export function StatusBadge({ status, labels }: { status: SyncStatus; labels?: Partial<Record<SyncStatus, string>> }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} icon={s.icon} title={s.help}>
      {labels?.[status] ?? s.label}
    </Badge>
  );
}

export function LiveDot({ status }: { status?: string }) {
  const busy = status !== 'idle';
  return (
    <span
      title={busy ? 'Claude is working in this session' : 'Open in Claude Code, waiting for you'}
      className={cx('inline-block size-2 shrink-0 rounded-full', busy ? 'live-dot bg-signal' : 'bg-good')}
    />
  );
}

// ------------------------------------------------------------------ layout

export function PageHeader({ title, description, actions, back, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { to: string; label: string }; children?: ReactNode }) {
  return (
    <header className="mb-6">
      {back && (
        <Link to={back.to} className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink">
          <ArrowLeft className="size-3.5" aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
          {description && <p className="mt-1 max-w-[68ch] text-base text-ink-2">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  padded = true,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
  id?: string;
}) {
  return (
    <section id={id} className={cx('rounded-[10px] border border-line bg-surface', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-md font-semibold leading-6 text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-ink-3">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {Icon && (
        <div className="mb-4 grid size-11 place-items-center rounded-[10px] border border-line bg-raised text-ink-2">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <h3 className="text-md font-semibold text-ink">{title}</h3>
      {children && <div className="mt-1.5 max-w-[52ch] text-base text-ink-2">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Callout({ tone = 'info', icon: Icon = TriangleAlert, title, children, action }: { tone?: 'info' | 'warn' | 'signal'; icon?: LucideIcon; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const styles = { info: 'bg-info-wash border-info/25', warn: 'bg-warn-wash border-warn/30', signal: 'bg-signal-wash border-signal-line/50' }[tone];
  const iconColor = { info: 'text-info', warn: 'text-warn', signal: 'text-ink' }[tone];
  return (
    <div className={cx('flex flex-wrap items-start gap-3 rounded-[10px] border px-4 py-3', styles)}>
      <Icon className={cx('mt-0.5 size-4 shrink-0', iconColor)} aria-hidden />
      <div className="min-w-[200px] flex-1">
        <p className="font-semibold text-ink">{title}</p>
        {children && <div className="mt-0.5 text-sm text-ink-2">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ form controls

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className={cx('flex items-start justify-between gap-4', disabled && 'opacity-60')}>
      <div className="min-w-0">
        <label htmlFor={id} className="font-medium text-ink">
          {label}
        </label>
        {description && <p className="mt-0.5 text-sm text-ink-3">{description}</p>}
      </div>
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors', checked ? 'border-ink bg-ink' : 'border-line-strong bg-sunken')}
      >
        <span className={cx('inline-block size-3.5 rounded-full transition-transform', checked ? 'translate-x-[18px] bg-signal' : 'translate-x-[2px] bg-ink-3')} />
      </button>
    </div>
  );
}

export function Checkbox({ checked, onChange, label, indeterminate, className }: { checked: boolean; onChange: (v: boolean) => void; label: string; indeterminate?: boolean; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className={cx('size-4 shrink-0 cursor-pointer rounded-[4px] accent-[var(--ink)]', className)}
    />
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: LucideIcon }>(function TextInput({ className, icon: Icon, ...rest }, ref) {
  return (
    <div className={cx('relative', className)}>
      {Icon && <Icon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />}
      <input
        ref={ref}
        className={cx(
          'h-9 w-full rounded-[7px] border border-line-strong bg-raised text-base text-ink placeholder:text-ink-3 focus:border-ink-2 focus:outline-none',
          Icon ? 'pl-8 pr-3' : 'px-3',
        )}
        {...rest}
      />
    </div>
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx('relative', className)}>
      <select
        className="h-9 w-full appearance-none rounded-[7px] border border-line-strong bg-raised pl-3 pr-8 text-base text-ink focus:border-ink-2 focus:outline-none"
        {...rest}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-9 rounded-[7px] border border-line-strong bg-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx('rounded-[5px] px-3 text-sm font-medium transition-colors', value === o.value ? 'bg-ink text-surface' : 'text-ink-2 hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ value: T; label: ReactNode; count?: number }>; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line scroll-thin">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            '-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-base font-medium transition-colors',
            value === t.value ? 'border-signal-line text-ink' : 'border-transparent text-ink-3 hover:text-ink',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="tnum rounded-[4px] bg-sunken px-1.5 text-xs text-ink-2">{t.count.toLocaleString()}</span>}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ misc

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx('size-4 animate-spin text-ink-3', className)} aria-label="Loading" />;
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx('h-1.5 overflow-hidden rounded-full bg-sunken', className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <div className="h-full rounded-full bg-ink transition-[width] duration-300" style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function CopyButton({ text, label = 'Copy', size = 'sm', variant = 'secondary', className }: { text: string; label?: string; size?: Size; variant?: Variant; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size={size}
      variant={variant}
      icon={done ? Check : Copy}
      className={className}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-line-strong bg-raised px-1 font-mono text-[11px] text-ink-2">{children}</kbd>;
}

export function Menu({ trigger, children, align = 'end' }: { trigger: (props: { onClick: () => void; 'aria-expanded': boolean }) => ReactNode; children: (close: () => void) => ReactNode; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open })}
      {open && (
        <div role="menu" className={cx('absolute z-40 mt-1 min-w-52 rounded-[8px] border border-line bg-raised p-1 shadow-[var(--shadow)]', align === 'end' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon: Icon, children, onClick, danger, disabled }: { icon?: LucideIcon; children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cx('flex w-full items-center gap-2.5 rounded-[5px] px-2.5 py-1.5 text-left text-base disabled:opacity-40', danger ? 'text-bad hover:bg-bad-wash' : 'text-ink hover:bg-sunken')}
    >
      {Icon && <Icon className="size-4 shrink-0 text-ink-3" aria-hidden />}
      {children}
    </button>
  );
}

export function Stat({ label, value, sub, title }: { label: string; value: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <p className="text-sm text-ink-3">{label}</p>
      <p className="mt-0.5 truncate text-xl font-semibold text-ink">{value}</p>
      {sub && <p className="truncate text-sm text-ink-3">{sub}</p>}
    </div>
  );
}
