import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Laptop, Link2, MonitorSmartphone, Plus, Radar, RefreshCw, ShieldCheck, Trash2, Wifi, WifiOff } from 'lucide-react';
import type { DiscoveredDevice } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { qk, useDevices, useMe, useSettings, useUpdateSettings } from '../lib/queries';
import { relative } from '../lib/format';
import { useToast } from '../lib/toast';
import { Dialog } from '../components/Dialog';
import { Badge, Button, Callout, CopyButton, EmptyState, IconButton, PageHeader, Panel, Spinner, Switch, TextInput, cx } from '../components/ui';

function PairDialog({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: DiscoveredDevice }) {
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const qc = useQueryClient();
  useEffect(() => {
    if (open) {
      setAddress(preset?.url ?? '');
      setCode('');
      setError('');
    }
  }, [open, preset]);
  const isLink = address.includes('#');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={preset ? `Pair with ${preset.name}` : 'Add a device'}
      description="On the other computer, open Handoff, go to Devices and turn on network sharing. It shows a 6-digit code."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!address.trim() || (!isLink && code.replace(/\D/g, '').length !== 6)}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const body = isLink ? { connection: address.trim() } : { url: address.trim(), code: code.replace(/\D/g, '') };
                const d = await api.post<{ name: string }>('/api/devices', body);
                toast({ tone: 'success', message: `Paired with ${d.name}` });
                void qc.invalidateQueries({ queryKey: qk.devices });
                onClose();
              } catch (e) {
                setError(e instanceof ApiError ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Pair
          </Button>
        </>
      }
    >
      <label className="block text-sm font-medium text-ink">Address</label>
      <TextInput value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.20:7420, or paste a connection link" className="mt-1 font-mono" spellCheck={false} autoFocus={!preset} />
      {!isLink && (
        <>
          <label className="mt-4 block text-sm font-medium text-ink">Pairing code</label>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, 7))}
            inputMode="numeric"
            autoFocus={!!preset}
            placeholder="000 000"
            aria-label="Pairing code"
            className="mt-1 h-14 w-full rounded-[8px] border border-line-strong bg-raised text-center font-mono text-3xl tracking-[0.3em] text-ink placeholder:text-ink-3/50 focus:border-ink-2 focus:outline-none"
          />
          <p className="mt-2 text-sm text-ink-3">Pairing works both ways: each computer can then browse and send to the other.</p>
        </>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
    </Dialog>
  );
}

function ThisDevice() {
  const devices = useDevices();
  const settings = useSettings();
  const update = useUpdateSettings();
  const toast = useToast();
  const qc = useQueryClient();
  const [reveal, setReveal] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const lan = devices.data?.lan;
  const s = settings.data?.settings;
  const pairing = devices.data?.pairing;
  const token = s?.lan.token ?? '';
  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;
  useEffect(() => {
    if (pairing && left === 0) void qc.invalidateQueries({ queryKey: qk.devices });
  }, [left, pairing, qc]);
  const link = lan?.urls[0] ? `${lan.urls[0]}#${token}` : '';
  return (
    <Panel title={s?.deviceName ?? 'This computer'} description="How other computers reach this one">
      <Switch
        checked={!!lan?.enabled}
        disabled={update.isPending}
        onChange={(v) =>
          update.mutate(
            { lan: { enabled: v } },
            {
              onSuccess: () => {
                toast({ tone: 'success', message: v ? 'Network sharing is on' : 'Network sharing is off' });
                setTimeout(() => void qc.invalidateQueries({ queryKey: qk.devices }), 800);
              },
            },
          )
        }
        label="Share on my network"
        description="Lets your other computers on the same Wi-Fi or LAN browse and pull sessions from this one. Everything stays on your network and needs a code or token."
      />
      {lan?.enabled && (
        <div className="mt-5 flex flex-col gap-5">
          <div className="grid gap-4 md:grid-cols-[auto_minmax(0,1fr)]">
            <div className="rounded-[10px] border border-signal-line/50 bg-signal-wash px-5 py-4 text-center">
              <p className="text-sm text-ink-2">Pairing code</p>
              <p className="tnum mt-1 font-mono text-4xl font-medium tracking-[0.16em] text-ink">{pairing ? `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}` : '—'}</p>
              <p className="tnum mt-1 text-xs text-ink-3">
                Changes in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
              </p>
            </div>
            <div className="min-w-0 text-sm">
              <p className="font-medium text-ink">To pair, on the other computer:</p>
              <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-ink-2">
                <li>Open Handoff and go to Devices.</li>
                <li>
                  Pick <span className="font-medium text-ink">{s?.deviceName}</span> under “Found on your network”, or add it by address:
                  {lan.urls.map((u) => (
                    <code key={u} className="ml-1 rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink">
                      {u.replace('http://', '')}
                    </code>
                  ))}
                </li>
                <li>Type the code shown here.</li>
              </ol>
            </div>
          </div>
          <div className="grid gap-4 border-t border-line pt-4 md:grid-cols-2">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                <ShieldCheck className="size-4 text-ink-3" aria-hidden /> Access token
              </p>
              <p className="mt-0.5 text-sm text-ink-3">Used instead of a code, and to open this dashboard from a phone or tablet.</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-[6px] bg-sunken px-2.5 py-1.5 font-mono text-[12px] text-ink">{reveal ? token : '•'.repeat(24)}</code>
                <IconButton label={reveal ? 'Hide token' : 'Show token'} icon={reveal ? EyeOff : Eye} size="sm" onClick={() => setReveal((r) => !r)} />
                <CopyButton text={token} />
              </div>
              <button
                className="mt-2 text-sm text-ink-3 underline decoration-line-strong underline-offset-2 hover:text-ink"
                onClick={async () => {
                  if (!confirm('Make a new token? Paired devices have to pair again.')) return;
                  await api.post('/api/settings/rotate-token');
                  void qc.invalidateQueries({ queryKey: qk.settings });
                  void qc.invalidateQueries({ queryKey: qk.devices });
                  toast({ tone: 'success', message: 'New token created' });
                }}
              >
                Make a new token
              </button>
            </div>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                <Link2 className="size-4 text-ink-3" aria-hidden /> Connection link
              </p>
              <p className="mt-0.5 text-sm text-ink-3">Paste it into “Add a device” on the other computer. It contains the token, so keep it private.</p>
              {link && (
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-[6px] bg-sunken px-2.5 py-1.5 font-mono text-[12px] text-ink">{reveal ? link : link.replace(/#.*/, '#••••••')}</code>
                  <CopyButton text={link} />
                </div>
              )}
            </div>
          </div>
          <div className="border-t border-line pt-4">
            <Switch
              checked={!!lan.acceptPush}
              onChange={(v) => update.mutate({ lan: { acceptPush: v } })}
              label="Accept sessions sent to this computer"
              description="Paired devices can send sessions here. They wait in your inbox until you review them."
            />
          </div>
          <Callout tone="info" icon={Wifi} title="Windows may ask about network access">
            When you turn sharing on, Windows Firewall can ask whether Node.js may use the network. Allow it on private networks.
          </Callout>
        </div>
      )}
    </Panel>
  );
}

