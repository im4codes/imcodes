import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MACOS_LIBWEBRTC_NOTICE_TARGETS,
  validateMacosLibwebrtcNotices,
} from '../../scripts/libwebrtc-sdk-artifacts.mjs';
import { PINNED_LIBWEBRTC_REVISION } from '../../shared/remote-desktop-native-pins.js';

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '../..');
const generator = join(repositoryRoot, 'scripts/generate-macos-libwebrtc-notices.py');
const roots: string[] = [];

async function fixture(dependency = '//third_party/example:example') {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-macos-notices-'));
  roots.push(root);
  const webrtc = join(root, 'webrtc');
  const build = join(webrtc, 'out/release');
  const gn = join(root, 'gn');
  const output = join(root, 'THIRD_PARTY_NOTICES.webrtc.md');
  await mkdir(join(webrtc, 'tools_webrtc/libs'), { recursive: true });
  await mkdir(join(webrtc, 'third_party/example'), { recursive: true });
  await mkdir(build, { recursive: true });
  await Promise.all([
    writeFile(join(webrtc, 'LICENSE'), 'WebRTC license\n'),
    writeFile(join(webrtc, 'third_party/example/LICENSE'), 'Example license\n'),
    writeFile(join(webrtc, 'tools_webrtc/libs/generate_licenses.py'), [
      "LIB_TO_LICENSES_DICT = {'example': ['third_party/example/LICENSE']}",
      'LIB_REGEX_TO_LICENSES_DICT = {}',
      '',
    ].join('\n')),
    writeFile(gn, `#!/bin/sh\nprintf '%s\\n' '${dependency}' '//third_party/imcodes_macos_remote_desktop:owned' '//third_party/remote-desktop-common:owned'\n`),
  ]);
  await chmod(gn, 0o755);
  return { root, webrtc, build, gn, output };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('macOS pinned libwebrtc notices', () => {
  it('renders a deterministic inventory from all three production target graphs', async () => {
    const value = await fixture();
    await execute('python3', [
      generator,
      '--webrtc-root', value.webrtc,
      '--build-directory', value.build,
      '--gn', value.gn,
      '--revision', PINNED_LIBWEBRTC_REVISION,
      ...MACOS_LIBWEBRTC_NOTICE_TARGETS.flatMap((target) => ['--target', target]),
      '--output', value.output,
    ]);
    const notices = await readFile(value.output, 'utf8');
    expect(validateMacosLibwebrtcNotices(notices, PINNED_LIBWEBRTC_REVISION)).toBe(notices);
    expect(notices).toContain('libraries=webrtc,example');
    expect(notices).not.toContain('# imcodes_macos_remote_desktop');
  });

  it('fails closed on an unmapped linked tree and publishes no partial file', async () => {
    const value = await fixture('//third_party/unmapped:unmapped');
    await expect(execute('python3', [
      generator,
      '--webrtc-root', value.webrtc,
      '--build-directory', value.build,
      '--gn', value.gn,
      '--revision', PINNED_LIBWEBRTC_REVISION,
      ...MACOS_LIBWEBRTC_NOTICE_TARGETS.flatMap((target) => ['--target', target]),
      '--output', value.output,
    ])).rejects.toThrow(/no license mapping/u);
    await expect(readFile(value.output)).rejects.toThrow();
  });

  it('merges architecture inventories as a deterministic union and rejects conflicts', async () => {
    const value = await fixture();
    const args = [
      generator,
      '--webrtc-root', value.webrtc,
      '--build-directory', value.build,
      '--gn', value.gn,
      '--revision', PINNED_LIBWEBRTC_REVISION,
      ...MACOS_LIBWEBRTC_NOTICE_TARGETS.flatMap((target) => ['--target', target]),
      '--output', value.output,
    ];
    await execute('python3', args);
    const arm = await readFile(value.output, 'utf8');
    const x64 = join(value.root, 'x64.md');
    const merged = join(value.root, 'merged.md');
    await writeFile(x64, arm
      .replace('libraries=webrtc,example', 'libraries=webrtc,example,nasm')
      .concat('# nasm\n```\nNASM license\n```\n'));
    await execute('python3', [
      generator,
      '--merge-input', value.output,
      '--merge-input', x64,
      '--output', merged,
    ]);
    const notices = await readFile(merged, 'utf8');
    expect(validateMacosLibwebrtcNotices(notices, PINNED_LIBWEBRTC_REVISION)).toBe(notices);
    expect(notices).toContain('libraries=webrtc,example,nasm');

    await writeFile(x64, (await readFile(x64, 'utf8')).replace('Example license', 'conflict'));
    await expect(execute('python3', [
      generator,
      '--merge-input', value.output,
      '--merge-input', x64,
      '--output', merged,
    ])).rejects.toThrow(/conflicting license text/u);
  });

  it('keeps notice generation in the native build gate', async () => {
    const script = await readFile(join(repositoryRoot, 'scripts/macos-remote-desktop-build-spike.sh'), 'utf8');
    expect(script).toContain('generate-macos-libwebrtc-notices.py');
    expect(script).toContain('THIRD_PARTY_NOTICES.webrtc.md');
    for (const target of MACOS_LIBWEBRTC_NOTICE_TARGETS) {
      expect(script).toContain(target.slice(2));
    }
  });
});
