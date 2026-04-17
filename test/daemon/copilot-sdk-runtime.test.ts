import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CopilotSdkProvider,
  copilotSdkRuntimeHooks,
} from "../../src/agent/providers/copilot-sdk.js";
import { TransportSessionRuntime } from "../../src/agent/transport-session-runtime.js";
import { createCopilotSdkHarness } from "../agent/providers/copilot-sdk-harness.js";

vi.mock("../../src/util/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("CopilotSdkProvider + TransportSessionRuntime", () => {
  const originalLoadSdk = copilotSdkRuntimeHooks.loadSdk;
  let harness = createCopilotSdkHarness();

  beforeEach(() => {
    harness = createCopilotSdkHarness();
    copilotSdkRuntimeHooks.loadSdk = async () => harness.sdkModule as never;
  });

  afterEach(() => {
    copilotSdkRuntimeHooks.loadSdk = originalLoadSdk;
  });

  it("does not let stale poisoned-session callbacks resolve a later runtime turn", async () => {
    const provider = new CopilotSdkProvider();
    await provider.connect({ binaryPath: "copilot" });

    const runtime = new TransportSessionRuntime(
      provider,
      "deck_copilot_runtime_brain",
    );
    const statuses: string[] = [];
    runtime.onStatusChange = (status) => {
      statuses.push(status);
    };
    await runtime.initialize({
      sessionKey: "deck_copilot_runtime_brain",
      cwd: "/tmp/project",
    });

    runtime.send("first turn");
    const oldSession = harness.lastSession();
    oldSession.emit({
      type: "tool.execution_start",
      data: {
        toolCallId: "tool-1",
        toolName: "shell",
        arguments: { mode: "async", command: "sleep 30" },
      },
    });

    await runtime.cancel();
    const rotatedSession = harness.lastSession();
    expect(rotatedSession.sessionId).toBe("copilot-session-2");

    runtime.send("second turn");
    oldSession.emit({
      type: "assistant.message_delta",
      data: { messageId: "stale-msg", deltaContent: "STALE" },
    });
    oldSession.emit({
      type: "assistant.message",
      data: { messageId: "stale-msg", content: "STALE" },
    });
    rotatedSession.emit({
      type: "assistant.message",
      data: { messageId: "fresh-msg", content: "FRESH" },
    });
    rotatedSession.emit({ type: "session.idle", data: {} });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const history = runtime.getHistory();
    expect(history.at(-1)?.content).toBe("FRESH");
    expect(history.some((entry) => String(entry.content) === "STALE")).toBe(
      false,
    );
    expect(runtime.getStatus()).toBe("idle");
    expect(statuses.includes("error")).toBe(false);
  });
});
