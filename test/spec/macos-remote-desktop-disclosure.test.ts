import { runNative } from './support/native-exec.js';
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("macOS non-requester-controlled local disclosure", () => {
  const header = read("native/macos-remote-desktop/macos_local_disclosure.h");
  const implementation = read(
    "native/macos-remote-desktop/macos_local_disclosure.mm",
  );
  const main = read(
    "native/macos-remote-desktop/macos_remote_desktop_disclosure_main.mm",
  );
  const build = read("native/macos-remote-desktop/BUILD.gn");

  it("implements the common adapter without exposing AppKit in the public seam", async () => {
    expect(header).toContain("public common::DisclosureAdapter");
    expect(header).toContain("class Impl;");
    expect(header).toContain("std::unique_ptr<Impl> impl_");
    expect(header).not.toMatch(
      /#import|NSWindow|NSButton|NSTextField|NSString/,
    );
    expect(implementation).toContain("#import <AppKit/AppKit.h>");
    expect(implementation).toMatch(
      /Run(?:Readiness|Bool|Void)OnMainThreadSync/,
    );
    expect(implementation).toContain("dispatch_get_main_queue()");
    expect(build).toContain('source_set("macos_local_disclosure")');
    expect(build).toContain('"macos_local_disclosure.mm"');
    expect(build).toContain('"AppKit.framework"');
  });

  it("renders only stable aiDesk.to by IM.codes copy plus bounded participant counts", async () => {
    expect(implementation).toContain('@"aiDesk.to by IM.codes"');
    expect(implementation).toContain('@"aiDesk.to remote desktop is active"');
    expect(implementation).toContain('@"Viewers: %u"');
    expect(implementation).toContain('@"Controllers: %u"');
    expect(implementation).toContain('@"Stop"');
    expect(header).toContain("kMacosDisclosureMaxViewers = 64");
    expect(header).toContain("kMacosDisclosureMaxControllers = 64");
    expect(header).not.toMatch(
      /requester|requester_name|session_name|remote_text/i,
    );
    expect(implementation).not.toMatch(
      /setTitleWithRepresentedFilename|representedURL|requester_name|session_name|remote_text/i,
    );
  });

  it("makes visibility a readiness prerequisite and fences every failure by generation", async () => {
    expect(implementation).toContain("!state_->visible");
    expect(implementation).toContain("backend_->ProbeReadiness()");
    expect(implementation).toContain("state->generation != generation");
    expect(implementation).toContain("state->stop_dispatched");
    expect(implementation).toContain("MacosDisclosureEvent::kWindowClosed");
    expect(implementation).toContain("MacosDisclosureEvent::kWindowFailed");
    expect(implementation).toContain("ReportProcessCrash");
    expect(implementation).not.toMatch(/approve|allowRemoteHide|remoteStop/);
  });

  it("runs the production startup seam in Show-before-readiness order", async () => {
    const startup = implementation.slice(
      implementation.indexOf("DisclosureStartupOutcome RunDisclosureStartup("),
    );
    const beginAt = startup.indexOf("adapter.BeginSession(generation)");
    const showAt = startup.indexOf("adapter.Show(viewers, controllers)");
    const visibleAt = startup.indexOf("adapter.IsVisible()");
    const readinessAt = startup.indexOf("adapter.ProbeReadiness()");
    expect(beginAt).toBeGreaterThanOrEqual(0);
    expect(showAt).toBeGreaterThan(beginAt);
    expect(visibleAt).toBeGreaterThan(showAt);
    expect(readinessAt).toBeGreaterThan(visibleAt);

    expect(main).toContain("macos::RunDisclosureStartup(");
    expect(main).not.toContain("adapter.ProbeReadiness()");
    expect(main).not.toContain("adapter.Show(viewers, controllers)");
    const productionStartupAt = main.indexOf("macos::RunDisclosureStartup(");
    const processAt = main.indexOf(
      "macos::RunDisclosureProcessAfterStartup(",
    );
    expect(processAt).toBeGreaterThan(productionStartupAt);
  });

  it("uses the visible production startup for probe-only and then hides it", async () => {
    const process = implementation.slice(
      implementation.indexOf("int RunDisclosureProcessAfterStartup("),
    );
    const probeBranch = process.match(
      /if \(probe_only\) \{([\s\S]*?)return EX_OK;/,
    )?.[1];
    expect(probeBranch).toBeDefined();
    expect(probeBranch).toContain("callbacks.report_probe_success");
    expect(probeBranch).toContain("adapter.Hide()");
    expect(probeBranch).not.toContain("ProbeReadiness");
  });

  it("compiles production Objective-C++ for macOS 13 arm64 and x86_64", async () => {
    if (process.platform !== "darwin") return;

    const directory = mkdtempSync(
      resolve(tmpdir(), "imcodes-macos-disclosure-obj-"),
    );
    try {
      for (const architecture of ["arm64", "x86_64"]) {
        const object = resolve(directory, `disclosure-${architecture}.o`);
        const compile = await runNative(
          "xcrun",
          [
            "clang++",
            "-std=c++20",
            "-fobjc-arc",
            "-fblocks",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-Wunguarded-availability-new",
            "-mmacosx-version-min=12.3",
            "-arch",
            architecture,
            "-I",
            resolve(ROOT, "native/macos-remote-desktop"),
            "-I",
            resolve(ROOT, "native/remote-desktop-common"),
            "-c",
            resolve(
              ROOT,
              "native/macos-remote-desktop/macos_local_disclosure.mm",
            ),
            "-o",
            object,
          ],
          { encoding: "utf8" },
        );
        expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs readiness, Stop, close, crash, bounds and stale-generation fakes", async () => {
    if (process.platform !== "darwin") return;

    const directory = mkdtempSync(
      resolve(tmpdir(), "imcodes-macos-disclosure-test-"),
    );
    const executable = resolve(directory, "disclosure-test");
    try {
      const compile = await runNative(
        "xcrun",
        [
          "clang++",
          "-std=c++20",
          "-fobjc-arc",
          "-fblocks",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-Wunguarded-availability-new",
          "-fsanitize=address,undefined",
          "-fno-omit-frame-pointer",
          "-mmacosx-version-min=12.3",
          "-I",
          resolve(ROOT, "native/macos-remote-desktop"),
          "-I",
          resolve(ROOT, "native/remote-desktop-common"),
          resolve(ROOT, "test/spec/macos-remote-desktop-disclosure-test.mm"),
          resolve(
            ROOT,
            "native/macos-remote-desktop/macos_local_disclosure.mm",
          ),
          "-framework",
          "AppKit",
          "-framework",
          "Foundation",
          "-o",
          executable,
        ],
        { encoding: "utf8" },
      );
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);

      const run = await runNative(executable, [], {
        encoding: "utf8",
        env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
      });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain("local disclosure adapter tests passed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
