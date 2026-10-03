// A session as a "flight strip": a row of hairline-divided cells that reads at a
// glance and stacks into a bay. Air-traffic controllers literally hand off
// strips between positions, which is what this app does with sessions.

import { memo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeftRight, GitBranch, Star } from 'lucide-react';
import type { SessionListItem } from '../../shared/types';
import { cost, duration, plural, relative, shortId } from '../lib/format';
import { Checkbox, LiveDot, cx } from './ui';

export interface StripProps {
  s: Pick<
    SessionListItem,
    'id' | 'title' | 'projectName' | 'projectPath' | 'firstPrompt' | 'endedAt' | 'userMessages' | 'activeMs' | 'cost' | 'branch' | 'live' | 'starred' | 'hasForeignPaths' | 'models' | 'totalTokens' | 'toolCalls'
  > &
    Partial<SessionListItem>;
  to?: string;
  selected?: boolean;
  onSelect?: (v: boolean) => void;
  /** replaces the metrics cells, e.g. a sync status and an action */
  trailing?: ReactNode;
  subtitle?: ReactNode;
}

export const SessionStrip = memo(function SessionStrip({ s, to, selected, onSelect, trailing, subtitle }: StripProps) {
  const live = !!s.live;
  const branch = s.branch && s.branch !== 'HEAD' ? s.branch : undefined;
  const body = (
    <>
      <span aria-hidden className={cx('self-stretch rounded-l-[5px]', live ? 'bg-signal' : selected ? 'bg-signal-line' : 'bg-line-strong/70')} />
      <div className="flex min-w-0 flex-col justify-center gap-0.5 px-3 py-2">
        <div className="flex items-center gap-2">
          {onSelect && <Checkbox checked={!!selected} onChange={onSelect} label={`Select ${s.title}`} />}
          <span className="font-mono text-xs text-ink-2">{shortId(s.id)}</span>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-ink-3">
          {live ? (
            <>
              <LiveDot status={s.live?.status} />
              {s.live?.status === 'idle' ? 'waiting' : 'working'}
            </>
          ) : (
            relative(s.endedAt)
          )}
        </span>
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-0.5 border-l border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {s.starred && <Star className="size-3.5 shrink-0 fill-signal text-signal-line" aria-label="Starred" />}
          <span className="truncate font-semibold text-ink">{s.title}</span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-sm text-ink-3">
          {s.hasForeignPaths && (
            <span title="Contains paths from another machine (moved here)" className="inline-flex shrink-0 items-center">
              <ArrowLeftRight className="size-3.5" aria-label="Moved from another machine" />
            </span>
          )}
          <span className="truncate">{subtitle ?? s.firstPrompt ?? '—'}</span>
        </div>
      </div>
      <div className="hidden min-w-0 flex-col justify-center gap-0.5 border-l border-line px-3 py-2 md:flex">
        <span className="truncate text-sm text-ink-2" title={s.projectPath}>
          {s.projectName}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-ink-3">
          {branch ? (
            <>
              <GitBranch className="size-3 shrink-0" aria-hidden />
              <span className="truncate font-mono">{branch}</span>
            </>
          ) : (
            <span className="truncate">{s.models[0] ?? ''}</span>
          )}
        </span>
      </div>
      {trailing ?? (
        <>
          <div className="hidden flex-col justify-center gap-0.5 border-l border-line px-3 py-2 text-sm lg:flex">
            <span className="tnum text-ink-2">{plural(s.userMessages, 'prompt')}</span>
            <span className="tnum text-xs text-ink-3">{duration(s.activeMs)} active</span>
          </div>
          <div className="flex flex-col items-end justify-center gap-0.5 border-l border-line px-3 py-2 text-sm">
            <span className="tnum font-medium text-ink" title="API-equivalent cost">
              {cost(s.cost)}
            </span>
            <span className="tnum whitespace-nowrap text-xs text-ink-3">{plural(s.toolCalls, 'tool')}</span>
          </div>
        </>
      )}
    </>
  );
  const cls = cx(
    'group grid min-h-[58px] w-full items-stretch rounded-[5px] border text-left transition-colors cv-auto',
    trailing
      ? 'grid-cols-[4px_auto_minmax(0,1fr)_auto] md:grid-cols-[4px_104px_minmax(0,1fr)_minmax(0,190px)_auto]'
      : 'grid-cols-[4px_auto_minmax(0,1fr)_84px] md:grid-cols-[4px_104px_minmax(0,1fr)_minmax(0,190px)_92px] lg:grid-cols-[4px_104px_minmax(0,1fr)_minmax(0,190px)_120px_92px]',
    selected ? 'border-signal-line/60 bg-signal-wash' : 'border-line bg-surface hover:border-line-strong hover:bg-raised',
  );
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
});

export function StripBay({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div role="list" aria-label={label} className="flex flex-col gap-1.5">
      {children}
    </div>
  );
}
