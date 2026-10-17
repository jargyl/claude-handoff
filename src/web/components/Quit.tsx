import { useState } from 'react';
import { Power } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useRuns } from '../lib/queries';
import { useToast } from '../lib/toast';
import { plural } from '../lib/format';
import { LogoMark } from './Logo';
import { Dialog } from './Dialog';
import { Button } from './ui';

/** The power button at the bottom of the sidebar: stops Handoff, after asking. */
export function QuitButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const runs = useRuns();
  const toast = useToast();
  const running = (runs.data?.runs ?? []).filter((r) => r.status === 'running').length;
  const quit = async () => {
    setBusy(true);
    try {
      await api.post('/api/quit');
      // the server's quit event swaps the app for the stopped screen
    } catch (e) {
      setBusy(false);
      toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
    }
  };
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Quit Handoff"
        title="Quit Handoff"
        className="grid size-8 place-items-center rounded-[6px] border border-line bg-raised text-ink-2 hover:text-ink"
      >
        <Power className="size-4" />
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title="Quit Handoff?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={Power} loading={busy} onClick={quit} data-autofocus>
              Quit
            </Button>
          </>
        }
      >
        <p className="text-base text-ink-2">
          The dashboard stops until you start Handoff again.
          {running > 0 && <> The {plural(running, 'command')} you're running from here will stop too.</>}
        </p>
      </Dialog>
    </>
  );
}

/** Shown in every open tab once Handoff has quit. Comes back by itself when Handoff starts again. */
export function Stopped() {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-6 text-center">
      <div className="flex flex-col items-center">
        <LogoMark className="mb-4 size-10" />
        <h1 className="text-lg font-semibold text-ink">Handoff has stopped</h1>
        <p className="mt-1 max-w-[44ch] text-base text-ink-2">You can close this tab. Start Handoff again and this page picks up where you left off.</p>
      </div>
    </div>
  );
}
