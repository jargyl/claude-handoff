import { useState } from 'react';
import { Tooltip, TipRow, niceTicks, useWidth } from './common';

export interface ColumnSeries {
  key: string;
  label: string;
  color: string;
}

export interface ColumnDatum {
  key: string;
  label: string; // tooltip heading
  tick: string; // axis label
  values: Record<string, number>;
}

const GAP = 2; // surface gap between stacked segments
const RADIUS = 4;

function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Stacked columns over time. The whole band is the hover target; one tooltip lists every series. */
export function ColumnChart({ data, series, height = 200, format, tickFormat = format }: { data: ColumnDatum[]; series: ColumnSeries[]; height?: number; format: (n: number) => string; tickFormat?: (n: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const axisW = 52;
  const axisH = 22;
  const innerW = Math.max(0, width - axisW);
  const innerH = height - axisH;
  const totals = data.map((d) => series.reduce((s, se) => s + (d.values[se.key] ?? 0), 0));
  const max = Math.max(0, ...totals);
  const ticks = niceTicks(max, 4);
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => innerH - (v / top) * innerH;
  const band = data.length ? innerW / data.length : 0;
  const barW = Math.max(2, Math.min(24, band - Math.max(2, band * 0.3)));
  const labelEvery = Math.max(1, Math.ceil(44 / Math.max(1, band)));

  return (
    <div
      ref={ref}
      className="relative outline-none"
      tabIndex={0}
      aria-label="Chart. Use the arrow keys to read each column."
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') setHover((h) => Math.min(data.length - 1, (h ?? -1) + 1));
        else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? data.length) - 1));
        else if (e.key === 'Escape') setHover(null);
      }}
      onBlur={() => setHover(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-hidden className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={axisW} x2={width} y1={y(t) + 0.5} y2={y(t) + 0.5} stroke={t === 0 ? 'var(--line-strong)' : 'var(--line)'} strokeWidth={1} />
              <text x={axisW - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tnum fill-[var(--ink-3)] text-[11px]">
                {tickFormat(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = axisW + i * band + (band - barW) / 2;
            let cursor = innerH;
            const segs = series
              .map((se) => ({ se, v: d.values[se.key] ?? 0 }))
              .filter((s) => s.v > 0);
            const dim = hover !== null && hover !== i;
            return (
              <g key={d.key} opacity={dim ? 0.55 : 1}>
                {segs.map((s, si) => {
                  const h = (s.v / top) * innerH;
                  const isTop = si === segs.length - 1;
                  const gap = si > 0 ? GAP : 0;
                  const yTop = cursor - h;
                  const hh = Math.max(0, h - gap);
                  cursor = yTop;
                  if (hh < 0.5) return null;
                  return isTop ? (
                    <path key={s.se.key} d={topRounded(cx, yTop, barW, hh, RADIUS)} fill={s.se.color} />
                  ) : (
                    <rect key={s.se.key} x={cx} y={yTop} width={barW} height={hh} fill={s.se.color} />
                  );
                })}
                {i % labelEvery === 0 && (
                  <text x={axisW + i * band + band / 2} y={height - 6} textAnchor="middle" className="fill-[var(--ink-3)] text-[11px]">
                    {d.tick}
                  </text>
                )}
                <rect
                  x={axisW + i * band}
                  y={0}
                  width={band}
                  height={innerH}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover((h) => (h === i ? null : h))}
                />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <Tooltip x={axisW + hover * band + band / 2} y={8} containerWidth={width}>
          <p className="mb-1 text-xs font-medium text-ink-2">{data[hover]!.label}</p>
          <TipRow label="Total" value={format(totals[hover]!)} />
          {series
            .filter((se) => (data[hover]!.values[se.key] ?? 0) > 0)
            .map((se) => (
              <TipRow key={se.key} color={se.color} label={se.label} value={format(data[hover]!.values[se.key]!)} />
            ))}
        </Tooltip>
      )}
    </div>
  );
}
