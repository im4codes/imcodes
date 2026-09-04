import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMMON = resolve(ROOT, "native", "remote-desktop-common");
const WINDOWS_PEER = resolve(ROOT, "native", "windows-remote-desktop", "peer_session.cc");
const MACOS_WORKER = resolve(ROOT, "native", "macos-remote-desktop", "macos_remote_desktop_worker_main.mm");
const COUNTERFACTUAL = resolve(
  ROOT,
  "test",
  "spec",
  "remote-desktop-common-transport-session-core.cc",
);

const SANITIZER_FLAGS = [
  "-fsanitize=address,undefined",
  "-fno-omit-frame-pointer",
];

function source(name: string): string {
  return readFileSync(resolve(COMMON, name), "utf8");
}

async function findCompiler(): Promise<string> {
  for (const candidate of [process.env.CXX, "clang++", "c++", "g++"]) {
    if (!candidate) continue;
    const probe = await runNative(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("A C++20 compiler is required for the transport core test");
}

describe("remote-desktop common transport/session core contract", () => {
  it("is a public production source in the common GN target", async () => {
    const build = source("BUILD.gn");
    for (const file of [
      "transport_session_core.h",
      "transport_session_core.cc",
    ]) {
      expect(build).toContain(`"${file}"`);
    }
    expect(build).toMatch(
      /public\s*=\s*\[[\s\S]*"transport_session_core\.h"[\s\S]*\]/,
    );
  });

  it("keeps platform and libwebrtc types behind the narrow adapter seam", async () => {
    const implementation = [
      source("transport_session_core.h"),
      source("transport_session_core.cc"),
    ].join("\n");
    for (const token of [
      "windows.h",
      "DXGI",
      "MediaFoundation",
      "AppKit",
      "ScreenCaptureKit",
      "VideoToolbox",
      "CoreGraphics",
      "webrtc::",
      "rtc::",
      "_WIN32",
      "__APPLE__",
    ]) {
      expect(implementation, `${token} remains adapter-owned`).not.toContain(
        token,
      );
    }
    expect(implementation).toContain("class TransportSessionAdapter");
    expect(implementation).toMatch(
      /TransportSessionAdapter& adapter,\s+const QualityLadder& quality_ladder/,
    );
    expect(implementation).toContain("struct TransportTime");
    expect(implementation).toContain("negotiated_capability_binding");
    expect(implementation).not.toContain("capability_profile_hash");
    expect(implementation).not.toContain("now_ms");
    for (const operation of [
      "Start",
      "RenewLease",
      "UpdateMode",
      "OnPeerConnectionState",
      "RecordActivity",
      "RecordMediaProgress",
      "ResetMediaProgress",
      "Tick",
    ]) {
      expect(
        source("transport_session_core.h"),
        `${operation} must accept the explicit dual clock`,
      ).toMatch(new RegExp(`${operation}\\([^;]*TransportTime now\\);`));
    }
  });

  it("does not change the existing SessionCore public API", async () => {
    const sessionHeader = source("session_core.h");
    expect(sessionHeader).not.toContain("TransportSessionCore");
    expect(sessionHeader).toContain(
      "explicit SessionCore(PlatformAdapters adapters);",
    );
    expect(sessionHeader).toContain(
      "bool Start(CapabilityReadiness readiness, DesktopTopology topology);",
    );
  });

  it("binds incremental lease and mode envelopes before platform authority checks", () => {
    const windows = readFileSync(WINDOWS_PEER, "utf8");
    const macos = readFileSync(MACOS_WORKER, "utf8");
    expect(windows.match(/BindOmittedAuthorityFields\(authority_, (?:renewal|update)\)/g) ?? [])
      .toHaveLength(2);
    expect(macos.match(/BindOmittedAuthorityFields\(authority_, authority\)/g) ?? [])
      .toHaveLength(2);
  });

  it("pins every requested executable counterfactual", async () => {
    const counterfactual = readFileSync(COUNTERFACTUAL, "utf8").replace(
      /"\s*"/g,
      "",
    );
    for (const assertion of [
      "stale generation renewal cannot extend route authority",
      "non-increasing renewal is rejected",
      "matching increasing renewal extends the lease",
      "incremental authority inherits only omitted route fields",
      "incremental authority never overwrites explicit route changes",
      "lease wire omission inherits the bound absolute route expiry",
      "renewal cannot mutate the bound absolute route expiry",
      "renewal lease cannot outlive absolute route authority",
      "negotiated capability binding fences renewal authority",
      "expired authority cannot be revived by a late renewal",
      "absolute authority expiry cannot precede its renewable lease",
      "first libwebrtc callback may report new before connecting and connected",
      "stale callback generation cannot connect a replacement route",
      "caller limits cannot exceed the compiled hard bounds",
      "remote ICE remains bounded before remote description",
      "local ICE remains bounded before signaling emission is ready",
      "candidate overflow terminates and erases queued material",
      "local candidate overflow is bounded and terminal",
      "required channel failure is terminal",
      "terminal cleanup orders authority release before channels and transport",
      "transport close and terminal callback happen exactly once",
      "peer lifecycle cannot regress to new and bypass watchdog state",
      "failed peer releases input but stays alive for ICE restart",
      "failed peer can recover in place through connecting",
      "an explicit peer close remains terminal after recovery",
      "control downgrade releases the previous input epoch",
      "same-mode rekey releases every input owned by the old epoch",
      "duplicate rekey is idempotent and does not release twice",
      "same-mode rekey cannot skip an input authority generation",
      "mode update cannot mutate absolute route expiry before release",
      "wall-clock jumps and duplicate callbacks cannot postpone a real media stall",
      "a static source never trips the media watchdog across wall-clock jumps",
      "static desktop remains live while capture is not advancing",
      "explicit media reset admits fresh monotonic counters after track replacement",
      "media counter regression fails closed instead of resetting watchdogs",
      "monotonic clock regression fails closed with one cleanup",
      "absolute route expiry wins over lease expiry at the same Unix deadline",
      "renewable lease expiry remains distinct from absolute authority expiry",
      "direct transport status is owned by the common core",
      "relay transport status replaces direct status",
      "quality target and selected diagnostics use the shared ladder seam",
      "wall-clock forward jump does not expire the idle watchdog",
      "wall-clock rollback does not postpone the monotonic idle watchdog",
    ]) {
      expect(counterfactual).toContain(assertion);
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "remote-desktop common transport/session executable",
  async () => {
    it("passes all counterfactuals under ASan and UBSan", async () => {
      const compiler = await findCompiler();
      const temp = mkdtempSync(resolve(tmpdir(), "imcodes-rd-transport-"));
      const executable = resolve(temp, "transport-session-core");
      try {
        const compile = await runNative(
          compiler,
          [
            "-std=c++20",
            ...SANITIZER_FLAGS,
            "-Wall",
            "-Wextra",
            "-Werror",
            "-pedantic",
            "-I",
            COMMON,
            resolve(COMMON, "value_types.cc"),
            resolve(COMMON, "transport_session_core.cc"),
            COUNTERFACTUAL,
            "-o",
            executable,
          ],
          { encoding: "utf8" },
        );
        expect(
          compile.status,
          `sanitized native compile failed\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`,
        ).toBe(0);

        const run = await runNative(executable, [], {
          encoding: "utf8",
          env: {
            ...process.env,
            ASAN_OPTIONS: "halt_on_error=1:abort_on_error=1",
            UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
          },
        });
        expect(
          run.status,
          `sanitized transport counterfactual failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        ).toBe(0);
        expect(run.stdout).toContain(
          "remote-desktop common transport counterfactuals passed",
        );
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
  },
);
