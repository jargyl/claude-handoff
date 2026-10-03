// Recognizing the different things that show up as "user" text in a transcript.

export type UserTextKind =
  | 'prompt'
  | 'command' // <command-name>/foo</command-name>
  | 'command-output' // <local-command-stdout>
  | 'caveat' // <local-command-caveat>
  | 'shell' // <bash-input> / <bash-stdout> from "!" commands
  | 'notification' // <task-notification>
  | 'interrupt'
  | 'empty';

export function classifyUserText(text: string): UserTextKind {
  const t = text.trimStart();
  if (!t) return 'empty';
  if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) return 'command';
  if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>')) return 'command-output';
  if (t.startsWith('<local-command-caveat>') || t.startsWith('Caveat: The messages below were generated')) return 'caveat';
  if (t.startsWith('<bash-input>') || t.startsWith('<bash-stdout>') || t.startsWith('<bash-stderr>')) return 'shell';
  if (t.startsWith('<task-notification>')) return 'notification';
  if (/^\[Request interrupted by user/.test(t)) return 'interrupt';
  return 'prompt';
}

export function tagContent(text: string, tag: string): string | undefined {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : undefined;
}

/** Remove <system-reminder> blocks and similar injected context from prompt text. */
export function stripInjected(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<fork-boilerplate>[\s\S]*?<\/fork-boilerplate>/g, '')
    .trim();
}

export function oneLine(text: string, max = 240): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Text of a message.content value (string or block array), ignoring tool results and images. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === 'object' && (b as any).type === 'text' && typeof (b as any).text === 'string') parts.push((b as any).text);
  }
  return parts.join('\n');
}

export function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => b && typeof b === 'object' && (b as any).type === 'tool_result');
}
