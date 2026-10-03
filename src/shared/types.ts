// Types shared by the server and the web app. The server is the only place that
// reads Claude Code's files; everything the UI sees is shaped here.

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

export const totalTokens = (u: Usage): number => u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;

export function addUsage(into: Usage, u: Usage): Usage {
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheWrite5m += u.cacheWrite5m;
  into.cacheWrite1h += u.cacheWrite1h;
  return into;
}

export interface ModelStat {
  model: string;
  label: string;
  messages: number;
  usage: Usage;
  cost: number | null;
}

export interface LiveInfo {
  pid: number;
  status: string; // "busy" | "idle" | whatever Claude Code reports
  name?: string;
  updatedAt?: number;
  startedAt?: number;
}

export type TitleSource = 'custom' | 'claude' | 'ai' | 'summary' | 'prompt' | 'none';

export interface SessionListItem {
  id: string;
  projectDir: string;
  projectPath: string;
  projectName: string;
  title: string;
  titleSource: TitleSource;
  firstPrompt?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs: number;
  activeMs: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolErrors: number;
  usage: Usage;
  totalTokens: number;
  cost: number | null;
  costPartial: boolean;
  models: string[];
  branch?: string;
  version?: string;
  sizeBytes: number;
  mtimeMs: number;
  subagentCount: number;
  compactions: number;
  /** cwd values in the file that point somewhere other than the project path (e.g. copied from another PC). */
  hasForeignPaths: boolean;
  live?: LiveInfo;
  starred: boolean;
  tags: string[];
  note?: string;
  idCount: number;
  idHash: string;
}

export interface SubagentInfo {
  agentId: string;
  description?: string;
  agentType?: string;
  toolUseId?: string;
  model?: string;
  lines: number;
  sizeBytes: number;
  usage: Usage;
  cost: number | null;
  toolCalls: number;
  startedAt?: string;
  endedAt?: string;
}

export interface FileTouch {
  path: string;
  reads: number;
  edits: number;
  writes: number;
}

export interface SessionDetail extends SessionListItem {
  aiTitle?: string;
  lastPrompt?: string;
  recap?: string;
  cwds: string[];
  branches: string[];
  modelStats: ModelStat[];
  tools: Record<string, number>;
  subagents: SubagentInfo[];
  filesTouched: FileTouch[];
  diskFiles: Array<{ rel: string; size: number }>;
  resume: ResumeInfo;
}

export interface ResumeInfo {
  cwd: string;
  cwdExists: boolean;
  powershell: string;
  cmd: string;
  bash: string;
}

// ---------------------------------------------------------------- transcript

