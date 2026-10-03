// Turns raw JSONL lines into a readable conversation: assistant lines that belong
// to one API message are merged, tool results are attached to their tool calls,
// slash commands / shell commands / notifications get their own item kinds, and
// injected context is kept but marked so the UI can hide it.

import { readLines, tryParse } from '../util/lines.js';
import { classifyUserText, contentText, oneLine, stripInjected, tagContent } from './text.js';
import { toUsage } from './parse.js';
import type { Block, ImageRef, PatchHunk, ToolResult, ToolResultMeta, Transcript, TranscriptItem, Usage } from '../../shared/types.js';
import { isSyntheticModel } from '../../shared/pricing.js';

export interface CorpusEntry {
  uuid: string;
  role: 'user' | 'assistant' | 'tool';
  ts?: string;
  text: string;
}

export interface TranscriptBuild {
  transcript: Transcript;
  /** [start, length] byte ranges per line */
  ranges: Float64Array;
  corpus: CorpusEntry[];
}

const TEXT_LIMIT = 3000; // tool result text sent to the UI before "show full"
const INPUT_STRING_LIMIT = 6000;
const PROSE_LIMIT = 40000;
const CORPUS_TOOL_LIMIT = 2000;

/** Attachment kinds that are pure plumbing — dropped entirely. */
const DROP_ATTACHMENTS = new Set([
  'total_tokens_reminder',
  'deferred_tools_record',
  'prompt_snapshot',
  'credential_org',
  'thinking_drop',
  'silent_turn_reminder',
  'atis',
]);

const ATTACHMENT_LABELS: Record<string, string> = {
  environment: 'Environment info',
  model: 'Model info',
  date: 'Date',
  skill_listing: 'Available skills',
  agent_listing_delta: 'Available agents',
  deferred_tools_delta: 'Tools changed',
  mcp_instructions_delta: 'MCP server instructions',
  auto_mode: 'Auto mode',
  session_context: 'Session context',
  remote_session_change: 'Commit attribution',
  edited_text_file: 'File changed outside Claude',
  nested_memory: 'Memory file loaded',
  instructions: 'Project instructions loaded',
  file: 'File attached',
  hook_system_message: 'Hook message',
  queued_command: 'Queued message',
  todo: 'Todo list',
  plan_mode: 'Plan mode',
  diagnostics: 'Diagnostics',
};

function truncate(s: string, limit: number): { text: string; truncated: boolean } {
  return s.length > limit ? { text: s.slice(0, limit), truncated: true } : { text: s, truncated: false };
}

function truncateInput(input: unknown): { value: unknown; truncated: boolean } {
  let truncated = false;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      if (v.length > INPUT_STRING_LIMIT) {
        truncated = true;
        return v.slice(0, INPUT_STRING_LIMIT);
      }
      return v;
    }
    if (depth > 6 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      const arr = v.slice(0, 200).map((x) => walk(x, depth + 1));
      if (v.length > 200) truncated = true;
      return arr;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, depth + 1);
    return out;
  };
  return { value: walk(input, 0), truncated };
}

function imageRef(line: number, path: string, block: any): ImageRef | null {
  const src = block?.source;
  if (!src || src.type !== 'base64' || typeof src.data !== 'string') return null;
  return { ref: `${line}:${path}`, mediaType: String(src.media_type || 'image/png'), bytes: Math.floor((src.data.length * 3) / 4) };
}

