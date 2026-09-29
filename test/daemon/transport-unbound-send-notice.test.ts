import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

const mocks = vi.hoisted(() => {
  const store = new Map<string, Record<string, any>>();
  const cursorSpawns: Array<{
    file: string;
    args: string[];
    child: EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: Writable;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
  }> = [];
  const copilotRuns: Array<{
    sessionId: string;
    prompt: string;
    attachments?: Array<Record<string, unknown>>;
  }> = [];
  const copilotListFilters: Array<Record<string, unknown> | undefined> = [];
  const emits: Array<{ session: string; type: string; payload: Record<string, unknown> }> = [];
  return { store, cursorSpawns, copilotRuns, copilotListFilters, emits };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = vi.fn(
    (file: string, args: string[], optsOrCb?: unknown, maybeCb?: unknown) => {
      const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as
        | ((err: Error | null, stdout: string, stderr: string) => void)
        | undefined;
      if (args.includes("--version")) {
        cb?.(null, "Cursor Agent 1.0.0\n", "");
        return {} as never;
      }
      if (args[0] === "status") {
        cb?.(null, "Logged in\n", "");
        return {} as never;
      }
      if (args[0] === "create-chat") {
        cb?.(null, "cursor-chat-restored\n", "");
        return {} as never;
      }
      cb?.(null, "ok\n", "");
      return {} as never;
    },
  );
  const spawn = vi.fn((file: string, args: string[]) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: Writable;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.killed = false;
    child.kill = vi.fn((signal?: string) => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", 0, signal ?? "SIGTERM"));
      return true;
    });
    mocks.cursorSpawns.push({ file, args, child });
    queueMicrotask(() => child.emit("spawn"));
    return child as never;
  });
  return { ...actual, execFile, spawn };
});

vi.mock("@github/copilot-sdk", () => {
  class FakeSession {
    sessionId: string;
    handlers = new Set<(event: Record<string, unknown>) => void>();
    constructor(sessionId: string) {
      this.sessionId = sessionId;
    }
    async send(options: Record<string, unknown>): Promise<void> {
      mocks.copilotRuns.push({
        sessionId: this.sessionId,
        prompt: String(options.prompt ?? ""),
        attachments: options.attachments as
          | Array<Record<string, unknown>>
          | undefined,
      });
      for (const handler of this.handlers) {
        handler({
          type: "assistant.message",
          data: { messageId: "msg-1", content: "ACK" },
        });
        handler({ type: "session.idle", data: {} });
      }
    }
    async abort(): Promise<void> {}
    async setModel(
      _model: string,
      _options?: Record<string, unknown>,
    ): Promise<void> {}
    on(handler: (event: Record<string, unknown>) => void): () => void {
      this.handlers.add(handler);
      return () => {
        this.handlers.delete(handler);
      };
    }
    async disconnect(): Promise<void> {}
  }
  class CopilotClient {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async getStatus(): Promise<{ version: string; protocolVersion: number }> {
      return { version: "1.0.31", protocolVersion: 3 };
    }
    async getAuthStatus(): Promise<{
      isAuthenticated: boolean;
      statusMessage?: string;
    }> {
      return { isAuthenticated: true, statusMessage: "Logged in" };
    }
    async listModels(): Promise<Array<{ id: string }>> {
      return [{ id: "gpt-5.4" }];
    }
    async createSession(): Promise<FakeSession> {
      return new FakeSession("copilot-created");
    }
    async resumeSession(sessionId: string): Promise<FakeSession> {
      return new FakeSession(sessionId);
    }
    async listSessions(filter?: Record<string, unknown>): Promise<
      Array<{ sessionId: string; summary?: string; context?: { cwd: string } }>
    > {
      mocks.copilotListFilters.push(filter);
      return [{
        sessionId: "copilot-session-restore",
        summary: "restored",
        context: { cwd: "/tmp/copilot-restore" },
      }];
    }
    async deleteSession(_sessionId: string): Promise<void> {}
  }
  return { CopilotClient };
});

