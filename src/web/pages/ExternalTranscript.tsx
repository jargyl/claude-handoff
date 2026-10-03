// Read-only view of a session that isn't on this computer: on a paired device,
// or archived in the sync folder.

import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine } from 'lucide-react';
import type { ImportPlan, Transcript } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { qk, useMe } from '../lib/queries';
import { useToast } from '../lib/toast';
import { DEFAULT_FILTERS, TranscriptView, buildUnits } from '../components/transcript/Transcript';
import { Button, Callout, PageHeader, Spinner } from '../components/ui';

export default function ExternalTranscript({ source }: { source: 'device' | 'sync' }) {
  const { id = '', sid = '' } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const url = source === 'device' ? `/api/devices/${id}/sessions/${sid}/transcript` : `/api/sync/sessions/${sid}/transcript`;
  const t = useQuery({ queryKey: ['external', source, id, sid], queryFn: () => api.get<Transcript>(url), retry: false });
  const units = useMemo(() => buildUnits(t.data?.items ?? [], DEFAULT_FILTERS), [t.data]);
  const firstPrompt = t.data?.items.find((i) => i.kind === 'user' && !i.meta);
  const title = firstPrompt && firstPrompt.kind === 'user' ? firstPrompt.text.slice(0, 90) : sid;

  const pull = async () => {
    setBusy(true);
    try {
      const plan =
        source === 'device'
          ? await api.post<ImportPlan>(`/api/devices/${id}/pull`, { ids: [sid] })
          : (await api.post<{ plan: ImportPlan }>('/api/sync/pull', { ids: [sid] })).plan;
      void qc.invalidateQueries({ queryKey: qk.imports });
      navigate(`/inbox/${plan.id}`);
    } catch (e) {
      toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        back={source === 'device' ? { to: `/devices/${id}`, label: 'Device' } : { to: '/sync', label: 'Sync folder' }}
        title={title}
        description={source === 'device' ? 'Preview from the other computer. Pull it to resume it here.' : 'Copy in the sync folder. Pull it to resume it here.'}
        actions={
          <Button variant="primary" icon={ArrowDownToLine} loading={busy} onClick={pull}>
            Pull to this computer
          </Button>
        }
      />
      {t.isLoading ? (
        <div className="grid h-60 place-items-center">
          <Spinner />
        </div>
      ) : t.error ? (
        <Callout tone="warn" title="Couldn't load this session">
          {(t.error as Error).message}
        </Callout>
      ) : (
        <TranscriptView units={units} f={DEFAULT_FILTERS} ctx={{ sessionId: sid, projectPath: '', home: me.data?.device.homeDir ?? '', live: false }} />
      )}
    </>
  );
}
