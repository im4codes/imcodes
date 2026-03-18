export interface Observation {
  sessionName: string;
  projectName: string;
  content: string;
  timestamp: number;
  tags?: string[];
}

export interface MemorySearchResult {
  content: string;
  score: number;
  timestamp: number;
}

export interface MemoryBackend {
  /** Check if this backend is available on this machine */
  isAvailable(): Promise<boolean>;

  /** Store an observation from a session */
  addObservation(obs: Observation): Promise<void>;

  /** Semantic search for related memories */
  search(query: string, projectName: string, limit?: number): Promise<MemorySearchResult[]>;

  /** Get aggregated project context (recent observations + summaries) */
  getProjectContext(projectName: string): Promise<MemorySearchResult[]>;

  /** Summarize a completed session and store the summary */
  summarizeSession(sessionName: string, projectName: string, screenContent: string): Promise<void>;
}
