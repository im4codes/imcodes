import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  detectInstalledAgents,
  __resetAgentAvailabilityCacheForTests,
  type AgentAvailabilityProbeDeps,
} from '../../src/agent/agent-availability.js';
import {
  resolveClaudeCodePathForSdk,
  resolveExecutableForSpawn,
  resolveNodePackageRoot,
} from '../../src/agent/transport-paths.js';
import { SESSION_AGENT_TYPES } from '../../shared/agent-types.js';
import { AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';
import { CODEBUDDY_PROVIDER_IDS } from '../../shared/codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../shared/hermes-agent.js';

function createFakeDeps(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  isMusl?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  imcodesHomeDir?: string;
  executables?: string[];
  files?: string[];
  packages?: Record<string, string>;
  connectedProviders?: string[];
}): AgentAvailabilityProbeDeps {
  const execSet = new Set(options.executables ?? []);
  const fileSet = new Set([...(options.files ?? []), ...(options.executables ?? [])]);
  const packages = options.packages ?? {};
  const connected = new Set(options.connectedProviders ?? []);
  return {
    platform: options.platform ?? 'linux',
    arch: options.arch ?? 'x64',
    ...(options.isMusl !== undefined ? { isMusl: options.isMusl } : {}),
    env: options.env ?? { PATH: '/usr/local/bin:/usr/bin' },
    homeDir: options.homeDir ?? '/home/alice',
    imcodesHomeDir: options.imcodesHomeDir ?? '/home/alice/.imcodes',
    isExecutableFile: async (filePath) => execSet.has(filePath),
    fileExists: async (filePath) => fileSet.has(filePath),
    resolvePackageRoot: (specifier) => packages[specifier] ?? null,
    isProviderConnected: (id) => connected.has(id),
  };
}

