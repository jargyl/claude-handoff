import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FolderX, Play, Plus, RotateCw, Square, SquareTerminal, Trash2, X } from 'lucide-react';
import type { CustomRunCommand, RunCommand, RunInfo, RunLog, RunLogLine } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { qk, useProjectRun } from '../lib/queries';
import { relative } from '../lib/format';
import { useToast } from '../lib/toast';
import { Dialog } from './Dialog';
import { Badge, Button, Callout, IconButton, Spinner, TextInput, cx } from './ui';

// ------------------------------------------------------------------ open the dialog from anywhere

const RunCtx = createContext<(path: string) => void>(() => {});
export const useOpenRun = () => useContext(RunCtx);

export function RunProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState<string | null>(null);
  return (
    <RunCtx.Provider value={setPath}>
      {children}
      <RunDialog path={path} onClose={() => setPath(null)} />
    </RunCtx.Provider>
  );
}

function RunDialog({ path, onClose }: { path: string | null; onClose: () => void }) {
  const name = path ? (path.split(/[\\/]/).filter(Boolean).pop() ?? path) : '';
  return (
    <Dialog open={!!path} onClose={onClose} size="lg" title={`Run ${name}`} description={<span className="font-mono text-[12px]">{path}</span>}>
      {path && <RunPanel path={path} />}
    </Dialog>
  );
}

// ------------------------------------------------------------------ status