function resultTextAndImages(content: unknown, line: number, blockIndex: number): { text: string; images: ImageRef[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  const images: ImageRef[] = [];
  const parts: string[] = [];
  if (Array.isArray(content)) {
    content.forEach((c, j) => {
      if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else if (c?.type === 'image') {
        const r = imageRef(line, `c${blockIndex}/${j}`, c);
        if (r) images.push(r);
      } else if (c?.type === 'document') parts.push('[document]');
      else if (c?.type === 'tool_reference' && c.tool_name) parts.push(`[tool: ${c.tool_name}]`);
    });
  }
  return { text: parts.join('\n'), images };
}

function patchFrom(r: any): { patch?: PatchHunk[]; truncated?: boolean } {
  const sp = r?.structuredPatch;
  if (!Array.isArray(sp) || sp.length === 0) return {};
  let budget = 600;
  const out: PatchHunk[] = [];
  let truncated = false;
  for (const h of sp) {
    if (!h || !Array.isArray(h.lines)) continue;
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const lines = (h.lines as unknown[]).filter((l): l is string => typeof l === 'string');
    const take = lines.slice(0, budget).map((l) => (l.length > 400 ? l.slice(0, 400) + '…' : l));
    if (take.length < lines.length) truncated = true;
    budget -= take.length;
    out.push({ oldStart: h.oldStart ?? 0, oldLines: h.oldLines ?? 0, newStart: h.newStart ?? 0, newLines: h.newLines ?? 0, lines: take });
  }
  return { patch: out, truncated };
}

function resultMeta(r: any): ToolResultMeta | undefined {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  const m: ToolResultMeta = {};
  if (typeof r.stdout === 'string') m.stdout = truncate(r.stdout, TEXT_LIMIT).text;
  if (typeof r.stderr === 'string' && r.stderr) m.stderr = truncate(r.stderr, TEXT_LIMIT).text;
  if (r.interrupted) m.interrupted = true;
  if (typeof r.filePath === 'string') m.filePath = r.filePath;
  if (typeof r.file?.filePath === 'string') {
    m.filePath = r.file.filePath;
    if (typeof r.file.numLines === 'number') m.numLines = r.file.numLines;
  }
  if (typeof r.agentId === 'string') m.agentId = r.agentId;
  if (typeof r.persistedOutputPath === 'string') m.persistedOutputPath = r.persistedOutputPath;
  if (typeof r.backgroundTaskId === 'string') m.backgroundTaskId = r.backgroundTaskId;
  const p = patchFrom(r);
  if (p.patch) {
    m.patch = p.patch;
    if (p.truncated) m.patchTruncated = true;
  }
  return Object.keys(m).length ? m : undefined;
}

function maxUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b;
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
  };
}

function attachmentText(o: any): string | undefined {
  const r = o.rendered;
  if (Array.isArray(r)) {
    const t = r
      .map((x: any) => (typeof x?.content === 'string' ? x.content : ''))
      .join('\n')
      .replace(/^<system-reminder>\s*|\s*<\/system-reminder>$/g, '')
      .trim();
    if (t) return truncate(t, TEXT_LIMIT).text;
  }
  const a = o.attachment ?? {};
  for (const k of ['content', 'text', 'prompt', 'snippet']) {
    if (typeof a[k] === 'string' && a[k]) return truncate(a[k], TEXT_LIMIT).text;
  }
  return undefined;
}

