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

  // An incremental authority envelope may omit route fields. Every handler that
  // checks one must first bind the omitted fields from the current authority,
  // then check and act on the BOUND value -- never on the raw envelope.
  //
  // This used to pin a global occurrence count per file. The macOS worker then
  // gained legitimate offer/ICE/stop paths and the count went from 2 to 5, which
  // failed CI while proving nothing: a count also passes when one path drops its
  // binding and an unrelated call site is added. The rule is stated per path
  // instead, over every Authority-taking method that calls Matches(), plus the
  // named paths that must exist.
  it("binds incremental lease and mode envelopes before platform authority checks", () => {
    type Method = { name: string; param: string; body: string };
    const methodsTakingAuthority = (text: string): Method[] => {
      const methods: Method[] = [];
      const signature = /(?:^|\n)[ \t]*(?:\[\[nodiscard\]\][ \t]+)?[\w:<>]+[ \t]+((?:\w+::)*\w+)\(([^;{}()]*(?:\([^()]*\)[^;{}()]*)*)\)[^;{}]*\{/g;
      for (let match = signature.exec(text); match; match = signature.exec(text)) {
        const param = /const (?:imcodes::rd::)?Authority& (\w+)/.exec(match[2])?.[1];
        if (!param) continue;
        const open = match.index + match[0].length - 1;
        let depth = 0;
        let end = open;
        for (let index = open; index < text.length; index++) {
          const character = text[index];
          if (character === "/" && text[index + 1] === "/") { index = text.indexOf("\n", index); if (index < 0) break; continue; }
          if (character === "/" && text[index + 1] === "*") { index = text.indexOf("*/", index + 2) + 1; continue; }
          if (character === '"' || character === "'") {
            for (index += 1; index < text.length && text[index] !== character; index++) if (text[index] === "\\") index++;
            continue;
          }
          if (character === "{") depth++;
          if (character === "}" && --depth === 0) { end = index; break; }
        }
        methods.push({ name: match[1].split("::").pop()!, param, body: text.slice(open, end + 1) });
      }
      return methods;
    };
    const checksAuthority = (body: string) => /(?<![\w])Matches\(/.test(body);
    const bindingOf = (method: Method) => new RegExp(
      `(?:const (?:imcodes::rd::)?Authority (\\w+)\\s*=\\s*)?(?:imcodes::rd::)?BindOmittedAuthorityFields\\(authority_, ${method.param}\\)`,
    ).exec(method.body);

    const files = { windows: readFileSync(WINDOWS_PEER, "utf8"), macos: readFileSync(MACOS_WORKER, "utf8") };
    // The paths that must bind today. A new path is covered by the class rule
    // below without editing this table; removing or unbinding one of these fails.
    const intended: Record<keyof typeof files, Record<string, RegExp>> = {
      windows: {
        Renew: /transport_core_\.RenewLease\(/,
        SetMode: /transport_core_\.UpdateMode\(/,
      },
      macos: {
        NegotiateOffer: /session_->NegotiateOffer\(/,
        AddRemoteIce: /session_->AddRemoteIceCandidate\(/,
        RenewLease: /session_->RenewRouteAuthority\(/,
        SetMode: /session_->ApplyModeAuthority\(/,
        Stop: /session_->Stop\(\)/,
      },
    };

    for (const platform of Object.keys(files) as Array<keyof typeof files>) {
      const methods = methodsTakingAuthority(files[platform]).filter((method) => method.name !== "Matches");
      const checked = methods.filter((method) => checksAuthority(method.body));

      // Class rule: every authority-checking handler binds first and never uses the raw envelope.
      for (const method of checked) {
        const where = `${platform} ${method.name}(${method.param})`;
        const binding = bindingOf(method);
        expect(binding, `${where} must bind omitted authority fields`).not.toBeNull();
        // What the first check actually receives: the bound variable, or the
        // binding call itself inline (evaluated before the check either way).
        const firstCheck = method.body.search(/(?<![\w])Matches\(/);
        const argumentStart = method.body.indexOf("(", firstCheck) + 1;
        let depth = 1;
        let argumentEnd = argumentStart;
        while (argumentEnd < method.body.length && depth > 0) {
          if (method.body[argumentEnd] === "(") depth++;
          if (method.body[argumentEnd] === ")") depth--;
          argumentEnd++;
        }
        const checkedValue = method.body.slice(argumentStart, argumentEnd - 1).trim();
        const inlineBinding = new RegExp(`^(?:imcodes::rd::)?BindOmittedAuthorityFields\\(authority_, ${method.param}\\)$`);
        const checksBound = inlineBinding.test(checkedValue)
          || (!!binding![1] && checkedValue === binding![1] && binding!.index < firstCheck);
        expect(checksBound, `${where} must check the bound authority, got Matches(${checkedValue})`).toBe(true);
        expect(method.body, `${where} must not check the raw envelope`)
          .not.toMatch(new RegExp(`(?<![\\w])Matches\\(${method.param}\\)`));
        expect(method.body, `${where} must not hand the raw envelope to the platform`)
          .not.toMatch(new RegExp(`CommonAuthority\\(${method.param}\\)`));
      }

      // Every intended path exists, binds, and checks before its platform action.
      for (const [name, action] of Object.entries(intended[platform])) {
        const method = checked.find((candidate) => candidate.name === name);
        expect(method, `${platform} ${name} must check a bound authority envelope`).toBeDefined();
        const firstCheck = method!.body.search(/(?<![\w])Matches\(/);
        const actionAt = method!.body.search(action);
        expect(actionAt, `${platform} ${name} must still perform its platform action`).toBeGreaterThan(-1);
        expect(firstCheck, `${platform} ${name} must check authority before acting`).toBeLessThan(actionAt);
      }
    }
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
