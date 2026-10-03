// One streaming pass over a transcript to compute everything the lists, stats
// and sync comparisons need. Results are cached by (file, size, mtime).

import crypto from 'node:crypto';
import { readLines, tryParse } from '../util/lines.js';
import { classifyUserText, contentText, hasToolResult, oneLine, stripInjected } from './text.js';
import type { Usage } from '../../shared/types.js';
import { isSyntheticModel } from '../../shared/pricing.js';

export const PARSER_VERSION = 4;

export interface UsageEvent {
  /** message id (usage is deduplicated per message across split lines) */
  id: string;
  t: number;
  model: string;
  u: Usage;
  fast?: boolean;
}

export interface SessionCore {
  lines: number;
  parseErrors: number;
  /** uuids in file order — the identity of the conversation, independent of path rewrites */
  idSeq: string[];
  idHash: string;
  cwds: string[];
  branches: string[];
  version?: string;
  startedAt?: string;
  endedAt?: string;
  activeMs: number;
  customTitle?: string;
  aiTitle?: string;
  summaryTitle?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  recap?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolErrors: number;
  compactions: number;
  tools: Record<string, number>;
  usage: UsageEvent[];
  promptTimes: number[];
  /** path → [reads, edits, writes] */
  files: Record<string, [number, number, number]>;
  agentByToolUse: Record<string, string>;
  sessionIdInFile?: string;
  parentSessionId?: string;
  model?: string;
}

const IDLE_GAP_MS = 15 * 60 * 1000;

export function toUsage(u: any): Usage {
  if (!u || typeof u !== 'object') return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const cc = u.cache_creation;
  let w5 = 0;
  let w1 = 0;
  if (cc && typeof cc === 'object' && (Number(cc.ephemeral_5m_input_tokens) || Number(cc.ephemeral_1h_input_tokens))) {
    w5 = Number(cc.ephemeral_5m_input_tokens) || 0;
    w1 = Number(cc.ephemeral_1h_input_tokens) || 0;
  } else {
    w5 = Number(u.cache_creation_input_tokens) || 0;
  }
  return {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cacheRead: Number(u.cache_read_input_tokens) || 0,
    cacheWrite5m: w5,
    cacheWrite1h: w1,
  };
}

function maxUsage(a: Usage, b: Usage): Usage {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
  };
}

const FILE_TOOLS: Record<string, [keyof { r: 0; e: 0; w: 0 }, string]> = {
  Read: ['r', 'file_path'],
  NotebookRead: ['r', 'notebook_path'],
  Edit: ['e', 'file_path'],
  MultiEdit: ['e', 'file_path'],
  NotebookEdit: ['e', 'notebook_path'],
  Write: ['w', 'file_path'],
};

export function hashIds(ids: string[], count = ids.length): string {
  const h = crypto.createHash('sha1');
  for (let i = 0; i < count; i++) h.update(ids[i]! + '\n');
  return h.digest('hex');
}

