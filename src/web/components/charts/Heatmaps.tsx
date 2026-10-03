import { useMemo, useState } from 'react';
import { Tooltip, useWidth } from './common';

const LEVELS = ['var(--seq-0)', 'var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];

/** Quantile thresholds over the non-zero values, so one huge day doesn't wash out the rest. */
function levelFn(values: number[]): (v: number) => number {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nz.length === 0) return () => 0;
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))]!;
  const t = [q(0.2), q(0.4), q(0.6), q(0.8)];
  return (v) => (v <= 0 ? 0 : v <= t[0]! ? 1 : v <= t[1]! ? 2 : v <= t[2]! ? 3 : v <= t[3]! ? 4 : 5);
}

export function ScaleLegend() {
  return (
    <div className="flex items-center gap-1.5 text-xs text-ink-3">
      <span>Less</span>
      {LEVELS.map((c) => (
        <span key={c} className="size-2.5 rounded-[2px]" style={{ background: c }} aria-hidden />
      ))}
      <span>More</span>
    </div>
  );
}

export function CalendarHeatmap({
  days,
  value,
  tip,
  onPick,
}: {
  days: Array<{ date: string }>;
  value: (d: any) => number;
  tip: (d: any) => string;
  onPick?: (date: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  // In narrow spaces show the most recent weeks rather than clipping them off
  const fit = Math.max(4, Math.floor((width - 30) / 9));
  const { cells, weeks, months, level } = useMemo(() => {
    const level = levelFn(days.map(value));
    const allFirst = days[0] ? new Date(`${days[0].date}T12:00:00`) : new Date();
    const allOffset = (allFirst.getDay() + 6) % 7; // Monday = 0
    const totalWeeks = Math.ceil((days.length + allOffset) / 7);
    const dropWeeks = width > 0 ? Math.max(0, totalWeeks - fit) : 0;
    const start = Math.max(0, dropWeeks * 7 - allOffset);
    const shown = days.slice(start);
    const first = shown[0] ? new Date(`${shown[0].date}T12:00:00`) : new Date();
    const offset = (first.getDay() + 6) % 7;
    const cells = shown.map((d, i) => ({ d, i, col: Math.floor((i + offset) / 7), row: (i + offset) % 7 }));
    const weeks = cells.length ? cells[cells.length - 1]!.col + 1 : 0;
    const months: Array<{ col: number; label: string }> = [];
    let last = -1;
    for (const c of cells) {
      const m = Number(c.d.date.slice(5, 7));
      if (m !== last && c.row === 0) {
        months.push({ col: c.col, label: new Date(`${c.d.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short' }) });
        last = m;
      } else if (last === -1) last = m;
    }
    return { cells, weeks, months, level };
  }, [days, value, fit, width]);

  const left = 30;
  const cell = Math.max(7, Math.min(15, Math.floor((width - left) / Math.max(1, weeks)) - 2));
  const pitch = cell + 2;
  const height = 18 + pitch * 7;

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg width={Math.min(width, left + weeks * pitch)} height={height} role="img" aria-hidden className="block">
          {months.map((m, i) =>
            i > 0 && m.col - months[i - 1]!.col < 3 ? null : (
              <text key={`${m.col}-${m.label}`} x={left + m.col * pitch} y={10} className="fill-[var(--ink-3)] text-[11px]">
                {m.label}
              </text>
            ),
          )}
          {['Mon', 'Wed', 'Fri'].map((d, i) => (
            <text key={d} x={0} y={18 + (i * 2) * pitch + cell - 1} className="fill-[var(--ink-3)] text-[11px]">
              {d}
            </text>
          ))}
          {cells.map((c) => (
            <rect
              key={c.d.date}
              x={left + c.col * pitch}
              y={18 + c.row * pitch}
              width={cell}
              height={cell}
              rx={2}
              fill={LEVELS[level(value(c.d))]}
              stroke={hover?.i === c.i ? 'var(--ink)' : 'none'}
              strokeWidth={1.5}
              onPointerEnter={() => setHover({ i: c.i, x: left + c.col * pitch, y: 18 + c.row * pitch + cell })}
              onPointerLeave={() => setHover((h) => (h?.i === c.i ? null : h))}
              onClick={() => onPick?.(c.d.date)}
              style={{ cursor: onPick ? 'pointer' : undefined }}
            />
          ))}
        </svg>
      )}
      {hover && cells[hover.i] && (
        <Tooltip x={hover.x} y={hover.y} containerWidth={width}>
          <p className="text-ink">{tip(cells[hover.i]!.d)}</p>
        </Tooltip>
      )}
    </div>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function HourHeatmap({ matrix }: { matrix: number[][] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const level = useMemo(() => levelFn(matrix.flat()), [matrix]);
  const left = 34;
  const cellW = Math.max(6, (width - left) / 24 - 2);
  const pitchX = cellW + 2;
  const cellH = 16;
  const pitchY = cellH + 3;
  const height = 7 * pitchY + 18;
  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-hidden className="block">
          {matrix.map((row, d) => (
            <g key={d}>
              <text x={0} y={d * pitchY + cellH - 4} className="fill-[var(--ink-3)] text-[11px]">
                {DAYS[d]}
              </text>
              {row.map((v, h) => (
                <rect
                  key={h}
                  x={left + h * pitchX}
                  y={d * pitchY}
                  width={cellW}
                  height={cellH}
                  rx={2}
                  fill={LEVELS[level(v)]}
                  stroke={hover?.d === d && hover.h === h ? 'var(--ink)' : 'none'}
                  strokeWidth={1.5}
                  onPointerEnter={() => setHover({ d, h })}
                  onPointerLeave={() => setHover(null)}
                />
              ))}
            </g>
          ))}
          {[0, 6, 12, 18, 23].map((h) => (
            <text
              key={h}
              x={h === 23 ? left + 24 * pitchX - 2 : h === 0 ? left : left + h * pitchX + cellW / 2}
              y={height - 4}
              textAnchor={h === 23 ? 'end' : h === 0 ? 'start' : 'middle'}
              className="tnum fill-[var(--ink-3)] text-[11px]"
            >
              {String(h).padStart(2, '0')}:00
            </text>
          ))}
        </svg>
      )}
      {hover && (
        <Tooltip x={left + hover.h * pitchX} y={hover.d * pitchY + cellH} containerWidth={width}>
          <p className="tnum font-semibold text-ink">
            {matrix[hover.d]![hover.h]!.toLocaleString()} prompt{matrix[hover.d]![hover.h] === 1 ? '' : 's'}
          </p>
          <p className="text-ink-3">
            {DAYS[hover.d]} {String(hover.h).padStart(2, '0')}:00–{String(hover.h).padStart(2, '0')}:59
          </p>
        </Tooltip>
      )}
    </div>
  );
}

/** 2px line with a 10% wash, for stat-tile trends. */
export function Sparkline({ values, className = 'h-8 w-28' }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 30 - (v / max) * 28] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('');
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className={className} aria-hidden>
      <path d={`${line}L100,32L0,32Z`} fill="var(--series-1)" opacity={0.1} />
      <path d={line} fill="none" stroke="var(--series-1)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
