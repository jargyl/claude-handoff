// Human-readable Markdown export of a session (for sharing, notes, PR descriptions).

import type { SessionDetail, Transcript } from '../shared/types.js';

function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text.replace(/\n+$/, '')}\n${f}`;
}

function time(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function duration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.path;
  return typeof pick === 'string' ? pick.split('\n')[0]!.slice(0, 160) : '';
}

export function transcriptToMarkdown(d: SessionDetail, t: Transcript, opts: { includeTools: boolean; includeThinking: boolean }): string {
  const out: string[] = [];
  out.push(`# ${d.title}`, '');
  const rows: Array<[string, string]> = [
    ['Session', `\`${d.id}\``],
    ['Project', `\`${d.projectPath}\``],
    ...(d.branch && d.branch !== 'HEAD' ? ([['Branch', `\`${d.branch}\``]] as Array<[string, string]>) : []),
    ['Started', time(d.startedAt)],
    ['Duration', `${duration(d.durationMs)} (${duration(d.activeMs)} active)`],
    ['Models', d.models.join(', ') || '—'],
    ['Prompts', String(d.userMessages)],
    ['Tool calls', String(d.toolCalls)],
    ...(d.cost !== null ? ([['API-equivalent cost', `$${d.cost.toFixed(2)}`]] as Array<[string, string]>) : []),
  ];
  out.push('| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`), '');
  out.push(`Resume: \`claude --resume ${d.id}\``, '', '---', '');

  for (const it of t.items) {
    if (it.offBranch || it.sidechain) continue;
    switch (it.kind) {
      case 'user':
        if (it.meta) break;
        out.push(`## You${it.ts ? ` · ${time(it.ts)}` : ''}`, '', it.text, '');
        if (it.images.length) out.push(`_${it.images.length} image(s) attached_`, '');
        break;
      case 'assistant': {
        const parts: string[] = [];
        for (const b of it.blocks) {
          if (b.type === 'text') parts.push(b.text, '');
          else if (b.type === 'thinking' && opts.includeThinking && b.text) parts.push('<details><summary>Thinking</summary>', '', b.text, '', '</details>', '');
          else if (b.type === 'tool' && opts.includeTools) {
            const summary = toolSummary(b.name, b.input);
            parts.push(`<details><summary>${b.name}${summary ? `: ${summary.replace(/</g, '&lt;')}` : ''}</summary>`, '');
            const input = b.input as any;
            if (b.name === 'Bash' && typeof input?.command === 'string') parts.push(fence(input.command, 'bash'), '');
            else parts.push(fence(JSON.stringify(b.input, null, 2), 'json'), '');
            if (b.result) {
              parts.push(b.result.isError ? '**Error:**' : '**Result:**', '');
              parts.push(fence(b.result.text + (b.result.truncated ? '\n… (truncated)' : '')), '');
            }
            parts.push('</details>', '');
          }
        }
        if (parts.some((p) => p.trim())) out.push(`## Claude${it.ts ? ` · ${time(it.ts)}` : ''}`, '', ...parts);
        break;
      }
      case 'command':
        if (it.name) out.push(`> \`${it.name}${it.args ? ' ' + it.args : ''}\``, '');
        if (it.output) out.push(fence(it.output), '');
        break;
      case 'shell':
        out.push(fence(`$ ${it.input ?? ''}${it.stdout ? '\n' + it.stdout : ''}${it.stderr ? '\n' + it.stderr : ''}`, 'console'), '');
        break;
      case 'compact':
        out.push('---', '', `_Conversation compacted${it.preTokens ? ` at ${Math.round(it.preTokens / 1000)}k tokens` : ''}_`, '', '---', '');
        break;
      case 'system':
        if (it.subtype === 'away_summary') out.push(`> **Recap:** ${it.text}`, '');
        break;
      case 'notice':
        out.push(`> _${it.label}${it.text ? `: ${it.text}` : ''}_`, '');
        break;
      default:
        break;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
