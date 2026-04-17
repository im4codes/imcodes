import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorHeadlessProvider } from "../../src/agent/providers/cursor-headless.js";
import type {
  ProviderError,
  SessionInfoUpdate,
} from "../../src/agent/transport-provider.js";

const RUN = process.env.RUN_CURSOR_LIVE === "1";
const TIMEOUT_MS = 60_000;

function waitForCompletion(
  provider: CursorHeadlessProvider,
  sessionId: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const offComplete = provider.onComplete((sid, message) => {
      if (sid !== sessionId) return;
      offComplete();
      offError();
      resolve(String(message.content ?? ""));
    });
    const offError = provider.onError((sid, error) => {
      if (sid !== sessionId) return;
      offComplete();
      offError();
      reject(Object.assign(new Error(error.message), { code: error.code }));
    });
  });
}

function waitForCancel(
  provider: CursorHeadlessProvider,
  sessionId: string,
): Promise<ProviderError> {
  return new Promise((resolve, reject) => {
    const offError = provider.onError((sid, error) => {
      if (sid !== sessionId || error.code !== "CANCELLED") return;
      offError();
      resolve(error);
    });
    setTimeout(() => {
      offError();
      reject(new Error("Timed out waiting for Cursor cancellation"));
    }, 10_000);
  });
}

describe.skipIf(!RUN)("cursor-headless live transport", () => {
  let provider: CursorHeadlessProvider;
  let sessionId: string;

  beforeEach(async () => {
    provider = new CursorHeadlessProvider();
    await provider.connect({
      binaryPath: process.env.CURSOR_BIN_PATH,
      force: true,
      trust: true,
    });
    sessionId = await provider.createSession({
      sessionKey: `cursor-live-${Date.now()}`,
      cwd: process.cwd(),
      agentId: process.env.CURSOR_LIVE_MODEL || "gpt-5.2",
    });
  }, TIMEOUT_MS);

  afterEach(async () => {
    await provider.disconnect();
  });

  it(
    "supports multi-turn resume and explicit tool-mediated answers",
    async () => {
      const first = waitForCompletion(provider, sessionId);
      await provider.send(
        sessionId,
        "Use shell if needed, then reply with exactly CURSOR_LIVE_OK and nothing else.",
      );
      await expect(first).resolves.toContain("CURSOR_LIVE_OK");

      const second = waitForCompletion(provider, sessionId);
      await provider.send(
        sessionId,
        "Without explanation, reply exactly CURSOR_LIVE_RESUME_OK if your previous final answer in this conversation was CURSOR_LIVE_OK, otherwise reply CURSOR_LIVE_RESUME_NO.",
      );
      await expect(second).resolves.toContain("CURSOR_LIVE_RESUME_OK");
    },
    TIMEOUT_MS,
  );

  it(
    "supports deterministic process-kill cancellation",
    async () => {
      await provider.send(
        sessionId,
        "Run a long task and do not finish quickly.",
      );
      const cancelled = waitForCancel(provider, sessionId);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await provider.cancel(sessionId);
      await expect(cancelled).resolves.toMatchObject({ code: "CANCELLED" });
    },
    TIMEOUT_MS,
  );
});