export interface ImageRef {
  ref: string;
  mediaType: string;
  bytes: number;
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ToolResultMeta {
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  patch?: PatchHunk[];
  patchTruncated?: boolean;
  filePath?: string;
  agentId?: string;
  persistedOutputPath?: string;
  numLines?: number;
  backgroundTaskId?: string;
}

export interface ToolResult {
  ts?: string;
  text: string;
  truncated: boolean;
  fullLength: number;
  isError: boolean;
  images: ImageRef[];
  line: number;
  meta?: ToolResultMeta;
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean; durationMs?: number }
  | {
      type: 'tool';
      id: string;
      name: string;
      input: unknown;
      inputTruncated?: boolean;
      line: number;
      ts?: string;
      result?: ToolResult;
    };

interface ItemBase {
  uuid: string;
  ts?: string;
  line: number;
  offBranch?: boolean;
  sidechain?: boolean;
}

export type TranscriptItem =
  | (ItemBase & { kind: 'user'; text: string; images: ImageRef[]; meta?: boolean })
  | (ItemBase & { kind: 'command'; name: string; args?: string; output?: string })
  | (ItemBase & { kind: 'shell'; input?: string; stdout?: string; stderr?: string })
  | (ItemBase & {
      kind: 'assistant';
      msgId?: string;
      model?: string;
      blocks: Block[];
      usage?: Usage;
      stopReason?: string;
    })
  | (ItemBase & { kind: 'system'; subtype: string; text: string; level?: string })
  | (ItemBase & { kind: 'compact'; trigger?: string; preTokens?: number; summary?: string })
  | (ItemBase & { kind: 'notice'; tone: 'info' | 'warn'; label: string; text?: string })
  | (ItemBase & { kind: 'context'; attachmentType: string; label: string; text?: string });

export interface Transcript {
  sessionId: string;
  agentId?: string;
  items: TranscriptItem[];
  lineCount: number;
  truncateAt: number;
}

// ---------------------------------------------------------------- projects & stats

export interface ProjectSummary {
  dir: string;
  path: string;
  name: string;
  pathExists: boolean;
  sessions: number;
  lastActive?: string;
  firstActive?: string;
  usage: Usage;
  totalTokens: number;
  cost: number | null;
  userMessages: number;
  live: number;
  hasMemory: boolean;
}

export interface DayBucket {
  date: string; // YYYY-MM-DD in the requested time zone
  sessions: number;
  prompts: number;
  tokens: number;
  cost: number;
  byModel: Record<string, { tokens: number; cost: number }>;
}

export interface StatsResponse {
  from: string;
  to: string;
  totals: {
    sessions: number;
    prompts: number;
    assistantMessages: number;
    toolCalls: number;
    usage: Usage;
    totalTokens: number;
    cost: number;
    costPartial: boolean;
    activeDays: number;
    longestStreak: number;
    currentStreak: number;
  };
  days: DayBucket[];
  models: ModelStat[];
  projects: Array<{ dir: string; name: string; path: string; sessions: number; tokens: number; cost: number }>;
  tools: Array<{ name: string; count: number }>;
  /** 7 x 24 matrix of prompts, Monday first. */
  hourOfWeek: number[][];
  /** Daily activity over the last year (independent of the selected range), for the calendar heatmap. */
  heatmap: Array<{ date: string; prompts: number; tokens: number; cost: number }>;
}

// ---------------------------------------------------------------- search

export interface SearchHit {
  sessionId: string;
  title: string;
  projectName: string;
  uuid: string;
  role: 'user' | 'assistant' | 'tool';
  ts?: string;
  snippet: string;
  /** [start, end) offsets into snippet to highlight */
  highlights: Array<[number, number]>;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  totalMatches: number;
  sessionsSearched: number;
  tookMs: number;
  truncated: boolean;
}

// ---------------------------------------------------------------- transfer

export type SyncStatus =
  | 'new' // only on the other side
  | 'missing' // only here
  | 'same'
  | 'incoming-ahead' // the other copy continues ours
  | 'local-ahead' // ours continues the other copy
  | 'diverged';

export interface BundleSession {
  id: string;
  projectDir: string;
  projectPath: string;
  title: string;
  startedAt?: string;
  endedAt?: string;
  userMessages: number;
  sizeBytes: number;
  idCount: number;
  idHash: string;
  files: string[]; // relative to the bundle root (Claude dir layout)
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  homeDir: string;
  claudeDir: string;
  app: string;
  version: string;
}

export interface BundleManifest {
  format: 'claude-handoff-bundle';
  version: 1;
  createdAt: string;
  source: DeviceInfo;
  sessions: BundleSession[];
  memory: Array<{ projectDir: string; projectPath: string; files: string[] }>;
}

export type ImportAction = 'import' | 'update' | 'overwrite' | 'copy' | 'skip';

export interface ImportCandidate {
  session: BundleSession;
  /** Path on this machine Claude Code should resume the session from. */
  targetPath: string;
  targetDir: string;
  targetPathExists: boolean;
  mappingReason: string;
  status: SyncStatus;
  local?: { projectDir: string; projectPath: string; idCount: number; mtimeMs: number; live: boolean };
  suggestedAction: ImportAction;
  allowedActions: ImportAction[];
  warnings: string[];
}

export interface StagingSourceInfo {
  kind: 'upload' | 'device' | 'sync' | 'push';
  label: string;
  deviceId?: string;
  deviceName?: string;
  filename?: string;
}

export interface ImportPlan {
  id: string;
  createdAt: string;
  source: StagingSourceInfo;
  sourceDevice?: DeviceInfo;
  candidates: ImportCandidate[];
  /** Distinct source project paths and where they map to. */
  mappings: Array<{ from: string; to: string; reason: string; exists: boolean; sessions: number }>;
  homeRule?: { from: string; to: string };
  memory: Array<{ projectPath: string; files: number; targetHasMemory: boolean }>;
  warnings: string[];
}

export interface ImportOptions {
  rewriteMetadata: boolean;
  rewriteContent: boolean;
  includeFileHistory: boolean;
  includeMemory: boolean;
}

export interface ImportRequest {
  mappings: Record<string, string>;
  actions: Record<string, ImportAction>;
  options: ImportOptions;
}

export interface ImportResultItem {
  sessionId: string;
  title: string;
  action: ImportAction;
  ok: boolean;
  error?: string;
  newSessionId?: string;
  targetPath: string;
  targetFile?: string;
  rewrites: number;
  backup?: string;
  resume?: ResumeInfo;
}

export interface ImportResult {
  historyId: string;
  items: ImportResultItem[];
}

export interface HistoryEntry {
  id: string;
  at: string;
  source: StagingSourceInfo;
  items: Array<{
    sessionId: string;
    newSessionId?: string;
    action: ImportAction;
    title: string;
    targetPath: string;
    createdFiles: string[];
    backupDir?: string;
  }>;
  undone?: boolean;
}

export interface PeerSession {
  id: string;
  projectPath: string;
  projectName: string;
  title: string;
  startedAt?: string;
  endedAt?: string;
  userMessages: number;
  sizeBytes: number;
  idCount: number;
  idHash: string;
  live: boolean;
}

export interface RemoteSessionView extends PeerSession {
  status: SyncStatus;
  localProjectPath?: string;
}

export interface PairedDevice {
  id: string;
  name: string;
  url: string;
  platform?: string;
  addedAt: string;
  lastSeenAt?: string;
}

export interface DeviceState extends PairedDevice {
  online: boolean;
  error?: string;
  version?: string;
}

export interface DiscoveredDevice {
  id: string;
  name: string;
  address: string;
  port: number;
  url: string;
  lastSeen: number;
  paired: boolean;
}

export interface SyncFolderSession extends PeerSession {
  status: SyncStatus;
  pushedAt: string;
  pushedBy: { id: string; name: string };
  localProjectPath?: string;
}

export interface SyncState {
  folder: string | null;
  exists: boolean;
  writable: boolean;
  autoPush: 'off' | 'all' | 'starred';
  lastPushAt?: string;
  sessions: SyncFolderSession[];
  devices: Array<{ id: string; name: string; platform: string; lastSeen: string }>;
  pendingPush: number;
  error?: string;
}

// ---------------------------------------------------------------- settings & identity

export interface Settings {
  deviceId: string;
  deviceName: string;
  port: number;
  claudeDir: string | null;
  lan: {
    enabled: boolean;
    token: string;
    acceptPush: boolean;
    discovery: boolean;
  };
  sync: {
    folder: string | null;
    autoPush: 'off' | 'all' | 'starred';
  };
  importDefaults: ImportOptions;
  pricingOverrides: Record<string, Partial<import('./pricing.js').ModelPrice>>;
}

export interface MeResponse {
  device: DeviceInfo;
  access: 'local' | 'remote';
  lan: { enabled: boolean; urls: string[]; port: number; acceptPush: boolean };
  claude: {
    dir: string;
    exists: boolean;
    cleanupPeriodDays: number | null;
  };
  inbox: number;
  index: IndexStatus;
}

export interface IndexStatus {
  state: 'idle' | 'scanning';
  done: number;
  total: number;
  sessions: number;
  lastScanAt?: string;
}

export type ServerEvent =
  | { type: 'index'; status: IndexStatus }
  | { type: 'sessions'; changed: string[]; removed: string[] }
  | { type: 'live'; sessions: string[] }
  | { type: 'inbox'; count: number }
  | { type: 'sync'; pendingPush: number; lastPushAt?: string }
  | { type: 'devices' }
  | { type: 'toast'; tone: 'info' | 'success' | 'error'; message: string };
