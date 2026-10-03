import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Brain, ChevronRight, CircleAlert, GitFork, Info, Layers, Scissors, Sparkles, SquareTerminal } from 'lucide-react';
import type { Block, TranscriptItem } from '../../../shared/types';
import { compact, duration, time, dayLabel } from '../../lib/format';
import { renderMarkdown } from '../../lib/markdown';
import { modelLabel } from '../../../shared/pricing';
import { ImageThumb, ToolCall, toolHasFind, type ToolContext } from './ToolCall';
import { cx } from '../ui';

type Assistant = Extract<TranscriptItem, { kind: 'assistant' }>;

export interface TranscriptFilters {
  tools: boolean;
  thinking: boolean;
  context: boolean;
  branches: boolean;
  meta: boolean;
}

export const DEFAULT_FILTERS: TranscriptFilters = { tools: true, thinking: true, context: false, branches: false, meta: false };

export type Unit =
  | { kind: 'item'; item: TranscriptItem; key: string }
  | { kind: 'activity'; items: Assistant[]; key: string }
  | { kind: 'branch'; items: TranscriptItem[]; key: string };

const isToolOnly = (it: TranscriptItem): it is Assistant =>
  it.kind === 'assistant' && it.blocks.length > 0 && it.blocks.every((b) => b.type === 'tool' || (b.type === 'thinking' && !b.text));

export function buildUnits(items: TranscriptItem[], f: TranscriptFilters): Unit[] {
  const units: Unit[] = [];
  let activity: Assistant[] | null = null;
  let branch: TranscriptItem[] | null = null;
  const flushActivity = () => {
    if (activity?.length) units.push({ kind: 'activity', items: activity, key: `a-${activity[0]!.uuid}` });
    activity = null;
  };
  const flushBranch = () => {
    if (branch?.length) units.push({ kind: 'branch', items: branch, key: `b-${branch[0]!.uuid}` });
    branch = null;
  };
  for (const it of items) {
    if (it.sidechain) continue;
    if (it.offBranch) {
      flushActivity();
      (branch ??= []).push(it);
      continue;
    }
    flushBranch();
    if (it.kind === 'context' && !f.context) continue;
    if (it.kind === 'user' && it.meta && !f.meta) continue;
    if (isToolOnly(it)) {
      (activity ??= []).push(it);
      continue;
    }
    flushActivity();
    units.push({ kind: 'item', item: it, key: it.uuid + it.line });
  }
  flushActivity();
  flushBranch();
  return units;
}

/** Plain text of a unit, for find-in-conversation. */
export function unitText(u: Unit): string {
  const parts: string[] = [];
  const add = (it: TranscriptItem) => {
    switch (it.kind) {
      case 'user':
        parts.push(it.text);
        break;
      case 'assistant':
        for (const b of it.blocks) {
          if (b.type === 'text' || b.type === 'thinking') parts.push(b.text);
          else if (b.type === 'tool') parts.push(b.name, JSON.stringify(b.input ?? ''), b.result?.text ?? '');
        }
        break;
      case 'command':
        parts.push(it.name, it.args ?? '', it.output ?? '');
        break;
      case 'shell':
        parts.push(it.input ?? '', it.stdout ?? '', it.stderr ?? '');
        break;
      case 'system':
      case 'context':
        parts.push(it.kind === 'system' ? it.text : `${it.label} ${it.text ?? ''}`);
        break;
      case 'compact':
        parts.push(it.summary ?? '');
        break;
      case 'notice':
        parts.push(it.label, it.text ?? '');
        break;
    }
  };
  if (u.kind === 'item') add(u.item);
  else for (const it of u.items) add(it);
  return parts.join('\n');
}

export function unitUuids(u: Unit): string[] {
  return u.kind === 'item' ? [u.item.uuid] : u.items.map((i) => i.uuid);
}

// ------------------------------------------------------------------ rows

function Gutter({ ts, who, sub }: { ts?: string; who?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-xs text-ink-3 md:flex-col md:items-end md:gap-0 md:pt-0.5 md:text-right">
      {who && <span className="text-sm font-semibold text-ink">{who}</span>}
      <span className="tnum" title={ts ? new Date(ts).toLocaleString() : undefined}>
        {time(ts)}
      </span>
      {sub && <span className="truncate md:max-w-full">{sub}</span>}
    </div>
  );
}

