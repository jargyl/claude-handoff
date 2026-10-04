import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, seg } from './api';
import type {
  DeviceState,
  DiscoveredDevice,
  HistoryEntry,
  ImportPlan,
  IndexStatus,
  MeResponse,
  ProjectRunInfo,
  ProjectSummary,
  RunInfo,
  RemoteSessionView,
  SearchResponse,
  SessionDetail,
  SessionListItem,
  Settings,
  StagingSourceInfo,
  StatsResponse,
  SyncState,
  SyncStatus,
  Transcript,
} from '../../shared/types';
import type { ModelPrice } from '../../shared/pricing';

export const qk = {
  me: ['me'] as const,
  sessions: ['sessions'] as const,
  session: (id: string) => ['session', id] as const,
  transcript: (id: string, agent?: string) => ['transcript', id, agent ?? null] as const,
  projects: ['projects'] as const,
  runs: ['runs'] as const,
  runProject: (path: string) => ['run-project', path] as const,
  stats: (p: object) => ['stats', p] as const,
  search: (p: object) => ['search', p] as const,
  imports: ['imports'] as const,
  plan: (id: string) => ['plan', id] as const,
  history: ['history'] as const,
  devices: ['devices'] as const,
  deviceSessions: (id: string) => ['device-sessions', id] as const,
  sync: ['sync'] as const,
  settings: ['settings'] as const,
  trash: ['trash'] as const,
};

export const useMe = () => useQuery({ queryKey: qk.me, queryFn: () => api.get<MeResponse>('/api/me'), staleTime: 15_000 });

export const useSessions = () =>
  useQuery({
    queryKey: qk.sessions,
    queryFn: () => api.get<{ sessions: SessionListItem[]; status: IndexStatus }>('/api/sessions'),
    staleTime: 5_000,
    placeholderData: keepPreviousData,
  });

export const useSession = (id: string) =>
  useQuery({ queryKey: qk.session(id), queryFn: () => api.get<SessionDetail>(`/api/sessions/${seg(id)}`), placeholderData: keepPreviousData });

export const useTranscript = (id: string, agent?: string) =>
  useQuery({
    queryKey: qk.transcript(id, agent),
    queryFn: () => api.get<Transcript>(`/api/sessions/${seg(id)}/transcript${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`),
    staleTime: 3_000,
    placeholderData: keepPreviousData,
  });

export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: () => api.get<{ projects: ProjectSummary[] }>('/api/projects') });

export interface StatsParams {
  from?: string;
  to?: string;
  project?: string;
}
export const useStats = (p: StatsParams) =>
  useQuery({
    queryKey: qk.stats(p),
    queryFn: () => {
      const q = new URLSearchParams({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      if (p.from) q.set('from', p.from);
      if (p.to) q.set('to', p.to);
      if (p.project) q.set('project', p.project);
      return api.get<StatsResponse>(`/api/stats?${q}`);
    },
    placeholderData: keepPreviousData,
  });

export interface SearchParams {
  q: string;
  project?: string;
  role?: string;
  session?: string;
}
export const useSearch = (p: SearchParams) =>
  useQuery({
    queryKey: qk.search(p),
    enabled: p.q.trim().length >= 2,
    queryFn: () => {
      const q = new URLSearchParams({ q: p.q });
      if (p.project) q.set('project', p.project);
      if (p.role) q.set('role', p.role);
      if (p.session) q.set('session', p.session);
      return api.get<SearchResponse>(`/api/search?${q}`);
    },
    placeholderData: keepPreviousData,
  });

export interface InboxItem {
  id: string;
  createdAt: string;
  source: StagingSourceInfo;
  sessions: Array<{ id: string; title: string; projectPath: string }>;
}
export const useImports = () => useQuery({ queryKey: qk.imports, queryFn: () => api.get<{ imports: InboxItem[] }>('/api/imports') });
export const usePlan = (id: string) => useQuery({ queryKey: qk.plan(id), queryFn: () => api.get<ImportPlan>(`/api/imports/${seg(id)}`), retry: false });
export const useHistory = () => useQuery({ queryKey: qk.history, queryFn: () => api.get<{ history: HistoryEntry[] }>('/api/history') });

export interface DevicesResponse {
  devices: DeviceState[];
  discovered: DiscoveredDevice[];
  pairing: { code: string; expiresAt: number } | null;
  lan: { enabled: boolean; urls: string[]; acceptPush: boolean; discovery: boolean };
}
/** Polls while shown: each poll checks whether paired devices are reachable. */
export const useDevices = (enabled = true) =>
  useQuery({ queryKey: qk.devices, queryFn: () => api.get<DevicesResponse>('/api/devices'), refetchInterval: enabled ? 8_000 : false, enabled });

export interface DeviceSessionsResponse {
  device: { id: string; name: string; url: string };
  sessions: RemoteSessionView[];
  pushable: Array<{ id: string; status: SyncStatus }>;
}
export const useDeviceSessions = (id: string) =>
  useQuery({ queryKey: qk.deviceSessions(id), queryFn: () => api.get<DeviceSessionsResponse>(`/api/devices/${seg(id)}/sessions`), retry: false, refetchInterval: 15_000 });

export const useSync = (enabled = true) =>
  useQuery({ queryKey: qk.sync, queryFn: () => api.get<SyncState>('/api/sync'), refetchInterval: enabled ? 20_000 : false, enabled });

export interface SettingsResponse {
  settings: Settings;
  pricing: Array<{ key: string; ids: string[]; price: ModelPrice }>;
  paths: { dataDir: string; claudeDir: string; home: string };
  platform: string;
}
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: () => api.get<SettingsResponse>('/api/settings') });

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch<{ settings: Settings; restartNeeded: boolean }>('/api/settings', patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.settings });
      void qc.invalidateQueries({ queryKey: qk.me });
      void qc.invalidateQueries({ queryKey: qk.devices });
      void qc.invalidateQueries({ queryKey: qk.sync });
    },
  });
}

export interface TrashEntry {
  id: string;
  sessionId: string;
  title: string;
  projectPath: string;
  deletedAt: string;
  files: string[];
  sizeBytes: number;
}
export const useTrash = () => useQuery({ queryKey: qk.trash, queryFn: () => api.get<{ trash: TrashEntry[] }>('/api/trash') });

export function useSessionMeta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; title?: string; starred?: boolean; tags?: string[]; note?: string }) =>
      api.patch<SessionListItem>(`/api/sessions/${seg(id)}/meta`, patch),
    onMutate: async ({ id, ...patch }) => {
      // optimistic star/title updates in the list
      qc.setQueryData<{ sessions: SessionListItem[]; status: IndexStatus }>(qk.sessions, (old) =>
        old ? { ...old, sessions: old.sessions.map((s) => (s.id === id ? { ...s, ...(patch as Partial<SessionListItem>) } : s)) } : old,
      );
    },
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: qk.sessions });
      void qc.invalidateQueries({ queryKey: qk.session(v.id) });
    },
  });
}

// ------------------------------------------------------------------ running projects

export function useRuns(enabled = true) {
  return useQuery({ queryKey: qk.runs, queryFn: () => api.get<{ runs: RunInfo[] }>('/api/run'), enabled });
}

export function useProjectRun(path: string | null) {
  return useQuery({
    queryKey: qk.runProject(path ?? ''),
    queryFn: () => api.get<ProjectRunInfo>(`/api/run/project?path=${encodeURIComponent(path!)}`),
    enabled: !!path,
  });
}
