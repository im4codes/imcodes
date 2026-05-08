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
  return { store, cursorSpawns, copilotRuns };
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
    async listSessions(): Promise<
      Array<{ sessionId: string; summary?: string }>
    > {
      return [{ sessionId: "copilot-session-restore", summary: "restored" }];
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
    emit: vi.fn(),
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
  getTransportRuntime,
  restoreTransportSessions,
} from "../../src/agent/session-manager.js";

const flush = async () => {
  for (let i = 0; i < 4; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

// Pin a 10s timeout for this suite. The cursor-headless restore case spawns
// a fake child process and walks resume-id continuity — under default vitest
// `testTimeout: 5000` and a busy daemon project run, the case routinely takes
// 4-5s and intermittently flakes at the 5s limit. CLAUDE.md and
// `openspec/changes/memory-system-1.1-foundations/tasks.md` already note this
// as a "pre-existing timeout"; pinning it here removes the foot-gun.
describe("cursor/copilot transport restore", { timeout: 10_000 }, () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.cursorSpawns.length = 0;
    mocks.copilotRuns.length = 0;
  });

  afterEach(async () => {
    await disconnectAll();
  });

  it("restores cursor-headless sessions with persisted provider resume ids", async () => {
    mocks.store.set("deck_cursor_restore_brain", {
      name: "deck_cursor_restore_brain",
      projectName: "cursorrestore",
      role: "brain",
      agentType: "cursor-headless",
      projectDir: "/tmp/cursor-restore",
      state: "idle",
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeType: "transport",
      providerId: "cursor-headless",
      providerSessionId: "route-cursor-restore",
      providerResumeId: "cursor-chat-restore",
      requestedModel: "gpt-5.2",
      activeModel: "gpt-5.2",
    });

    await connectProvider("cursor-headless", {});
    await restoreTransportSessions("cursor-headless");

    const runtime = getTransportRuntime("deck_cursor_restore_brain");
    expect(runtime?.providerSessionId).toBe("route-cursor-restore");

    runtime!.send("Verify cursor restore");
    await flush();
    const spawned = mocks.cursorSpawns.at(-1);
    expect(spawned?.args).toContain("--resume");
    expect(spawned?.args).toContain("cursor-chat-restore");
  });

  it("restores copilot-sdk sessions with persisted provider resume ids and sends on resumed continuity", async () => {
    mocks.store.set("deck_copilot_restore_brain", {
      name: "deck_copilot_restore_brain",
      projectName: "copilotrestore",
      role: "brain",
      agentType: "copilot-sdk",
      projectDir: "/tmp/copilot-restore",
      state: "idle",
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeType: "transport",
      providerId: "copilot-sdk",
      providerSessionId: "route-copilot-restore",
      providerResumeId: "copilot-session-restore",
      requestedModel: "gpt-5.4",
      activeModel: "gpt-5.4",
      effort: "high",
    });

    await connectProvider("copilot-sdk", {});
    await restoreTransportSessions("copilot-sdk");

    const runtime = getTransportRuntime("deck_copilot_restore_brain");
    expect(runtime?.providerSessionId).toBe("route-copilot-restore");

    runtime!.send("Verify copilot restore");
    await flush();

    expect(mocks.copilotRuns).toContainEqual(
      expect.objectContaining({
        sessionId: "copilot-session-restore",
        prompt: expect.stringContaining("Verify copilot restore"),
      }),
    );
  }, 10_000);

  it("skips unavailable provider restores without throwing and leaves the persisted session inspectable", async () => {
    mocks.store.set("deck_missing_provider_brain", {
      name: "deck_missing_provider_brain",
      projectName: "missingprovider",
      role: "brain",
      agentType: "copilot-sdk",
      projectDir: "/tmp/missing-provider",
      state: "idle",
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeType: "transport",
      providerId: "copilot-sdk",
      providerSessionId: "route-missing-provider",
      providerResumeId: "copilot-session-missing",
    });

    await expect(
      restoreTransportSessions("copilot-sdk"),
    ).resolves.toBeUndefined();
    expect(getTransportRuntime("deck_missing_provider_brain")).toBeUndefined();
    expect(
      mocks.store.get("deck_missing_provider_brain")?.providerResumeId,
    ).toBe("copilot-session-missing");
  });
});
