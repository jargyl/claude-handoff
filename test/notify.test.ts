import { describe, expect, it } from 'vitest';
import { finishedWork, MIN_WORK_MS } from '../src/server/notify.js';

describe('finishedWork', () => {
  it('reports a session that worked long enough and then waits', () => {
    const since = new Map<string, number>();
    expect(finishedWork(since, new Map([['a', 'busy']]), 0)).toEqual([]);
    expect(finishedWork(since, new Map([['a', 'shell']]), 5_000)).toEqual([]);
    expect(finishedWork(since, new Map([['a', 'idle']]), MIN_WORK_MS)).toEqual(['a']);
    // stays waiting: no second toast
    expect(finishedWork(since, new Map([['a', 'idle']]), MIN_WORK_MS + 5_000)).toEqual([]);
  });

  it('skips short replies, sessions already waiting at startup, and closed sessions', () => {
    const since = new Map<string, number>();
    expect(finishedWork(since, new Map([['a', 'idle'], ['b', 'busy'], ['c', 'busy']]), 0)).toEqual([]);
    expect(finishedWork(since, new Map([['a', 'idle'], ['b', 'idle']]), 3_000)).toEqual([]);
    expect(since.size).toBe(0);
  });
});
