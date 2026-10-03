import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArchiveRestore, Cloud, Download, Inbox, MonitorSmartphone, MessagesSquare } from 'lucide-react';
import { useDevices, useImports, useMe, useSessions, useStats, useSync } from '../lib/queries';
import { addDaysKey, compact, cost, localDateKey, plural, relative } from '../lib/format';
import { SessionStrip, StripBay } from '../components/SessionStrip';
import { Button, Callout, EmptyState, PageHeader, Panel, Spinner } from '../components/ui';
import { CalendarHeatmap, ScaleLegend, Sparkline } from '../components/charts/Heatmaps';

function Tile({ label, value, trend, sub }: { label: string; value: string; trend?: number[]; sub?: string }) {
  return (
    <div className="min-w-0 rounded-[8px] border border-line bg-raised px-3.5 py-3">
      <p className="truncate text-sm text-ink-3">{label}</p>
      <div className="mt-0.5 flex items-end justify-between gap-2">
        <p className="text-2xl font-semibold text-ink">{value}</p>
        {trend && trend.some((v) => v > 0) && <Sparkline values={trend} className="mb-1 h-6 w-16 shrink-0" />}
      </div>
      {sub && <p className="truncate text-xs text-ink-3">{sub}</p>}
    </div>
  );
}

export default function Overview() {
  const me = useMe();
  const sessions = useSessions();
  const imports = useImports();
  const sync = useSync();
  const devices = useDevices();
  const navigate = useNavigate();
  const to = localDateKey(new Date());
  const stats = useStats({ from: addDaysKey(to, -29), to });
  const list = sessions.data?.sessions ?? [];
  const live = list.filter((s) => s.live);
  const recent = list.filter((s) => !s.live).slice(0, 8);
  const pending = imports.data?.imports ?? [];
  const remote = me.data?.access === 'remote';
  const cleanup = me.data?.claude.cleanupPeriodDays;
  const trend = useMemo(() => stats.data?.days.map((d) => d.prompts) ?? [], [stats.data]);
  const costTrend = useMemo(() => stats.data?.days.map((d) => d.cost) ?? [], [stats.data]);
  const tokenTrend = useMemo(() => stats.data?.days.map((d) => d.tokens) ?? [], [stats.data]);

  if (sessions.isLoading) {
    return (
      <div className="grid h-[50vh] place-items-center">
        <Spinner />
      </div>
    );
  }

  if (!list.length) {
    return (
      <>
        <PageHeader title="Overview" />
        <Panel>
          <EmptyState
            icon={MessagesSquare}
            title="No Claude Code sessions on this machine yet"
            action={
              !remote && (
                <Link to="/inbox">
                  <Button variant="primary" icon={Inbox}>
                    Import sessions from another machine
                  </Button>
                </Link>
              )
            }
          >
            Sessions appear here as soon as you use Claude Code (they're read from {me.data?.claude.dir ?? '~/.claude'}). Coming from another
            computer? Import the sessions you brought along.
          </EmptyState>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Overview" description={`Your Claude Code sessions on ${me.data?.device.name ?? 'this computer'}.`} />

      <div className="mb-6 flex flex-col gap-3">
        {pending.length > 0 && !remote && (
          <Callout
            tone="signal"
            icon={Inbox}
            title={`${plural(pending.reduce((n, p) => n + p.sessions.length, 0), 'session')} waiting in your inbox`}
            action={
              <Button variant="primary" size="sm" onClick={() => navigate(pending.length === 1 ? `/inbox/${pending[0]!.id}` : '/inbox')}>
                Review
              </Button>
            }
          >
            {pending
              .slice(0, 3)
              .map((p) => p.source.label)
              .join(', ')}
          </Callout>
        )}
        {!remote && sync.data && !sync.data.folder && cleanup !== 0 && (
          <Callout
            tone="warn"
            icon={ArchiveRestore}
            title={`Claude Code deletes transcripts older than ${cleanup ?? 30} days`}
            action={
              <Link to="/sync">
                <Button size="sm">Set up a sync folder</Button>
              </Link>
            }
          >
            {cleanup ? `Your cleanupPeriodDays setting is ${cleanup}.` : 'That is the default cleanup period.'} A sync folder keeps a copy of every session, and makes them
            available on your other computers.
          </Callout>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          {live.length > 0 && (
            <section>
              <div className="mb-2.5 flex items-baseline justify-between">
                <h2 className="text-md font-semibold">Open in Claude Code</h2>
                <span className="text-sm text-ink-3">{plural(live.length, 'session')}</span>
              </div>
              <StripBay label="Live sessions">
                {live.map((s) => (
                  <SessionStrip key={s.id} s={s} to={`/sessions/${s.id}`} subtitle={s.live?.name ? `${s.live.name} · ${s.projectPath}` : s.projectPath} />
                ))}
              </StripBay>
            </section>
          )}

          <section>
            <div className="mb-2.5 flex items-baseline justify-between">
              <h2 className="text-md font-semibold">Recent</h2>
              <Link to="/sessions" className="text-sm text-ink-2 underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                All {plural(list.length, 'session')}
              </Link>
            </div>
            {recent.length ? (
              <StripBay label="Recent sessions">
                {recent.map((s) => (
                  <SessionStrip key={s.id} s={s} to={`/sessions/${s.id}`} />
                ))}
              </StripBay>
            ) : (
              <p className="rounded-[5px] border border-dashed border-line-strong px-4 py-3 text-sm text-ink-3">Every session is open in Claude Code right now. Finished ones show up here.</p>
            )}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          <section>
            <div className="mb-2.5 flex items-baseline justify-between">
              <h2 className="text-md font-semibold">Last 30 days</h2>
              <Link to="/analytics" className="text-sm text-ink-2 underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                Analytics
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Tile label="Prompts" value={compact(stats.data?.totals.prompts ?? 0)} trend={trend} sub={plural(stats.data?.totals.sessions ?? 0, 'session')} />
              <Tile label="Active days" value={String(stats.data?.totals.activeDays ?? 0)} sub={`${stats.data?.totals.currentStreak ?? 0}-day streak`} />
              <Tile label="Tokens" value={compact(stats.data?.totals.totalTokens ?? 0)} trend={tokenTrend} />
              <Tile label="API-equivalent cost" value={cost(stats.data?.totals.cost ?? 0)} trend={costTrend} sub="At API list prices" />
            </div>
          </section>

          <Panel title="Activity" description="Prompts per day over the past year" actions={<ScaleLegend />}>
            {stats.data ? (
              <CalendarHeatmap
                days={stats.data.heatmap}
                value={(d) => d.prompts}
                tip={(d) =>
                  `${new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${plural(d.prompts, 'prompt')}, ${compact(d.tokens)} tokens`
                }
              />
            ) : (
              <Spinner />
            )}
          </Panel>

          {!remote && (
            <Panel title="Move sessions between machines" padded={false}>
              <ul className="divide-y divide-line">
                <li>
                  <Link to="/devices" className="flex items-center gap-3 px-4 py-3 hover:bg-sunken/60">
                    <MonitorSmartphone className="size-4 shrink-0 text-ink-3" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">Devices</span>
                      <span className="block truncate text-sm text-ink-3">
                        {devices.data?.devices.length
                          ? `${devices.data.devices.filter((d) => d.online).length} of ${plural(devices.data.devices.length, 'paired device')} online`
                          : 'Pull sessions straight from your other PC'}
                      </span>
                    </span>
                  </Link>
                </li>
                <li>
                  <Link to="/sync" className="flex items-center gap-3 px-4 py-3 hover:bg-sunken/60">
                    <Cloud className="size-4 shrink-0 text-ink-3" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">Sync folder</span>
                      <span className="block truncate text-sm text-ink-3">
                        {sync.data?.folder
                          ? `${plural(sync.data.sessions.length, 'session')} in the folder${sync.data.lastPushAt ? `, pushed ${relative(sync.data.lastPushAt)}` : ''}`
                          : 'Use OneDrive, Dropbox or a USB stick'}
                      </span>
                    </span>
                  </Link>
                </li>
                <li>
                  <Link to="/sessions" className="flex items-center gap-3 px-4 py-3 hover:bg-sunken/60">
                    <Download className="size-4 shrink-0 text-ink-3" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">Export a bundle</span>
                      <span className="block truncate text-sm text-ink-3">Select sessions, download one zip, drop it on the other machine</span>
                    </span>
                  </Link>
                </li>
              </ul>
            </Panel>
          )}
        </aside>
      </div>
    </>
  );
}
