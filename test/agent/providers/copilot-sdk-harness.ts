import { EventEmitter } from 'node:events';

type SessionConfig = Record<string, unknown> & {
  onPermissionRequest?: (request: Record<string, unknown>, invocation: { sessionId: string }) => Promise<unknown> | unknown;
};

export interface CopilotHarnessState {
  clientCalls: {
    start: number;
    stop: number;
    getStatus: number;
    getAuthStatus: number;
    listModels: number;
    deleteSession: string[];
  };
  status: {
    version: string;
    protocolVersion: number;
  };
  auth: {
    isAuthenticated: boolean;
    statusMessage?: string;
  };
  models: Array<{ id: string; displayName?: string }>;
  startError: Error | null;
  statusError: Error | null;
  authError: Error | null;
  modelsError: Error | null;
  deleteSessionError: Error | null;
  keepDeletedSessions: boolean;
}

export interface CopilotSpawnedSession {
  sessionId: string;
  config: SessionConfig;
  sendCalls: Array<Record<string, unknown>>;
  setModelCalls: Array<{ model: string; options?: Record<string, unknown> }>;
  abortCalls: number;
  disconnectCalls: number;
  active: boolean;
  emitter: EventEmitter;
  emit(event: Record<string, unknown>): void;
  requestPermission(request: Record<string, unknown>): Promise<unknown>;
}

export function createCopilotSdkHarness() {
  const state: CopilotHarnessState = {
    clientCalls: {
      start: 0,
      stop: 0,
      getStatus: 0,
      getAuthStatus: 0,
      listModels: 0,
      deleteSession: [],
    },
    status: { version: '1.0.31', protocolVersion: 3 },
    auth: { isAuthenticated: true, statusMessage: 'Logged in' },
    models: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }],
    startError: null,
    statusError: null,
    authError: null,
    modelsError: null,
    deleteSessionError: null,
    keepDeletedSessions: true,
  };

  const sessions: CopilotSpawnedSession[] = [];
  const clients: FakeCopilotClient[] = [];

  class FakeCopilotSession {
    readonly sessionId: string;
    readonly config: SessionConfig;
    readonly emitter = new EventEmitter();
    sendCalls: Array<Record<string, unknown>> = [];
    setModelCalls: Array<{ model: string; options?: Record<string, unknown> }> = [];
    abortCalls = 0;
    disconnectCalls = 0;
    active = true;

    constructor(sessionId: string, config: SessionConfig) {
      this.sessionId = sessionId;
      this.config = config;
    }

    async send(options: Record<string, unknown>): Promise<void> {
      this.sendCalls.push(options);
    }

    async abort(): Promise<void> {
      this.abortCalls += 1;
      this.emitter.emit('aborted');
    }

    async setModel(model: string, options?: Record<string, unknown>): Promise<void> {
      this.setModelCalls.push({ model, options });
    }

    async disconnect(): Promise<void> {
      this.disconnectCalls += 1;
      this.active = false;
    }

    requestPermission(request: Record<string, unknown>): Promise<unknown> {
      const handler = this.config.onPermissionRequest;
      if (!handler) {
        return Promise.resolve({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' });
      }
      return Promise.resolve(handler(request, { sessionId: this.sessionId }));
    }

    emit(event: Record<string, unknown>): void {
      this.emitter.emit('event', event);
    }

    on(handler: (event: Record<string, unknown>) => void): () => void {
      const wrapped = (event: Record<string, unknown>) => handler(event);
      this.emitter.addListener('event', wrapped);
      return () => {
        this.emitter.removeListener('event', wrapped);
      };
    }
  }

  class FakeCopilotClient {
    private sessionCounter = 0;
    readonly createdSessions: CopilotSpawnedSession[] = sessions;

    async start(): Promise<void> {
      state.clientCalls.start += 1;
      if (state.startError) throw state.startError;
    }

    async stop(): Promise<void> {
      state.clientCalls.stop += 1;
    }

    async getStatus(): Promise<{ version: string; protocolVersion: number }> {
      state.clientCalls.getStatus += 1;
      if (state.statusError) throw state.statusError;
      return { ...state.status };
    }

    async getAuthStatus(): Promise<{ isAuthenticated: boolean; statusMessage?: string }> {
      state.clientCalls.getAuthStatus += 1;
      if (state.authError) throw state.authError;
      return { ...state.auth };
    }

    async listModels(): Promise<Array<{ id: string; displayName?: string }>> {
      state.clientCalls.listModels += 1;
      if (state.modelsError) throw state.modelsError;
      return state.models.map((model) => ({ ...model }));
    }

    async createSession(config: SessionConfig): Promise<FakeCopilotSession> {
      const sessionId = `copilot-session-${++this.sessionCounter}`;
      const session = new FakeCopilotSession(sessionId, config);
      sessions.push(session);
      clients.push(this);
      return session;
    }

    async resumeSession(sessionId: string, config: SessionConfig): Promise<FakeCopilotSession> {
      const existing = sessions.find((session) => session.sessionId === sessionId);
      if (existing) {
        existing.config.onPermissionRequest = config.onPermissionRequest ?? existing.config.onPermissionRequest;
        return existing as unknown as FakeCopilotSession;
      }
      const session = new FakeCopilotSession(sessionId, config);
      sessions.push(session);
      clients.push(this);
      return session;
    }

    async listSessions(): Promise<Array<{ sessionId: string; summary?: string; modifiedTime?: Date }>> {
      return sessions.map((session) => ({
        sessionId: session.sessionId,
        summary: session.sessionId,
        modifiedTime: new Date(1_700_000_000_000 + sessions.indexOf(session)),
      }));
    }

    async deleteSession(sessionId: string): Promise<void> {
      state.clientCalls.deleteSession.push(sessionId);
      if (state.deleteSessionError) throw state.deleteSessionError;
      if (!state.keepDeletedSessions) {
        const idx = sessions.findIndex((session) => session.sessionId === sessionId);
        if (idx >= 0) sessions.splice(idx, 1);
      }
    }
  }

  const sdkModule = { CopilotClient: FakeCopilotClient };

  return {
    state,
    sessions,
    clients,
    sdkModule,
    lastSession(): CopilotSpawnedSession {
      const session = sessions.at(-1);
      if (!session) throw new Error('No Copilot session recorded');
      return session;
    },
    reset(): void {
      sessions.length = 0;
      clients.length = 0;
    },
  };
}
