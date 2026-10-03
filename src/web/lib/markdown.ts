// Markdown → sanitized HTML. Transcripts contain text from tool output and web
// pages, so everything goes through DOMPurify before it touches the DOM.

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';

const langs: Record<string, any> = {
  bash,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  powershell,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
  csharp,
  cpp,
  php,
  ruby,
  ini,
  dockerfile,
  kotlin,
  swift,
};
for (const [name, def] of Object.entries(langs)) hljs.registerLanguage(name, def);
const aliases: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  html: 'xml',
  svg: 'xml',
  vue: 'xml',
  astro: 'xml',
  md: 'markdown',
  cs: 'csharp',
  'c++': 'cpp',
  c: 'cpp',
  h: 'cpp',
  rb: 'ruby',
  toml: 'ini',
  kt: 'kotlin',
  docker: 'dockerfile',
  scss: 'css',
  less: 'css',
  patch: 'diff',
};

export function langFromPath(p: string): string | undefined {
  const ext = p.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  if (hljs.getLanguage(ext)) return ext;
  return aliases[ext];
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function highlight(code: string, lang?: string): string {
  const l = lang ? (hljs.getLanguage(lang) ? lang : aliases[lang.toLowerCase()]) : undefined;
  if (l && code.length < 200_000) {
    try {
      return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(code);
}

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    code({ text, lang }) {
      const l = (lang ?? '').trim().split(/\s+/)[0];
      return `<pre><code class="hljs">${highlight(text, l)}</code></pre>`;
    },
    html({ text }) {
      // raw HTML in a transcript is shown, not rendered
      return escapeHtml(text);
    },
    image({ href, text }) {
      // Never load remote images: opening a session must not make requests to
      // hosts named in it (a prompt-injected reply could leak data that way).
      const label = escapeHtml(text || 'image');
      return href ? `<a href="${escapeHtml(href)}">[image: ${label}]</a>` : `[image: ${label}]`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const cache = new Map<string, string>();

export function renderMarkdown(src: string): string {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(md.parse(src, { async: false }) as string, {
    FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'img', 'picture', 'source', 'video', 'audio', 'object', 'embed', 'link', 'meta'],
    FORBID_ATTR: ['style', 'srcset', 'background', 'poster'],
  });
  if (cache.size > 2000) cache.clear();
  cache.set(src, html);
  return html;
}
