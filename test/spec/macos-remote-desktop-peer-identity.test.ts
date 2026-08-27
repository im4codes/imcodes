import { runNativeOrThrow } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

describe('macOS remote-desktop native peer identity', async () => {
  it.skipIf(process.platform !== 'darwin')(
    'compiles the production authority for arm64 and x86_64 with the macOS 13 boundary',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'imcodes-macos-peer-identity-objects-'));
      try {
        for (const architecture of ['arm64', 'x86_64']) {
          for (const source of ['macos_peer_identity.mm', 'macos_peer_verifier_command.mm']) {
            await runNativeOrThrow('xcrun', [
              'clang++',
              '-std=c++20',
              '-fobjc-arc',
              '-Wall',
              '-Wextra',
              '-Werror',
              '-Werror=unguarded-availability-new',
              '-mmacosx-version-min=12.3',
              '-arch', architecture,
              '-I', join(ROOT, 'native/macos-remote-desktop'),
              '-c', join(ROOT, 'native/macos-remote-desktop', source),
              '-o', join(directory, `${source}-${architecture}.o`),
            ], { cwd: directory });
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it.skipIf(process.platform !== 'darwin')(
    'builds the fd-3 verifier command and rejects non-verifier invocations',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'imcodes-macos-peer-verifier-'));
      const output = join(directory, 'peer-verifier');
      try {
        await runNativeOrThrow('xcrun', [
          'clang++',
          '-std=c++20',
          '-fobjc-arc',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-Werror=unguarded-availability-new',
          '-mmacosx-version-min=12.3',
          '-DIMCODES_MACOS_PEER_VERIFIER_STANDALONE',
          '-I', join(ROOT, 'native/macos-remote-desktop'),
          join(ROOT, 'native/macos-remote-desktop/macos_peer_identity.mm'),
          join(ROOT, 'native/macos-remote-desktop/macos_peer_verifier_command.mm'),
          '-framework', 'CoreFoundation',
          '-framework', 'Security',
          '-lbsm',
          '-o', output,
        ], { cwd: directory });
        let exitCode: number | null = null;
        try {
          await runNativeOrThrow(output, [], { cwd: directory });
        } catch (error) {
          exitCode = (error as { status?: number }).status ?? null;
        }
        expect(exitCode).toBe(64);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it.skipIf(process.platform !== 'darwin')(
    'authenticates kernel-owned Unix peer evidence and fails closed on code identity',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'imcodes-macos-peer-identity-'));
      const output = join(directory, 'peer-identity-test');
      try {
        await runNativeOrThrow('xcrun', [
          'clang++',
          '-std=c++20',
          '-fobjc-arc',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-Werror=unguarded-availability-new',
          '-fsanitize=address,undefined',
          '-fno-omit-frame-pointer',
          '-mmacosx-version-min=12.3',
          '-I', join(ROOT, 'native/macos-remote-desktop'),
          join(ROOT, 'native/macos-remote-desktop/macos_peer_identity.mm'),
          join(ROOT, 'test/spec/macos-remote-desktop-peer-identity-test.mm'),
          '-framework', 'CoreFoundation',
          '-framework', 'Security',
          '-lbsm',
          '-o', output,
        ], { cwd: directory });
        await runNativeOrThrow(output, [], {
          cwd: directory,
          env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' },
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it('wires only Darwin kernel credentials and Security.framework identity', async () => {
    const header = readFileSync(
      join(ROOT, 'native/macos-remote-desktop/macos_peer_identity.h'),
      'utf8',
    );
    const source = readFileSync(
      join(ROOT, 'native/macos-remote-desktop/macos_peer_identity.mm'),
      'utf8',
    );
    const build = readFileSync(
      join(ROOT, 'native/macos-remote-desktop/BUILD.gn'),
      'utf8',
    );
    const verifier = readFileSync(
      join(ROOT, 'native/macos-remote-desktop/macos_peer_verifier_command.mm'),
      'utf8',
    );

    for (const kernelBoundary of [
      'getpeereid(',
      'LOCAL_PEERCRED',
      'LOCAL_PEERPID',
      'LOCAL_PEERTOKEN',
    ]) {
      expect(source).toContain(kernelBoundary);
    }
    for (const securityBoundary of [
      'kSecGuestAttributeAudit',
      'SecCodeCopyGuestWithAttributes',
      'SecRequirementCreateWithString',
      'SecCodeCheckValidity',
      'SecCodeCopySigningInformation',
      'SecCodeCopyDesignatedRequirement',
      'SecRequirementCopyData',
    ]) {
      expect(source).toContain(securityBoundary);
    }
    expect(header).toContain('kMacosPeerDesignatedRequirementMaxBytes = 1024');
    expect(header).toContain('kernel socket credentials');
    expect(source).not.toMatch(/JSON|bundleIdentifierFromPeer|teamIdFromPeer/);
    expect(verifier).toContain('kInheritedSocketFd = 3');
    expect(verifier).toContain('AuthenticateMacosRemoteDesktopPeer(socket_fd');
    expect(verifier).not.toMatch(/getenv\(|uidFromJson|pidFromJson/);
    expect(build).toContain('source_set("macos_peer_identity")');
    expect(build).toContain('"Security.framework"');
    expect(build).toContain('libs = [ "bsm" ]');
  });
});
