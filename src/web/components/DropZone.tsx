import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { FileArchive, Upload } from 'lucide-react';
import type { ImportPlan } from '../../shared/types';
import { ApiError, uploadFile } from '../lib/api';
import { qk } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Button, ProgressBar, cx } from './ui';

/** Upload bundles / transcripts into one staging area, then open its review. */
export function useImportFiles() {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [progress, setProgress] = useState<{ name: string; value: number } | null>(null);
  const run = async (files: File[]) => {
    const valid = files.filter((f) => /\.(zip|jsonl)$/i.test(f.name));
    if (!valid.length) {
      toast({ tone: 'error', message: 'Drop a bundle (.zip) or session transcripts (.jsonl).' });
      return;
    }
    let id: string | undefined;
    try {
      for (const f of valid) {
        setProgress({ name: f.name, value: 0 });
        const plan = await uploadFile<ImportPlan>(id ? `/api/imports?append=${id}` : '/api/imports', f, (v) => setProgress({ name: f.name, value: v }));
        id = plan.id;
      }
      void qc.invalidateQueries({ queryKey: qk.imports });
      if (id) navigate(`/inbox/${id}`);
    } catch (e) {
      toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setProgress(null);
    }
  };
  return { run, progress };
}

export function DropZone() {
  const { run, progress } = useImportFiles();
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void run([...e.dataTransfer.files]);
      }}
      className={cx('flex flex-col items-center rounded-[10px] border-2 border-dashed px-6 py-10 text-center transition-colors', over ? 'border-signal-line bg-signal-wash' : 'border-line-strong bg-surface')}
    >
      <div className="mb-3 grid size-11 place-items-center rounded-[10px] border border-line bg-raised text-ink-2">
        <FileArchive className="size-5" aria-hidden />
      </div>
      <p className="text-md font-semibold">Drop a bundle or session files here</p>
      <p className="mt-1 max-w-[56ch] text-sm text-ink-2">
        A <span className="font-mono">.zip</span> exported from Handoff on your other computer, or <span className="font-mono">.jsonl</span> transcripts copied straight out of{' '}
        <span className="font-mono">~/.claude/projects</span>. Nothing is written until you review it.
      </p>
      {progress ? (
        <div className="mt-5 w-full max-w-sm">
          <p className="mb-1.5 truncate text-sm text-ink-2">Reading {progress.name}…</p>
          <ProgressBar value={progress.value} />
        </div>
      ) : (
        <Button variant="primary" icon={Upload} className="mt-5" onClick={() => input.current?.click()}>
          Choose files
        </Button>
      )}
      <input
        ref={input}
        type="file"
        multiple
        accept=".zip,.jsonl"
        className="hidden"
        onChange={(e) => {
          void run([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