export default function Devices() {
  const devices = useDevices();
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [pair, setPair] = useState<{ open: boolean; preset?: DiscoveredDevice }>({ open: false });
  const list = devices.data?.devices ?? [];
  const found = (devices.data?.discovered ?? []).filter((d) => !d.paired);
  return (
    <>
      <PageHeader
        title="Devices"
        description="Pair your computers once, then pull or send sessions between them over your network."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setPair({ open: true })}>
            Add a device
          </Button>
        }
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ThisDevice />
        <div className="flex min-w-0 flex-col gap-6">
          <Panel
            title="Paired devices"
            padded={false}
            actions={<IconButton label="Check again" icon={RefreshCw} size="sm" onClick={() => void api.get('/api/devices?refresh=1').then(() => qc.invalidateQueries({ queryKey: qk.devices }))} />}
          >
            {devices.isLoading ? (
              <div className="grid h-24 place-items-center">
                <Spinner />
              </div>
            ) : list.length === 0 ? (
              <EmptyState icon={MonitorSmartphone} title="No paired devices yet" action={<Button icon={Plus} onClick={() => setPair({ open: true })}>Add a device</Button>}>
                Install Handoff on your other computer and turn on network sharing there.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {list.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                    <span className={cx('grid size-9 shrink-0 place-items-center rounded-[7px] border', d.online ? 'border-good/30 bg-good-wash text-good' : 'border-line bg-raised text-ink-3')}>
                      {d.online ? <Laptop className="size-4" /> : <WifiOff className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate font-medium">
                        {d.name} {d.online ? <Badge tone="good">Online</Badge> : <Badge>Offline</Badge>}
                      </p>
                      <p className="truncate text-sm text-ink-3">
                        {d.url.replace('http://', '')} · {d.online ? `Handoff ${d.version ?? ''}` : d.error ?? `last seen ${relative(d.lastSeenAt)}`}
                      </p>
                    </div>
                    <Link to={`/devices/${d.id}`}>
                      <Button size="sm" variant={d.online ? 'primary' : 'secondary'} disabled={!d.online}>
                        Browse sessions
                      </Button>
                    </Link>
                    <IconButton
                      label={`Remove ${d.name}`}
                      icon={Trash2}
                      size="sm"
                      onClick={async () => {
                        if (!confirm(`Remove ${d.name}? You can pair again any time.`)) return;
                        await api.del(`/api/devices/${d.id}`);
                        void qc.invalidateQueries({ queryKey: qk.devices });
                        toast({ tone: 'success', message: `Removed ${d.name}` });
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel
            title={
              <span className="flex items-center gap-2">
                <Radar className="size-4 text-ink-3" aria-hidden /> Found on your network
              </span>
            }
            padded={false}
          >
            {!devices.data?.lan.enabled ? (
              <p className="px-4 py-3 text-sm text-ink-3">Turn on network sharing to look for other computers running Handoff.</p>
            ) : found.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-3">Looking… Computers appear here when Handoff runs on them with network sharing on. You can always add one by address.</p>
            ) : (
              <ul className="divide-y divide-line">
                {found.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                    <Laptop className="size-4 shrink-0 text-ink-3" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{d.name}</p>
                      <p className="truncate text-sm text-ink-3">{d.url.replace('http://', '')}</p>
                    </div>
                    <Button size="sm" onClick={() => setPair({ open: true, preset: d })}>
                      Pair
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {me.data && !me.data.lan.enabled && list.length > 0 && (
            <p className="text-sm text-ink-3">Paired devices can only reach this computer when network sharing is on here too. Pulling from them works either way.</p>
          )}
        </div>
      </div>
      <PairDialog open={pair.open} preset={pair.preset} onClose={() => setPair({ open: false })} />
    </>
  );
}
