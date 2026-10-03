import { Link } from 'react-router';
import { Brain, FolderGit2, FolderX } from 'lucide-react';
import { useMe, useProjects } from '../lib/queries';
import { compact, cost, plural, relative } from '../lib/format';
import { tildify } from '../../shared/paths';
import { Badge, EmptyState, PageHeader, Spinner } from '../components/ui';

export default function Projects() {
  const projects = useProjects();
  const me = useMe();
  const home = me.data?.device.homeDir ?? '';
  const list = projects.data?.projects ?? [];
  return (
    <>
      <PageHeader title="Projects" description="Every folder you've used Claude Code in, with its sessions." />
      {projects.isLoading ? (
        <div className="grid h-60 place-items-center">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon={FolderGit2} title="No projects yet" />
      ) : (
        <div className="flex flex-col gap-1.5">
          {list.map((p) => (
            <Link
              key={p.dir}
              to={`/sessions?project=${encodeURIComponent(p.dir)}`}
              className="cv-auto grid grid-cols-[4px_minmax(0,1fr)_96px] items-stretch rounded-[5px] border border-line bg-surface hover:border-line-strong hover:bg-raised md:grid-cols-[4px_minmax(0,1fr)_120px_120px_96px]"
            >
              <span aria-hidden className={p.live ? 'rounded-l-[5px] bg-signal' : 'rounded-l-[5px] bg-line-strong/70'} />
              <div className="min-w-0 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-semibold">{p.name}</span>
                  {!p.pathExists && (
                    <Badge tone="warn" icon={FolderX} title="This folder doesn't exist on this machine">
                      Folder missing
                    </Badge>
                  )}
                  {p.hasMemory && (
                    <Badge icon={Brain} title="Claude Code has saved project memory for this folder">
                      Memory
                    </Badge>
                  )}
                </div>
                <p className="truncate font-mono text-[12px] text-ink-3" title={p.path}>
                  {tildify(p.path, home)}
                </p>
              </div>
              <div className="hidden flex-col justify-center border-l border-line px-3 text-sm md:flex">
                <span className="tnum text-ink-2">{plural(p.sessions, 'session')}</span>
                <span className="text-xs text-ink-3">{p.live ? `${p.live} open now` : relative(p.lastActive)}</span>
              </div>
              <div className="hidden flex-col justify-center border-l border-line px-3 text-sm md:flex">
                <span className="tnum text-ink-2">{compact(p.totalTokens)} tokens</span>
                <span className="tnum text-xs text-ink-3">{plural(p.userMessages, 'prompt')}</span>
              </div>
              <div className="flex flex-col items-end justify-center border-l border-line px-3 text-sm">
                <span className="tnum font-medium">{cost(p.cost)}</span>
                <span className="text-xs text-ink-3 md:hidden">{plural(p.sessions, 'session')}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
