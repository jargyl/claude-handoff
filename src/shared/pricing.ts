// API-equivalent pricing used to estimate what a session would have cost on the
// Anthropic API. Claude Code subscribers don't pay this; it's a yardstick.
// Rates are USD per million tokens (first-party Anthropic API list prices).

import type { Usage } from './types.js';

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** Multiplier applied when usage.speed === "fast". */
  fastMultiplier?: number;
}

interface Family {
  key: string;
  ids: string[];
  price: ModelPrice;
}

const FAMILIES: Family[] = [
  {
    key: 'fable-5.1',
    ids: ['claude-fable-5-1', 'claude-mythos-5-1'],
    price: { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  },
  {
    key: 'fable-5',
    ids: ['claude-fable-5', 'claude-mythos-5'],
    price: { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  },
  {
    key: 'opus-5.5',
    ids: ['claude-opus-5-5'],
    price: { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, fastMultiplier: 2 },
  },
  {
    key: 'opus-5',
    ids: ['claude-opus-5'],
    price: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, fastMultiplier: 2 },
  },
  {
    key: 'opus-4.5+',
    ids: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'],
    price: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  },
  {
    key: 'opus-4',
    ids: ['claude-opus-4-1', 'claude-opus-4-0', 'claude-opus-4', 'claude-3-opus'],
    price: { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  },
  {
    key: 'sonnet-5',
    ids: ['claude-sonnet-5-5', 'claude-sonnet-5'],
    price: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  },
  {
    key: 'sonnet-4',
    ids: ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-0', 'claude-sonnet-4', 'claude-3-7-sonnet', 'claude-3-5-sonnet'],
    price: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  },
  {
    key: 'haiku-4.5',
    ids: ['claude-haiku-4-5'],
    price: { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  },
  {
    key: 'haiku-3.5',
    ids: ['claude-3-5-haiku'],
    price: { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 },
  },
  {
    key: 'haiku-3',
    ids: ['claude-3-haiku'],
    price: { input: 0.25, output: 1.25, cacheWrite5m: 0.3, cacheWrite1h: 0.5, cacheRead: 0.03 },
  },
];

const BY_ID = new Map<string, Family>();
for (const f of FAMILIES) for (const id of f.ids) BY_ID.set(id, f);

/** Strip provider prefixes, date stamps and version suffixes: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" → "claude-sonnet-4-5". */
export function normalizeModelId(model: string): string {
  let s = model.trim().toLowerCase();
  const k = s.indexOf('claude-');
  if (k > 0) s = s.slice(k);
  s = s
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-latest$/, '');
  return s;
}

export function isSyntheticModel(model: string | undefined): boolean {
  return !model || model === '<synthetic>' || model.startsWith('<');
}

const NAMES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'];

/** Human label: "claude-opus-5-5" → "Opus 5.5", "claude-3-5-sonnet-20241022" → "Sonnet 3.5". */
export function modelLabel(model: string): string {
  if (isSyntheticModel(model)) return 'Synthetic';
  const id = normalizeModelId(model);
  const parts = id.replace(/^claude-/, '').split('-');
  const nameIdx = parts.findIndex((p) => NAMES.includes(p));
  if (nameIdx === -1) return model;
  const name = parts[nameIdx]!;
  const nums = parts.filter((p, i) => i !== nameIdx && /^\d+$/.test(p));
  const label = name[0]!.toUpperCase() + name.slice(1);
  return nums.length ? `${label} ${nums.join('.')}` : label;
}

export function priceFor(model: string, overrides?: Record<string, Partial<ModelPrice>>): ModelPrice | null {
  const id = normalizeModelId(model);
  const override = overrides?.[id] ?? overrides?.[model];
  const fam = BY_ID.get(id);
  if (!fam && !override) return null;
  const base: ModelPrice = fam?.price ?? { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  return override ? { ...base, ...override } : base;
}

export function costOf(
  usage: Usage,
  model: string,
  opts: { fast?: boolean; overrides?: Record<string, Partial<ModelPrice>> } = {},
): number | null {
  if (isSyntheticModel(model)) return 0;
  const p = priceFor(model, opts.overrides);
  if (!p) return null;
  const raw =
    usage.input * p.input +
    usage.output * p.output +
    usage.cacheRead * p.cacheRead +
    usage.cacheWrite5m * p.cacheWrite5m +
    usage.cacheWrite1h * p.cacheWrite1h;
  const mult = opts.fast ? (p.fastMultiplier ?? 1) : 1;
  return (raw / 1_000_000) * mult;
}

/** Table for the settings page. */
export function pricingTable(): Array<{ key: string; ids: string[]; price: ModelPrice }> {
  return FAMILIES.map((f) => ({ key: f.key, ids: [...f.ids], price: { ...f.price } }));
}