describe('detectInstalledAgents()', () => {
  let tempRoot: string | null = null;

  beforeEach(() => {
    __resetAgentAvailabilityCacheForTests();
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('probes every SESSION_AGENT_TYPES entry and marks missing binaries as uninstalled', async () => {
    const deps = createFakeDeps({
      env: { PATH: '/usr/bin' },
      executables: ['/usr/bin/codex'],
    });
    const result = await detectInstalledAgents({ deps });

    for (const agentType of SESSION_AGENT_TYPES) {
      expect(result[agentType]).toBeDefined();
      expect(typeof result[agentType]?.installed).toBe('boolean');
    }

    expect(result['codex-sdk']?.installed).toBe(true);
    expect(result['codex']?.installed).toBe(true);
    expect(result[AGY_SDK_PROVIDER_ID]?.installed).toBe(false);
    expect(result['claude-code-sdk']?.installed).toBe(false);
    expect(result['claude-code']?.installed).toBe(false);
    expect(result['deepseek-harness']?.installed).toBe(false);
    expect(result['pi']?.installed).toBe(false);
    expect(result['openclaw']?.installed).toBe(false);
    expect(result['shell']?.installed).toBe(true);
    expect(result['script']?.installed).toBe(true);
  });

  it('resolves real exports-encapsulated SDKs (qoder-sdk, copilot-sdk, opencode-sdk, claude-code-sdk) against the real node_modules tree without mocking resolvePackageRoot', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'imcodes-avail-real-'));
    const binDir = path.join(tempRoot, 'bin');
    const homeDir = path.join(tempRoot, 'home');
    await mkdir(binDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });

    const opencodeBin = path.join(binDir, 'opencode');
    await writeFile(opencodeBin, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(opencodeBin, 0o755);

    const qoderBin = path.join(binDir, process.platform === 'win32' ? 'qodercli.exe' : 'qodercli');
    await writeFile(qoderBin, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(qoderBin, 0o755);

    const withOpenCode = await detectInstalledAgents({
      deps: {
        env: { PATH: binDir, QODERCLI_PATH: qoderBin },
        homeDir,
        imcodesHomeDir: path.join(homeDir, '.imcodes'),
        isProviderConnected: () => false,
      },
    });
    expect(withOpenCode['qoder-sdk']?.installed).toBe(true);
    expect(withOpenCode['copilot-sdk']?.installed).toBe(true);
    expect(withOpenCode['opencode-sdk']?.installed).toBe(true);
    expect(withOpenCode['opencode']?.installed).toBe(true);
    if (process.platform === 'linux' && process.arch === 'x64') {
      expect(withOpenCode['claude-code-sdk']?.installed).toBe(true);
    }

    // Without opencode CLI on PATH, @opencode/sdk v2 still resolves in-process while the PTY CLI yields false:
    const withoutOpenCode = await detectInstalledAgents({
      deps: {
        env: { PATH: path.join(tempRoot, 'empty-bin') },
        homeDir,
        imcodesHomeDir: path.join(homeDir, '.imcodes'),
        isProviderConnected: () => false,
      },
    });
    expect(withoutOpenCode['opencode-sdk']?.installed).toBe(true);
    expect(withoutOpenCode['opencode']?.installed).toBe(false);
  });

  it('does not falsely report PATH-only launchers as installed when binaries only exist in unsearched ~/.local/bin under sparse Unix PATH', async () => {
    const deps = createFakeDeps({
      env: { PATH: '/usr/bin' },
      executables: [
        '/home/alice/.local/bin/codex',
        '/home/alice/.local/bin/claude',
        '/home/alice/.local/bin/cursor-agent',
        '/home/alice/.local/bin/opencode',
        '/home/alice/.local/bin/dsh',
        '/home/alice/.local/bin/pi',
        '/home/alice/.local/bin/qwen',
        // Providers that genuinely search ~/.local/bin / bundled assets:
        '/home/alice/.local/bin/agy',
        '/home/alice/.local/bin/kimi',
        '/home/alice/.local/bin/muse',
        '/home/alice/.local/bin/grok',
        '/home/alice/.local/bin/hermes',
      ],
    });

    const result = await detectInstalledAgents({ deps });
    // Exact PATH-only launchers must report false under sparse PATH:
    expect(result['codex-sdk']?.installed).toBe(false);
    expect(result['codex']?.installed).toBe(false);
    expect(result['claude-code']?.installed).toBe(false);
    expect(result['opencode']?.installed).toBe(false);
    expect(result['opencode-sdk']?.installed).toBe(false);
    expect(result['deepseek-harness']?.installed).toBe(false);
    expect(result['pi']?.installed).toBe(false);
    expect(result['qwen']?.installed).toBe(false);

    // Providers whose real launch path checks ~/.local/bin / candidate dirs must report true:
    expect(result['claude-code-sdk']?.installed).toBe(true);
    expect(result['cursor-headless']?.installed).toBe(true);
    expect(result[AGY_SDK_PROVIDER_ID]?.installed).toBe(true);
    expect(result['kimi-sdk']?.installed).toBe(true);
    expect(result['muse-code-sdk']?.installed).toBe(true);
    expect(result['grok-sdk']?.installed).toBe(true);
    expect(result[HERMES_AGENT_PROVIDER_ID]?.installed).toBe(true);
  });

  it('detects cursor-headless via standalone agent binary on Unix ~/.local/bin and Windows agent.exe', async () => {
    const unixDeps = createFakeDeps({
      env: { PATH: '/usr/bin' },
      executables: ['/home/alice/.local/bin/agent'],
    });
    const unixResult = await detectInstalledAgents({ deps: unixDeps });
    expect(unixResult['cursor-headless']?.installed).toBe(true);

    const winDeps = createFakeDeps({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
      homeDir: 'C:\\Users\\alice',
      executables: ['C:\\Users\\alice\\AppData\\Local\\cursor-agent\\agent.exe'],
    });
    const winResult = await detectInstalledAgents({ deps: winDeps });
    expect(winResult['cursor-headless']?.installed).toBe(true);
  });

  it('skips PATH-shadowed non-executable cursor-agent files consistently with runtime launch', async () => {
    const blockedOnlyDeps = createFakeDeps({
      env: { PATH: '/bad-bin:/usr/bin' },
      files: ['/bad-bin/cursor-agent'],
      executables: [],
    });
    const blockedOnly = await detectInstalledAgents({ deps: blockedOnlyDeps });
    expect(blockedOnly['cursor-headless']?.installed).toBe(false);

    const shadowedWithFallbackDeps = createFakeDeps({
      env: { PATH: '/bad-bin:/good-bin' },
      files: ['/bad-bin/cursor-agent'],
      executables: ['/good-bin/cursor-agent'],
    });
    const recovered = await detectInstalledAgents({ deps: shadowedWithFallbackDeps });
    expect(recovered['cursor-headless']?.installed).toBe(true);
  });

  it('skips Windows POSIX/unlaunchable cursor-agent shims in PATH and resolves valid downstream agent.cmd', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'imcodes-win-cursor-avail-'));
    try {
      const badDir = path.join(tmpRoot, 'bad');
      const goodDir = path.join(tmpRoot, 'good');
      const verDir = path.join(goodDir, 'versions', '2026.11.22-e9042b2');
      await mkdir(badDir, { recursive: true });
      await mkdir(verDir, { recursive: true });

      // Bad dir: extensionless POSIX cursor-agent + unparseable cursor-agent.cmd
      await writeFile(path.join(badDir, 'cursor-agent'), '#!/bin/sh\n');
      await writeFile(path.join(badDir, 'cursor-agent.cmd'), '@echo off\r\necho broken\r\n');

      const execCheck = async (filePath: string) => {
        const diskPath = process.platform !== 'win32' && (filePath.startsWith('/') || /^\\[^\\]/.test(filePath))
          ? filePath.replace(/\\/g, '/')
          : filePath;
        try {
          const { statSync } = await import('node:fs');
          return statSync(diskPath).isFile();
        } catch {
          return false;
        }
      };

      // Only bad dir present -> must report NOT installed
      const badOnly = await detectInstalledAgents({
        forceRefresh: true,
        deps: {
          platform: 'win32',
          env: { PATH: badDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
          homeDir: tmpRoot,
          imcodesHomeDir: path.join(tmpRoot, '.imcodes'),
          isExecutableFile: execCheck,
          isProviderConnected: () => false,
        },
      });
      expect(badOnly['cursor-headless']?.installed).toBe(false);

      // Good dir downstream has real Windows node.exe + index.js + valid agent.cmd wrapper
      await writeFile(path.join(verDir, 'node.exe'), 'node');
      await writeFile(path.join(verDir, 'index.js'), 'console.log("ok");\n');
      await writeFile(
        path.join(goodDir, 'agent.cmd'),
        '"%~dp0versions\\2026.11.22-e9042b2\\node.exe" --use-system-ca "%~dp0versions\\2026.11.22-e9042b2\\index.js" %*\r\n',
      );
      const withGood = await detectInstalledAgents({
        forceRefresh: true,
        deps: {
          platform: 'win32',
          env: { PATH: `${badDir};${goodDir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
          homeDir: tmpRoot,
          imcodesHomeDir: path.join(tmpRoot, '.imcodes'),
          isExecutableFile: execCheck,
          isProviderConnected: () => false,
        },
      });
      expect(withGood['cursor-headless']?.installed).toBe(true);

      // Standalone .ps1 under PATHEXT=.PS1;.EXE;.CMD + broken .cmd naming missing node.exe must BOTH be rejected
      const ps1Dir = path.join(tmpRoot, 'ps1-only');
      const missingNodeDir = path.join(tmpRoot, 'missing-node');
      const exeDir = path.join(tmpRoot, 'exe-good');
      await mkdir(ps1Dir, { recursive: true });
      await mkdir(missingNodeDir, { recursive: true });
      await mkdir(exeDir, { recursive: true });
      await writeFile(path.join(ps1Dir, 'cursor-agent.ps1'), 'Write-Output "ps1"\n');
      await writeFile(path.join(missingNodeDir, 'index.js'), 'console.log("x");\n');
      await writeFile(path.join(missingNodeDir, 'cursor-agent.cmd'), '"%~dp0missing\\node.exe" "%~dp0index.js" %*\r\n');

      const rejectedBadWrappers = await detectInstalledAgents({
        forceRefresh: true,
        deps: {
          platform: 'win32',
          env: { PATH: `${ps1Dir};${missingNodeDir}`, PATHEXT: '.PS1;.EXE;.CMD' },
          homeDir: path.join(tmpRoot, 'empty-home'),
          imcodesHomeDir: path.join(tmpRoot, '.imcodes'),
          isExecutableFile: execCheck,
          isProviderConnected: () => false,
        },
      });
      expect(rejectedBadWrappers['cursor-headless']?.installed).toBe(false);

      await writeFile(path.join(exeDir, 'agent.exe'), 'exe');
      const recoveredWithExe = await detectInstalledAgents({
        forceRefresh: true,
        deps: {
          platform: 'win32',
          env: { PATH: `${ps1Dir};${missingNodeDir};${exeDir}`, PATHEXT: '.PS1;.EXE;.CMD' },
          homeDir: path.join(tmpRoot, 'empty-home'),
          imcodesHomeDir: path.join(tmpRoot, '.imcodes'),
          isExecutableFile: execCheck,
          isProviderConnected: () => false,
        },
      });
      expect(recoveredWithExe['cursor-headless']?.installed).toBe(true);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('finds bundled SDK runtimes without global CLIs on sparse daemon PATHs', async () => {
    const deps = createFakeDeps({
      env: { PATH: '/usr/bin' },
      executables: [
        '/opt/imcodes/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
        '/home/alice/.local/bin/agy',
        '/home/alice/.grok/bin/grok',
        '/home/alice/.hermes/hermes-agent/venv/bin/hermes',
      ],
      files: [
        '/opt/imcodes/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs',
        '/opt/imcodes/node_modules/@microsoft/copilot-sdk-linux-x64/prebuilds/linux-x64/copilot-runtime',
        '/opt/imcodes/node_modules/@microsoft/copilot-sdk-linux-x64/prebuilds/linux-x64/runtime.node',
      ],
      packages: {
        '@anthropic-ai/claude-agent-sdk': '/opt/imcodes/node_modules/@anthropic-ai/claude-agent-sdk',
        '@anthropic-ai/claude-agent-sdk-linux-x64': '/opt/imcodes/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64',
        '@qoder-ai/qoder-agent-sdk': '/opt/imcodes/node_modules/@qoder-ai/qoder-agent-sdk',
        '@microsoft/copilot-sdk': '/opt/imcodes/node_modules/@microsoft/copilot-sdk',
        '@microsoft/copilot-sdk-linux-x64': '/opt/imcodes/node_modules/@microsoft/copilot-sdk-linux-x64',
        '@opencode/sdk': '/opt/imcodes/node_modules/@opencode/sdk',
      },
    });

    const result = await detectInstalledAgents({ deps });
    expect(result['claude-code-sdk']?.installed).toBe(true);
    expect(result['claude-code']?.installed).toBe(false);
    expect(result[AGY_SDK_PROVIDER_ID]?.installed).toBe(true);
    expect(result['qoder-sdk']?.installed).toBe(true);
    expect(result['copilot-sdk']?.installed).toBe(true);
    expect(result['opencode-sdk']?.installed).toBe(true);
    expect(result['grok-sdk']?.installed).toBe(true);
    expect(result[HERMES_AGENT_PROVIDER_ID]?.installed).toBe(true);
  });

  it('respects custom binary env overrides and Windows PATHEXT/install locations', async () => {
    const winDeps = createFakeDeps({
      platform: 'win32',
      env: {
        PATH: 'C:\\Windows\\System32;C:\\Users\\alice\\AppData\\Roaming\\npm',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        IMCODES_DSH_BIN: 'C:\\custom\\dsh.cmd',
        IMCODES_PI_BIN: 'C:\\custom\\pi.exe',
      },
      homeDir: 'C:\\Users\\alice',
      imcodesHomeDir: 'C:\\Users\\alice\\.imcodes',
      executables: [
        'C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd',
        'C:\\Users\\alice\\AppData\\Local\\cursor-agent\\agent.exe',
        'C:\\Users\\alice\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy.exe',
        'C:\\custom\\dsh.cmd',
        'C:\\custom\\pi.exe',
      ],
    });

    const result = await detectInstalledAgents({ deps: winDeps });
    expect(result['codex-sdk']?.installed).toBe(true);
    expect(result['codex']?.installed).toBe(true);
    expect(result['cursor-headless']?.installed).toBe(true);
    expect(result[CODEBUDDY_PROVIDER_IDS.CHINA]?.installed).toBe(true);
    expect(result[CODEBUDDY_PROVIDER_IDS.INTERNATIONAL]?.installed).toBe(false);
    expect(result['deepseek-harness']?.installed).toBe(true);
    expect(result['pi']?.installed).toBe(true);
  });

  it('detects kimi-sdk in Kimi Code CLI v2 (~/.kimi-code/bin) and KIMI_CODE_HOME/KIMI_CLI_PATH', async () => {
    const v2Deps = createFakeDeps({
      env: { PATH: '/usr/bin' },
      homeDir: '/home/alice',
      executables: ['/home/alice/.kimi-code/bin/kimi'],
    });
    expect((await detectInstalledAgents({ deps: v2Deps }))['kimi-sdk']?.installed).toBe(true);

    const customHomeDeps = createFakeDeps({
      env: { PATH: '/usr/bin', KIMI_CODE_HOME: '/opt/kimi-code-home' },
      homeDir: '/home/alice',
      executables: ['/opt/kimi-code-home/bin/kimi'],
    });
    expect((await detectInstalledAgents({ deps: customHomeDeps }))['kimi-sdk']?.installed).toBe(true);

    const overrideDeps = createFakeDeps({
      env: { PATH: '/usr/bin', KIMI_CLI_PATH: '/custom/bin/kimi-v2' },
      homeDir: '/home/alice',
      executables: ['/custom/bin/kimi-v2'],
    });
    expect((await detectInstalledAgents({ deps: overrideDeps }))['kimi-sdk']?.installed).toBe(true);
  });

  it('detects openclaw availability from connected provider or local gateway config', async () => {
    const configDeps = createFakeDeps({
      files: ['/home/alice/.openclaw/openclaw.json'],
    });
    expect((await detectInstalledAgents({ deps: configDeps }))['openclaw']?.installed).toBe(true);

    const connectedDeps = createFakeDeps({
      connectedProviders: ['openclaw'],
    });
    expect((await detectInstalledAgents({ deps: connectedDeps }))['openclaw']?.installed).toBe(true);
  });

  it('times out wedged probe checks cleanly without stalling the whole detection map', async () => {
    const hangingDeps: Partial<AgentAvailabilityProbeDeps> = {
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      homeDir: '/home/alice',
      imcodesHomeDir: '/home/alice/.imcodes',
      isExecutableFile: () => new Promise<boolean>(() => {
        // intentionally never resolves
      }),
      fileExists: async () => false,
      resolvePackageRoot: () => null,
      isProviderConnected: () => false,
    };
    const result = await detectInstalledAgents({ deps: hangingDeps, timeoutMs: 25 });
    expect(result[AGY_SDK_PROVIDER_ID]?.installed).toBe(false);
    expect(result[AGY_SDK_PROVIDER_ID]?.reason).toBe('Probe timed out');
    expect(result['shell']?.installed).toBe(true);
  });

  it('caches default host probes and bypasses cache when forceRefresh is true', async () => {
    const first = await detectInstalledAgents({ now: 10_000 });
    const second = await detectInstalledAgents({ now: 20_000 });
    expect(second).toBe(first);

    const refreshed = await detectInstalledAgents({ forceRefresh: true, now: 20_000 });
    expect(refreshed).not.toBe(first);
    expect(refreshed['shell']?.installed).toBe(true);
  });

  it('detects bundled Windows claude.exe and aligns probeClaudeSdk with resolveClaudeCodePathForSdk while leaving non-SDK claude-code false', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'imcodes-win-bundled-'));
    const nodeModulesDir = path.join(tempRoot, 'node_modules');
    const winPkgDir = path.join(nodeModulesDir, '@anthropic-ai', 'claude-agent-sdk-win32-x64');
    const mainPkgDir = path.join(nodeModulesDir, '@anthropic-ai', 'claude-agent-sdk');
    await mkdir(winPkgDir, { recursive: true });
    await mkdir(mainPkgDir, { recursive: true });
    await writeFile(path.join(winPkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk-win32-x64', version: '0.0.0' }));
    await writeFile(path.join(mainPkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.0.0' }));
    const fakeExe = path.join(winPkgDir, 'claude.exe');
    await writeFile(fakeExe, 'MZ');

    const origPlatform = process.platform;
    const origArch = process.arch;
    const origPath = process.env.PATH;
    const origAppData = process.env.APPDATA;
    const origNodePath = process.env.NODE_PATH;

    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    process.env.PATH = '';
    process.env.APPDATA = path.join(tempRoot, 'empty-appdata');
    process.env.NODE_PATH = nodeModulesDir;

    try {
      const detected = await detectInstalledAgents({
        deps: {
          platform: 'win32',
          arch: 'x64',
          env: { PATH: '', NODE_PATH: nodeModulesDir, APPDATA: process.env.APPDATA },
          homeDir: tempRoot,
          imcodesHomeDir: path.join(tempRoot, '.imcodes'),
          isProviderConnected: () => false,
        },
      });
      const resolvedForSdk = resolveClaudeCodePathForSdk('claude');
      const spawnResolved = resolveExecutableForSpawn(resolvedForSdk);

      expect(detected['claude-code-sdk']?.installed).toBe(true);
      expect(detected['claude-code-cli-sdk']?.installed).toBe(true);
      expect(detected['claude-code']?.installed).toBe(false);
      expect(resolvedForSdk).toBe(fakeExe);
      expect(spawnResolved).toEqual({ executable: fakeExe, prependArgs: [] });

      // Explicit custom paths and explicit npm .cmd shims remain preserved:
      const explicitExe = 'C:\\custom\\claude.exe';
      expect(resolveClaudeCodePathForSdk(explicitExe)).toBe(explicitExe);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      Object.defineProperty(process, 'arch', { value: origArch });
      process.env.PATH = origPath;
      if (origAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = origAppData;
      if (origNodePath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = origNodePath;
    }
  });

  it('does not let a dummy package.json in NODE_PATH shadow real installed ESM SDKs such as @qoder-ai/qoder-agent-sdk', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'imcodes-node-path-shadow-'));
    const shadowNodeModules = path.join(tempRoot, 'node_modules');
    const shadowQoderDir = path.join(shadowNodeModules, '@qoder-ai', 'qoder-agent-sdk');
    const shadowFakeDir = path.join(shadowNodeModules, '@fake', 'esm-only-sdk');
    await mkdir(shadowQoderDir, { recursive: true });
    await mkdir(shadowFakeDir, { recursive: true });
    await writeFile(
      path.join(shadowQoderDir, 'package.json'),
      JSON.stringify({ name: '@qoder-ai/qoder-agent-sdk', version: '0.0.0' }),
    );
    await writeFile(
      path.join(shadowFakeDir, 'package.json'),
      JSON.stringify({ name: '@fake/esm-only-sdk', version: '0.0.0' }),
    );

    const binDir = path.join(tempRoot, 'bin');
    await mkdir(binDir, { recursive: true });
    const qoderBin = path.join(binDir, process.platform === 'win32' ? 'qodercli.exe' : 'qodercli');
    await writeFile(qoderBin, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(qoderBin, 0o755);

    const origNodePath = process.env.NODE_PATH;
    process.env.NODE_PATH = shadowNodeModules;
    try {
      const resolvedRealRoot = resolveNodePackageRoot('@qoder-ai/qoder-agent-sdk');
      expect(resolvedRealRoot).toBeTruthy();
      expect(resolvedRealRoot).not.toBe(shadowQoderDir);
      expect(resolveNodePackageRoot('@fake/esm-only-sdk')).toBeNull();

      const detected = await detectInstalledAgents({
        deps: {
          env: {
            PATH: path.join(tempRoot, 'empty-bin'),
            NODE_PATH: shadowNodeModules,
            QODERCLI_PATH: qoderBin,
          },
          homeDir: tempRoot,
          imcodesHomeDir: path.join(tempRoot, '.imcodes'),
          isProviderConnected: () => false,
        },
      });
      expect(detected['qoder-sdk']?.installed).toBe(true);
    } finally {
      if (origNodePath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = origNodePath;
    }
  });

  it('aligns copilot-sdk availability strictly with v2 runtimeArtifacts rules and explicit COPILOT_CLI_PATH', async () => {
    const sdkOnly = { '@microsoft/copilot-sdk': '/opt/imcodes/node_modules/@microsoft/copilot-sdk' };

    // 1. Missing wrapper (`runtime.node` alone) is NOT usable by v2 ensureRuntimeBundle -> false.
    const missingWrapper = await detectInstalledAgents({
      deps: createFakeDeps({
        platform: 'linux',
        arch: 'x64',
        isMusl: false,
        packages: {
          ...sdkOnly,
          '@microsoft/copilot-sdk-linux-x64': '/opt/imcodes/node_modules/@microsoft/copilot-sdk-linux-x64',
        },
        files: [
          '/opt/imcodes/node_modules/@microsoft/copilot-sdk-linux-x64/prebuilds/linux-x64/runtime.node',
        ],
      }),
    });
    expect(missingWrapper['copilot-sdk']?.installed).toBe(false);

    // 2. Legacy `@github/copilot-*` npm package alone (COPILOT_CLI_USE_NPM_PACKAGE = false) -> false.
    const legacyNpmOnly = await detectInstalledAgents({
      deps: createFakeDeps({
        platform: 'linux',
        arch: 'x64',
        isMusl: false,
        packages: {
          ...sdkOnly,
          '@github/copilot-linux-x64': '/opt/imcodes/node_modules/@github/copilot-linux-x64',
        },
        files: [
          '/opt/imcodes/node_modules/@github/copilot-linux-x64/prebuilds/linux-x64/copilot-runtime',
          '/opt/imcodes/node_modules/@github/copilot-linux-x64/prebuilds/linux-x64/runtime.node',
        ],
      }),
    });
    expect(legacyNpmOnly['copilot-sdk']?.installed).toBe(false);

    // 3. Wrong Linux libc package (`linuxmusl-x64` when glibc, or `linux-x64` when musl) -> false.
    const wrongLibcGlibc = await detectInstalledAgents({
      deps: createFakeDeps({
        platform: 'linux',
        arch: 'x64',
        isMusl: false,
        packages: {
          ...sdkOnly,
          '@microsoft/copilot-sdk-linuxmusl-x64': '/opt/imcodes/node_modules/@microsoft/copilot-sdk-linuxmusl-x64',
        },
        files: [
          '/opt/imcodes/node_modules/@microsoft/copilot-sdk-linuxmusl-x64/prebuilds/linuxmusl-x64/copilot-runtime',
          '/opt/imcodes/node_modules/@microsoft/copilot-sdk-linuxmusl-x64/prebuilds/linuxmusl-x64/runtime.node',
        ],
      }),
    });
    expect(wrongLibcGlibc['copilot-sdk']?.installed).toBe(false);

    const matchingMusl = await detectInstalledAgents({
      deps: createFakeDeps({
        platform: 'linux',
        arch: 'x64',
        isMusl: true,
        packages: {
          ...sdkOnly,
          '@microsoft/copilot-sdk-linuxmusl-x64': '/opt/imcodes/node_modules/@microsoft/copilot-sdk-linuxmusl-x64',
        },
        files: [
          '/opt/imcodes/node_modules/@microsoft/copilot-sdk-linuxmusl-x64/prebuilds/linuxmusl-x64/copilot-runtime',
          '/opt/imcodes/node_modules/@microsoft/copilot-sdk-linuxmusl-x64/prebuilds/linuxmusl-x64/runtime.node',
        ],
      }),
    });
    expect(matchingMusl['copilot-sdk']?.installed).toBe(true);

    // 4. Windows with legacy `copilot.cmd` on PATH (no `@microsoft/copilot-sdk-win32-x64`) -> false.
    const winLegacyPath = await detectInstalledAgents({
      deps: createFakeDeps({
        platform: 'win32',
        arch: 'x64',
        env: { PATH: 'C:\\legacy-cli', PATHEXT: '.EXE;.CMD' },
        packages: sdkOnly,
        executables: ['C:\\legacy-cli\\copilot.cmd'],
      }),
    });
    expect(winLegacyPath['copilot-sdk']?.installed).toBe(false);

    // 5. Explicit absolute executable COPILOT_CLI_PATH (with @microsoft/copilot-sdk) -> true; relative -> false.
    const explicitV4Cli = await detectInstalledAgents({
      deps: createFakeDeps({
        platform: 'win32',
        arch: 'x64',
        env: { PATH: '', COPILOT_CLI_PATH: 'C:\\v4\\copilot.exe' },
        packages: sdkOnly,
        executables: ['C:\\v4\\copilot.exe'],
      }),
    });
    expect(explicitV4Cli['copilot-sdk']?.installed).toBe(true);

    const relativeCli = await detectInstalledAgents({
      deps: createFakeDeps({
        platform: 'linux',
        arch: 'x64',
        isMusl: false,
        env: { PATH: '', COPILOT_CLI_PATH: 'copilot' },
        packages: sdkOnly,
        executables: ['copilot'],
      }),
    });
    expect(relativeCli['copilot-sdk']?.installed).toBe(false);
  });

  it('discovers ~/.opencode/bin/opencode under sparse PATH when non-elevated and honors PATH priority', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'imcodes opencode home '));
    const homeOcDir = path.join(tempRoot, '.opencode', 'bin');
    await mkdir(homeOcDir, { recursive: true });
    const homeOcBin = path.join(homeOcDir, 'opencode');
    await writeFile(homeOcBin, '#!/bin/sh\necho ok\n', 'utf8');
    await chmod(homeOcBin, 0o755);

    const detected = await detectInstalledAgents({
      deps: {
        platform: 'linux',
        homeDir: tempRoot,
        imcodesHomeDir: path.join(tempRoot, '.imcodes'),
        env: { PATH: '/usr/bin' },
        isProviderConnected: () => false,
      },
    });
    expect(detected.opencode?.installed).toBe(true);

    // Windows home fallback denies elevated callers (isElevated: true) and allows confirmed non-elevated callers (isElevated: false)
    const winHome = 'C:\\Users\\alice';
    const winHomeBin = 'C:\\Users\\alice\\.opencode\\bin\\opencode.exe';
    const winElevated = await detectInstalledAgents({
      deps: {
        platform: 'win32',
        homeDir: winHome,
        imcodesHomeDir: 'C:\\Users\\alice\\.imcodes',
        env: { PATH: 'C:\\Windows\\System32' },
        isElevated: true,
        isExecutableFile: async (p) => p.toLowerCase() === winHomeBin.toLowerCase(),
        isProviderConnected: () => false,
      },
    });
    expect(winElevated.opencode?.installed).toBe(false);

    const winNonElevated = await detectInstalledAgents({
      deps: {
        platform: 'win32',
        homeDir: winHome,
        imcodesHomeDir: 'C:\\Users\\alice\\.imcodes',
        env: { PATH: 'C:\\Windows\\System32' },
        isElevated: false,
        isExecutableFile: async (p) => p.toLowerCase() === winHomeBin.toLowerCase(),
        isProviderConnected: () => false,
      },
    });
    expect(winNonElevated.opencode?.installed).toBe(true);
  });
});
