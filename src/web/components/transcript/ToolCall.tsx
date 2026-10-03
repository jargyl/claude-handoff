import { memo, useState, type ReactNode } from 'react';
import {
  Bot,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { Block, ToolResult } from '../../../shared/types';
import { api } from '../../lib/api';
import { duration } from '../../lib/format';
import { highlight, langFromPath, renderMarkdown } from '../../lib/markdown';
import { relativeUnder, tildify } from '../../../shared/paths';
import { DiffView, SimpleDiff, patchStats } from './Diff';
import { Button, Spinner, cx } from '../ui';

type ToolBlock = Extract<Block, { type: 'tool' }>;

export interface ToolContext {
  sessionId: string;
  agent?: string;
  projectPath: string;
  home: string;
  live: boolean;
  /** viewing a session that lives on another device or in the sync folder: images and full output stay there */
  external?: boolean;
  onOpenSubagent?: (agentId: string) => void;
}

const ICONS: Record<string, LucideIcon> = {
  Bash: SquareTerminal,
  PowerShell: SquareTerminal,
  BashOutput: SquareTerminal,
  Read: FileText,
  NotebookRead: FileText,
  Write: FilePlus,
  Edit: FilePen,
  MultiEdit: FilePen,
  NotebookEdit: FilePen,
  Grep: Search,
  Glob: FolderSearch,
  LS: FolderSearch,
  WebFetch: Globe,
  WebSearch: Globe,
  web_search: Globe,
  web_fetch: Globe,
  Agent: Bot,
  Task: Bot,
  TodoWrite: ListTodo,
};

export function displayPath(p: string, ctx: ToolContext): string {
  const rel = relativeUnder(p, ctx.projectPath);
  if (rel !== null && rel !== '') return rel;
  return tildify(p, ctx.home);
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function toolSummary(b: ToolBlock, ctx: ToolContext): { label: string; detail?: string; mono?: boolean; extra?: ReactNode } {
  const i = (b.input ?? {}) as Record<string, any>;
  const name = b.name;
  if (name === 'Bash' || name === 'PowerShell') return { label: name === 'PowerShell' ? 'PowerShell' : 'Bash', detail: str(i.command)?.split('\n')[0], mono: true };
  if (name === 'Read' || name === 'NotebookRead') {
    const p = str(i.file_path) ?? str(i.notebook_path);
    const range = i.offset ? ` · from line ${i.offset}${i.limit ? `, ${i.limit} lines` : ''}` : '';
    return { label: 'Read', detail: p ? displayPath(p, ctx) + range : undefined, mono: true };
  }
  if (name === 'Write') return { label: 'Write', detail: str(i.file_path) && displayPath(i.file_path, ctx), mono: true };
  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const p = str(i.file_path) ?? str(i.notebook_path);
    const st = patchStats(b.result?.meta?.patch);
    return {
      label: name === 'MultiEdit' ? 'Edit (multiple)' : 'Edit',
      detail: p && displayPath(p, ctx),
      mono: true,
      extra:
        st.add || st.del ? (
          <span className="tnum shrink-0 font-mono text-xs">
            <span className="text-add-ink">+{st.add}</span> <span className="text-del-ink">−{st.del}</span>
          </span>
        ) : undefined,
    };
  }
  if (name === 'Grep') return { label: 'Grep', detail: `${i.pattern ?? ''}${i.path ? `  in ${displayPath(i.path, ctx)}` : ''}${i.glob ? `  (${i.glob})` : ''}`, mono: true };
  if (name === 'Glob') return { label: 'Glob', detail: `${i.pattern ?? ''}${i.path ? `  in ${displayPath(i.path, ctx)}` : ''}`, mono: true };
  if (name === 'WebFetch' || name === 'web_fetch') return { label: 'Fetch', detail: str(i.url), mono: true };
  if (name === 'WebSearch' || name === 'web_search') return { label: 'Web search', detail: str(i.query) };
  if (name === 'Agent' || name === 'Task') return { label: i.subagent_type ? `Agent · ${i.subagent_type}` : 'Agent', detail: str(i.description) };
  if (name === 'TodoWrite') return { label: 'Todo list', detail: Array.isArray(i.todos) ? `${i.todos.filter((t: any) => t.status === 'completed').length} of ${i.todos.length} done` : undefined };
  if (name === 'ToolSearch') return { label: 'Tool search', detail: str(i.query) };
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
    return { label: `${server} › ${tool}`, detail: first?.split('\n')[0] };
  }
  const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
  return { label: name, detail: first?.split('\n')[0] };
}

