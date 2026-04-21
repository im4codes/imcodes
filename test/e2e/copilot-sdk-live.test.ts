import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotSdkProvider } from "../../src/agent/providers/copilot-sdk.js";
import type {
  ApprovalRequest,
  ProviderError,
  SessionInfoUpdate,
} from "../../src/agent/transport-provider.js";

const RUN = process.env.RUN_COPILOT_LIVE === "1";
const TIMEOUT_MS = 90_000;

function waitForCompletion(
  provider: CopilotSdkProvider,
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

function waitForInfo(
  provider: CopilotSdkProvider,
  sessionId: string,
  predicate: (info: SessionInfoUpdate) => boolean,
): Promise<SessionInfoUpdate> {
  return new Promise((resolve, reject) => {
    const off = provider.onSessionInfo((sid, info) => {
      if (sid !== sessionId || !predicate(info)) return;
      off();
      resolve(info);
    });
    setTimeout(() => {
      off();
      reject(new Error("Timed out waiting for Copilot session info update"));
    }, 20_000);
  });
}

function waitForCancel(
  provider: CopilotSdkProvider,
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
      reject(new Error("Timed out waiting for Copilot cancellation"));
    }, 20_000);
  });
}

function waitForToolStart(
  provider: CopilotSdkProvider,
  sessionId: string,
  predicate: (toolName: string, input: unknown) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    provider.onToolCall((sid, tool) => {
      if (settled) return;
      if (sid !== sessionId || tool.status !== "running") return;
      if (!predicate(String(tool.name ?? ""), tool.input)) return;
      settled = true;
      resolve();
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Timed out waiting for Copilot tool start"));
    }, 30_000);
  });
}

describe.skipIf(!RUN)("copilot-sdk live transport", () => {
  let provider: CopilotSdkProvider;
  let sessionId: string;
  let latestResumeId = "";
  let tempDir = "";

  beforeEach(async () => {
    provider = new CopilotSdkProvider();
    provider.onApprovalRequest((sid, req: ApprovalRequest) => {
      void provider.respondApproval(sid, req.id, true);
    });
    provider.onSessionInfo((sid, info) => {
      if (sid === sessionId && info.resumeId) latestResumeId = info.resumeId;
    });
    await provider.connect({
      binaryPath: process.env.COPILOT_BIN_PATH,
      approvalTimeoutMs: 20_000,
    });
    sessionId = await provider.createSession({
      sessionKey: `copilot-live-${Date.now()}`,
      cwd: process.cwd(),
      agentId: process.env.COPILOT_LIVE_MODEL || "gpt-5.4",
      effort: "high",
    });
    tempDir = await mkdtemp(join(tmpdir(), "copilot-live-"));
  }, TIMEOUT_MS);

  afterEach(async () => {
    await provider.disconnect();
  });

  it(
    "supports attachments and multi-turn resume",
    async () => {
      const attachmentPath = join(tempDir, "transport-live.txt");
      await writeFile(attachmentPath, "COPILOT_ATTACHMENT_OK\n", "utf8");

      const first = waitForCompletion(provider, sessionId);
      await provider.send(
        sessionId,
        "Read the attached file and reply with exactly COPILOT_ATTACHMENT_OK and nothing else.",
        [
          {
            id: "att-1",
            daemonPath: attachmentPath,
            originalName: "transport-live.txt",
            type: "file",
          },
        ],
      );
      await expect(first).resolves.toContain("COPILOT_ATTACHMENT_OK");

      const second = waitForCompletion(provider, sessionId);
      await provider.send(
        sessionId,
        "Without explanation, reply exactly COPILOT_LIVE_RESUME_OK if the previous final answer in this conversation was COPILOT_ATTACHMENT_OK, otherwise reply COPILOT_LIVE_RESUME_NO.",
      );
      await expect(second).resolves.toContain("COPILOT_LIVE_RESUME_OK");
    },
    TIMEOUT_MS,
  );

  it(
    "rotates away from background-tainted aborts before the next turn",
    async () => {
      const originalResume = latestResumeId;
      const toolStarted = waitForToolStart(
        provider,
        sessionId,
        (toolName, input) =>
          toolName.toLowerCase() === "bash"
          && typeof input === "object"
          && input !== null
          && String((input as Record<string, unknown>).command ?? "").includes("COPILOT_BG_STARTED"),
      );
      await provider.send(
        sessionId,
        'Use shell immediately to run: nohup sh -c "sleep 30" >/tmp/copilot-bg.log 2>&1 & echo COPILOT_BG_STARTED. After starting the background process, do not wait for it; just say COPILOT_BG_STARTED.',
      );
      await toolStarted;
      const cancelled = waitForCancel(provider, sessionId);
      const rotatedInfo = waitForInfo(
        provider,
        sessionId,
        (info) => !!info.resumeId && info.resumeId !== originalResume,
      );
      await provider.cancel(sessionId);
      await expect(cancelled).resolves.toMatchObject({ code: "CANCELLED" });
      const info = await rotatedInfo;
      expect(info.resumeId).not.toBe(originalResume);

      const followup = waitForCompletion(provider, sessionId);
      await provider.send(
        sessionId,
        "Reply with exactly COPILOT_POST_ABORT_OK and nothing else.",
      );
      await expect(followup).resolves.toContain("COPILOT_POST_ABORT_OK");
    },
    TIMEOUT_MS,
  );
});
