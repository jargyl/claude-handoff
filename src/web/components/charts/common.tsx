import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChartColumn, Table2 } from 'lucide-react';
import { cx } from '../ui';

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];
export const OTHER = 'var(--series-other)';

/** Width of an element, kept up to date. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** "Nice" axis ticks: 0 and 3–4 round steps covering max. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

export interface LegendItem {
  label: string;
  color: string;
  kind?: 'rect' | 'line';
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className={i.kind === 'line' ? 'h-0.5 w-3 rounded-full' : 'size-2.5 rounded-[2px]'} style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export interface TableData {
  columns: string[];
  rows: Array<Array<string | number>>;
  align?: Array<'left' | 'right'>;
}

/** Card chrome for a chart: title, legend and a table view that carries every value. */
export function ChartFrame({ title, subtitle, legend, table, children, className, actions }: { title: string; subtitle?: ReactNode; legend?: LegendItem[]; table?: TableData; children: ReactNode; className?: string; actions?: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={cx('flex flex-col rounded-[10px] border border-line bg-surface', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-3.5">
        <div className="min-w-0">
          <h2 className="text-md font-semibold text-ink">{title}</h2>
          {subtitle && <p className="text-sm text-ink-3">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-1">
          {actions}
          {table && (
            <button
              onClick={() => setAsTable((v) => !v)}
              aria-pressed={asTable}
              title={asTable ? 'Show chart' : 'Show as table'}
              aria-label={asTable ? 'Show chart' : 'Show as table'}
              className="grid size-7 place-items-center rounded-[6px] text-ink-3 hover:bg-sunken hover:text-ink"
            >
              {asTable ? <ChartColumn className="size-4" /> : <Table2 className="size-4" />}
            </button>
          )}
        </div>
      </div>
      {legend && legend.length > 1 && !asTable && (
        <div className="px-4 pt-2">
          <Legend items={legend} />
        </div>
      )}
      <div className="min-w-0 flex-1 px-4 pb-4 pt-3">
        {asTable && table ? (
          <div className="max-h-[320px] overflow-auto rounded-[6px] border border-line scroll-thin">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-sunken text-ink-2">
                <tr>
                  {table.columns.map((c, i) => (
                    <th key={c} className={cx('px-3 py-1.5 font-medium', table.align?.[i] === 'right' ? 'text-right' : 'text-left')}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, ri) => (
                  <tr key={ri} className="border-t border-line">
                    {r.map((v, i) => (
                      <td key={i} className={cx('tnum px-3 py-1.5', table.align?.[i] === 'right' ? 'text-right' : 'text-left', i === 0 ? 'text-ink' : 'text-ink-2')}>
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

export function Tooltip({ x, y, containerWidth, children }: { x: number; y: number; containerWidth: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x + 12), Math.max(8, containerWidth - 220));
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 min-w-36 max-w-[220px] rounded-[8px] border border-line bg-raised px-3 py-2 text-sm shadow-[var(--shadow)]"
      style={{ left, top: Math.max(0, y - 8) }}
    >
      {children}
    </div>
  );
}

export function TipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      {color && <span aria-hidden className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: color }} />}
      <span className="tnum font-semibold text-ink">{value}</span>
      <span className="truncate text-ink-3">{label}</span>
    </div>
  );
}
