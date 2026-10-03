// Path helpers that work on paths from *any* OS (a bundle made on Windows can be
// imported on macOS and vice versa), so nothing here uses node:path.

export type PathStyle = 'windows' | 'posix';

export function detectStyle(p: string): PathStyle {
  return /^[a-zA-Z]:([\\/]|$)/.test(p) || p.startsWith('\\\\') ? 'windows' : 'posix';
}

/**
 * Claude Code stores a project's sessions in ~/.claude/projects/<encoded>, where
 * <encoded> is the absolute project path with every non-alphanumeric character
 * replaced by "-". C:\Users\me\my_app → C--Users-me-my-app.
 */
export function encodeProjectDir(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

export function sameEncodedDir(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function trimSep(p: string): string {
  if (/^[a-zA-Z]:[\\/]?$/.test(p) || p === '/') return p;
  return p.replace(/[\\/]+$/, '');
}

export function basename(p: string): string {
  const parts = trimSep(p).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function dirname(p: string): string {
  const t = trimSep(p);
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  if (i <= 0) return detectStyle(t) === 'windows' ? t.slice(0, 3) : '/';
  const d = t.slice(0, i);
  return /^[a-zA-Z]:$/.test(d) ? d + '\\' : d;
}

export function joinPath(base: string, ...parts: string[]): string {
  const sep = detectStyle(base) === 'windows' ? '\\' : '/';
  let out = trimSep(base);
  for (const part of parts) {
    if (!part) continue;
    const clean = part.replace(/^[\\/]+|[\\/]+$/g, '').replace(/[\\/]+/g, sep);
    out = out.endsWith(sep) ? out + clean : out + sep + clean;
  }
  return out;
}

/** Canonical form for comparisons: no trailing separator; Windows paths lower-cased with backslashes. */
export function canonicalPath(p: string): string {
  let s = trimSep(p.trim());
  if (detectStyle(s) === 'windows') s = s.replace(/\//g, '\\').toLowerCase();
  return s;
}

export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

export function isInside(child: string, parent: string): boolean {
  const c = canonicalPath(child);
  const p = canonicalPath(parent);
  if (c === p) return true;
  const sep = detectStyle(p) === 'windows' ? '\\' : '/';
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Relative remainder of child under parent ("" when equal), using "/" separators. */
export function relativeUnder(child: string, parent: string): string | null {
  if (!isInside(child, parent)) return null;
  const rest = trimSep(child).slice(trimSep(parent).length);
  return rest.replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

/**
 * Lossy decode for when no session in a folder tells us its real path.
 * C--Users-me-app → C:\Users\me\app ; -home-me-app → /home/me/app
 */
export function naiveDecodeProjectDir(dir: string): string {
  const win = dir.match(/^([A-Za-z])--(.*)$/);
  if (win) return `${win[1]!.toUpperCase()}:\\${win[2]!.replace(/-/g, '\\')}`;
  if (dir.startsWith('-')) return dir.replace(/-/g, '/');
  return dir;
}

/** Shorten a path for display by replacing the home directory with ~. */
export function tildify(p: string, home: string): string {
  if (!home) return p;
  const rest = relativeUnder(p, home);
  if (rest === null) return p;
  const sep = detectStyle(p) === 'windows' ? '\\' : '/';
  return rest ? `~${sep}${rest.replace(/\//g, sep)}` : '~';
}

// ---------------------------------------------------------------- rewriting

export interface PathRule {
  from: string;
  to: string;
}

interface Variant {
  text: string;
  /** separator used inside this textual form */
  sep: '\\' | '/' | '\\\\';
  ruleIndex: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function windowsVariants(p: string, ruleIndex: number): Variant[] {
  const back = trimSep(p).replace(/\//g, '\\');
  const fwd = back.replace(/\\/g, '/');
  const out: Variant[] = [
    { text: back, sep: '\\', ruleIndex },
    { text: fwd, sep: '/', ruleIndex },
    // JSON-escaped form, as it appears when tool input JSON is quoted inside text
    { text: back.replace(/\\/g, '\\\\'), sep: '\\\\', ruleIndex },
  ];
  const drive = back.match(/^([a-zA-Z]):\\(.*)$/);
  if (drive) {
    // Git Bash / MSYS form: /c/Users/me
    out.push({ text: `/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`, sep: '/', ruleIndex });
  }
  return out;
}

function renderTarget(to: string, sep: Variant['sep'], fromStyle: PathStyle): string {
  const toStyle = detectStyle(to);
  const t = trimSep(to);
  if (toStyle === 'posix') return t;
  // Windows target: mirror the textual form that matched
  const back = t.replace(/\//g, '\\');
  if (sep === '\\\\') return back.replace(/\\/g, '\\\\');
  if (sep === '/') {
    // keep MSYS-looking matches MSYS-looking only when the source was Windows too
    return fromStyle === 'windows' ? back.replace(/\\/g, '/') : back;
  }
  return back;
}

/**
 * Build a function that rewrites every occurrence of the rule paths inside a
 * string. Rules are applied in a single pass (longest match first), so a rule's
 * output is never re-matched by another rule. Matching is case-insensitive for
 * Windows source paths, and only matches whole path segments.
 */
export function buildRewriter(rules: PathRule[]): { rewrite: (s: string) => string; count: () => number; reset: () => void } {
  const usable = rules.filter((r) => r.from && r.to && !samePath(r.from, r.to));
  let hits = 0;
  if (usable.length === 0) {
    return { rewrite: (s) => s, count: () => 0, reset: () => void 0 };
  }
  const variants: Variant[] = [];
  usable.forEach((r, i) => {
    if (detectStyle(r.from) === 'windows') variants.push(...windowsVariants(r.from, i));
    else variants.push({ text: trimSep(r.from), sep: '/', ruleIndex: i });
  });
  // Longest first so the most specific rule wins in the alternation.
  variants.sort((a, b) => b.text.length - a.text.length);
  const anyWindows = usable.some((r) => detectStyle(r.from) === 'windows');
  const lookup = new Map<string, Variant>();
  for (const v of variants) {
    const key = anyWindows ? v.text.toLowerCase() : v.text;
    if (!lookup.has(key)) lookup.set(key, v);
  }
  const alternation = [...lookup.values()].map((v) => escapeRe(v.text)).join('|');
  // Boundaries: not glued to a preceding letter/digit; followed by a separator,
  // end of string, a delimiter, or a sentence-ending period.
  const re = new RegExp(
    `(?<![A-Za-z0-9_])(${alternation})(?=$|[\\\\/"'\`\\s:;,)\\]}>|*?]|\\.(?:\\s|$))((?:\\\\\\\\|[\\\\/])[^\\s"'\`<>|*?\\r\\n)\\]}]*)?`,
    anyWindows ? 'gi' : 'g',
  );

  const rewrite = (s: string): string => {
    if (s.length < 3) return s;
    return s.replace(re, (_m, prefix: string, rest: string | undefined) => {
      const v = lookup.get(anyWindows ? prefix.toLowerCase() : prefix);
      if (!v) return _m;
      const rule = usable[v.ruleIndex]!;
      const fromStyle = detectStyle(rule.from);
      const toStyle = detectStyle(rule.to);
      hits++;
      let tail = rest ?? '';
      if (fromStyle !== toStyle && tail) {
        tail = toStyle === 'posix' ? tail.replace(/\\\\|\\/g, '/') : tail.replace(/\//g, v.sep === '\\\\' ? '\\\\' : '\\');
      }
      return renderTarget(rule.to, v.sep, fromStyle) + tail;
    });
  };
  return { rewrite, count: () => hits, reset: () => void (hits = 0) };
}
