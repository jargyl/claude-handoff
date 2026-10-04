import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import {
  ExternalLink,
  ChartColumn,
  Cloud,
  FileArchive,
  FolderGit2,
  Inbox,
  LayoutDashboard,
  Lock,
  Menu as MenuIcon,
  MessagesSquare,
  MonitorSmartphone,
  Moon,
  Search,
  Settings as SettingsIcon,
  Sun,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useServerEvents } from './lib/events';
import { useImports, useMe, useRuns, useSessions } from './lib/queries';
import { RunDot, useOpenRun } from './components/RunPanel';
import { useTheme } from './lib/theme';
import { onUnauthorized } from './lib/api';
import { LogoMark } from './components/Logo';
import { CommandPalette } from './components/CommandPalette';
import { Kbd, ProgressBar, Spinner, cx } from './components/ui';
import { RemoteLogin } from './pages/RemoteLogin';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { useImportFiles } from './components/DropZone';

const Overview = lazy(() => import('./pages/Overview'));
const Sessions = lazy(() => import('./pages/Sessions'));
const SessionPage = lazy(() => import('./pages/SessionPage'));
const Projects = lazy(() => import('./pages/Projects'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const Analytics = lazy(() => import('./pages/Analytics'));
const InboxPage = lazy(() => import('./pages/Inbox'));
const ImportReview = lazy(() => import('./pages/ImportReview'));
const Devices = lazy(() => import('./pages/Devices'));
const DeviceDetail = lazy(() => import('./pages/DeviceDetail'));
const SyncPage = lazy(() => import('./pages/SyncPage'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const ExternalTranscript = lazy(() => import('./pages/ExternalTranscript'));
const NotFound = lazy(() => import('./pages/NotFound'));

/** Pages that hold per-item state get a fresh instance when the item in the URL changes. */
function SessionRoute() {
  const { id } = useParams();
  return <SessionPage key={id} />;
}
function ImportRoute() {
  const { id } = useParams();
  return <ImportReview key={id} />;
}

/** Pages that change this computer only make sense on the computer itself. */
function LocalOnly({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.data?.access === 'remote') {
    return (
      <div className="flex flex-col items-center px-6 py-16 text-center">
        <Lock className="mb-3 size-6 text-ink-3" aria-hidden />
        <h1 className="text-lg font-semibold">Only on the computer running Handoff</h1>
        <p className="mt-1 max-w-[48ch] text-base text-ink-2">From another device you can read and search sessions. Moving and importing them happens on the computer itself.</p>
        <Link to="/" className="mt-5 text-sm font-medium underline decoration-line-strong underline-offset-2">
          Go to overview
        </Link>
      </div>
    );
  }
  return <>{children}</>;
}

/** A crashing page shouldn't take the whole app down. */
class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-col items-center px-6 py-16 text-center">
        <TriangleAlert className="mb-3 size-6 text-warn" aria-hidden />
        <h1 className="text-lg font-semibold">This page ran into a problem</h1>
        <p className="mt-1 max-w-[56ch] font-mono text-sm text-ink-3">{this.state.error.message}</p>
        <button className="mt-5 text-sm font-medium underline decoration-line-strong underline-offset-2" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}

function NavItem({ to, icon: Icon, children, end, badge }: { to: string; icon: typeof Inbox; children: ReactNode; end?: boolean; badge?: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'group relative flex h-8 items-center gap-2.5 rounded-[6px] px-2.5 text-base transition-colors',
          isActive ? 'bg-raised font-medium text-ink shadow-[inset_0_0_0_1px_var(--line)]' : 'text-ink-2 hover:bg-sunken hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span aria-hidden className="absolute -left-3 top-1.5 h-5 w-[3px] rounded-r bg-signal" />}
          <Icon className={cx('size-4 shrink-0', isActive ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2')} aria-hidden />
          <span className="flex-1 truncate">{children}</span>
          {badge}
        </>
      )}
    </NavLink>
  );
}

function Count({ n, tone = 'neutral' }: { n: number; tone?: 'neutral' | 'signal' }) {
  if (!n) return null;
  return (
    <span className={cx('tnum rounded-[4px] px-1.5 text-xs font-medium', tone === 'signal' ? 'bg-signal text-signal-ink' : 'bg-sunken text-ink-3')}>{n.toLocaleString()}</span>
  );
}

function Sidebar({ onNavigate, onSearch }: { onNavigate?: () => void; onSearch: () => void }) {
  const me = useMe();
  const sessions = useSessions();
  const imports = useImports();
  const { resolved, toggle } = useTheme();
  const live = sessions.data?.sessions.filter((s) => s.live).length ?? 0;
  const remote = me.data?.access === 'remote';
  const runs = useRuns(me.data?.access === 'local');
  const openRun = useOpenRun();
  const active = (runs.data?.runs ?? []).filter((r) => r.status === 'running');
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-5 px-3 pb-3 pt-4" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      <div className="flex items-center gap-2.5 px-1">
        <LogoMark />
        <div className="leading-tight">
          <p className="text-lg font-semibold tracking-[-0.01em] text-ink">Handoff</p>
          <p className="text-xs text-ink-3">for Claude Code</p>
        </div>
      </div>
      <button
        onClick={onSearch}
        className="flex h-9 items-center gap-2 rounded-[7px] border border-line-strong bg-raised px-2.5 text-left text-base text-ink-3 hover:border-ink-3 hover:text-ink-2"
      >
        <Search className="size-4" aria-hidden />
        <span className="flex-1">Jump to…</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      <div className="flex flex-col gap-0.5">
        <NavItem to="/" end icon={LayoutDashboard}>
          Overview
        </NavItem>
        <NavItem
          to="/sessions"
          icon={MessagesSquare}
          badge={live ? <span className="flex items-center gap-1.5 text-xs text-ink-3"><span className="live-dot size-1.5 rounded-full bg-signal" />{live}</span> : <Count n={sessions.data?.sessions.length ?? 0} />}
        >
          Sessions
        </NavItem>
        <NavItem to="/projects" icon={FolderGit2}>
          Projects
        </NavItem>
        <NavItem to="/search" icon={Search}>
          Search
        </NavItem>
        <NavItem to="/analytics" icon={ChartColumn}>
          Analytics
        </NavItem>
      </div>
      {!remote && (
        <div className="flex flex-col gap-0.5">
          <p className="mb-1 px-2.5 text-sm text-ink-3">Move between machines</p>
          <NavItem to="/inbox" icon={Inbox} badge={<Count n={imports.data?.imports.length ?? 0} tone="signal" />}>
            Inbox
          </NavItem>
          <NavItem to="/devices" icon={MonitorSmartphone}>
            Devices
          </NavItem>
          <NavItem to="/sync" icon={Cloud}>
            Sync folder
          </NavItem>
        </div>
      )}
      {!remote && active.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="mb-1 px-2.5 text-sm text-ink-3">Running</p>
          {active.map((r) => (
            <div key={r.id} className="group flex h-8 items-center gap-2 rounded-[6px] px-2.5 hover:bg-sunken">
              <RunDot status={r.status} />
              <button onClick={() => (openRun(r.projectPath), onNavigate?.())} className="min-w-0 flex-1 truncate text-left text-base text-ink-2 hover:text-ink" title={`${r.projectName}: ${r.command}`}>
                {r.projectName} <span className="text-ink-3">{r.label}</span>
              </button>
              {r.url && (
                <a href={r.url} target="_blank" rel="noreferrer" aria-label={`Open ${r.url}`} title={r.url} className="shrink-0 text-ink-3 hover:text-ink">
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-auto flex flex-col gap-0.5">
        {!remote && (
          <NavItem to="/settings" icon={SettingsIcon}>
            Settings
          </NavItem>
        )}
        <div className="mt-2 flex items-center gap-2 border-t border-line px-1 pt-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{me.data?.device.name ?? '…'}</p>
            <p className="flex items-center gap-1.5 truncate text-xs text-ink-3">
              <span className={cx('size-1.5 rounded-full', me.data?.lan.enabled ? 'bg-good' : 'bg-line-strong')} aria-hidden />
              {remote ? 'Viewing from another device' : me.data?.lan.enabled ? 'Visible on your network' : 'This computer only'}
            </p>
          </div>
          <button
            onClick={toggle}
            aria-label={resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={resolved === 'dark' ? 'Light mode (T)' : 'Dark mode (T)'}
            className="grid size-8 place-items-center rounded-[6px] border border-line bg-raised text-ink-2 hover:text-ink"
          >
            {resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </div>
    </nav>
  );
}

/** Drop a bundle or transcript anywhere in the app to import it. */
function useGlobalDrop(enabled: boolean) {
  const { run, progress } = useImportFiles();
  const runRef = useRef(run);
  runRef.current = run;
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    // capture phase: always clear the overlay, even when a drop zone stops the event
    const onDropCapture = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = 0;
      setDragging(false);
    };
    // bubble phase: import, unless a drop zone on the page already handled it
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      void runRef.current([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDropCapture, true);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDropCapture, true);
      window.removeEventListener('drop', onDrop);
    };
  }, [enabled]);
  return { dragging, progress };
}

export function App() {
  const { index } = useServerEvents();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const { toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const gPressed = useRef(0);
  const me = useMe();
  const drop = useGlobalDrop(me.data?.access === 'local');

  useEffect(() => onUnauthorized(() => setNeedsLogin(true)), []);
  useEffect(() => setDrawer(false), [location.pathname]);
  const remoteRef = useRef(false);
  remoteRef.current = me.data?.access === 'remote';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      // a dialog or the menu drawer owns the keyboard while it's open
      if (document.querySelector('dialog[open], [data-drawer]')) {
        if (e.key === 'Escape') setDrawer(false);
        return;
      }
      if (e.key === '?') setHelpOpen(true);
      else if (e.key === 't') toggle();
      else if (e.key === '/') {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>('[data-page-search]');
        if (input) input.focus();
        else navigate('/search');
      } else if (e.key === 'g') gPressed.current = Date.now();
      else if (Date.now() - gPressed.current < 1200) {
        const dest: Record<string, string> = remoteRef.current
          ? { o: '/', s: '/sessions', p: '/projects', a: '/analytics' }
          : { o: '/', s: '/sessions', p: '/projects', a: '/analytics', i: '/inbox', d: '/devices', f: '/sync', ',': '/settings' };
        if (dest[e.key]) {
          navigate(dest[e.key]!);
          gPressed.current = 0;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, toggle]);

  if (needsLogin) return <RemoteLogin onDone={() => window.location.reload()} />;

  return (
    <div className="min-h-dvh bg-bg">
      {index?.state === 'scanning' && index.total > 0 && (
        <div className="fixed inset-x-0 top-0 z-50 flex items-center gap-3 border-b border-line bg-surface/95 px-4 py-1.5 text-sm text-ink-2 backdrop-blur">
          <Spinner className="size-3.5" />
          <span className="tnum">
            Reading your sessions… {index.done.toLocaleString()} of {index.total.toLocaleString()}
          </span>
          <ProgressBar value={index.done / Math.max(1, index.total)} className="max-w-60 flex-1" />
        </div>
      )}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[240px] border-r border-line bg-bg lg:block">
        <Sidebar onSearch={() => setPaletteOpen(true)} />
      </aside>
      <div className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-line bg-bg/95 px-3 backdrop-blur lg:hidden">
        <button aria-label="Open menu" onClick={() => setDrawer(true)} className="grid size-9 place-items-center rounded-[6px] text-ink-2 hover:bg-sunken">
          <MenuIcon className="size-5" />
        </button>
        <LogoMark className="size-6" />
        <span className="font-semibold">Handoff</span>
        <button aria-label="Search" onClick={() => setPaletteOpen(true)} className="ml-auto grid size-9 place-items-center rounded-[6px] text-ink-2 hover:bg-sunken">
          <Search className="size-5" />
        </button>
      </div>
      {drawer && (
        <div data-drawer className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-[280px] max-w-[85vw] border-r border-line bg-bg">
            <button aria-label="Close menu" onClick={() => setDrawer(false)} className="absolute right-2 top-3 grid size-8 place-items-center rounded text-ink-3 hover:text-ink">
              <X className="size-4" />
            </button>
            <Sidebar onNavigate={() => setDrawer(false)} onSearch={() => setPaletteOpen(true)} />
          </div>
        </div>
      )}
      <main className="lg:pl-[240px]">
        <div className="mx-auto w-full max-w-[1320px] px-4 pb-16 pt-6 sm:px-6 lg:px-8 lg:pt-8">
          <Suspense
            fallback={
              <div className="grid h-[50vh] place-items-center">
                <Spinner />
              </div>
            }
          >
            <ErrorBoundary resetKey={location.pathname}>
              <Routes>
                <Route path="/" element={<Overview />} />
                <Route path="/sessions" element={<Sessions />} />
                <Route path="/sessions/:id" element={<SessionRoute />} />
                <Route path="/projects" element={<Projects />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/analytics" element={<Analytics />} />
                <Route path="/inbox" element={<LocalOnly><InboxPage /></LocalOnly>} />
                <Route path="/inbox/:id" element={<LocalOnly><ImportRoute /></LocalOnly>} />
                <Route path="/devices" element={<LocalOnly><Devices /></LocalOnly>} />
                <Route path="/devices/:id" element={<LocalOnly><DeviceDetail /></LocalOnly>} />
                <Route path="/devices/:id/sessions/:sid" element={<LocalOnly><ExternalTranscript source="device" /></LocalOnly>} />
                <Route path="/sync" element={<LocalOnly><SyncPage /></LocalOnly>} />
                <Route path="/sync/sessions/:sid" element={<LocalOnly><ExternalTranscript source="sync" /></LocalOnly>} />
                <Route path="/settings" element={<LocalOnly><SettingsPage /></LocalOnly>} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </ErrorBoundary>
          </Suspense>
        </div>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      {drop.dragging && (
        <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center bg-bg/80 p-6 backdrop-blur-sm">
          <div className="flex w-full max-w-lg flex-col items-center rounded-[14px] border-2 border-dashed border-signal-line bg-signal-wash px-8 py-12 text-center">
            <FileArchive className="mb-3 size-8 text-ink-2" aria-hidden />
            <p className="text-lg font-semibold text-ink">Drop to import</p>
            <p className="mt-1 text-sm text-ink-2">A bundle (.zip) or session files (.jsonl). You'll review where everything goes first.</p>
          </div>
        </div>
      )}
      {drop.progress && (
        <div className="fixed bottom-4 left-1/2 z-[70] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 rounded-[10px] border border-line bg-raised px-4 py-3 shadow-[var(--shadow)]">
          <p className="mb-1.5 truncate text-sm text-ink-2">Reading {drop.progress.name}…</p>
          <ProgressBar value={drop.progress.value} />
        </div>
      )}
    </div>
  );
}
