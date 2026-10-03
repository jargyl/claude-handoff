import type { ReactNode } from 'react';
import { Link } from 'react-router';

/** Horizontal bars, one series: values sit at the bar tips, so no tooltip is needed. */
export function BarList({
  rows,
  format,
  color = 'var(--series-1)',
  max,
}: {
  rows: Array<{ key: string; label: ReactNode; value: number; sub?: ReactNode; to?: string; title?: string }>;
  format: (n: number) => string;
  color?: string;
  max?: number;
}) {
  const top = max ?? Math.max(0, ...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => {
        const pct = top > 0 ? (r.value / top) * 100 : 0;
        const label = (
          <span className="flex min-w-0 items-baseline justify-between gap-3">
            <span className="truncate text-base text-ink" title={r.title}>
              {r.label}
            </span>
            <span className="tnum shrink-0 text-sm text-ink-2">
              {format(r.value)}
              {r.sub && <span className="ml-1.5 text-ink-3">{r.sub}</span>}
            </span>
          </span>
        );
        return (
          <li key={r.key}>
            {r.to ? (
              <Link to={r.to} className="block rounded-[4px] hover:bg-sunken/60">
                {label}
              </Link>
            ) : (
              label
            )}
            <div className="mt-1 h-2 rounded-r-[4px] bg-transparent">
              <div className="h-2 rounded-r-[4px]" style={{ width: `${Math.max(pct, r.value > 0 ? 0.8 : 0)}%`, background: color }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
