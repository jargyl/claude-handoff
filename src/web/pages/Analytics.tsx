import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { ChartColumn } from 'lucide-react';
import type { DayBucket, StatsResponse } from '../../shared/types';
import { useProjects, useSessions, useStats } from '../lib/queries';
import { addDaysKey, compact, cost, costAxis, localDateKey, plural } from '../lib/format';
import { ColumnChart, type ColumnDatum, type ColumnSeries } from '../components/charts/ColumnChart';
import { BarList } from '../components/charts/BarList';
import { CalendarHeatmap, HourHeatmap, ScaleLegend } from '../components/charts/Heatmaps';
import { ChartFrame, Legend, OTHER, SERIES } from '../components/charts/common';
import { EmptyState, PageHeader, Segmented, Select, Spinner } from '../components/ui';

type Preset = '7' | '30' | '90' | '365' | 'all';

/** Colors follow the model, not its rank: each family owns a slot, extra versions take the spare slots. */
function modelColors(labels: string[]): Map<string, string> {
  const FAMILY: Record<string, number> = { Opus: 0, Sonnet: 1, Haiku: 2, Fable: 3, Mythos: 6 };
  const spare = [4, 5, 7];
  const out = new Map<string, string>();
  const taken = new Set<number>();
  const sorted = [...labels].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const l of sorted) {
    const slot = FAMILY[l.split(' ')[0]!];
    if (slot !== undefined && !taken.has(slot)) {
      out.set(l, SERIES[slot]!);
      taken.add(slot);
    }
  }
  for (const l of sorted) {
    if (out.has(l)) continue;
    const slot = spare.find((s) => !taken.has(s));
    if (slot === undefined) out.set(l, OTHER);
    else {
      out.set(l, SERIES[slot]!);
      taken.add(slot);
    }
  }
  return out;
}

function bucketize(days: DayBucket[]): { data: DayBucket[]; unit: 'day' | 'week' | 'month' } {
  if (days.length <= 120) return { data: days, unit: 'day' };
  const unit = days.length > 730 ? 'month' : 'week';
  const map = new Map<string, DayBucket>();
  for (const d of days) {
    const date = new Date(`${d.date}T12:00:00`);
    let key: string;
    if (unit === 'month') key = d.date.slice(0, 7) + '-01';
    else {
      const monday = new Date(date);
      monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      key = localDateKey(monday);
    }
    const b = map.get(key) ?? { date: key, sessions: 0, prompts: 0, tokens: 0, cost: 0, byModel: {} };
    b.sessions += d.sessions;
    b.prompts += d.prompts;
    b.tokens += d.tokens;
    b.cost += d.cost;
    for (const [m, v] of Object.entries(d.byModel)) {
      const t = (b.byModel[m] ??= { tokens: 0, cost: 0 });
      t.tokens += v.tokens;
      t.cost += v.cost;
    }
    map.set(key, b);
  }
  return { data: [...map.values()], unit };
}

function series(stats: StatsResponse, colors: Map<string, string>): ColumnSeries[] {
  const top = stats.models.slice(0, 5).map((m) => m.label);
  const out = top.map((l) => ({ key: l, label: l, color: colors.get(l) ?? OTHER }));
  if (stats.models.length > 5) out.push({ key: 'Other', label: 'Other models', color: OTHER });
  return out;
}

