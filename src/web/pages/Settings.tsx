import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Info, Keyboard, Trash2, Undo2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { qk, useMe, useSettings, useTrash, useUpdateSettings } from '../lib/queries';
import { bytes, relative } from '../lib/format';
import { useTheme, type ThemePref } from '../lib/theme';
import { useToast } from '../lib/toast';
import { FolderPicker } from '../components/FolderPicker';
import { ShortcutsDialog } from '../components/ShortcutsDialog';
import { Button, PageHeader, Panel, Segmented, Spinner, Switch, TextInput } from '../components/ui';

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 py-4 first:pt-0 last:pb-0 md:grid-cols-[240px_minmax(0,1fr)] md:gap-6">
      <div>
        <p className="font-medium text-ink">{label}</p>
        {description && <p className="mt-0.5 text-sm text-ink-3">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export default function Settings() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const me = useMe();
  const trash = useTrash();
  const theme = useTheme();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [claudeDir, setClaudeDir] = useState('');
  const [picker, setPicker] = useState(false);
  const [prices, setPrices] = useState('');
  const [help, setHelp] = useState(false);
  const s = settings.data?.settings;

  useEffect(() => {
    if (s) {
      setName(s.deviceName);
      setClaudeDir(s.claudeDir ?? '');
      setPrices(Object.keys(s.pricingOverrides).length ? JSON.stringify(s.pricingOverrides, null, 2) : '');
    }
  }, [s]);

  if (!s || !settings.data) {
    return (
      <div className="grid h-[50vh] place-items-center">
        <Spinner />
      </div>
    );
  }
  const save = (patch: Record<string, unknown>, msg = 'Saved') =>
    update.mutate(patch, {
      onSuccess: (r) => toast({ tone: 'success', message: r.restartNeeded ? `${msg}. Restart Handoff to apply.` : msg }),
      onError: (e) => toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) }),
    });

  return (
    <>
      <PageHeader
        title="Settings"
        actions={
          <Button icon={Keyboard} onClick={() => setHelp(true)}>
            Keyboard shortcuts
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        <Panel title="This computer">
          <div className="divide-y divide-line">
            <Field label="Name" description="How this computer shows up on your other devices.">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  save({ deviceName: name });
                }}
              >
                <TextInput value={name} onChange={(e) => setName(e.target.value)} aria-label="Computer name" className="max-w-sm flex-1" />
                <Button type="submit" disabled={name.trim() === s.deviceName || !name.trim()}>
                  Save
                </Button>
              </form>
            </Field>
            <Field label="Claude Code folder" description="Where Claude Code keeps sessions. Leave empty for the default.">
              <div className="flex flex-wrap gap-2">
                <TextInput value={claudeDir} onChange={(e) => setClaudeDir(e.target.value)} placeholder={settings.data.paths.claudeDir} className="min-w-[260px] flex-1 font-mono" aria-label="Claude Code folder" spellCheck={false} />
                <Button icon={FolderOpen} onClick={() => setPicker(true)}>
                  Browse
                </Button>
                <Button onClick={() => save({ claudeDir: claudeDir.trim() || null }, 'Claude folder updated')} disabled={(claudeDir.trim() || null) === s.claudeDir}>
                  Save
                </Button>
              </div>
              <p className="mt-1.5 text-sm text-ink-3">
                Reading from <span className="font-mono text-[12px]">{settings.data.paths.claudeDir}</span>
                {me.data?.claude.cleanupPeriodDays !== undefined && (
                  <>. Claude Code removes sessions after {me.data.claude.cleanupPeriodDays ?? 30} days (cleanupPeriodDays).</>
                )}
              </p>
            </Field>
            <Field label="Handoff's own data" description="Settings, notes, inbox, backups and trash.">
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 truncate rounded-[6px] bg-sunken px-2.5 py-1.5 font-mono text-[12px]">{settings.data.paths.dataDir}</code>
                <Button size="sm" icon={FolderOpen} onClick={() => void api.post('/api/reveal', { path: settings.data!.paths.dataDir })}>
                  Open
                </Button>
              </div>
            </Field>
          </div>
        </Panel>

        <Panel title="Appearance">
          <Field label="Theme" description="Press T anywhere to switch.">
            <Segmented<ThemePref>
              label="Theme"
              value={theme.pref}
              onChange={theme.setPref}
              options={[
                { value: 'system', label: 'Match system' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </Field>
        </Panel>

        <Panel title="When importing sessions" description="Defaults for the import review. You can change them per import.">
          <div className="flex flex-col gap-4">
            <Switch checked={s.importDefaults.rewriteMetadata} onChange={(v) => save({ importDefaults: { rewriteMetadata: v } })} label="Point session details at the new folder" description="Working directory and checkpoint paths. Recommended." />
            <Switch
              checked={s.importDefaults.rewriteContent}
              onChange={(v) => save({ importDefaults: { rewriteContent: v } })}
              label="Also update paths inside conversations"
              description="Off by default: editing earlier turns makes newer models set aside their saved reasoning on resume."
            />
            <Switch checked={s.importDefaults.includeFileHistory} onChange={(v) => save({ importDefaults: { includeFileHistory: v } })} label="Include checkpoints" description="File backups used by /rewind, when exporting and importing." />
            <Switch checked={s.importDefaults.includeMemory} onChange={(v) => save({ importDefaults: { includeMemory: v } })} label="Include project memory" description="Only copied into projects that have no memory yet." />
          </div>
        </Panel>

        <Panel title="Prices" description="Used for API-equivalent cost estimates, in US dollars per million tokens." padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-ink-3">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 text-left font-medium">Models</th>
                  <th className="px-2 py-2 text-right font-medium">Input</th>
                  <th className="px-2 py-2 text-right font-medium">Output</th>
                  <th className="px-2 py-2 text-right font-medium">Cache write 5m</th>
                  <th className="px-2 py-2 text-right font-medium">Cache write 1h</th>
                  <th className="px-4 py-2 text-right font-medium">Cache read</th>
                </tr>
              </thead>
              <tbody>
                {settings.data.pricing.map((p) => (
                  <tr key={p.key} className="tnum border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      <span className="font-mono text-[12px] text-ink-2">{p.ids.join(', ')}</span>
                    </td>
                    <td className="px-2 py-2 text-right">${p.price.input}</td>
                    <td className="px-2 py-2 text-right">${p.price.output}</td>
                    <td className="px-2 py-2 text-right">${p.price.cacheWrite5m}</td>
                    <td className="px-2 py-2 text-right">${p.price.cacheWrite1h}</td>
                    <td className="px-4 py-2 text-right">${p.price.cacheRead}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line px-4 py-4">
            <p className="font-medium">Custom prices</p>
            <p className="mt-0.5 text-sm text-ink-3">For models missing above, or your own rates. JSON keyed by model id.</p>
            <textarea
              value={prices}
              onChange={(e) => setPrices(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={'{\n  "my-model": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite5m": 3.75, "cacheWrite1h": 6 }\n}'}
              className="mt-2 w-full rounded-[7px] border border-line-strong bg-raised px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-3 focus:border-ink-2 focus:outline-none"
            />
            <Button
              className="mt-2"
              onClick={() => {
                try {
                  save({ pricingOverrides: prices.trim() ? JSON.parse(prices) : {} }, 'Prices saved');
                } catch {
                  toast({ tone: 'error', message: "That isn't valid JSON." });
                }
              }}
            >
              Save prices
            </Button>
          </div>
        </Panel>

        <Panel
          title="Trash"
          description="Deleted sessions wait here until you empty the trash."
          padded={false}
          actions={
            trash.data?.trash.length ? (
              <Button
                size="sm"
                variant="danger"
                icon={Trash2}
                onClick={async () => {
                  if (!confirm('Delete everything in the trash for good?')) return;
                  await api.del('/api/trash');
                  void qc.invalidateQueries({ queryKey: qk.trash });
                }}
              >
                Empty trash
              </Button>
            ) : undefined
          }
        >
          {!trash.data?.trash.length ? (
            <p className="px-4 py-3 text-sm text-ink-3">The trash is empty.</p>
          ) : (
            <ul className="divide-y divide-line">
              {trash.data.trash.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{t.title}</p>
                    <p className="truncate text-sm text-ink-3">
                      Deleted {relative(t.deletedAt)} · {bytes(t.sizeBytes)} · <span className="font-mono text-[12px]">{t.projectPath}</span>
                    </p>
                  </div>
                  <Button
                    size="sm"
                    icon={Undo2}
                    onClick={async () => {
                      try {
                        await api.post(`/api/trash/${t.id}/restore`);
                        void qc.invalidateQueries({ queryKey: qk.trash });
                        void qc.invalidateQueries({ queryKey: qk.sessions });
                        toast({ tone: 'success', message: 'Restored' });
                      } catch (e) {
                        toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
                      }
                    }}
                  >
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await api.del(`/api/trash/${t.id}`);
                      void qc.invalidateQueries({ queryKey: qk.trash });
                    }}
                  >
                    Delete for good
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <p className="flex items-center gap-2 text-sm text-ink-3">
          <Info className="size-3.5" aria-hidden />
          Claude Handoff {me.data?.device.version} · device id <span className="font-mono text-[12px]">{s.deviceId}</span>
        </p>
      </div>
      <FolderPicker open={picker} onClose={() => setPicker(false)} initial={claudeDir || settings.data.paths.claudeDir} onPick={setClaudeDir} title="Claude Code folder" description="Usually .claude in your home folder." />
      <ShortcutsDialog open={help} onClose={() => setHelp(false)} />
    </>
  );
}
