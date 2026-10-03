import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, Folder, HardDrive, House } from 'lucide-react';
import { api } from '../lib/api';
import { Dialog } from './Dialog';
import { Button, Spinner, TextInput, cx } from './ui';

interface Listing {
  path: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
  roots: Array<{ name: string; path: string }>;
}

export function FolderPicker({
  open,
  onClose,
  onPick,
  initial,
  title = 'Choose a folder',
  description,
  confirmLabel = 'Use this folder',
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
  initial?: string;
  title?: string;
  description?: string;
  confirmLabel?: string;
}) {
  const [path, setPath] = useState(initial ?? '');
  const [typed, setTyped] = useState(initial ?? '');
  useEffect(() => {
    if (open) {
      setPath(initial ?? '');
      setTyped(initial ?? '');
    }
  }, [open, initial]);
  const q = useQuery({
    queryKey: ['fs', path],
    enabled: open,
    queryFn: () => api.get<Listing>(`/api/fs/dirs?path=${encodeURIComponent(path)}`),
  });
  const data = q.data;
  useEffect(() => {
    if (data) setTyped(data.path);
  }, [data]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!data}
            onClick={() => {
              if (data) onPick(data.path);
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPath(typed);
        }}
      >
        <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} className="flex-1 font-mono" aria-label="Folder path" spellCheck={false} />
        <Button type="submit">Go</Button>
      </form>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {data?.roots.map((r) => (
          <Button key={r.path} size="sm" variant="ghost" icon={r.name === 'Home' ? House : HardDrive} onClick={() => setPath(r.path)}>
            {r.name}
          </Button>
        ))}
        {data?.parent && (
          <Button size="sm" variant="ghost" icon={ArrowUp} onClick={() => setPath(data.parent!)}>
            Up one level
          </Button>
        )}
      </div>
      <div className="h-[340px] overflow-y-auto rounded-[8px] border border-line bg-raised scroll-thin">
        {q.isLoading ? (
          <div className="grid h-full place-items-center">
            <Spinner />
          </div>
        ) : data && data.dirs.length === 0 ? (
          <p className="p-4 text-sm text-ink-3">No folders inside this one.</p>
        ) : (
          <ul>
            {data?.dirs.map((d) => (
              <li key={d.path}>
                <button
                  onDoubleClick={() => {
                    onPick(d.path);
                    onClose();
                  }}
                  onClick={() => setPath(d.path)}
                  className={cx('flex w-full items-center gap-2.5 border-b border-line px-3 py-2 text-left text-base last:border-0 hover:bg-sunken', d.name.startsWith('.') && 'text-ink-3')}
                >
                  <Folder className="size-4 shrink-0 text-ink-3" aria-hidden />
                  <span className="truncate">{d.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-2 text-sm text-ink-3">Click a folder to open it, double-click to choose it.</p>
    </Dialog>
  );
}