export async function buildTranscript(
  file: string,
  opts: { sessionId: string; agentId?: string; isSubagent?: boolean },
): Promise<TranscriptBuild> {
  const items: TranscriptItem[] = [];
  const corpus: CorpusEntry[] = [];
  const rangeList: number[] = [];
  const assistantByMsg = new Map<string, number>();
  const toolIndex = new Map<string, { item: number; block: number }>();
  const parentOf = new Map<string, string>();
  const lineOfUuid = new Map<string, number>();
  let leaf: string | undefined;
  let lineCount = 0;

  const push = (it: TranscriptItem) => items.push(it);
  const lastItem = () => items[items.length - 1];

  for await (const ln of readLines(file)) {
    lineCount++;
    rangeList.push(ln.start, ln.length);
    const o = tryParse(ln.text);
    if (!o || typeof o !== 'object') continue;
    const line = ln.no;
    const uuid: string = typeof o.uuid === 'string' ? o.uuid : `line-${line}`;
    const ts: string | undefined = typeof o.timestamp === 'string' ? o.timestamp : undefined;
    const sidechain = !opts.isSubagent && o.isSidechain === true ? true : undefined;
    if (typeof o.uuid === 'string') {
      lineOfUuid.set(o.uuid, line);
      const parent = typeof o.parentUuid === 'string' ? o.parentUuid : typeof o.logicalParentUuid === 'string' ? o.logicalParentUuid : undefined;
      if (parent) parentOf.set(o.uuid, parent);
      if ((o.type === 'user' || o.type === 'assistant') && !sidechain) leaf = o.uuid;
    }

    switch (o.type) {
      case 'assistant': {
        const m = o.message;
        if (!m || typeof m !== 'object') break;
        const msgId: string | undefined = typeof m.id === 'string' ? m.id : undefined;
        let idx = msgId ? assistantByMsg.get(msgId) : undefined;
        let item: Extract<TranscriptItem, { kind: 'assistant' }>;
        if (idx !== undefined && items[idx]?.kind === 'assistant') {
          item = items[idx] as typeof item;
        } else {
          item = {
            kind: 'assistant',
            uuid,
            ts,
            line,
            msgId,
            model: typeof m.model === 'string' ? m.model : undefined,
            blocks: [],
            ...(sidechain ? { sidechain } : {}),
          };
          push(item);
          idx = items.length - 1;
          if (msgId) assistantByMsg.set(msgId, idx);
        }
        if (!isSyntheticModel(item.model) && m.usage) item.usage = maxUsage(item.usage, toUsage(m.usage));
        if (typeof m.stop_reason === 'string') item.stopReason = m.stop_reason;
        const content = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text' && typeof b.text === 'string') {
            if (!b.text.trim()) continue;
            const t = truncate(b.text, PROSE_LIMIT).text;
            item.blocks.push({ type: 'text', text: t });
            corpus.push({ uuid: item.uuid, role: 'assistant', ts, text: t });
          } else if (b.type === 'thinking') {
            const t = typeof b.thinking === 'string' ? b.thinking : '';
            const dur = typeof o.thinkingDurationMs === 'number' && o.thinkingDurationMs > 0 ? o.thinkingDurationMs : undefined;
            if (!t.trim()) {
              // Thinking display omitted: keep only how long it took
              if (dur) item.blocks.push({ type: 'thinking', text: '', durationMs: dur });
              continue;
            }
            item.blocks.push({ type: 'thinking', text: truncate(t, PROSE_LIMIT).text, ...(dur ? { durationMs: dur } : {}) });
            corpus.push({ uuid: item.uuid, role: 'assistant', ts, text: truncate(t, CORPUS_TOOL_LIMIT * 4).text });
          } else if (b.type === 'redacted_thinking') {
            item.blocks.push({ type: 'thinking', text: '', redacted: true });
          } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
            const { value, truncated } = truncateInput(b.input);
            const block: Block = {
              type: 'tool',
              id: String(b.id ?? `${line}-${item.blocks.length}`),
              name: String(b.name ?? 'tool'),
              input: value,
              line,
              ...(truncated ? { inputTruncated: true } : {}),
            };
            item.blocks.push(block);
            toolIndex.set(block.id, { item: idx, block: item.blocks.length - 1 });
            corpus.push({ uuid: item.uuid, role: 'tool', ts, text: `${block.name} ${JSON.stringify(value ?? '').slice(0, CORPUS_TOOL_LIMIT)}` });
          } else if (typeof b.type === 'string' && b.type.endsWith('_tool_result') && b.tool_use_id) {
            const target = toolIndex.get(b.tool_use_id);
            const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '').slice(0, TEXT_LIMIT * 2);
            const t = truncate(text, TEXT_LIMIT);
            const res: ToolResult = { text: t.text, truncated: t.truncated, fullLength: text.length, isError: false, images: [], line };
            if (target) {
              const tb = (items[target.item] as any).blocks[target.block];
              if (tb?.type === 'tool') tb.result = res;
            }
          }
        }
        break;
      }

      case 'user': {
        const content = o.message?.content;
        // Tool results: attach to the matching tool call
        if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) {
          content.forEach((b: any, bi: number) => {
            if (b?.type !== 'tool_result') return;
            const { text, images } = resultTextAndImages(b.content, line, bi);
            const t = truncate(text, TEXT_LIMIT);
            const res: ToolResult = {
              text: t.text,
              truncated: t.truncated,
              fullLength: text.length,
              isError: !!b.is_error,
              images,
              line,
            };
            const meta = resultMeta(o.toolUseResult);
            if (meta) res.meta = meta;
            const target = toolIndex.get(b.tool_use_id);
            if (target) {
              const tb = (items[target.item] as any).blocks[target.block];
              if (tb?.type === 'tool') tb.result = res;
            } else {
              push({ kind: 'notice', tone: 'info', uuid, ts, line, label: 'Tool result', text: t.text, ...(sidechain ? { sidechain } : {}) });
            }
            if (text) corpus.push({ uuid, role: 'tool', ts, text: text.slice(0, CORPUS_TOOL_LIMIT) });
          });
          break;
        }

        const text = contentText(content);
        if (o.isCompactSummary) {
          const prev = [...items].reverse().find((x) => x.kind === 'compact') as Extract<TranscriptItem, { kind: 'compact' }> | undefined;
          if (prev && !prev.summary) prev.summary = truncate(text, PROSE_LIMIT).text;
          else push({ kind: 'compact', uuid, ts, line, summary: truncate(text, PROSE_LIMIT).text });
          break;
        }
        const images: ImageRef[] = [];
        if (Array.isArray(content)) {
          content.forEach((b: any, i: number) => {
            if (b?.type === 'image') {
              const r = imageRef(line, `c${i}`, b);
              if (r) images.push(r);
            }
          });
        }
        if (o.isMeta) {
          if (classifyUserText(text) === 'caveat') break;
          push({ kind: 'user', uuid, ts, line, text: truncate(text, PROSE_LIMIT).text, images, meta: true, ...(sidechain ? { sidechain } : {}) });
          break;
        }
        const kind = classifyUserText(text);
        switch (kind) {
          case 'caveat':
          case 'empty':
            if (images.length) push({ kind: 'user', uuid, ts, line, text: '', images, ...(sidechain ? { sidechain } : {}) });
            break;
          case 'command': {
            const name = (tagContent(text, 'command-name') ?? tagContent(text, 'command-message') ?? '').trim();
            const args = tagContent(text, 'command-args')?.trim();
            push({ kind: 'command', uuid, ts, line, name: name.startsWith('/') ? name : `/${name}`, ...(args ? { args } : {}) });
            corpus.push({ uuid, role: 'user', ts, text: `${name} ${args ?? ''}` });
            break;
          }
          case 'command-output': {
            const out = (tagContent(text, 'local-command-stdout') ?? tagContent(text, 'local-command-stderr') ?? '').trim();
            const prev = lastItem();
            if (prev?.kind === 'command' && prev.output === undefined) prev.output = truncate(out, TEXT_LIMIT).text;
            else push({ kind: 'command', uuid, ts, line, name: '', output: truncate(out, TEXT_LIMIT).text });
            break;
          }
          case 'shell': {
            const input = tagContent(text, 'bash-input');
            const stdout = tagContent(text, 'bash-stdout');
            const stderr = tagContent(text, 'bash-stderr');
            const prev = lastItem();
            if (input === undefined && prev?.kind === 'shell' && prev.stdout === undefined && prev.stderr === undefined) {
              if (stdout !== undefined) prev.stdout = truncate(stdout, TEXT_LIMIT).text;
              if (stderr) prev.stderr = truncate(stderr, TEXT_LIMIT).text;
            } else {
              push({
                kind: 'shell',
                uuid,
                ts,
                line,
                ...(input !== undefined ? { input } : {}),
                ...(stdout !== undefined ? { stdout: truncate(stdout, TEXT_LIMIT).text } : {}),
                ...(stderr ? { stderr: truncate(stderr, TEXT_LIMIT).text } : {}),
              });
            }
            if (input) corpus.push({ uuid, role: 'user', ts, text: `! ${input}` });
            break;
          }
          case 'notification': {
            const status = tagContent(text, 'status')?.trim();
            const summary = tagContent(text, 'summary')?.trim();
            push({
              kind: 'notice',
              tone: status === 'failed' ? 'warn' : 'info',
              uuid,
              ts,
              line,
              label: status ? `Background task ${status}` : 'Background task update',
              ...(summary ? { text: summary } : {}),
            });
            break;
          }
          case 'interrupt':
            push({ kind: 'notice', tone: 'warn', uuid, ts, line, label: 'Interrupted by user', ...(sidechain ? { sidechain } : {}) });
            break;
          default: {
            const clean = stripInjected(text);
            if (!clean && !images.length) break;
            const t = truncate(clean, PROSE_LIMIT).text;
            push({ kind: 'user', uuid, ts, line, text: t, images, ...(sidechain ? { sidechain } : {}) });
            corpus.push({ uuid, role: 'user', ts, text: t });
          }
        }
        break;
      }

      case 'system': {
        const sub: string = typeof o.subtype === 'string' ? o.subtype : 'system';
        if (sub === 'compact_boundary') {
          push({
            kind: 'compact',
            uuid,
            ts,
            line,
            trigger: o.compactMetadata?.trigger,
            preTokens: typeof o.compactMetadata?.preTokens === 'number' ? o.compactMetadata.preTokens : undefined,
          });
        } else if (sub === 'turn_duration') {
          // folded into the timeline gaps; not worth a row
        } else {
          const text = typeof o.content === 'string' ? o.content : '';
          if (!text) break;
          push({ kind: 'system', uuid, ts, line, subtype: sub, text: truncate(text, TEXT_LIMIT).text, ...(o.level ? { level: o.level } : {}) });
        }
        break;
      }

      case 'attachment': {
        const a = o.attachment;
        const at: string = typeof a?.type === 'string' ? a.type : 'attachment';
        if (DROP_ATTACHMENTS.has(at)) break;
        if (at === 'queued_command' && a?.commandMode === 'prompt' && typeof a.prompt === 'string') {
          const t = stripInjected(a.prompt);
          push({ kind: 'user', uuid, ts, line, text: truncate(t, PROSE_LIMIT).text, images: [], ...(sidechain ? { sidechain } : {}) });
          corpus.push({ uuid, role: 'user', ts, text: t });
          break;
        }
        if (at === 'hook_system_message' && typeof a?.content === 'string') {
          push({ kind: 'notice', tone: 'info', uuid, ts, line, label: a.hookName ? `Hook · ${a.hookName}` : 'Hook message', text: truncate(a.content, TEXT_LIMIT).text });
          break;
        }
        let label = ATTACHMENT_LABELS[at] ?? at.replace(/_/g, ' ');
        if ((at === 'file' || at === 'edited_text_file') && typeof (a?.displayPath ?? a?.filename) === 'string') {
          label = `${label}: ${a.displayPath ?? a.filename}`;
        } else if (at === 'nested_memory' && typeof (a?.displayPath ?? a?.path) === 'string') {
          label = `${label}: ${a.displayPath ?? a.path}`;
        } else if (at === 'queued_command' && a?.commandMode === 'task-notification') {
          label = 'Background task notification';
        }
        push({ kind: 'context', uuid, ts, line, attachmentType: at, label, text: attachmentText(o), ...(sidechain ? { sidechain } : {}) });
        break;
      }
    }
  }

  markOffBranch(items, parentOf, lineOfUuid, leaf);

  const ranges = new Float64Array(rangeList);
  return {
    transcript: { sessionId: opts.sessionId, agentId: opts.agentId, items, lineCount, truncateAt: TEXT_LIMIT },
    ranges,
    corpus,
  };
}

