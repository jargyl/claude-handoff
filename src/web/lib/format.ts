export function compact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (abs < 1_000_000) return Math.round(n / 1000) + 'k';
  if (abs < 10_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (abs < 1_000_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  return (n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '') + 'B';
}

export function cost(n: number | null | undefined, opts: { precise?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n >= 1000 && !opts.precise) return '$' + compact(n);
  return '$' + n.toFixed(2);
}

/** Short money labels for chart axes: $0, $2.5, $40, $1.2k */
export function costAxis(n: number): string {
  if (!n) return '$0';
  if (n >= 1000) return '$' + compact(n);
  if (n >= 10) return '$' + Math.round(n);
  if (n >= 1) return '$' + n.toFixed(1).replace(/\.0$/, '');
  return '$' + n.toFixed(2);
}

export function duration(ms: number): string {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function bytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

export function relative(input?: string | number | null): string {
  if (!input) return '—';
  const t = typeof input === 'number' ? input : Date.parse(input);
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return rtf ? rtf.format(-1, 'day') : 'yesterday';
  if (d < 7) return `${d}d ago`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function dateTime(input?: string | number | null): string {
  if (!input) return '';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function time(input?: string | null): string {
  if (!input) return '';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(input?: string | null): string {
  if (!input) return '';
  const d = new Date(input);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export const shortId = (id: string) => id.slice(0, 8);

export const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.4);
  return s.slice(0, head) + '…' + s.slice(s.length - (keep - head));
}

export function number(n: number): string {
  return n.toLocaleString();
}

export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaysKey(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDateKey(d);
}
