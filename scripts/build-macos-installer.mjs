#!/usr/bin/env node
/**
 * Build unified macOS `.pkg` Desktop 3-in-1 installer using `pkgbuild` + `productbuild`.
 *
 * Preserves signed `aiDesk.to by IM.codes.app` seal untouched (`BundleIsRelocatable=false`),
 * installs read-only `daemon-runtime/releases/<ver>` + optional `imcodes-node` + LaunchDaemons,
 * runs shared Phase A compatibility `preinstall`/`postinstall` (including Scenario 3 dev exemption
 * and Scenario 4 `LaunchAgent` `ProgramArguments[0]` FDA preservation), and integrates with
 * `macos-release-signing.mjs` for `productsign` + `notarytool` + `stapler`.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { parseDaemonRuntimeTarget } from './daemon-runtime-artifacts.mjs';
import {
  loadDesktopCompatibilityModule,
  REPO_ROOT,
  renderMacosControlledNodeLaunchDaemonPlist,
  renderPosixPhaseARunnerScript,
  resolveDesktopInstallerVersion,
  stageDaemonRuntimePayload,
  writeDesktopInstallerManifest,
} from './desktop-installer-shared.mjs';
import { signInstallerPackage } from './macos-release-signing.mjs';

export function renderMacosAppComponentPlist(appRelativePath = 'Applications/aiDesk.to by IM.codes.app') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>BundleHasStrictIdentifier</key>
    <true/>
    <key>BundleIsRelocatable</key>
    <false/>
    <key>BundleIsVersionChecked</key>
    <false/>
    <key>BundleOverwriteAction</key>
    <string>upgrade</string>
    <key>RootRelativeBundlePath</key>
    <string>${appRelativePath}</string>
  </dict>
</array>
</plist>
`;
}

export function renderMacosDistributionXml({
  version,
  arch,
  runtimePkgFilename,
  appPkgFilename,
}) {
  const pkgs = [`  <pkg-ref id="to.aidesk.desktop.runtime"/>`];
  const choices = [
    `  <choice id="to.aidesk.desktop.runtime" visible="false">`,
    `    <pkg-ref id="to.aidesk.desktop.runtime"/>`,
    `  </choice>`,
  ];
  const outline = [`    <line choice="to.aidesk.desktop.runtime"/>`];
  const pkgRefs = [
    `  <pkg-ref id="to.aidesk.desktop.runtime" version="${version}" onConclusion="none">${runtimePkgFilename}</pkg-ref>`,
  ];

  if (appPkgFilename) {
    pkgs.push(`  <pkg-ref id="to.aidesk.app"/>`);
    choices.push(
      `  <choice id="to.aidesk.app" visible="false">`,
      `    <pkg-ref id="to.aidesk.app"/>`,
      `  </choice>`,
    );
    outline.unshift(`    <line choice="to.aidesk.app"/>`);
    pkgRefs.push(
      `  <pkg-ref id="to.aidesk.app" version="${version}" onConclusion="none">${appPkgFilename}</pkg-ref>`,
    );
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>aiDesk.to by IM.codes (${version} ${arch})</title>
  <options customize="never" require-scripts="false" hostArchitectures="${arch === 'arm64' ? 'arm64' : 'x86_64'}"/>
  <domains enable_localSystem="true" enable_currentUserHome="false"/>
  <choices-outline>
${outline.join('\n')}
  </choices-outline>
${choices.join('\n')}
${pkgRefs.join('\n')}
</installer-gui-script>
`;
}

function copyBundlePreservingSeal(srcApp, destApp) {
  mkdirSync(join(destApp, '..'), { recursive: true });
  if (process.platform === 'darwin' && existsSync('/usr/bin/ditto')) {
    execFileSync('/usr/bin/ditto', [srcApp, destApp], { stdio: 'inherit' });
    return;
  }
  cpSync(srcApp, destApp, { recursive: true, dereference: false });
}

export async function stageMacosInstallerTree(options) {
  const arch = options.arch === 'x64' ? 'x64' : 'arm64';
  const targetInfo = parseDaemonRuntimeTarget('darwin', arch);
  const version = resolveDesktopInstallerVersion(options.version);
  const stageDir = resolve(options.stageDir);
  mkdirSync(stageDir, { recursive: true });

  const compat = await loadDesktopCompatibilityModule();
  const cliWrapperContent = compat.renderPosixImcodesCliWrapper({ platform: 'darwin' });
  const runnerScriptText = renderPosixPhaseARunnerScript({
    platform: 'darwin',
    version,
    cliWrapperContent,
  });

  // 1. Runtime + controlled node root
  const runtimeRoot = join(stageDir, 'runtime-root');
  const releaseDest = join(
    runtimeRoot,
    'Library',
    'Application Support',
    'imcodes',
    'daemon-runtime',
    'releases',
    version,
  );
  stageDaemonRuntimePayload({
    runtimeDir: options.runtimeDir,
    runtimeArchive: options.runtimeArchive,
    target: targetInfo.target,
    destReleaseDir: releaseDest,
  });

  let hasNodeBinary = false;
  if (options.nodeExe && existsSync(options.nodeExe)) {
    const nodeSupportDir = join(runtimeRoot, 'Library', 'Application Support', 'imcodes-node');
    const launchDaemonsDir = join(runtimeRoot, 'Library', 'LaunchDaemons');
    mkdirSync(nodeSupportDir, { recursive: true });
    mkdirSync(launchDaemonsDir, { recursive: true });
    const destNodeExe = join(nodeSupportDir, 'imcodes-node');
    cpSync(resolve(options.nodeExe), destNodeExe);
    chmodSync(destNodeExe, 0o755);
    hasNodeBinary = true;

    if (options.remoteDesktopDir && existsSync(options.remoteDesktopDir)) {
      cpSync(resolve(options.remoteDesktopDir), join(nodeSupportDir, 'remote-desktop-worker'), {
        recursive: true,
        dereference: false,
      });
    }
    if (options.computerUseDir && existsSync(options.computerUseDir)) {
      cpSync(resolve(options.computerUseDir), join(nodeSupportDir, 'computer-use-helper'), {
        recursive: true,
        dereference: false,
      });
    }

    writeFileSync(
      join(launchDaemonsDir, 'cc.imcodes.node.plist'),
      renderMacosControlledNodeLaunchDaemonPlist('cc.imcodes.node'),
      'utf8',
    );
    writeFileSync(
      join(launchDaemonsDir, 'cc.imcodes.node.watchdog.plist'),
      renderMacosControlledNodeLaunchDaemonPlist(
        'cc.imcodes.node.watchdog',
        '/Library/Application Support/imcodes-node/imcodes-node',
        ['--watchdog'],
      ),
      'utf8',
    );
  }

  // 2. Component scripts (preinstall / postinstall)
  const scriptsDir = join(stageDir, 'runtime-scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, 'phase-a-runner.sh'), runnerScriptText, { mode: 0o755 });
  writeFileSync(
    join(scriptsDir, 'preinstall'),
    `#!/bin/sh\nset -e\nDIR="$(CDPATH= cd -- "\${0%/*}" && pwd)"\nexec /bin/sh "$DIR/phase-a-runner.sh" --phase preinstall "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(scriptsDir, 'postinstall'),
    `#!/bin/sh\nset -e\nDIR="$(CDPATH= cd -- "\${0%/*}" && pwd)"\nexec /bin/sh "$DIR/phase-a-runner.sh" --phase postinstall "$@"\n`,
    { mode: 0o755 },
  );

  // 3. Optional aiDesk .app root (sealed bundle untouched!)
  let appRoot;
  let componentPlistPath;
  if (options.appBundle && existsSync(options.appBundle)) {
    appRoot = join(stageDir, 'app-root');
    const appName = basename(resolve(options.appBundle));
    const destApp = join(appRoot, 'Applications', appName);
    copyBundlePreservingSeal(resolve(options.appBundle), destApp);
    componentPlistPath = join(stageDir, 'app-component.plist');
    writeFileSync(
      componentPlistPath,
      renderMacosAppComponentPlist(`Applications/${appName}`),
      'utf8',
    );
  }

  const distributionXmlPath = join(stageDir, 'Distribution.xml');
  const runtimePkgFilename = `imcodes-runtime-${arch}.pkg`;
  const appPkgFilename = appRoot ? `imcodes-aidesk-app-${arch}.pkg` : undefined;
  writeFileSync(
    distributionXmlPath,
    renderMacosDistributionXml({
      version,
      arch,
      runtimePkgFilename,
      appPkgFilename,
    }),
    'utf8',
  );

  return {
    version,
    arch,
    stageDir,
    runtimeRoot,
    scriptsDir,
    appRoot,
    componentPlistPath,
    distributionXmlPath,
    runtimePkgFilename,
    appPkgFilename,
    hasNodeBinary,
  };
}

export async function buildMacosInstaller(options) {
  const arch = options.arch === 'x64' ? 'x64' : 'arm64';
  const version = resolveDesktopInstallerVersion(options.version);
  const outDir = resolve(options.outDir ?? join(REPO_ROOT, 'dist-node-exe', 'installers'));
  mkdirSync(outDir, { recursive: true });

  const workDir = options.stageDir
    ? resolve(options.stageDir)
    : mkdtempSync(join(tmpdir(), `imcodes-macos-pkg-${arch}-`));
  const cleanupWorkDir = !options.stageDir && !options.keepStage;

  try {
    const staged = await stageMacosInstallerTree({
      ...options,
      arch,
      version,
      stageDir: workDir,
    });

    if (options.emitStageOnly) {
      return {
        version,
        arch,
        stageDir: staged.stageDir,
        distributionXmlPath: staged.distributionXmlPath,
        scriptsDir: staged.scriptsDir,
      };
    }

    if (process.platform !== 'darwin') {
      throw new Error('Building a macOS .pkg requires macOS (`pkgbuild` / `productbuild`) or --emit-stage-only');
    }

    const pkgWork = join(workDir, 'components');
    mkdirSync(pkgWork, { recursive: true });

    const runtimeComponentPkg = join(pkgWork, staged.runtimePkgFilename);
    execFileSync(
      '/usr/bin/pkgbuild',
      [
        '--root',
        staged.runtimeRoot,
        '--scripts',
        staged.scriptsDir,
        '--identifier',
        'to.aidesk.desktop.runtime',
        '--version',
        version,
        '--install-location',
        '/',
        runtimeComponentPkg,
      ],
      { stdio: 'inherit' },
    );

    if (staged.appRoot && staged.appPkgFilename) {
      const appComponentPkg = join(pkgWork, staged.appPkgFilename);
      execFileSync(
        '/usr/bin/pkgbuild',
        [
          '--root',
          staged.appRoot,
          '--component-plist',
          staged.componentPlistPath,
          '--identifier',
          'to.aidesk.app',
          '--version',
          version,
          '--install-location',
          '/',
          appComponentPkg,
        ],
        { stdio: 'inherit' },
      );
    }

    const pkgPath = join(outDir, `imcodes-desktop-${version}-darwin-${arch}.pkg`);
    execFileSync(
      '/usr/bin/productbuild',
      [
        '--distribution',
        staged.distributionXmlPath,
        '--package-path',
        pkgWork,
        pkgPath,
      ],
      { stdio: 'inherit' },
    );

    const signIdentity = options.signIdentity ?? process.env.IMCODES_MACOS_INSTALLER_SIGNING_IDENTITY;
    if (signIdentity) {
      signInstallerPackage({
        pkgPath,
        identitySha1: signIdentity,
        keychainPath: options.keychainPath,
      });
    }

    await writeDesktopInstallerManifest(pkgPath, {
      platform: 'darwin',
      arch,
      format: 'pkg',
      version,
      signed: Boolean(signIdentity),
      hasAppBundle: Boolean(staged.appRoot),
      hasNodeBinary: staged.hasNodeBinary,
    });

    return {
      version,
      arch,
      pkgPath,
      signed: Boolean(signIdentity),
    };
  } finally {
    if (cleanupWorkDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

function parseCliArgs(argv) {
  const args = {
    arch: process.arch === 'x64' ? 'x64' : 'arm64',
    outDir: join(REPO_ROOT, 'dist-node-exe', 'installers'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--arch') args.arch = argv[++i];
    else if (token === '--version') args.version = argv[++i];
    else if (token === '--runtime-dir') args.runtimeDir = argv[++i];
    else if (token === '--runtime-archive') args.runtimeArchive = argv[++i];
    else if (token === '--app-bundle') args.appBundle = argv[++i];
    else if (token === '--node-exe') args.nodeExe = argv[++i];
    else if (token === '--remote-desktop-dir') args.remoteDesktopDir = argv[++i];
    else if (token === '--computer-use-dir') args.computerUseDir = argv[++i];
    else if (token === '--out-dir') args.outDir = resolve(argv[++i]);
    else if (token === '--stage-dir') args.stageDir = resolve(argv[++i]);
    else if (token === '--sign-identity') args.signIdentity = argv[++i];
    else if (token === '--keychain') args.keychainPath = argv[++i];
    else if (token === '--emit-stage-only') args.emitStageOnly = true;
    else if (token === '--keep-stage') args.keepStage = true;
    else throw new Error(`Unknown flag: ${token}`);
  }
  return args;
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith('build-macos-installer.mjs');
if (isMain) {
  buildMacosInstaller(parseCliArgs(process.argv.slice(2)))
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