const STATUS: Record<RunInfo['status'], { label: string; tone: 'signal' | 'good' | 'bad' | 'neutral' }> = {
  running: { label: 'Running', tone: 'signal' },
  exited: { label: 'Finished', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

export function RunDot({ status }: { status: RunInfo['status'] }) {
  return (
    <span
      aria-hidden
      className={cx(
        'size-2 shrink-0 rounded-full',
        status === 'running' ? 'live-dot bg-signal' : status === 'failed' ? 'bg-bad' : status === 'exited' ? 'bg-good' : 'bg-line-strong',
      )}
    />
  );
}

// ------------------------------------------------------------------ the panel

export function RunPanel({ path }: { path: string }) {
  const info = useProjectRun(path);
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.runProject(path) });
    void qc.invalidateQueries({ queryKey: qk.runs });
  };
  const fail = (e: unknown) => toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });

  const run = async (c: RunCommand, terminal = false) => {
    setBusy(c.id + (terminal ? ':t' : ''));
    try {
      const r = await api.post<{ run?: RunInfo; terminal?: string; opened?: boolean; hint?: string }>('/api/run', { path, commandId: c.id, terminal });
      if (r.terminal) toast({ tone: 'success', message: `Opened in ${r.terminal}` });
      else if (r.hint) toast({ tone: 'info', message: r.hint });
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const saveCustom = async (list: CustomRunCommand[]) => {
    try {
      await api.put('/api/run/project/custom', { path, commands: list });
      refresh();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  if (info.isLoading) {
    return (
      <div className="grid h-40 place-items-center">
        <Spinner />
      </div>
    );
  }
  if (info.error || !info.data) return <Callout tone="warn" title="Couldn't look at this project">{(info.error as Error)?.message}</Callout>;
  const d = info.data;
  if (!d.exists) {
    return (
      <Callout tone="warn" icon={FolderX} title="This folder isn't on this computer">
        Clone or copy the project here first.
      </Callout>
    );
  }

  const runs = d.runs;
  const commands = d.commands;
  const visible = all ? commands : commands.slice(0, 6);

  return (
    <div className="flex flex-col gap-5">
      {runs.length > 0 && (
        <section className="flex flex-col gap-2">
          {runs.map((r) => (
            <RunCard key={r.id} r={r} onChange={refresh} onError={fail} />
          ))}
        </section>
      )}

      <section>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className="font-semibold">Ways to run it</h3>
          <button onClick={() => setAdding((a) => !a)} className="flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
            <Plus className="size-3.5" aria-hidden /> Add a command
          </button>
        </div>
        {adding && (
          <AddCommand
            onCancel={() => setAdding(false)}
            onSave={async (c) => {
              if (await saveCustom([...d.custom, c])) setAdding(false);
            }}
          />
        )}
        {commands.length === 0 ? (
          <p className="rounded-[6px] border border-dashed border-line-strong px-4 py-3 text-sm text-ink-3">
            Nothing found to run here: no package.json scripts, Python entry point, .csproj, Cargo.toml or similar. Add the command you use yourself.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-[8px] border border-line">
            {visible.map((c) => {
              const running = runs.find((r) => r.commandId === c.id && r.status === 'running');
              return (
                <li key={c.id} className={cx('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2', c.primary && 'bg-signal-wash/60')}>
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{c.label}</span>
                      {c.primary && <Badge tone="signal">Suggested</Badge>}
                      {c.kind === 'custom' && <Badge>Yours</Badge>}
                    </p>
                    <p className="truncate font-mono text-[12px] text-ink-3" title={c.source}>
                      {c.kind === 'open' ? c.source : c.command}
                      {c.install && <span className="font-sans"> · installs dependencies first ({c.install})</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {c.kind === 'custom' && (
                      <IconButton
                        label="Remove this command"
                        icon={Trash2}
                        size="sm"
                        onClick={() => void saveCustom(d.custom.filter((x) => !(x.command === c.command && (x.cwd ?? '').replace(/^[\\/]+|[\\/]+$/g, '') === c.cwd)))}
                      />
                    )}
                    {c.kind !== 'open' && (
                      <IconButton label="Run in a terminal window" title="Run in a terminal window (for commands that ask you things)" icon={SquareTerminal} size="sm" onClick={() => void run(c, true)} />
                    )}
                    <Button size="sm" variant={c.primary ? 'primary' : 'secondary'} icon={c.kind === 'open' ? ExternalLink : Play} loading={busy === c.id} disabled={!!running} onClick={() => void run(c)}>
                      {running ? 'Running' : c.kind === 'open' ? 'Open' : 'Run'}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {commands.length > 6 && (
          <button onClick={() => setAll((a) => !a)} className="mt-2 text-sm text-ink-2 underline decoration-line-strong underline-offset-2">
            {all ? 'Show fewer' : `Show all ${commands.length}`}
          </button>
        )}
        <p className="mt-3 text-xs text-ink-3">Commands run in the background with their output here, and stop when you quit Handoff. Use the terminal button for anything that asks for input.</p>
      </section>
    </div>
  );
}

function AddCommand({ onSave, onCancel }: { onSave: (c: CustomRunCommand) => void; onCancel: () => void }) {
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');
  return (
    <form
      className="mb-3 grid gap-2 rounded-[8px] border border-line bg-raised p-3 sm:grid-cols-[1fr_2fr]"
      onSubmit={(e) => {
        e.preventDefault();
        if (command.trim()) onSave({ label: label.trim() || command.trim(), command: command.trim(), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) });
      }}
    >
      <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (optional)" aria-label="Name" />
      <TextInput value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Command, e.g. npm run dev -- --port 3001" aria-label="Command" className="font-mono" spellCheck={false} />
      <TextInput value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="Subfolder (optional)" aria-label="Subfolder" className="font-mono" spellCheck={false} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={!command.trim()}>
          Save command
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ one run

function RunCard({ r, onChange, onError }: { r: RunInfo; onChange: () => void; onError: (e: unknown) => void }) {
  const [showLog, setShowLog] = useState(r.status === 'running' || r.status === 'failed');
  const st = STATUS[r.status];
  const act = async (what: 'stop' | 'restart' | 'remove') => {
    try {
      if (what === 'remove') await api.del(`/api/run/${r.id}`);
      else await api.post(`/api/run/${r.id}/${what}`);
      onChange();
    } catch (e) {
      onError(e);
    }
  };
  return (
    <div className="rounded-[8px] border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <RunDot status={r.status} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            <span className="truncate font-medium">{r.label}</span>
            <Badge tone={st.tone}>{st.label}</Badge>
          </p>
          <p className="truncate text-xs text-ink-3">
            {r.status === 'running' ? `Started ${relative(r.startedAt)}` : `${st.label} ${relative(r.endedAt ?? r.startedAt)}${r.exitCode != null && r.status === 'failed' ? `, exit code ${r.exitCode}` : ''}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {r.url && r.status === 'running' && (
            <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-signal-line bg-signal px-2.5 text-sm font-medium text-signal-ink hover:brightness-95">
              <ExternalLink className="size-3.5" aria-hidden />
              {r.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            </a>
          )}
          <Button size="sm" variant="ghost" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'Hide output' : 'Output'}
          </Button>
          <IconButton label="Restart" icon={RotateCw} size="sm" onClick={() => void act('restart')} />
          {r.status === 'running' ? (
            <Button size="sm" variant="danger" icon={Square} onClick={() => void act('stop')}>
              Stop
            </Button>
          ) : (
            <IconButton label="Clear" icon={X} size="sm" onClick={() => void act('remove')} />
          )}
        </div>
      </div>
      {showLog && <LogView id={r.id} running={r.status === 'running'} />}
    </div>
  );
}

function LogView({ id, running }: { id: string; running: boolean }) {
  const [lines, setLines] = useState<RunLogLine[]>([]);
  const next = useRef(0);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  const poll = useCallback(async () => {
    try {
      const log = await api.get<RunLog>(`/api/run/${id}/log?after=${next.current}`);
      next.current = log.next;
      if (log.lines.length) setLines((prev) => [...prev, ...log.lines].slice(-4000));
    } catch {
      /* the run was cleared */
    }
  }, [id]);

  useEffect(() => {
    void poll();
    if (!running) return;
    const t = window.setInterval(() => void poll(), 1000);
    return () => clearInterval(t);
  }, [poll, running]);
  // one last read after it stops, for the final lines
  useEffect(() => {
    if (!running) void poll();
  }, [running, poll]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <pre
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-80 min-h-24 overflow-auto whitespace-pre-wrap break-words border-t border-line bg-sunken/50 px-3 py-2 font-mono text-[11.5px] leading-[1.5] text-ink-2 scroll-thin"
    >
      {lines.length === 0 ? <span className="text-ink-3">Waiting for output…</span> : lines.map((l) => <div key={l.n}>{l.text || ' '}</div>)}
    </pre>
  );
}
