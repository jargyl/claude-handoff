import { describe, expect, it } from 'vitest';
import {
  basename,
  buildRewriter,
  canonicalPath,
  detectStyle,
  dirname,
  encodeProjectDir,
  isInside,
  joinPath,
  naiveDecodeProjectDir,
  relativeUnder,
  tildify,
} from '../src/shared/paths.js';

describe('encodeProjectDir', () => {
  it('matches Claude Code folder names seen on disk', () => {
    expect(encodeProjectDir('C:\\Users\\jarig\\Development')).toBe('C--Users-jarig-Development');
    expect(encodeProjectDir('C:\\Users\\jarig\\Development\\portfolio_versions\\portfolio_v2')).toBe(
      'C--Users-jarig-Development-portfolio-versions-portfolio-v2',
    );
    expect(encodeProjectDir('C:\\Users\\jarig\\Development\\se-macrame\\.claude\\worktrees\\launch-cleanup')).toBe(
      'C--Users-jarig-Development-se-macrame--claude-worktrees-launch-cleanup',
    );
    expect(encodeProjectDir('/Users/me/my app')).toBe('-Users-me-my-app');
  });
});

describe('path helpers', () => {
  it('detects styles', () => {
    expect(detectStyle('C:\\x')).toBe('windows');
    expect(detectStyle('d:/x')).toBe('windows');
    expect(detectStyle('/home/x')).toBe('posix');
  });
  it('joins, splits and compares across OSes', () => {
    expect(joinPath('C:\\Users\\me', 'a', 'b/c')).toBe('C:\\Users\\me\\a\\b\\c');
    expect(joinPath('/home/me/', 'a')).toBe('/home/me/a');
    expect(basename('C:\\a\\b\\')).toBe('b');
    expect(dirname('C:\\a\\b')).toBe('C:\\a');
    expect(dirname('C:\\a')).toBe('C:\\');
    expect(canonicalPath('C:/Users/Me/')).toBe('c:\\users\\me');
    expect(isInside('C:\\Users\\me\\x', 'c:\\users\\ME')).toBe(true);
    expect(isInside('C:\\Users\\meme', 'C:\\Users\\me')).toBe(false);
    expect(relativeUnder('/home/me/a/b', '/home/me')).toBe('a/b');
    expect(tildify('C:\\Users\\me\\proj', 'C:\\Users\\me')).toBe('~\\proj');
  });
  it('naively decodes folder names', () => {
    expect(naiveDecodeProjectDir('C--Users-me-app')).toBe('C:\\Users\\me\\app');
    expect(naiveDecodeProjectDir('-home-me-app')).toBe('/home/me/app');
  });
});

