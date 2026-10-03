import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTranscript } from '../src/server/claude/transcript.js';
import { summarizeFile } from '../src/server/claude/parse.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-tr-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const S = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = { sessionId: S, cwd: 'C:\\proj', version: '2.1.288', gitBranch: 'main' };
let t = Date.UTC(2026, 9, 3, 10, 0, 0);
const ts = () => new Date((t += 1000)).toISOString();

const lines = [
  { type: 'ai-title', aiTitle: 'Fix the login bug', sessionId: S },
  { ...base, type: 'user', uuid: 'u0', parentUuid: null, timestamp: ts(), message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>' } },
  { ...base, type: 'user', uuid: 'u0b', parentUuid: 'u0', timestamp: ts(), message: { role: 'user', content: '<local-command-stdout>Set model to Opus</local-command-stdout>' } },
  { ...base, type: 'user', uuid: 'u1', parentUuid: 'u0b', timestamp: ts(), message: { role: 'user', content: 'Fix the login bug <system-reminder>secret context</system-reminder>' } },
  // one API message split over three lines; usage grows on the last one
  { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: ts(), thinkingDurationMs: 4200, message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }], usage: { input_tokens: 5, output_tokens: 1 } } },
  { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: ts(), message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Looking at it.' }], usage: { input_tokens: 5, output_tokens: 10 } } },
  { ...base, type: 'assistant', uuid: 'a3', parentUuid: 'a2', timestamp: ts(), message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 30 } } },
  { ...base, type: 'user', uuid: 'r1', parentUuid: 'a3', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'all tests pass', is_error: false }] }, toolUseResult: { stdout: 'all tests pass', stderr: '' } },
  // a rewound branch: this prompt was edited, so the next one shares its parent
  { ...base, type: 'user', uuid: 'u2old', parentUuid: 'r1', timestamp: ts(), message: { role: 'user', content: 'Old wording' } },
  { ...base, type: 'user', uuid: 'u2', parentUuid: 'r1', timestamp: ts(), message: { role: 'user', content: 'Now deploy it' } },
  { ...base, type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, logicalParentUuid: 'u2', timestamp: ts(), content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 120000 } },
  { ...base, type: 'user', uuid: 'cs', parentUuid: 'c1', timestamp: ts(), isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'Summary: we fixed login.' } },
  { ...base, type: 'assistant', uuid: 'a4', parentUuid: 'cs', timestamp: ts(), message: { id: 'msg_2', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Deployed.' }], usage: { input_tokens: 3, output_tokens: 4 } } },
  { ...base, type: 'attachment', uuid: 'att', parentUuid: 'a4', timestamp: ts(), attachment: { type: 'total_tokens_reminder', text: 'x' } },
];
const file = path.join(dir, `${S}.jsonl`);
fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"type":"user","partial');

describe('transcript', () => {
  it('builds a readable conversation', async () => {
    const { transcript, corpus } = await buildTranscript(file, { sessionId: S });
    const kinds = transcript.items.map((i) => i.kind);
    expect(kinds).toEqual(['command', 'user', 'assistant', 'user', 'user', 'compact', 'assistant']);

    const cmd = transcript.items[0] as any;
    expect(cmd.name).toBe('/model');
    expect(cmd.args).toBe('opus');
    expect(cmd.output).toBe('Set model to Opus');

    const prompt = transcript.items[1] as any;
    expect(prompt.text).toBe('Fix the login bug');

    const reply = transcript.items[2] as any;
    expect(reply.blocks.map((b: any) => b.type)).toEqual(['thinking', 'text', 'tool']);
    expect(reply.blocks[0].durationMs).toBe(4200);
    expect(reply.usage.output).toBe(30);
    expect(reply.blocks[2].result.text).toBe('all tests pass');
    expect(reply.blocks[2].result.meta.stdout).toBe('all tests pass');

    const old = transcript.items[3] as any;
    expect(old.text).toBe('Old wording');
    expect(old.offBranch).toBe(true);
    expect((transcript.items[4] as any).offBranch).toBeUndefined();

    const compact = transcript.items[5] as any;
    expect(compact.trigger).toBe('manual');
    expect(compact.preTokens).toBe(120000);
    expect(compact.summary).toBe('Summary: we fixed login.');

    // searchable text skips injected context
    expect(corpus.some((c) => c.text.includes('secret context'))).toBe(false);
    expect(corpus.some((c) => c.role === 'tool' && c.text.includes('all tests pass') && c.uuid === 'a1')).toBe(true);
  });

  it('summarizes without double-counting split messages', async () => {
    const core = await summarizeFile(file);
    expect(core.aiTitle).toBe('Fix the login bug');
    expect(core.userMessages).toBe(3); // the two prompts plus the rewound one
    expect(core.assistantMessages).toBe(2);
    expect(core.usage.reduce((n, e) => n + e.u.output, 0)).toBe(34);
    expect(core.toolCalls).toBe(1);
    expect(core.tools).toEqual({ Bash: 1 });
    expect(core.compactions).toBe(1);
    expect(core.firstPrompt).toBe('Fix the login bug');
    expect(core.branches).toEqual(['main']);
    expect(core.parseErrors).toBe(0); // the partial last line is still being written, not an error
  });
});