vi.mock("../../src/store/session-store.js", () => ({
  listSessions: vi.fn(() => [...mocks.store.values()]),
  getSession: vi.fn((name: string) => mocks.store.get(name) ?? null),
  upsertSession: vi.fn((record: Record<string, any>) => {
    if (record.name) mocks.store.set(record.name, record);
  }),
  removeSession: vi.fn((name: string) => {
    mocks.store.delete(name);
  }),
  updateSessionState: vi.fn((name: string, state: string) => {
    const existing = mocks.store.get(name);
    if (existing) mocks.store.set(name, { ...existing, state });
  }),
}));

vi.mock("../../src/daemon/transport-relay.js", () => ({
  wireProviderToRelay: vi.fn(),
  broadcastProviderStatus: vi.fn(),
}));
vi.mock("../../src/util/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/daemon/timeline-emitter.js", () => ({
  timelineEmitter: {
    emit: vi.fn((session: string, type: string, payload: Record<string, unknown>) => { mocks.emits.push({ session, type, payload }); }),
    on: vi.fn(() => () => {}),
    epoch: 0,
    replay: vi.fn(() => ({ events: [], truncated: false })),
  },
}));
vi.mock("../../src/agent/tmux.js", () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  newSession: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(undefined),
  sessionExists: vi.fn(),
  isPaneAlive: vi.fn(),
  respawnPane: vi.fn(),
  sendKeys: vi.fn(),
  sendKey: vi.fn(),
  capturePane: vi.fn(),
  showBuffer: vi.fn(),
  getPaneId: vi.fn().mockResolvedValue(undefined),
  getPaneCwd: vi.fn().mockResolvedValue("/tmp"),
  getPaneStartCommand: vi.fn().mockResolvedValue(""),
  cleanupOrphanFifos: vi.fn(),
  BACKEND: "tmux",
}));
vi.mock("../../src/daemon/jsonl-watcher.js", () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingFile: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
  findJsonlPathBySessionId: vi.fn(() => "/tmp/mock.jsonl"),
}));
vi.mock("../../src/daemon/codex-watcher.js", () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingSpecificFile: vi.fn().mockResolvedValue(undefined),
  startWatchingById: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
  findRolloutPathByUuid: vi.fn(async () => null),
}));
vi.mock("../../src/daemon/gemini-watcher.js", () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingLatest: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
}));
vi.mock("../../src/daemon/opencode-watcher.js", () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
}));
vi.mock("../../src/agent/structured-session-bootstrap.js", () => ({
  resolveStructuredSessionBootstrap: vi.fn(async (x) => x),
}));
vi.mock("../../src/agent/qwen-runtime-config.js", () => ({
  getQwenRuntimeConfig: vi.fn(async () => null),
}));
vi.mock("../../src/agent/sdk-runtime-config.js", () => ({
  getClaudeSdkRuntimeConfig: vi.fn(async () => ({})),
}));
vi.mock("../../src/agent/codex-runtime-config.js", () => ({
  getCodexRuntimeConfig: vi.fn(async () => ({})),
}));
vi.mock("../../src/agent/provider-display.js", () => ({
  getQwenDisplayMetadata: vi.fn(() => ({})),
}));
vi.mock("../../src/agent/provider-quota.js", () => ({
  getQwenOAuthQuotaUsageLabel: vi.fn(() => ""),
}));
vi.mock("../../src/agent/agent-version.js", () => ({
  getAgentVersion: vi.fn(async () => "test"),
}));
vi.mock("../../src/agent/signal.js", () => ({
  setupCCStopHook: vi.fn(async () => {}),
}));
vi.mock("../../src/agent/notify-setup.js", () => ({
  setupCodexNotify: vi.fn(async () => {}),
  setupOpenCodePlugin: vi.fn(async () => {}),
}));
vi.mock("../../src/repo/cache.js", () => ({
  repoCache: { invalidate: vi.fn() },
}));
vi.mock("../../src/agent/brain-dispatcher.js", () => ({
  BrainDispatcher: vi
    .fn()
    .mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

import {
  connectProvider,
  disconnectAll,
} from "../../src/agent/provider-registry.js";
import {
  ensureTransportRuntimeForPendingResend,
  getTransportRuntime,
  launchTransportSession,
} from "../../src/agent/session-manager.js";
import { buildTransportResumeLaunchOpts } from "../../src/agent/transport-resume-opts.js";
import { clearAllResend, enqueueResend, getResendCount } from "../../src/daemon/transport-resend-queue.js";
import { resetTransportRestoreBackoffForTests } from "../../src/agent/transport-restore-backoff.js";
import { DAEMON_USER_NOTICE_CODE } from "../../shared/daemon-user-notices.js";

const flush = async () => {
  for (let i = 0; i < 4; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
};


const SEND = { bypassBackoff: true, notifyIfPermanentlyUnbound: true } as const;
const notices = () => mocks.emits.filter((e) => e.type === "assistant.text" && e.payload.noticeCode === DAEMON_USER_NOTICE_CODE.TRANSPORT_RESTORE_UNBOUND);

function cursorRecord(name: string, over: Record<string, unknown> = {}): Record<string, any> {
  return {
    name, projectName: "cursorunbound", role: "brain", agentType: "cursor-headless", projectDir: "/tmp/cursor-unbound",
    state: "idle", restarts: 0, restartTimestamps: [], createdAt: Date.now(), updatedAt: Date.now(),
    runtimeType: "transport", providerId: "cursor-headless", providerSessionId: `route-${name}`, requestedModel: "gpt-5.2", activeModel: "gpt-5.2",
    ...over,
  };
}

describe("unbound-send notice end to end (real cursor-headless provider)", { timeout: 10_000 }, () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.cursorSpawns.length = 0;
    mocks.emits.length = 0;
    clearAllResend();
    resetTransportRestoreBackoffForTests();
  });
  afterEach(async () => {
    await disconnectAll();
  });

  it("notices once, keeps the message queued, then a relaunch delivers it with no further notice", async () => {
    const name = "deck_cursor_unbound_brain";
    mocks.store.set(name, cursorRecord(name)); // no providerResumeId: cursor-headless cannot list sessions
    expect(enqueueResend(name, { text: "please continue the task", commandId: "m1", clientMessageId: "m1", queuedAt: Date.now() }).accepted).toBe(true);

    await connectProvider("cursor-headless", {});
    await ensureTransportRuntimeForPendingResend(name, SEND);
    await ensureTransportRuntimeForPendingResend(name, SEND); // second send in the same step
    await flush();
    expect(notices()).toHaveLength(1);
    expect(getTransportRuntime(name)).toBeUndefined();
    expect(getResendCount(name)).toBe(1); // still queued

    // The user relaunches the session: it binds a provider conversation and the queue drains.
    await launchTransportSession(buildTransportResumeLaunchOpts(mocks.store.get(name) as never));
    await flush();
    expect(getTransportRuntime(name)?.providerSessionId).toBeTruthy();
    expect(getResendCount(name)).toBe(0); // delivered
    expect(mocks.cursorSpawns.some((spawn) => spawn.args.join(" ").includes("please continue the task"))).toBe(true);

    await ensureTransportRuntimeForPendingResend(name, SEND); // later sends: runtime bound, nothing to say
    expect(notices()).toHaveLength(1);
  });

  it("a restorable session (persisted provider resume id) is restored on a send with no notice", async () => {
    const name = "deck_cursor_restorable_brain";
    mocks.store.set(name, cursorRecord(name, { providerResumeId: "cursor-chat-restore" }));
    expect(enqueueResend(name, { text: "hello restorable", commandId: "m2", clientMessageId: "m2", queuedAt: Date.now() }).accepted).toBe(true);
    await connectProvider("cursor-headless", {});
    await ensureTransportRuntimeForPendingResend(name, SEND);
    await flush();
    expect(getTransportRuntime(name)?.providerSessionId).toBe(`route-${name}`);
    expect(notices()).toHaveLength(0);
  });
});