describe('buildRewriter', () => {
  const win = { from: 'C:\\Users\\JARI\\Development\\portfolio_cc\\portfolio_v2', to: 'C:\\Users\\jarig\\Development\\portfolio_versions\\portfolio_v2' };

  it('rewrites the project path and keeps the rest of the path', () => {
    const { rewrite, count } = buildRewriter([win]);
    expect(rewrite('C:\\Users\\JARI\\Development\\portfolio_cc\\portfolio_v2\\src\\index.ts')).toBe(
      'C:\\Users\\jarig\\Development\\portfolio_versions\\portfolio_v2\\src\\index.ts',
    );
    expect(count()).toBe(1);
  });

  it('matches Windows paths case-insensitively and in every textual form', () => {
    const { rewrite } = buildRewriter([win]);
    expect(rewrite('c:\\users\\jari\\development\\portfolio_cc\\portfolio_v2')).toBe(win.to);
    expect(rewrite('cd "C:/Users/JARI/Development/portfolio_cc/portfolio_v2/app"')).toBe(
      'cd "C:/Users/jarig/Development/portfolio_versions/portfolio_v2/app"',
    );
    expect(rewrite('ls /c/Users/JARI/Development/portfolio_cc/portfolio_v2/src')).toBe(
      'ls C:/Users/jarig/Development/portfolio_versions/portfolio_v2/src',
    );
    expect(rewrite('{"file_path":"C:\\\\Users\\\\JARI\\\\Development\\\\portfolio_cc\\\\portfolio_v2\\\\a.ts"}')).toBe(
      '{"file_path":"C:\\\\Users\\\\jarig\\\\Development\\\\portfolio_versions\\\\portfolio_v2\\\\a.ts"}',
    );
  });

  it('only matches whole path segments', () => {
    const { rewrite } = buildRewriter([win]);
    const longer = 'C:\\Users\\JARI\\Development\\portfolio_cc\\portfolio_v2_old\\x';
    expect(rewrite(longer)).toBe(longer);
    expect(rewrite('see C:\\Users\\JARI\\Development\\portfolio_cc\\portfolio_v2.')).toBe(`see ${win.to}.`);
  });

  it('prefers the most specific rule and never chains rules', () => {
    const { rewrite } = buildRewriter([
      { from: 'C:\\Users\\JARI', to: 'C:\\Users\\jarig' },
      win,
      { from: 'C:\\Users\\jarig', to: 'D:\\nope' }, // would chain if applied after the first rule
    ]);
    expect(rewrite('C:\\Users\\JARI\\Development\\portfolio_cc\\portfolio_v2\\a')).toBe(`${win.to}\\a`);
    expect(rewrite('C:\\Users\\JARI\\Desktop\\b')).toBe('C:\\Users\\jarig\\Desktop\\b');
  });

  it('converts separators when moving between Windows and POSIX', () => {
    const toMac = buildRewriter([{ from: 'C:\\Users\\JARI\\proj', to: '/Users/jari/proj' }]);
    expect(toMac.rewrite('open C:\\Users\\JARI\\proj\\src\\main.ts now')).toBe('open /Users/jari/proj/src/main.ts now');
    const toWin = buildRewriter([{ from: '/home/jari/proj', to: 'D:\\code\\proj' }]);
    expect(toWin.rewrite('/home/jari/proj/src/a.ts')).toBe('D:\\code\\proj\\src\\a.ts');
  });

  it('is case-sensitive for POSIX sources and ignores glued prefixes', () => {
    const { rewrite } = buildRewriter([{ from: '/home/jari/proj', to: '/home/j/proj' }]);
    expect(rewrite('/home/Jari/proj')).toBe('/home/Jari/proj');
    expect(rewrite('x/home/jari/proj')).toBe('x/home/jari/proj');
    expect(rewrite('"/home/jari/proj/a"')).toBe('"/home/j/proj/a"');
  });

  it('rewrites every path in a delimited list without mangling the others', () => {
    const posix = buildRewriter([{ from: '/home/a/app', to: '/home/b/app' }]);
    expect(posix.rewrite('/home/a/app/x:/home/a/app/y')).toBe('/home/b/app/x:/home/b/app/y');
    const toWin = buildRewriter([{ from: '/home/a/app', to: 'C:\\Users\\b\\app' }]);
    expect(toWin.rewrite('/home/a/app/x,/home/a/app/y')).toBe('C:\\Users\\b\\app\\x,C:\\Users\\b\\app\\y');
    expect(toWin.rewrite('/home/a/app/x,/other/z')).toBe('C:\\Users\\b\\app\\x,/other/z');
    const win = buildRewriter([{ from: 'C:\\old\\app', to: 'D:\\new\\app' }]);
    expect(win.rewrite('C:\\old\\app\\src\\a.ts:12:5')).toBe('D:\\new\\app\\src\\a.ts:12:5');
  });

  it('is a no-op without effective rules', () => {
    const { rewrite } = buildRewriter([{ from: 'C:\\a', to: 'c:\\A\\' }]);
    expect(rewrite('C:\\a\\b')).toBe('C:\\a\\b');
  });
});