function Pre({ children, className, html }: { children?: ReactNode; className?: string; html?: string }) {
  if (html !== undefined)
    return <pre className={cx('max-h-[420px] overflow-auto rounded-[6px] border border-line bg-raised px-3 py-2 font-mono text-[12px] leading-[1.55] scroll-thin', className)} dangerouslySetInnerHTML={{ __html: html }} />;
  return <pre className={cx('max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-[6px] border border-line bg-raised px-3 py-2 font-mono text-[12px] leading-[1.55] scroll-thin', className)}>{children}</pre>;
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

function FullOutput({ result, toolId, ctx }: { result: ToolResult; toolId: string; ctx: ToolContext }) {
  const [full, setFull] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!result.truncated || ctx.external) return null;
  if (full !== null) return <Pre className="mt-2">{stripAnsi(full)}</Pre>;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="mt-1.5"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const line = await api.get<any>(`/api/sessions/${ctx.sessionId}/line/${result.line}${ctx.agent ? `?agent=${ctx.agent}` : ''}`);
          const block = (line?.message?.content ?? []).find((c: any) => c?.type === 'tool_result' && c.tool_use_id === toolId);
          const c = block?.content;
          setFull(typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n') : JSON.stringify(line, null, 2));
        } finally {
          setBusy(false);
        }
      }}
    >
      Show all {result.fullLength.toLocaleString()} characters
    </Button>
  );
}

function ResultImages({ result, ctx }: { result: ToolResult; ctx: ToolContext }) {
  if (!result.images.length) return null;
  if (ctx.external) return <p className="mt-2 text-xs text-ink-3">{result.images.length} image(s). Pull the session to see them.</p>;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {result.images.map((img) => (
        <ImageThumb key={img.ref} src={`/api/sessions/${ctx.sessionId}/image/${encodeURIComponent(img.ref)}${ctx.agent ? `?agent=${ctx.agent}` : ''}`} />
      ))}
    </div>
  );
}

export function ImageThumb({ src }: { src: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="overflow-hidden rounded-[6px] border border-line bg-raised hover:border-ink-3" aria-label="Open image">
        <img src={src} loading="lazy" alt="" className="block max-h-48 max-w-[320px] object-contain" />
      </button>
      {open && (
        <div role="dialog" aria-modal="true" aria-label="Image" className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-6" onClick={() => setOpen(false)}>
          <img src={src} alt="" className="max-h-full max-w-full rounded-[6px] shadow-2xl" />
        </div>
      )}
    </>
  );
}

function Todos({ todos }: { todos: Array<{ content: string; status: string; activeForm?: string }> }) {
  return (
    <ul className="flex flex-col gap-1 rounded-[6px] border border-line bg-raised px-3 py-2 text-sm">
      {todos.map((t, i) => (
        <li key={i} className="flex items-start gap-2">
          {t.status === 'completed' ? (
            <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-good" aria-label="Done" />
          ) : t.status === 'in_progress' ? (
            <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-signal-line" aria-label="In progress" />
          ) : (
            <span className="mt-1 size-3 shrink-0 rounded-full border border-line-strong" aria-label="To do" />
          )}
          <span className={cx(t.status === 'completed' && 'text-ink-3 line-through')}>{t.content}</span>
        </li>
      ))}
    </ul>
  );
}

