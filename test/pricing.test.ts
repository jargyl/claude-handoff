import { describe, expect, it } from 'vitest';
import { costOf, modelLabel, normalizeModelId, priceFor } from '../src/shared/pricing.js';

describe('pricing', () => {
  it('normalizes provider and dated model ids', () => {
    expect(normalizeModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('us.anthropic.claude-opus-4-1-20250805-v1:0')).toBe('claude-opus-4-1');
    expect(normalizeModelId('claude-opus-4-5@20251101')).toBe('claude-opus-4-5');
    expect(normalizeModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('labels models', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelLabel('<synthetic>')).toBe('Synthetic');
  });

  it('distinguishes Opus 5 from Opus 5.5', () => {
    expect(priceFor('claude-opus-5')!.input).toBe(5);
    expect(priceFor('claude-opus-5-5')!.input).toBe(4);
  });

  it('computes cost per token type', () => {
    const u = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 };
    // 4 + 20 + 0.2 + 5 + 8
    expect(costOf(u, 'claude-opus-5-5')).toBeCloseTo(37.2);
    expect(costOf(u, 'claude-opus-5-5', { fast: true })).toBeCloseTo(74.4);
    expect(costOf(u, 'claude-sonnet-5-5')).toBeCloseTo(2 + 10 + 0.2 + 2.5 + 4);
    expect(costOf(u, 'some-unknown-model')).toBeNull();
    expect(costOf(u, '<synthetic>')).toBe(0);
    expect(costOf(u, 'mystery', { overrides: { mystery: { input: 1, output: 1 } } })).toBeCloseTo(2);
  });
});
