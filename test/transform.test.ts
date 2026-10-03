import { describe, expect, it } from 'vitest';
import { buildUuidMap, makeTransformer } from '../src/server/transfer/transform.js';
import { compareIdentity } from '../src/server/transfer/compare.js';
import { hashIds } from '../src/server/claude/parse.js';

const FROM = 'C:\\Users\\JARI\\Dev\\app';
const TO = 'D:\\work\\app';
const rules = [{ from: FROM, to: TO }];

const userLine = JSON.stringify({
  type: 'user',
  uuid: '11111111-1111-4111-8111-111111111111',
  parentUuid: null,
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  cwd: FROM,
  message: { role: 'user', content: `Fix ${FROM}\\src\\a.ts please` },
});

const assistantLine = JSON.stringify({
  type: 'assistant',
  uuid: '22222222-2222-4222-8222-222222222222',
  parentUuid: '11111111-1111-4111-8111-111111111111',
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  cwd: FROM,
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: `I will open ${FROM}\\src\\a.ts`, signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: `${FROM}\\src\\a.ts` } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ],
  },
});

describe('line transformer', () => {
  it('metadata mode rewrites cwd but leaves the conversation alone', () => {
    const t = makeTransformer({ rules, metadata: true, content: false });
    const u = JSON.parse(t.apply(userLine));
    expect(u.cwd).toBe(TO);
    expect(u.message.content).toContain(FROM);
    const a = JSON.parse(t.apply(assistantLine));
    expect(a.message.content[1].input.file_path).toContain(FROM);
  });

  it('content mode rewrites messages but never thinking blocks or signatures', () => {
    const t = makeTransformer({ rules, metadata: true, content: true });
    const u = JSON.parse(t.apply(userLine));
    expect(u.message.content).toBe(`Fix ${TO}\\src\\a.ts please`);
    const a = JSON.parse(t.apply(assistantLine));
    expect(a.message.content[0].thinking).toContain(FROM);
    expect(a.message.content[0].signature).toBe('sig');
    expect(a.message.content[1].input.file_path).toBe(`${TO}\\src\\a.ts`);
    expect(a.message.content[2].source.data).toBe('QUJD');
  });

  it('keeps untouched lines byte-for-byte', () => {
    const t = makeTransformer({ rules, metadata: true, content: true });
    const line = '{"type":"mode","mode":"normal" , "sessionId":"x"}';
    expect(t.apply(line)).toBe(line);
    expect(t.apply('not json')).toBe('not json');
  });

  it('rewrites checkpoint paths as metadata', () => {
    const t = makeTransformer({ rules, metadata: true, content: false });
    const snap = JSON.stringify({
      type: 'file-history-snapshot',
      messageId: 'm',
      snapshot: { messageId: 'm', trackedFileBackups: { [`${FROM}\\a.ts`]: { backupFileName: 'x@v1', realParentDir: FROM } } },
    });
    const o = JSON.parse(t.apply(snap));
    expect(Object.keys(o.snapshot.trackedFileBackups)).toEqual([`${TO}\\a.ts`]);
    expect(o.snapshot.trackedFileBackups[`${TO}\\a.ts`].realParentDir).toBe(TO);
  });

  it('copy mode re-keys the session and every message consistently', () => {
    const map = buildUuidMap([userLine, assistantLine]);
    expect(map.size).toBe(2);
    const t = makeTransformer({
      rules: [],
      metadata: false,
      content: false,
      copy: { fromId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', toId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', uuidMap: map },
    });
    const u = JSON.parse(t.apply(userLine));
    const a = JSON.parse(t.apply(assistantLine));
    expect(u.sessionId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(u.uuid).not.toBe('11111111-1111-4111-8111-111111111111');
    expect(a.parentUuid).toBe(u.uuid);
  });

  it('copy mode points metadata paths at the copy but leaves the conversation alone', () => {
    const OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const NEW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const line = JSON.stringify({
      type: 'user',
      uuid: '33333333-3333-4333-8333-333333333333',
      sessionId: OLD,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: `saved to C:\\x\\${OLD}\\tool-results\\o.txt` }] },
      toolUseResult: { persistedOutputPath: `C:\\x\\${OLD}\\tool-results\\o.txt` },
    });
    const snap = JSON.stringify({ type: 'file-history-snapshot', messageId: 'm', snapshot: { trackedFileBackups: { [`C:\\tmp\\${OLD}\\scratchpad\\a.mjs`]: { realParentDir: `C:\\tmp\\${OLD}\\scratchpad` } } } });
    const t = makeTransformer({ rules: [], metadata: false, content: false, copy: { fromId: OLD, toId: NEW, uuidMap: buildUuidMap([line]) } });
    const o = JSON.parse(t.apply(line));
    expect(o.toolUseResult.persistedOutputPath).toContain(NEW);
    expect(o.message.content[0].content).toContain(OLD);
    const s = JSON.parse(t.apply(snap));
    const key = Object.keys(s.snapshot.trackedFileBackups)[0]!;
    expect(key).toContain(NEW);
    expect(s.snapshot.trackedFileBackups[key].realParentDir).toContain(NEW);
  });
});

describe('compareIdentity', () => {
  const mk = (ids: string[]) => ({ idSeq: ids, idHash: hashIds(ids) });
  it('classifies copies of an append-only log', () => {
    expect(compareIdentity(mk(['a', 'b']), mk(['a', 'b']))).toBe('same');
    expect(compareIdentity(mk(['a', 'b']), mk(['a', 'b', 'c']))).toBe('incoming-ahead');
    expect(compareIdentity(mk(['a', 'b', 'c']), mk(['a', 'b']))).toBe('local-ahead');
    expect(compareIdentity(mk(['a', 'b', 'x']), mk(['a', 'b', 'y', 'z']))).toBe('diverged');
  });
});
