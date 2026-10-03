import { runNative } from './support/native-exec.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = 'native/macos-remote-desktop';
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

/**
 * Runs a compile WITHOUT blocking the worker thread.
 *
 * `spawnSync` holds the event loop for the whole compile. Roughly thirty of
 * them back to back kept a vitest worker from answering its own `onTaskUpdate`
 * RPC, and the run failed with an internal timeout while every test passed --
 * which reads exactly like a real failure and is not one.
 */
async function runTool(
  command: string, args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveRun) => {
    const child = spawn(command, [...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', (error) => resolveRun({ status: 1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolveRun({ status: code, stdout, stderr }));
  });
}

/**
 * Cross-architecture compilation of the virtual-display target.
 *
 * Split out of the authority spec because it is the expensive half: about
 * thirty compiles, two architectures over every source in the GN target. The
 * other file owns the sanitizer and runtime suites, which share one set of
 * pre-built objects; keeping the two together meant one file ran ~67s and
 * starved the worker's RPC.
 *
 * The source list is still DERIVED FROM BUILD.gn here, not copied from there
 * or from the sibling spec -- a duplicated list is stale in the silent
 * direction the moment a source is added.
 */
describe('macOS virtual-display cross-architecture build', () => {
  const build = read(`${NATIVE}/BUILD.gn`);
  const directory = process.platform === 'darwin'
    ? mkdtempSync(resolve(tmpdir(), 'aidesk-vd-cross-arch-'))
    : null;

  afterAll(async () => {
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
  });

  it('compiles every virtual-display source in the GN target for both arches', async () => {
    if (process.platform !== 'darwin') return;
    // ENUMERATED FROM BUILD.gn, not listed here.
    //
    // A hardcoded list is stale the moment a source is added, and stale in the
    // silent direction: the new file simply is not covered, and the test goes
    // on passing. Deriving the list from the GN target means a source cannot
    // enter the build without entering this check.
    const target = build.match(
      /source_set\("macos_virtual_display_authority"\)\s*\{[\s\S]*?sources\s*=\s*\[([\s\S]*?)\]/u,
    );
    expect(target, 'could not find the authority source_set in BUILD.gn').not.toBeNull();
    const sources = [...target![1].matchAll(/"([^"]+\.(?:cc|mm))"/gu)].map((m) => m[1]);
    // A guard on the guard: a regex that silently matched nothing would make
    // this test vacuous, which is the same failure it exists to prevent.
    expect(sources.length).toBeGreaterThanOrEqual(12);
    expect(sources).toContain('macos_virtual_display_control_server.cc');
    expect(sources).toContain('macos_virtual_display_resident.cc');

    for (const architecture of ['arm64', 'x86_64'] as const) {
      for (const source of sources) {
        const language = source.endsWith('.mm') ? 'objective-c++' : 'c++';
        const output = resolve(directory!, `${architecture}-${source.replace(/\W/gu, '_')}.o`);
        const compile = await runTool('xcrun', [
          'clang++', '-std=c++20', '-Wall', '-Wextra', '-Werror',
          '-mmacosx-version-min=12.3', '-arch', architecture,
          ...(language === 'objective-c++' ? ['-fobjc-arc'] : []),
          '-I', resolve(ROOT, NATIVE),
          '-I', ROOT,
          '-I', resolve(ROOT, 'native/remote-desktop-common'),
          '-c', resolve(ROOT, `${NATIVE}/${source}`), '-o', output,
        ]);
        expect(compile.status,
          `${architecture}/${source}: ${compile.stdout}\n${compile.stderr}`).toBe(0);
      }
    }
  }, 600_000);

  it('proves no private symbol is referenced at link time', async () => {
    if (process.platform !== 'darwin') return;
    const object = resolve(directory!, 'skylight-linkcheck.o');
    const compile = await runTool('xcrun', [
      'clang++', '-std=c++20', '-Werror', '-mmacosx-version-min=12.3',
      '-arch', 'arm64', '-fobjc-arc',
      '-I', resolve(ROOT, NATIVE),
      '-I', resolve(ROOT, 'native/remote-desktop-common'),
      '-c', resolve(ROOT, `${NATIVE}/macos_virtual_display_skylight_runtime.mm`), '-o', object,
    ]);
    expect(compile.status, compile.stderr).toBe(0);
    const undefinedSymbols = await runTool('nm', ['-u', object]);
    expect(undefinedSymbols.status).toBe(0);
    // If any of these appeared, the binary would carry a hard dependency on a
    // private symbol and would fail to launch when Apple moves it.
    expect(undefinedSymbols.stdout).not.toMatch(/_SLS[A-Za-z]/);
    expect(undefinedSymbols.stdout).not.toMatch(/_CGSConfigureDisplayEnabled/);
    expect(undefinedSymbols.stdout).not.toMatch(/_CGSGetDisplayList/);
    expect(undefinedSymbols.stdout).toMatch(/_dlsym/);
  }, 120_000);});