function Details({ b, ctx }: { b: ToolBlock; ctx: ToolContext }) {
  const i = (b.input ?? {}) as Record<string, any>;
  const r = b.result;
  const name = b.name;
  const parts: ReactNode[] = [];

  if (name === 'Bash' || name === 'PowerShell') {
    parts.push(<Pre key="cmd" html={highlight(String(i.command ?? ''), name === 'PowerShell' ? 'powershell' : 'bash')} />);
    if (i.description) parts.unshift(<p key="desc" className="text-sm text-ink-2">{i.description}</p>);
  } else if ((name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') && r?.meta?.patch?.length) {
    parts.push(<DiffView key="diff" patch={r.meta.patch} truncated={r.meta.patchTruncated} />);
  } else if (name === 'Edit' && typeof i.old_string === 'string') {
    parts.push(<SimpleDiff key="diff" oldText={i.old_string} newText={String(i.new_string ?? '')} />);
  } else if (name === 'Write' && typeof i.content === 'string') {
    parts.push(<Pre key="content" html={highlight(i.content, langFromPath(String(i.file_path ?? '')))} />);
  } else if (name === 'TodoWrite' && Array.isArray(i.todos)) {
    parts.push(<Todos key="todos" todos={i.todos} />);
  } else if ((name === 'Agent' || name === 'Task') && typeof i.prompt === 'string') {
    parts.push(
      <details key="prompt" className="rounded-[6px] border border-line bg-raised px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-ink-2">Instructions given to the agent</summary>
        <div className="prose mt-2 text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(i.prompt) }} />
      </details>,
    );
  } else if (name !== 'Read') {
    parts.push(<Pre key="input">{JSON.stringify(b.input, null, 2)}</Pre>);
  }
  if (b.inputTruncated) parts.push(<p key="trunc" className="text-xs text-ink-3">Input shortened for display.</p>);

  if (r) {
    const agentId = r.meta?.agentId;
    const out = r.meta?.stdout !== undefined || r.meta?.stderr ? `${r.meta?.stdout ?? ''}${r.meta?.stderr ? `\n${r.meta.stderr}` : ''}` : r.text;
    if ((name === 'Agent' || name === 'Task') && !r.isError) {
      parts.push(
        <div key="res">
          {r.text && <div className="prose max-h-[420px] overflow-auto rounded-[6px] border border-line bg-raised px-3 py-2 text-sm scroll-thin" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.text) }} />}
          {agentId && ctx.onOpenSubagent && (
            <Button size="sm" className="mt-2" icon={Bot} onClick={() => ctx.onOpenSubagent!(agentId)}>
              Open the agent's transcript
            </Button>
          )}
        </div>,
      );
    } else if (name === 'TodoWrite' || ((name === 'Edit' || name === 'Write') && r.meta?.patch?.length && !r.isError)) {
      // the diff/list above says it all
    } else if (out.trim() || r.images.length) {
      parts.push(
        <div key="res">
          {out.trim() && <Pre className={r.isError ? 'border-bad/40 text-bad' : ''}>{stripAnsi(out)}</Pre>}
          <ResultImages result={r} ctx={ctx} />
          <FullOutput result={r} toolId={b.id} ctx={ctx} />
        </div>,
      );
    }
    if (r.meta?.interrupted) parts.push(<p key="int" className="text-sm text-warn">Interrupted</p>);
  }
  return <div className="flex flex-col gap-2 pb-2 pl-9 pr-1 pt-1">{parts}</div>;
}

export const ToolCall = memo(function ToolCall({ b, ctx, defaultOpen = false }: { b: ToolBlock; ctx: ToolContext; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = ICONS[b.name] ?? (b.name.startsWith('mcp__') ? Plug : Wrench);
  const s = toolSummary(b, ctx);
  const r = b.result;
  const took = b.ts && r?.ts ? Date.parse(r.ts) - Date.parse(b.ts) : 0;
  return (
    <div className={cx('rounded-[6px] border', open ? 'border-line bg-surface' : 'border-transparent')}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-[6px] px-2 py-1 text-left hover:bg-sunken"
      >
        <ChevronRight className={cx('size-3.5 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} aria-hidden />
        <Icon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        <span className="shrink-0 text-sm font-medium text-ink-2">{s.label}</span>
        {s.detail && <span className={cx('min-w-0 truncate text-sm text-ink-3', s.mono && 'font-mono text-[12px]')}>{s.detail}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {s.extra}
          {took > 1500 && <span className="tnum text-xs text-ink-3">{duration(took)}</span>}
          {!r ? (
            ctx.live ? <Spinner className="size-3.5" /> : <CircleDashed className="size-3.5 text-ink-3" aria-label="No result recorded" />
          ) : r.isError ? (
            <CircleX className="size-3.5 text-bad" aria-label="Failed" />
          ) : (
            <CircleCheck className="size-3.5 text-good/80" aria-label="Done" />
          )}
        </span>
      </button>
      {open && <Details b={b} ctx={ctx} />}
    </div>
  );
});
