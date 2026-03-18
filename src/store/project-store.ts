import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const STORE_DIR = join(homedir(), '.imcodes');
const STORE_PATH = join(STORE_DIR, 'projects.json');
const DEBOUNCE_MS = 500;

export interface ProjectTrackerConfig {
  type: 'github' | 'gitlab';
  apiUrl?: string;           // empty = hosted; set for Enterprise/self-hosted
  tokenEnv: string;          // name of the env var holding the token
  repo?: string;             // GitHub: "owner/repo"
  projectId?: string;        // GitLab: numeric ID or "namespace/project-path"
  baseBranch: string;
}

export interface ProjectConfig {
  name: string;
  dir: string;
  coderAgent: string;        // claude-code | codex | opencode
  auditorAgent: string;
  maxDiscussionRounds: number;
  autoMerge: boolean;
  tracker?: ProjectTrackerConfig;
  issueFilters?: {
    labels?: string[];
    assignedToMe?: boolean;
    milestone?: string;
  };
  createdAt: number;
  updatedAt: number;
}

export interface ProjectStore {
  projects: Record<string, ProjectConfig>;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let store: ProjectStore = { projects: {} };

export async function loadProjectStore(): Promise<ProjectStore> {
  await mkdir(STORE_DIR, { recursive: true });
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    store = JSON.parse(raw) as ProjectStore;
  } catch {
    store = { projects: {} };
  }
  return store;
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
    writeTimer = null;
  }, DEBOUNCE_MS);
}

export function getProject(name: string): ProjectConfig | undefined {
  return store.projects[name];
}

export function upsertProject(config: Omit<ProjectConfig, 'createdAt' | 'updatedAt'> & { createdAt?: number }): void {
  const existing = store.projects[config.name];
  store.projects[config.name] = {
    ...config,
    createdAt: config.createdAt ?? existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  scheduleWrite();
}

export function removeProject(name: string): void {
  delete store.projects[name];
  scheduleWrite();
}

export function listProjects(): ProjectConfig[] {
  return Object.values(store.projects);
}

export function updateProject(name: string, patch: Partial<Omit<ProjectConfig, 'name' | 'createdAt'>>): void {
  const p = store.projects[name];
  if (!p) return;
  Object.assign(p, patch, { updatedAt: Date.now() });
  scheduleWrite();
}

export async function flushProjectStore(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}
