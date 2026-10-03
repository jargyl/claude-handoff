import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ChartColumn,
  Cloud,
  CornerDownLeft,
  FolderGit2,
  Inbox,
  LayoutDashboard,
  MessagesSquare,
  MonitorSmartphone,
  SunMoon,
  Search,
  Settings,
  TextSearch,
  type LucideIcon,
} from 'lucide-react';
import { useSessions } from '../lib/queries';
import { useTheme } from '../lib/theme';
import { relative, shortId } from '../lib/format';
import { LiveDot, cx } from './ui';

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon?: LucideIcon;
  live?: string;
  group: 'Sessions' | 'Go to' | 'Actions';
  run: () => void;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const sessions = useSessions();
  const { toggle } = useTheme();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQ('');
      setActive(0);
      d.showModal();
      setTimeout(() => input.current?.focus(), 0);
    } else if (!open && d.open) d.close();
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => {
      navigate(to);
      onClose();
    };
    const pages: Item[] = [
      { id: 'p-overview', label: 'Overview', icon: LayoutDashboard, group: 'Go to', run: go('/') },
      { id: 'p-sessions', label: 'Sessions', icon: MessagesSquare, group: 'Go to', run: go('/sessions') },
      { id: 'p-projects', label: 'Projects', icon: FolderGit2, group: 'Go to', run: go('/projects') },
      { id: 'p-analytics', label: 'Analytics', icon: ChartColumn, group: 'Go to', run: go('/analytics') },
      { id: 'p-inbox', label: 'Inbox: import sessions', icon: Inbox, group: 'Go to', run: go('/inbox') },
      { id: 'p-devices', label: 'Devices', icon: MonitorSmartphone, group: 'Go to', run: go('/devices') },
      { id: 'p-sync', label: 'Sync folder', icon: Cloud, group: 'Go to', run: go('/sync') },
      { id: 'p-settings', label: 'Settings', icon: Settings, group: 'Go to', run: go('/settings') },
    ];
    const actions: Item[] = [
      {
        id: 'a-theme',
        label: 'Switch light / dark mode',
        icon: SunMoon,
        group: 'Actions',
        run: () => {
          toggle();
          onClose();
        },
      },
    ];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (hay: string) => words.every((w) => hay.includes(w));
    const list = sessions.data?.sessions ?? [];
    const sess: Item[] = list
      .map((s) => {
        const hay = `${s.title} ${s.projectName} ${s.firstPrompt ?? ''} ${s.id} ${s.branch ?? ''} ${s.tags.join(' ')}`.toLowerCase();
        if (words.length && !match(hay)) return null;
        const score = words.length ? (s.title.toLowerCase().includes(words[0]!) ? 2 : 1) + (s.live ? 1 : 0) : s.live ? 2 : 0;
        return { s, score };
      })
      .filter((x): x is { s: (typeof list)[number]; score: number } => !!x)
      .sort((a, b) => b.score - a.score)
      .slice(0, words.length ? 8 : 5)
      .map(({ s }) => ({
        id: `s-${s.id}`,
        label: s.title,
        hint: `${s.projectName} · ${s.live ? (s.live.status === 'idle' ? 'waiting' : 'working') : relative(s.endedAt)} · ${shortId(s.id)}`,
        live: s.live?.status,
        group: 'Sessions' as const,
        run: go(`/sessions/${s.id}`),
      }));
    const filterStatic = (arr: Item[]) => (words.length ? arr.filter((i) => match(i.label.toLowerCase())) : arr);
    const searchAll: Item[] = q.trim().length >= 2 ? [{ id: 'a-search', label: `Search every transcript for “${q.trim()}”`, icon: TextSearch, group: 'Actions', run: go(`/search?q=${encodeURIComponent(q.trim())}`) }] : [];
    return [...sess, ...searchAll, ...filterStatic(pages), ...filterStatic(actions)];
  }, [q, sessions.data, navigate, onClose, toggle]);

  useEffect(() => setActive(0), [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[active]?.run();
    }
  };

  let lastGroup = '';
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      className="mx-auto mt-[12vh] w-[calc(100vw-2rem)] max-w-[620px] rounded-[12px] border border-line bg-surface p-0 shadow-[var(--shadow)]"
    >
      {open && (
        <div onKeyDown={onKey}>
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Search className="size-4 text-ink-3" aria-hidden />
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a session, page or action"
              aria-label="Command"
              className="h-12 flex-1 bg-transparent text-md text-ink placeholder:text-ink-3 focus:outline-none"
            />
          </div>
          <ul role="listbox" className="max-h-[55vh] overflow-y-auto p-1.5 scroll-thin">
            {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-ink-3">Nothing matches “{q}”.</li>}
            {items.map((it, i) => {
              const header = it.group !== lastGroup ? it.group : null;
              lastGroup = it.group;
              const Icon = it.icon;
              return (
                <li key={it.id} role="option" aria-selected={i === active}>
                  {header && <p className="px-2.5 pb-1 pt-2.5 text-xs font-medium text-ink-3">{header}</p>}
                  <button
                    onMouseMove={() => setActive(i)}
                    onClick={it.run}
                    className={cx('flex w-full items-center gap-3 rounded-[6px] px-2.5 py-2 text-left', i === active ? 'bg-sunken' : '')}
                  >
                    {it.live ? <LiveDot status={it.live} /> : Icon ? <Icon className="size-4 shrink-0 text-ink-3" aria-hidden /> : <MessagesSquare className="size-4 shrink-0 text-ink-3" aria-hidden />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base text-ink">{it.label}</span>
                      {it.hint && <span className="block truncate text-xs text-ink-3">{it.hint}</span>}
                    </span>
                    {i === active && <CornerDownLeft className="size-3.5 shrink-0 text-ink-3" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </dialog>
  );
}