function Row({ children, gutter, className, id, highlight }: { children: ReactNode; gutter?: ReactNode; className?: string; id?: string; highlight?: boolean }) {
  return (
    <div
      id={id}
      className={cx(
        'cv-auto grid scroll-mt-24 grid-cols-1 gap-x-5 gap-y-1 rounded-[8px] px-2 py-3 md:grid-cols-[84px_minmax(0,1fr)]',
        highlight && 'bg-signal-wash ring-2 ring-signal-line/60',
        className,
      )}
    >
      <div>{gutter}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Your prompt text; text you pasted (wrapped by Claude Code in <pasted_content>) gets its own box. */
function UserText({ text, find }: { text: string; find?: string }) {
  const [more, setMore] = useState(false);
  const segments = useMemo(() => {
    const out: Array<{ pasted: boolean; text: string }> = [];
    const re = /<pasted_content[^>]*>([\s\S]*?)(?:<\/pasted_content>|$)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ pasted: false, text: text.slice(last, m.index) });
      out.push({ pasted: true, text: m[1]!.replace(/^\n+|\n+$/g, '') });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ pasted: false, text: text.slice(last) });
    return out.filter((s) => s.text.trim());
  }, [text]);
  const plain = segments.map((s) => s.text).join('\n');
  const long = plain.length > 1600 || plain.split('\n').length > 24;
  // a find match past the cut-off opens the whole prompt
  useEffect(() => {
    if (long && find && plain.toLowerCase().indexOf(find) > 1000) setMore(true);
  }, [find, long, plain]);
  let budget = long && !more ? 1200 : Infinity;
  return (
    <div className="flex flex-col gap-2">
      {segments.map((s, i) => {
        if (budget <= 0) return null;
        const t = s.text.length > budget ? s.text.slice(0, budget) + '…' : s.text;
        budget -= s.text.length;
        return s.pasted ? (
          <div key={i} className="rounded-[6px] border border-line bg-sunken/60 px-3 py-2">
            <p className="mb-1 text-xs font-medium text-ink-3">Pasted text</p>
            <p className="whitespace-pre-wrap break-words text-base leading-[1.55] text-ink-2">{t}</p>
          </div>
        ) : (
          <p key={i} className="whitespace-pre-wrap break-words text-md leading-[1.6] text-ink">
            {t}
          </p>
        );
      })}
      {long && (
        <button className="self-start text-sm font-medium text-ink-2 underline decoration-line-strong underline-offset-2" onClick={() => setMore((m) => !m)}>
          {more ? 'Show less' : `Show all ${plain.length.toLocaleString()} characters`}
        </button>
      )}
    </div>
  );
}

export const plainPromptText = (t: string) => t.replace(/<\/?pasted_content[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** `find` (from ToolContext, already lowercased) occurs in `text`. */
export const hasFind = (text: string | undefined, find: string | undefined) => !!find && !!text && text.toLowerCase().includes(find);

function Thinking({ b, find }: { b: Extract<Block, { type: 'thinking' }>; find?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (hasFind(b.text, find)) setOpen(true);
  }, [find, b.text]);
  // Newer models send short progress notes as thinking blocks that took no time: show them as narration.
  if (b.text && !b.redacted && (b.durationMs ?? 0) < 1000 && b.text.length < 1200) {
    return <p className="border-l-2 border-line pl-3 text-base italic leading-[1.6] text-ink-2">{b.text}</p>;
  }
  const label = b.redacted ? 'Reasoning (redacted)' : b.durationMs && b.durationMs >= 1000 ? `Thought for ${duration(b.durationMs)}` : 'Reasoning';
  if (!b.text) {
    if (!b.redacted && (b.durationMs ?? 0) < 1000) return null;
    return (
      <p className="flex items-center gap-1.5 py-0.5 text-sm text-ink-3">
        <Brain className="size-3.5" aria-hidden />
        {label}
      </p>
    );
  }
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1.5 py-0.5 text-sm text-ink-3 hover:text-ink-2">
        <ChevronRight className={cx('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
        <Brain className="size-3.5" aria-hidden />
        {label}
      </button>
      {open && <div className="prose mt-1 border-l-2 border-line pl-3 text-sm text-ink-2" dangerouslySetInnerHTML={{ __html: renderMarkdown(b.text) }} />}
    </div>
  );
}

const AssistantBody = memo(function AssistantBody({ it, ctx, f }: { it: Assistant; ctx: ToolContext; f: TranscriptFilters }) {
  return (
    <div className="flex flex-col gap-2">
      {it.blocks.map((b, i) => {
        if (b.type === 'text') return <div key={i} className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(b.text) }} />;
        // blocks hidden by the filters still show when they hold what you're finding
        if (b.type === 'thinking') return f.thinking || hasFind(b.text, ctx.find) ? <Thinking key={i} b={b} find={ctx.find} /> : null;
        return f.tools || toolHasFind(b, ctx.find) ? <ToolCall key={b.id} b={b} ctx={ctx} /> : null;
      })}
    </div>
  );
});