export async function summarizeFile(file: string): Promise<SessionCore> {
  const core: SessionCore = {
    lines: 0,
    parseErrors: 0,
    idSeq: [],
    idHash: '',
    cwds: [],
    branches: [],
    activeMs: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: 0,
    compactions: 0,
    tools: {},
    usage: [],
    promptTimes: [],
    files: {},
    agentByToolUse: {},
  };
  const usageById = new Map<string, UsageEvent>();
  const assistantIds = new Set<string>();
  const toolUseIds = new Set<string>();
  const cwdSet = new Set<string>();
  const branchSet = new Set<string>();
  let minTs = Infinity;
  let maxTs = -Infinity;
  let lastActive = 0;
  let lastPromptText: string | undefined;

  for await (const line of readLines(file)) {
    core.lines++;
    const o = tryParse(line.text);
    if (!o || typeof o !== 'object') {
      if (line.complete && line.text.trim()) core.parseErrors++;
      continue;
    }
    const type: string = o.type;
    const tsMs = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (!Number.isNaN(tsMs)) {
      if (tsMs < minTs) minTs = tsMs;
      if (tsMs > maxTs) maxTs = tsMs;
      if (type === 'user' || type === 'assistant' || type === 'system') {
        if (lastActive && tsMs > lastActive && tsMs - lastActive < IDLE_GAP_MS) core.activeMs += tsMs - lastActive;
        if (tsMs > lastActive) lastActive = tsMs;
      }
    }
    if (typeof o.uuid === 'string') core.idSeq.push(o.uuid);
    if (typeof o.cwd === 'string' && o.cwd && !cwdSet.has(o.cwd)) {
      cwdSet.add(o.cwd);
      core.cwds.push(o.cwd);
    }
    if (typeof o.relocatedCwd === 'string' && o.relocatedCwd && !cwdSet.has(o.relocatedCwd)) {
      cwdSet.add(o.relocatedCwd);
      core.cwds.push(o.relocatedCwd);
    }
    if (typeof o.gitBranch === 'string' && o.gitBranch) {
      if (branchSet.has(o.gitBranch)) {
        // keep the most recent branch last
        const i = core.branches.indexOf(o.gitBranch);
        if (i !== core.branches.length - 1) {
          core.branches.splice(i, 1);
          core.branches.push(o.gitBranch);
        }
      } else {
        branchSet.add(o.gitBranch);
        core.branches.push(o.gitBranch);
      }
    }
    if (typeof o.version === 'string') core.version = o.version;
    if (!core.sessionIdInFile && typeof o.sessionId === 'string') core.sessionIdInFile = o.sessionId;

    switch (type) {
      case 'custom-title':
        if (typeof o.customTitle === 'string') core.customTitle = o.customTitle;
        else if (typeof o.title === 'string') core.customTitle = o.title;
        break;
      case 'ai-title':
        if (typeof o.aiTitle === 'string' && o.aiTitle.trim()) core.aiTitle = o.aiTitle.trim();
        break;
      case 'summary':
        if (typeof o.summary === 'string' && o.summary.trim()) core.summaryTitle = o.summary.trim();
        break;
      case 'last-prompt':
        if (typeof o.lastPrompt === 'string') core.lastPrompt = oneLine(o.lastPrompt, 300);
        break;
      case 'fork-context-ref':
        if (typeof o.parentSessionId === 'string') core.parentSessionId = o.parentSessionId;
        break;
      case 'system':
        if (o.subtype === 'compact_boundary') core.compactions++;
        else if (o.subtype === 'away_summary' && typeof o.content === 'string') core.recap = o.content;
        break;
      case 'user': {
        const content = o.message?.content;
        if (hasToolResult(content)) {
          for (const b of content as any[]) {
            if (b?.type === 'tool_result' && b.is_error) core.toolErrors++;
          }
          const agentId = o.toolUseResult?.agentId;
          if (typeof agentId === 'string') {
            const tr = (content as any[]).find((b) => b?.type === 'tool_result');
            if (tr?.tool_use_id) core.agentByToolUse[tr.tool_use_id] = agentId;
          }
          break;
        }
        if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) break;
        const text = contentText(content);
        if (classifyUserText(text) !== 'prompt') break;
        const clean = stripInjected(text);
        if (!clean) break;
        core.userMessages++;
        if (!Number.isNaN(tsMs)) core.promptTimes.push(tsMs);
        if (!core.firstPrompt) core.firstPrompt = oneLine(clean, 300);
        lastPromptText = clean;
        break;
      }
      case 'assistant': {
        const m = o.message;
        if (!m || typeof m !== 'object') break;
        const model: string = typeof m.model === 'string' ? m.model : '';
        const id: string = typeof m.id === 'string' ? m.id : (o.uuid ?? `line${line.no}`);
        if (!isSyntheticModel(model)) {
          assistantIds.add(id);
          if (!core.model) core.model = model;
          const u = toUsage(m.usage);
          const prev = usageById.get(id);
          if (prev) prev.u = maxUsage(prev.u, u);
          else
            usageById.set(id, {
              id,
              t: Number.isNaN(tsMs) ? 0 : tsMs,
              model,
              u,
              ...(m.usage?.speed === 'fast' ? { fast: true } : {}),
            });
        }
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type !== 'tool_use') continue;
            if (b.id && toolUseIds.has(b.id)) continue;
            if (b.id) toolUseIds.add(b.id);
            core.toolCalls++;
            const name = typeof b.name === 'string' ? b.name : 'unknown';
            core.tools[name] = (core.tools[name] ?? 0) + 1;
            const ft = FILE_TOOLS[name];
            const fp = ft ? b.input?.[ft[1]] : undefined;
            if (ft && typeof fp === 'string' && fp) {
              const rec = (core.files[fp] ??= [0, 0, 0]);
              rec[ft[0] === 'r' ? 0 : ft[0] === 'e' ? 1 : 2]++;
            }
          }
        }
        break;
      }
    }
  }

  core.assistantMessages = assistantIds.size;
  core.usage = [...usageById.values()];
  core.idHash = hashIds(core.idSeq);
  if (Number.isFinite(minTs)) core.startedAt = new Date(minTs).toISOString();
  if (Number.isFinite(maxTs)) core.endedAt = new Date(maxTs).toISOString();
  if (!core.lastPrompt && lastPromptText) core.lastPrompt = oneLine(lastPromptText, 300);
  return core;
}

/** Hash of the first n identities — used to tell whether one copy continues another. */
export function prefixHash(core: Pick<SessionCore, 'idSeq'>, n: number): string {
  return hashIds(core.idSeq, Math.min(n, core.idSeq.length));
}
