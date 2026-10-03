// Aggregations for the analytics page. Token usage is de-duplicated by API
// message id across files, so a conversation copied into a fork isn't counted twice.

import type { SessionIndex } from './claude/sessionIndex.js';
import { addUsage, emptyUsage, totalTokens, type DayBucket, type ModelStat, type StatsResponse } from '../shared/types.js';
import { costOf, modelLabel } from '../shared/pricing.js';
import { basename } from '../shared/paths.js';

export interface StatsParams {
  from?: string;
  to?: string;
  project?: string;
  tz?: string;
}

function safeTz(tz?: string): string {
  if (!tz) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

const DAY = 86_400_000;

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function computeStats(index: SessionIndex, params: StatsParams, overrides: Record<string, any>): StatsResponse {
  const tz = safeTz(params.tz);
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  const dayCache = new Map<number, string>();
  const dayOf = (t: number): string => {
    const k = Math.floor(t / 900_000); // every UTC offset is a multiple of 15 minutes
    let v = dayCache.get(k);
    if (!v) {
      v = dayFmt.format(new Date(t));
      dayCache.set(k, v);
    }
    return v;
  };
  const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

  const today = dayOf(Date.now());
  const to = params.to && /^\d{4}-\d{2}-\d{2}$/.test(params.to) ? params.to : today;
  const from = params.from && /^\d{4}-\d{2}-\d{2}$/.test(params.from) ? params.from : addDays(to, -29);
  const heatFrom = addDays(today, -364);

  const days = new Map<string, DayBucket & { sessionSet: Set<string> }>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    days.set(d, { date: d, sessions: 0, prompts: 0, tokens: 0, cost: 0, byModel: {}, sessionSet: new Set() });
    if (days.size > 3700) break;
  }
  const heat = new Map<string, { date: string; prompts: number; tokens: number; cost: number }>();
  for (let d = heatFrom; d <= today; d = addDays(d, 1)) heat.set(d, { date: d, prompts: 0, tokens: 0, cost: 0 });
  const activeAllTime = new Set<string>();

  const models = new Map<string, ModelStat>();
  const projects = new Map<string, { dir: string; name: string; path: string; sessions: Set<string>; tokens: number; cost: number }>();
  const tools = new Map<string, number>();
  const hourOfWeek = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const totalsUsage = emptyUsage();
  let totalCost = 0;
  let costPartial = false;
  let prompts = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  const sessionsInRange = new Set<string>();
  const seen = new Set<string>();

  const sessions = index.all().filter((s) => !params.project || s.projectDir === params.project);
  for (const s of sessions) {
    const info = index.projectInfo(s.projectDir);
    let touchedRange = false;
    const proj = projects.get(s.projectDir) ?? { dir: s.projectDir, name: basename(info.path), path: info.path, sessions: new Set<string>(), tokens: 0, cost: 0 };

    for (const f of [s.main, ...s.subagents]) {
      for (const ev of f.core.usage) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        if (!ev.t) continue;
        const day = dayOf(ev.t);
        const tokens = totalTokens(ev.u);
        const c = costOf(ev.u, ev.model, { fast: ev.fast, overrides });
        activeAllTime.add(day);
        const h = heat.get(day);
        if (h) {
          h.tokens += tokens;
          h.cost += c ?? 0;
        }
        const b = days.get(day);
        if (!b) continue;
        touchedRange = true;
        b.tokens += tokens;
        b.cost += c ?? 0;
        b.sessionSet.add(s.id);
        const label = modelLabel(ev.model);
        const bm = (b.byModel[label] ??= { tokens: 0, cost: 0 });
        bm.tokens += tokens;
        bm.cost += c ?? 0;
        addUsage(totalsUsage, ev.u);
        if (c === null) costPartial = true;
        else totalCost += c;
        assistantMessages++;
        const m = models.get(label) ?? { model: ev.model, label, messages: 0, usage: emptyUsage(), cost: 0 };
        m.messages++;
        addUsage(m.usage, ev.u);
        m.cost = c === null ? null : (m.cost ?? 0) + c;
        models.set(label, m);
        proj.tokens += tokens;
        proj.cost += c ?? 0;
      }
    }

    for (const t of s.main.core.promptTimes) {
      const day = dayOf(t);
      activeAllTime.add(day);
      const h = heat.get(day);
      if (h) h.prompts++;
      const b = days.get(day);
      if (!b) continue;
      touchedRange = true;
      b.prompts++;
      b.sessionSet.add(s.id);
      prompts++;
      const parts = partsFmt.formatToParts(new Date(t));
      const wd = WEEKDAYS[parts.find((p) => p.type === 'weekday')?.value ?? 'Mon'] ?? 0;
      const hr = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
      hourOfWeek[wd]![hr]!++;
    }

    if (touchedRange) {
      sessionsInRange.add(s.id);
      proj.sessions.add(s.id);
      projects.set(s.projectDir, proj);
      for (const f of [s.main, ...s.subagents]) {
        toolCalls += f.core.toolCalls;
        for (const [name, n] of Object.entries(f.core.tools)) tools.set(name, (tools.get(name) ?? 0) + n);
      }
    }
  }

  // streaks over all recorded history
  const sortedDays = [...activeAllTime].sort();
  let longest = 0;
  let run = 0;
  let prev: string | undefined;
  for (const d of sortedDays) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d;
  }
  let current = 0;
  let cursor = activeAllTime.has(today) ? today : addDays(today, -1);
  while (activeAllTime.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  const dayList: DayBucket[] = [...days.values()].map(({ sessionSet, ...b }) => ({ ...b, sessions: sessionSet.size }));
  return {
    from,
    to,
    totals: {
      sessions: sessionsInRange.size,
      prompts,
      assistantMessages,
      toolCalls,
      usage: totalsUsage,
      totalTokens: totalTokens(totalsUsage),
      cost: totalCost,
      costPartial,
      activeDays: dayList.filter((d) => d.prompts > 0 || d.tokens > 0).length,
      longestStreak: longest,
      currentStreak: current,
    },
    days: dayList,
    models: [...models.values()].sort((a, b) => totalTokens(b.usage) - totalTokens(a.usage)),
    projects: [...projects.values()]
      .map((p) => ({ dir: p.dir, name: p.name, path: p.path, sessions: p.sessions.size, tokens: p.tokens, cost: p.cost }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    tools: [...tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    hourOfWeek,
    heatmap: [...heat.values()],
  };
}

export { DAY };