function toolNames(items: Assistant[]): string {
  const m = new Map<string, number>();
  for (const it of items) for (const b of it.blocks) if (b.type === 'tool') m.set(b.name.startsWith('mcp__') ? b.name.split('__')[1]! : b.name, (m.get(b.name) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
    .join(', ');
}

function Activity({ items, ctx, f, id, highlight }: { items: Assistant[]; ctx: ToolContext; f: TranscriptFilters; id: string; highlight?: boolean }) {
  const tools = items.flatMap((it) => it.blocks.filter((b): b is Extract<Block, { type: 'tool' }> => b.type === 'tool'));
  const thinking = items.flatMap((it) => it.blocks.filter((b): b is Extract<Block, { type: 'thinking' }> => b.type === 'thinking'));
  const [expanded, setExpanded] = useState(tools.length <= 6);
  const findTools = tools.some((b) => toolHasFind(b, ctx.find));
  const findThinking = thinking.filter((b) => hasFind(b.text, ctx.find));
  useEffect(() => {
    if (tools.slice(3, -2).some((b) => toolHasFind(b, ctx.find))) setExpanded(true);
  }, [ctx.find]);
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const span = first.ts && last.ts ? Date.parse(last.ts) - Date.parse(first.ts) : 0;
  const thought = thinking.reduce((n, b) => n + (b.durationMs ?? 0), 0);
  if (!f.tools && !findTools && !findThinking.length) {
    return (
      <Row id={id} highlight={highlight} gutter={<Gutter ts={first.ts} />} className="py-1.5">
        <p className="flex items-center gap-1.5 text-sm text-ink-3">
          <Layers className="size-3.5" aria-hidden />
          {tools.length} tool call{tools.length === 1 ? '' : 's'}: {toolNames(items)}
        </p>
      </Row>
    );
  }
  const shown = expanded ? tools : [...tools.slice(0, 3), ...tools.slice(-2)];
  return (
    <Row id={id} highlight={highlight} gutter={<Gutter ts={first.ts} />} className="py-2">
      <div className="flex flex-col gap-0.5">
        {f.thinking && thought >= 1000 && (
          <p className="flex items-center gap-1.5 px-2 py-0.5 text-sm text-ink-3">
            <Brain className="size-3.5" aria-hidden />
            Thought for {duration(thought)}
          </p>
        )}
        {findThinking.map((b, i) => (
          <div key={`t${i}`} className="px-2">
            <Thinking b={b} find={ctx.find} />
          </div>
        ))}
        {shown.map((b, i) => (
          <div key={b.id}>
            {!expanded && i === 3 && (
              <button onClick={() => setExpanded(true)} className="my-0.5 ml-2 text-sm font-medium text-ink-2 underline decoration-line-strong underline-offset-2">
                Show {tools.length - 5} more tool calls
              </button>
            )}
            <ToolCall b={b} ctx={ctx} />
          </div>
        ))}
        {tools.length > 6 && (
          <p className="px-2 pt-1 text-xs text-ink-3">
            {tools.length} tool calls{span > 60_000 ? ` over ${duration(span)}` : ''}: {toolNames(items)}
            {expanded && (
              <button onClick={() => setExpanded(false)} className="ml-2 underline decoration-line-strong underline-offset-2">
                Collapse
              </button>
            )}
          </p>
        )}
      </div>
    </Row>
  );
}

function Compact({ it }: { it: Extract<TranscriptItem, { kind: 'compact' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-3 rounded-[8px] border border-dashed border-line-strong bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
        <Scissors className="size-4 text-ink-3" aria-hidden />
        <span className="font-medium text-ink">Conversation compacted</span>
        <span className="text-ink-3">
          {it.trigger === 'auto' ? 'automatically' : it.trigger === 'manual' ? 'with /compact' : ''}
          {it.preTokens ? ` at ${compact(it.preTokens)} tokens` : ''} · {dayLabel(it.ts)} {time(it.ts)}
        </span>
        {it.summary && (
          <button onClick={() => setOpen((o) => !o)} className="ml-auto text-sm font-medium underline decoration-line-strong underline-offset-2">
            {open ? 'Hide summary' : 'Show the summary Claude kept'}
          </button>
        )}
      </div>
      {open && it.summary && <div className="prose mt-3 border-t border-line pt-3 text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(it.summary) }} />}
    </div>
  );
}

function ContextRow({ it }: { it: Extract<TranscriptItem, { kind: 'context' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-0.5 pl-2 md:pl-[104px]">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-2" aria-expanded={open}>
        <ChevronRight className={cx('size-3 transition-transform', open && 'rotate-90')} aria-hidden />
        <Info className="size-3" aria-hidden />
        {it.label}
      </button>
      {open && it.text && <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-[6px] border border-line bg-raised px-3 py-2 font-mono text-[11px] text-ink-2 scroll-thin">{it.text}</pre>}
    </div>
  );
}

function ItemRow({ it, ctx, f, id, highlight }: { it: TranscriptItem; ctx: ToolContext; f: TranscriptFilters; id: string; highlight?: boolean }) {
  switch (it.kind) {
    case 'user':
      return (
        <Row id={id} highlight={highlight} gutter={<Gutter ts={it.ts} who={it.meta ? 'Injected' : 'You'} />}>
          <div className={cx('border-l-[3px] pl-3', it.meta ? 'border-line-strong opacity-80' : 'border-signal')}>
            {it.text && <UserText text={it.text} find={ctx.find} />}
            {it.images.length > 0 && ctx.external && <p className="mt-2 text-xs text-ink-3">{it.images.length} image(s). Pull the session to see them.</p>}
            {it.images.length > 0 && !ctx.external && (
              <div className="mt-2 flex flex-wrap gap-2">
                {it.images.map((img) => (
                  <ImageThumb key={img.ref} src={`/api/sessions/${ctx.sessionId}/image/${encodeURIComponent(img.ref)}${ctx.agent ? `?agent=${ctx.agent}` : ''}`} />
                ))}
              </div>
            )}
          </div>
        </Row>
      );
    case 'assistant':
      return (
        <Row id={id} highlight={highlight} gutter={<Gutter ts={it.ts} who="Claude" sub={it.model ? modelLabel(it.model) : undefined} />}>
          <AssistantBody it={it} ctx={ctx} f={f} />
          {it.stopReason === 'max_tokens' && <p className="mt-2 text-sm text-warn">Cut off: the reply hit the output token limit.</p>}
        </Row>
      );
    case 'command':
      return (
        <Row id={id} highlight={highlight} gutter={<Gutter ts={it.ts} who="You" />} className="py-2">
          {it.name && (
            <p className="flex flex-wrap items-center gap-2">
              <code className="rounded-[5px] border border-line-strong bg-raised px-2 py-0.5 font-mono text-[13px] text-ink">
                {it.name}
                {it.args ? ` ${it.args}` : ''}
              </code>
            </p>
          )}
          {it.output && <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-[6px] bg-sunken px-3 py-2 font-mono text-[12px] text-ink-2 scroll-thin">{it.output.replace(/\x1b\[[0-9;]*m/g, '')}</pre>}
        </Row>
      );
    case 'shell':
      return (
        <Row id={id} highlight={highlight} gutter={<Gutter ts={it.ts} who="You" />} className="py-2">
          <div className="overflow-hidden rounded-[6px] border border-line bg-raised font-mono text-[12px]">
            <p className="flex items-center gap-2 border-b border-line bg-sunken px-3 py-1.5 text-ink">
              <SquareTerminal className="size-3.5 text-ink-3" aria-hidden />! {it.input}
            </p>
            {(it.stdout || it.stderr) && (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap px-3 py-2 text-ink-2 scroll-thin">
                {it.stdout}
                {it.stderr && <span className="text-bad">{it.stderr}</span>}
              </pre>
            )}
          </div>
        </Row>
      );
    case 'compact':
      return (
        <div id={id} className="scroll-mt-24">
          <Compact it={it} />
        </div>
      );
    case 'system':
      if (it.subtype === 'away_summary')
        return (
          <Row id={id} highlight={highlight} gutter={<Gutter ts={it.ts} />} className="py-2">
            <div className="rounded-[8px] border border-line bg-surface px-3.5 py-2.5 text-sm">
              <p className="mb-0.5 flex items-center gap-1.5 font-medium text-ink">
                <Sparkles className="size-3.5 text-ink-3" aria-hidden />
                Recap
              </p>
              <p className="text-ink-2">{it.text}</p>
            </div>
          </Row>
        );
      return (
        <div id={id} className="py-1 pl-2 text-sm text-ink-3 md:pl-[104px]">
          {it.text}
        </div>
      );
    case 'notice':
      return (
        <div id={id} className={cx('flex items-start gap-1.5 py-1 pl-2 text-sm md:pl-[104px]', it.tone === 'warn' ? 'text-warn' : 'text-ink-3')}>
          {it.tone === 'warn' ? <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
          <span>
            <span className="font-medium">{it.label}</span>
            {it.text ? `: ${it.text.length > 400 ? it.text.slice(0, 400) + '…' : it.text}` : ''}
          </span>
        </div>
      );
    case 'context':
      return (
        <div id={id}>
          <ContextRow it={it} />
        </div>
      );
  }
}

function Branch({ items, ctx, f, id }: { items: TranscriptItem[]; ctx: ToolContext; f: TranscriptFilters; id: string }) {
  const [open, setOpen] = useState(f.branches);
  useEffect(() => setOpen(f.branches), [f.branches]);
  const n = items.filter((i) => i.kind === 'user' || i.kind === 'assistant').length;
  return (
    <div id={id} className="my-2 rounded-[8px] border border-dashed border-line-strong">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-3 hover:text-ink-2" aria-expanded={open}>
        <ChevronRight className={cx('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
        <GitFork className="size-3.5" aria-hidden />
        Rewound branch: {n} message{n === 1 ? '' : 's'} that were edited or undone
      </button>
      {open && (
        <div className="border-t border-dashed border-line-strong px-1 opacity-75">
          {buildUnits(
            items.map((i) => ({ ...i, offBranch: false })),
            f,
          ).map((u) => (
            <UnitView key={u.key} u={u} ctx={ctx} f={f} />
          ))}
        </div>
      )}
    </div>
  );
}

export const UnitView = memo(function UnitView({ u, ctx, f, highlight }: { u: Unit; ctx: ToolContext; f: TranscriptFilters; highlight?: boolean }) {
  const first = u.kind === 'item' ? u.item : u.items[0]!;
  const id = `m-${first.uuid}`;
  if (u.kind === 'activity') return <Activity items={u.items} ctx={ctx} f={f} id={id} highlight={highlight} />;
  if (u.kind === 'branch') return <Branch items={u.items} ctx={ctx} f={f} id={id} />;
  return <ItemRow it={u.item} ctx={ctx} f={f} id={id} highlight={highlight} />;
});

/** Renders units progressively so huge sessions don't block the first paint. */
export function TranscriptView({
  units,
  ctx,
  f,
  highlightIndex,
  renderTo,
  renderAll,
}: {
  units: Unit[];
  ctx: ToolContext;
  f: TranscriptFilters;
  highlightIndex?: number;
  /** a unit you're jumping to: render at least up to it */
  renderTo?: number;
  renderAll?: boolean;
}) {
  const [limit, setLimit] = useState(120);
  useEffect(() => {
    const need = Math.max(highlightIndex ?? -1, renderTo ?? -1);
    if (renderAll || need >= limit) setLimit(units.length);
  }, [renderAll, highlightIndex, renderTo, units.length, limit]);
  useEffect(() => {
    if (limit >= units.length) return;
    const t = window.setTimeout(() => setLimit((l) => l + 250), 30);
    return () => clearTimeout(t);
  }, [limit, units.length]);
  const shown = useMemo(() => units.slice(0, limit), [units, limit]);
  return (
    <div className="flex flex-col">
      {shown.map((u, i) => (
        <UnitView key={u.key} u={u} ctx={ctx} f={f} highlight={i === highlightIndex} />
      ))}
      {limit < units.length && <p className="py-6 text-center text-sm text-ink-3">Loading the rest of the conversation…</p>}
    </div>
  );
}
