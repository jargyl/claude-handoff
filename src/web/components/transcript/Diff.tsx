import type { PatchHunk } from '../../../shared/types';
import { cx } from '../ui';

export function patchStats(patch?: PatchHunk[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of patch ?? [])
    for (const l of h.lines) {
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
  return { add, del };
}

export function DiffView({ patch, truncated }: { patch: PatchHunk[]; truncated?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-[6px] border border-line bg-raised font-mono text-[12px] leading-[1.55] scroll-thin">
      {patch.map((h, i) => {
        let oldNo = h.oldStart;
        let newNo = h.newStart;
        return (
          <div key={i} className={cx(i > 0 && 'border-t border-line')}>
            <div className="bg-sunken px-3 py-0.5 text-ink-3">
              @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
            </div>
            {h.lines.map((l, j) => {
              const kind = l[0];
              const o = kind === '+' ? '' : oldNo++;
              const n = kind === '-' ? '' : newNo++;
              return (
                <div key={j} className={cx('grid grid-cols-[40px_40px_minmax(0,1fr)]', kind === '+' && 'bg-add-bg text-add-ink', kind === '-' && 'bg-del-bg text-del-ink')}>
                  <span className="select-none px-1 text-right text-ink-3/70">{o}</span>
                  <span className="select-none px-1 text-right text-ink-3/70">{n}</span>
                  <span className="whitespace-pre px-2">{l}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      {truncated && <div className="border-t border-line px-3 py-1 text-ink-3">Diff shortened. Open the raw line for everything.</div>}
    </div>
  );
}

/** Fallback when there's no structured patch: old and new text as removed/added lines. */
export function SimpleDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const o = oldText.split('\n');
  const n = newText.split('\n');
  return (
    <div className="overflow-x-auto rounded-[6px] border border-line bg-raised font-mono text-[12px] leading-[1.55] scroll-thin">
      {o.map((l, i) => (
        <div key={`o${i}`} className="whitespace-pre bg-del-bg px-3 text-del-ink">
          -{l}
        </div>
      ))}
      {n.map((l, i) => (
        <div key={`n${i}`} className="whitespace-pre bg-add-bg px-3 text-add-ink">
          +{l}
        </div>
      ))}
    </div>
  );
}