function toColumns(buckets: DayBucket[], ser: ColumnSeries[], metric: 'tokens' | 'cost', unit: string): ColumnDatum[] {
  const keys = new Set(ser.map((s) => s.key));
  return buckets.map((b) => {
    const values: Record<string, number> = {};
    for (const [m, v] of Object.entries(b.byModel)) {
      const k = keys.has(m) ? m : 'Other';
      values[k] = (values[k] ?? 0) + v[metric];
    }
    const d = new Date(`${b.date}T12:00:00`);
    const label =
      unit === 'month'
        ? d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
        : unit === 'week'
          ? `Week of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
          : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const tick = unit === 'month' ? d.toLocaleDateString(undefined, { month: 'short' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return { key: b.date, label, tick, values };
  });
}

export default function Analytics() {
  const [params, setParams] = useSearchParams();
  const preset = (params.get('range') as Preset) || '30';
  const project = params.get('project') ?? '';
  const sessions = useSessions();
  const projects = useProjects();
  const today = localDateKey(new Date());
  const earliest = useMemo(() => {
    const list = sessions.data?.sessions ?? [];
    let min = today;
    for (const s of list) if (s.startedAt) min = localDateKey(new Date(s.startedAt)) < min ? localDateKey(new Date(s.startedAt)) : min;
    return min;
  }, [sessions.data, today]);
  const from = preset === 'all' ? earliest : addDaysKey(today, -(Number(preset) - 1));
  const stats = useStats({ from, to: today, project: project || undefined });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const s = stats.data;
  const colors = useMemo(() => modelColors(s?.models.map((m) => m.label) ?? []), [s]);
  const ser = useMemo(() => (s ? series(s, colors) : []), [s, colors]);
  const { data: buckets, unit } = useMemo(() => bucketize(s?.days ?? []), [s]);
  const tokenCols = useMemo(() => toColumns(buckets, ser, 'tokens', unit), [buckets, ser, unit]);
  const costCols = useMemo(() => toColumns(buckets, ser, 'cost', unit), [buckets, ser, unit]);
  const unitWord = unit === 'day' ? 'day' : unit;

  const mix = s
    ? [
        { label: 'Cache reads', value: s.totals.usage.cacheRead, color: 'var(--series-1)' },
        { label: 'Cache writes', value: s.totals.usage.cacheWrite5m + s.totals.usage.cacheWrite1h, color: 'var(--series-2)' },
        { label: 'Output', value: s.totals.usage.output, color: 'var(--series-3)' },
        { label: 'Input', value: s.totals.usage.input, color: 'var(--series-4)' },
      ]
    : [];
  const mixTotal = mix.reduce((n, m) => n + m.value, 0);

  return (
    <>
      <PageHeader title="Analytics" description="Usage across your sessions. Costs are API-equivalent estimates at list prices; a Claude subscription doesn't bill per token." />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Segmented<Preset>
          label="Time range"
          value={preset}
          onChange={(v) => set('range', v === '30' ? '' : v)}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
            { value: '365', label: 'Year' },
            { value: 'all', label: 'All time' },
          ]}
        />
        <Select value={project} onChange={(e) => set('project', e.target.value)} aria-label="Project" className="w-full sm:w-56">
          <option value="">All projects</option>
          {projects.data?.projects.map((p) => (
            <option key={p.dir} value={p.dir}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>

      {!s ? (
        <div className="grid h-60 place-items-center">
          <Spinner />
        </div>
      ) : s.totals.sessions === 0 && s.totals.prompts === 0 ? (
        <EmptyState icon={ChartColumn} title="No activity in this range">
          Pick a longer range, or another project.
        </EmptyState>
      ) : (
        <div className={stats.isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <div className="mb-5 grid grid-cols-2 gap-2 md:grid-cols-5">
            {[
              ['Sessions', s.totals.sessions.toLocaleString(), `${s.totals.activeDays} active ${s.totals.activeDays === 1 ? 'day' : 'days'}`],
              ['Prompts', s.totals.prompts.toLocaleString(), `${compact(s.totals.assistantMessages)} replies from Claude`],
              ['Tool calls', compact(s.totals.toolCalls), plural(s.tools.length, 'different tool')],
              ['Tokens', compact(s.totals.totalTokens), `${compact(s.totals.usage.output)} written by Claude`],
              ['API-equivalent cost', cost(s.totals.cost), s.totals.costPartial ? 'Some models have no known price' : `Longest streak ${s.totals.longestStreak} days`],
            ].map(([label, value, sub]) => (
              <div key={label} className="rounded-[8px] border border-line bg-surface px-3.5 py-3">
                <p className="text-sm text-ink-3">{label}</p>
                <p className="mt-0.5 text-2xl font-semibold">{value}</p>
                <p className="truncate text-xs text-ink-3">{sub}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartFrame
              title={`Tokens per ${unitWord}`}
              subtitle="By model, including cache reads"
              legend={ser.map((x) => ({ label: x.label, color: x.color }))}
              table={{ columns: ['Date', ...ser.map((x) => x.label), 'Total'], align: ['left', ...ser.map(() => 'right' as const), 'right'], rows: tokenCols.map((c) => [c.label, ...ser.map((x) => compact(c.values[x.key] ?? 0)), compact(Object.values(c.values).reduce((a, b) => a + b, 0))]) }}
            >
              <ColumnChart data={tokenCols} series={ser} format={compact} />
            </ChartFrame>
            <ChartFrame
              title={`Cost per ${unitWord}`}
              subtitle="API-equivalent, by model"
              legend={ser.map((x) => ({ label: x.label, color: x.color }))}
              table={{ columns: ['Date', ...ser.map((x) => x.label), 'Total'], align: ['left', ...ser.map(() => 'right' as const), 'right'], rows: costCols.map((c) => [c.label, ...ser.map((x) => cost(c.values[x.key] ?? 0)), cost(Object.values(c.values).reduce((a, b) => a + b, 0))]) }}
            >
              <ColumnChart data={costCols} series={ser} format={(n) => cost(n)} tickFormat={costAxis} />
            </ChartFrame>

            <ChartFrame
              title="Activity over the past year"
              subtitle="Prompts per day"
              className="lg:col-span-2"
              actions={<ScaleLegend />}
              table={{ columns: ['Date', 'Prompts', 'Tokens', 'Cost'], align: ['left', 'right', 'right', 'right'], rows: s.heatmap.filter((d) => d.prompts || d.tokens).reverse().map((d) => [d.date, d.prompts, compact(d.tokens), cost(d.cost)]) }}
            >
              <CalendarHeatmap
                days={s.heatmap}
                value={(d) => d.prompts}
                tip={(d) => `${new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}: ${plural(d.prompts, 'prompt')}, ${compact(d.tokens)} tokens, ${cost(d.cost)}`}
              />
            </ChartFrame>

            <ChartFrame
              title="When you work"
              subtitle="Prompts by weekday and hour"
              actions={<ScaleLegend />}
              table={{ columns: ['Day', ...Array.from({ length: 24 }, (_, h) => String(h))], rows: s.hourOfWeek.map((r, i) => [['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]!, ...r]) }}
            >
              <HourHeatmap matrix={s.hourOfWeek} />
            </ChartFrame>

            <ChartFrame title="Where the tokens go" subtitle="Share of all tokens by type">
              <div className="flex h-5 overflow-hidden rounded-[4px]" role="img" aria-label="Token mix">
                {mix.map((m, i) =>
                  m.value > 0 ? (
                    <div key={m.label} title={`${m.label}: ${compact(m.value)}`} style={{ width: `${(m.value / Math.max(1, mixTotal)) * 100}%`, background: m.color, marginLeft: i ? 2 : 0 }} />
                  ) : null,
                )}
              </div>
              <div className="mt-3">
                <Legend items={mix.map((m) => ({ label: `${m.label} ${mixTotal ? Math.round((m.value / mixTotal) * 1000) / 10 : 0}% (${compact(m.value)})`, color: m.color }))} />
              </div>
              <p className="mt-3 text-sm text-ink-3">Cache reads are cheap re-reads of the conversation so far. A high share means prompt caching is doing its job.</p>
            </ChartFrame>

            <ChartFrame title="Projects" subtitle="By API-equivalent cost" table={{ columns: ['Project', 'Sessions', 'Tokens', 'Cost'], align: ['left', 'right', 'right', 'right'], rows: s.projects.map((p) => [p.name, p.sessions, compact(p.tokens), cost(p.cost)]) }}>
              <BarList
                rows={s.projects.slice(0, 10).map((p) => ({ key: p.dir, label: p.name, value: p.cost, sub: plural(p.sessions, 'session'), title: p.path, to: `/sessions?project=${encodeURIComponent(p.dir)}` }))}
                format={(n) => cost(n)}
              />
            </ChartFrame>

            <ChartFrame title="Tools Claude used" subtitle="Calls in this range" table={{ columns: ['Tool', 'Calls'], align: ['left', 'right'], rows: s.tools.map((t) => [t.name, t.count]) }}>
              <BarList rows={s.tools.slice(0, 10).map((t) => ({ key: t.name, label: t.name.startsWith('mcp__') ? t.name.split('__').slice(1).join(' › ') : t.name, value: t.count }))} format={(n) => n.toLocaleString()} />
            </ChartFrame>

            <ChartFrame title="Models" subtitle="Tokens and cost per model">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-ink-3">
                    <tr className="border-b border-line">
                      <th className="py-1.5 pr-2 text-left font-medium">Model</th>
                      <th className="px-2 py-1.5 text-right font-medium">Replies</th>
                      <th className="px-2 py-1.5 text-right font-medium">Output</th>
                      <th className="px-2 py-1.5 text-right font-medium">Cache read</th>
                      <th className="py-1.5 pl-2 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.models.map((m) => (
                      <tr key={m.label} className="tnum border-b border-line last:border-0">
                        <td className="py-1.5 pr-2">
                          <span className="flex items-center gap-2">
                            <span className="size-2.5 rounded-[2px]" style={{ background: colors.get(m.label) ?? OTHER }} aria-hidden />
                            {m.label}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right text-ink-2">{m.messages.toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-right text-ink-2">{compact(m.usage.output)}</td>
                        <td className="px-2 py-1.5 text-right text-ink-2">{compact(m.usage.cacheRead)}</td>
                        <td className="py-1.5 pl-2 text-right">{cost(m.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ChartFrame>
          </div>
        </div>
      )}
    </>
  );
}