/**
 * When a user edits an earlier prompt (or rewinds), Claude Code keeps the old
 * branch in the file. Walk from the last message back through parent links;
 * conversation items after the start of that chain but not on it are a
 * rewound branch.
 */
function markOffBranch(items: TranscriptItem[], parentOf: Map<string, string>, lineOfUuid: Map<string, number>, leaf?: string) {
  if (!leaf) return;
  const chain = new Set<string>();
  let cur: string | undefined = leaf;
  let guard = parentOf.size + 2;
  let firstLine = Infinity;
  while (cur && guard-- > 0 && !chain.has(cur)) {
    chain.add(cur);
    const l = lineOfUuid.get(cur);
    if (l === undefined) break;
    if (l < firstLine) firstLine = l;
    cur = parentOf.get(cur);
  }
  if (!Number.isFinite(firstLine)) return;
  // Only trust the walk if it covered most of the conversation
  let convo = 0;
  let covered = 0;
  for (const it of items) {
    if ((it.kind === 'user' || it.kind === 'assistant') && !it.sidechain) {
      convo++;
      if (chain.has(it.uuid)) covered++;
    }
  }
  if (convo === 0 || covered / convo < 0.5) return;
  for (const it of items) {
    if ((it.kind !== 'user' && it.kind !== 'assistant') || it.sidechain || it.line <= firstLine) continue;
    if (it.kind === 'user' && (it as any).meta) continue;
    if (!chain.has(it.uuid)) it.offBranch = true;
  }
}

/** Locate the base64 payload of an image ref ("12:c3" or "12:c3/1") inside a parsed line. */
export function extractImage(obj: any, path: string): { mediaType: string; data: Buffer } | null {
  const m = path.match(/^c(\d+)(?:\/(\d+))?$/);
  if (!m) return null;
  const content = obj?.message?.content;
  if (!Array.isArray(content)) return null;
  let block = content[Number(m[1])];
  if (m[2] !== undefined) block = Array.isArray(block?.content) ? block.content[Number(m[2])] : undefined;
  const src = block?.source;
  if (!src || src.type !== 'base64' || typeof src.data !== 'string') return null;
  return { mediaType: String(src.media_type || 'image/png'), data: Buffer.from(src.data, 'base64') };
}

export { oneLine };
