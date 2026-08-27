import { runNative, type NativeExecResult } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = resolve(ROOT, 'native', 'macos-remote-desktop');
const FIXTURE = resolve(__dirname, 'macos-remote-desktop-slvirtual-display-backend-test.cc');

async function compiler(): Promise<string> {
  for (const candidate of ['clang++', 'g++']) {
    if ((await runNative(candidate, ['--version'])).status === 0) return candidate;
  }
  throw new Error('a C++20 compiler is required');
}

async function compileAndRun(backendSource: string): Promise<ReturnType<typeof spawnSync>> {
  const directory = mkdtempSync(join(tmpdir(), 'imcodes-slvirtual-backend-'));
  try {
    const backend = join(directory, 'macos_slvirtual_display_backend.cc');
    writeFileSync(backend, backendSource);
    const executable = join(directory, 'backend-test');
    const build = await runNative(await compiler(), [
      '-std=c++20', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      '-I', NATIVE,
      backend,
      resolve(NATIVE, 'macos_virtual_display_adapter.cc'),
      resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
      FIXTURE,
      '-o', executable,
    ], {});
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    return await runNative(executable, [], {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const RUNTIME_PROBE_APPENDIX = String.raw`
@interface IMCodesSLApplyEncodingProbe : NSObject
- (BOOL)applySettings:(id)settings error:(NSError**)error;
@end

@implementation IMCodesSLApplyEncodingProbe
- (BOOL)applySettings:(id)settings error:(NSError**)error {
  (void)settings;
  (void)error;
  return YES;
}
@end

namespace {
int g_imcodes_mismatch_destroy_calls = 0;

void ImcodesMismatchDestroy(id object, SEL command) {
  (void)object;
  (void)command;
  ++g_imcodes_mismatch_destroy_calls;
}

BOOL ImcodesApplyEncodingImp(id object, SEL command, id settings,
                             NSError** error) {
  (void)object;
  (void)command;
  (void)settings;
  (void)error;
  return YES;
}
}  // namespace

namespace imcodes::remote_desktop::macos {
extern "C" int ImcodesSLAbiProbe() {
#if defined(__arm64__)
  const char* valid = "B32@0:8@16^@24";
  const char* opposite = "c32@0:8@16^@24";
#elif defined(__x86_64__)
  const char* valid = "c32@0:8@16^@24";
  const char* opposite = "B32@0:8@16^@24";
#else
  return 10;
#endif
  Method emitted = class_getInstanceMethod(
      [IMCodesSLApplyEncodingProbe class],
      sel_registerName("applySettings:error:"));
  if (emitted == nullptr ||
      std::strcmp(method_getTypeEncoding(emitted), valid) != 0)
    return 11;
  if (!ApplySettingsEncodingEquals(emitted))
    return 12;

  Class invalid_class = objc_allocateClassPair(
      [NSObject class], "IMCodesSLInvalidApplyEncodingProbe", 0);
  if (invalid_class == Nil)
    return 13;
  const SEL opposite_selector = sel_registerName("oppositeApply:error:");
  const SEL invalid_selector = sel_registerName("invalidApply:error:");
  if (!class_addMethod(invalid_class, opposite_selector,
                       reinterpret_cast<IMP>(ImcodesApplyEncodingImp),
                       opposite) ||
      !class_addMethod(invalid_class, invalid_selector,
                       reinterpret_cast<IMP>(ImcodesApplyEncodingImp),
                       "i32@0:8@16^@24"))
    return 14;
  objc_registerClassPair(invalid_class);
  if (ApplySettingsEncodingEquals(class_getInstanceMethod(
          invalid_class, opposite_selector)))
    return 15;
  if (ApplySettingsEncodingEquals(class_getInstanceMethod(
          invalid_class, invalid_selector)))
    return 16;
  return 0;
}

extern "C" int ImcodesSLPostInitMismatchProbe() {
  g_imcodes_mismatch_destroy_calls = 0;
  Class probe_class = objc_allocateClassPair(
      [NSObject class], "IMCodesSLPostInitMismatchProbe", 0);
  if (probe_class == Nil)
    return 20;
  const SEL destroy_selector = sel_registerName("destroy");
  if (!class_addMethod(probe_class, destroy_selector,
                       reinterpret_cast<IMP>(ImcodesMismatchDestroy),
                       "v24@0:8"))
    return 21;
  objc_registerClassPair(probe_class);
  __weak id weak_object = nil;
  {
    id object = [[probe_class alloc] init];
    weak_object = object;
    Method mismatch = class_getInstanceMethod(probe_class, destroy_selector);
    if (EncodingEquals(mismatch, "v16@0:8"))
      return 22;
    std::string error;
    if (!HandlePostInitDestroyEncodingMismatch(
            object, mismatch, [] { return true; }, &error))
      return 23;
    if (!error.empty())
      return 24;
    if (g_imcodes_mismatch_destroy_calls != 1)
      return 25;
  }
  if (weak_object != nil)
    return 26;
  return 0;
}
}  // namespace imcodes::remote_desktop::macos
`;

async function buildRuntimeProbe(
  runtimeSource: string,
  arch: 'arm64' | 'x86_64',
  directory: string,
  label: string,
): Promise<{ executable: string; build: NativeExecResult }> {
  const instrumentedRuntime = join(directory, `runtime-${label}-${arch}.mm`);
  const probe = join(directory, `probe-${label}-${arch}.mm`);
  const executable = join(directory, `probe-${label}-${arch}`);
  writeFileSync(instrumentedRuntime, `${runtimeSource}\n${RUNTIME_PROBE_APPENDIX}`);
  writeFileSync(probe, [
    '#include <cstdio>',
    '#include "macos_slvirtual_display_backend.h"',
    'extern "C" int ImcodesSLAbiProbe();',
    'extern "C" int ImcodesSLPostInitMismatchProbe();',
    'int main() {',
    '  const int abi = ImcodesSLAbiProbe();',
    '  if (abi != 0) {',
    '    std::fprintf(stderr, "ABI encoding probe failed: %d\\n", abi);',
    '    return 100 + abi;',
    '  }',
    '  const int cleanup = ImcodesSLPostInitMismatchProbe();',
    '  if (cleanup != 0) {',
    '    std::fprintf(stderr, "post-init mismatch cleanup counterexample failed: %d\\n", cleanup);',
    '    return 150 + cleanup;',
    '  }',
    '  auto backend = imcodes::remote_desktop::macos::CreateSLVirtualDisplayBackend();',
    '  if (backend->ProbeSupport() !=',
    '      imcodes::remote_desktop::common::ReadinessState::kReady) {',
    '    std::fprintf(stderr, "target-host read-only runtime probe failed\\n");',
    '    return 2;',
    '  }',
    '  return 0;',
    '}',
  ].join('\n'));
  const build = await runNative('xcrun', ['clang++',
    '-std=c++20', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
    '-Werror=unguarded-availability-new', '-mmacosx-version-min=12.3',
    '-arch', arch, '-I', NATIVE,
    resolve(NATIVE, 'macos_slvirtual_display_backend.cc'),
    instrumentedRuntime,
    resolve(NATIVE, 'macos_virtual_display_adapter.cc'),
    resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
    probe, '-framework', 'Foundation', '-framework', 'CoreGraphics',
    '-o', executable,
  ], {});
  return { executable, build };
}

async function runArchitecture(
  executable: string,
  arch: 'arm64' | 'x86_64',
): ReturnType<typeof spawnSync> {
  return arch === 'x86_64'
    ? await runNative('arch', ['-x86_64', executable], {})
    : await runNative(executable, [], {});
}

describe('SLVirtualDisplay exact-instance destroy backend', () => {
  const production = readFileSync(
    resolve(NATIVE, 'macos_slvirtual_display_backend.cc'), 'utf8',
  );
  const runtime = readFileSync(
    resolve(NATIVE, 'macos_slvirtual_display_runtime.mm'), 'utf8',
  );

  it('passes exact-instance counterfactuals under ASan and UBSan', async () => {
    const run = await compileAndRun(production);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('exact-instance backend counterfactuals passed');
  }, 180_000);

  it('behaviorally REDs a compile-clean global-availability substitution', async () => {
    const mutant = production.replace(
      '!runtime_->ExactInstanceEndorsesDestroy(candidate)',
      'false /* mutant: trust global availability */',
    );
    expect(mutant).not.toBe(production);
    const run = await compileAndRun(mutant);
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).toContain(
      'exact object without destroy must be refused',
    );
  }, 180_000);

  it('behaviorally REDs deletion of worker-generation binding', async () => {
    const mutant = production.replace(
      'candidate.generation != configuration.worker_generation ||',
      'false /* mutant: accept a different worker generation */ ||',
    );
    expect(mutant).not.toBe(production);
    const run = await compileAndRun(mutant);
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).toContain(
      'mismatched worker generation must be rejected',
    );
  }, 180_000);

  it('behaviorally REDs re-invoking exact destroy on every presence retry', async () => {
    const mutant = production.replace(
      'if (!destroy_invoked_) {',
      '{ /* mutant: invoke destroy on every retry */',
    );
    expect(mutant).not.toBe(production);
    const run = await compileAndRun(mutant);
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).toContain(
      'presence retry must not invoke exact destroy more than once',
    );
  }, 180_000);

  it('behaviorally REDs premature release when active evidence is ignored', async () => {
    const mutant = production.replace(
      '&& !active && !visible)',
      '&& !visible /* mutant: ignore active evidence */)',
    );
    expect(mutant).not.toBe(production);
    const run = await compileAndRun(mutant);
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).toContain(
      'active-only presence must block premature release',
    );
  }, 180_000);

  it('behaviorally REDs premature release when visible evidence is ignored', async () => {
    const mutant = production.replace(
      '&& !active && !visible)',
      '&& !active /* mutant: ignore visible evidence */)',
    );
    expect(mutant).not.toBe(production);
    const run = await compileAndRun(mutant);
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).toContain(
      'visible-only presence must block premature release',
    );
  }, 180_000);

  it('pins the verified OS build, Objective-C encodings and no-CG fallback', async () => {
    expect(runtime).toContain('kVerifiedDarwinBuild[] = "25C56"');
    for (const encoding of [
      '@32@0:8@16^@24', 'I16@0:8', 'v16@0:8',
      '@104@0:8@16Q24Q32Q40{?=ff}48{?=II}56{?={?=ff}{?=ff}{?=ff}{?=ff}}64^@96',
      '@44@0:8{?=II}16{?=II}24f32^@36', '@56@0:8@16@24@32Q40^@48',
    ]) expect(runtime).toContain(encoding);
    expect(runtime).toContain('std::string(@encode(BOOL)) + "32@0:8@16^@24"');
    expect(runtime).toContain('#if !__has_feature(objc_arc)');
    expect(runtime).toContain('requires Objective-C ARC');
    expect(`${production}\n${runtime}`).not.toContain('CGVirtualDisplay');
    expect(`${production}\n${runtime}`).not.toContain(
      'CreateAppleMacosVirtualDisplayBackend',
    );
  });

  it.skipIf(process.platform !== 'darwin')(
    'executes both ABI contracts and the post-init cleanup probe without creating a display',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'imcodes-slvirtual-runtime-'));
      try {
        for (const arch of ['arm64', 'x86_64'] as const) {
          const { executable, build } = await buildRuntimeProbe(
            runtime, arch, directory, 'baseline',
          );
          expect(build.status, `${arch}\n${build.stdout}\n${build.stderr}`).toBe(0);
          const run = await runArchitecture(executable, arch);
          expect(run.status, `${arch}\n${run.stdout}\n${run.stderr}`).toBe(0);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(process.platform !== 'darwin')(
    'behaviorally REDs a compile-clean bare post-init mismatch return',
    async () => {
      const mutant = runtime.replace(
        [
          '  return CleanupPostInitEncodingMismatch(object, method, removal_verified,',
          '                                         error);',
        ].join('\n'),
        [
          '  if (object == nil && method == nullptr && error == nullptr)',
          '    return CleanupPostInitEncodingMismatch(',
          '        object, method, removal_verified, error);',
          '  (void)object;',
          '  (void)method;',
          '  (void)removal_verified;',
          '  (void)error;',
          '  return false; /* mutant: former bare post-init return */',
        ].join('\n'),
      );
      expect(mutant).not.toBe(runtime);
      const directory = mkdtempSync(join(tmpdir(), 'imcodes-slvirtual-bare-mutant-'));
      try {
        const { executable, build } = await buildRuntimeProbe(
          mutant, 'arm64', directory, 'bare-mutant',
        );
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
        const run = await runArchitecture(executable, 'arm64');
        expect(run.status).not.toBe(0);
        expect(`${run.stdout}\n${run.stderr}`).toContain(
          'post-init mismatch cleanup counterexample failed',
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(process.platform !== 'darwin')(
    'behaviorally REDs the compile-clean B-only x86_64 ABI mutant',
    async () => {
      const mutant = runtime.replace(
        'return std::string(@encode(BOOL)) + "32@0:8@16^@24";',
        'return std::string("B") + "32@0:8@16^@24";',
      );
      expect(mutant).not.toBe(runtime);
      const directory = mkdtempSync(join(tmpdir(), 'imcodes-slvirtual-b-mutant-'));
      try {
        const { executable, build } = await buildRuntimeProbe(
          mutant, 'x86_64', directory, 'b-only-mutant',
        );
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
        const run = await runArchitecture(executable, 'x86_64');
        expect(run.status).not.toBe(0);
        expect(`${run.stdout}\n${run.stderr}`).toContain(
          'ABI encoding probe failed',
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(process.platform !== 'darwin')(
    'fails compilation when the owned runtime is built without ARC',
    async () => {
      const build = await runNative('xcrun', ['clang++',
        '-std=c++20', '-fsyntax-only', '-Wall', '-Wextra', '-Werror',
        '-mmacosx-version-min=12.3', '-arch', process.arch,
        '-I', NATIVE,
        resolve(NATIVE, 'macos_slvirtual_display_runtime.mm'),
      ], {});
      expect(build.status).not.toBe(0);
      expect(`${build.stdout}\n${build.stderr}`).toContain(
        'macos_slvirtual_display_runtime.mm requires Objective-C ARC',
      );
    },
  );
});
