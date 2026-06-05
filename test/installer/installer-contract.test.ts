import { describe, expect, it } from 'vitest';
import {
  INSTALLER_MIRROR_NPM_REGISTRY,
  INSTALLER_NODE_DEFAULT_MAJOR,
  INSTALLER_NODE_MIN_MAJOR,
  INSTALLER_OFFICIAL_NPM_REGISTRY,
  normalizeRegistryBase,
  parseShasumsLine,
  pickLatestNodeVersion,
  pickUpgradeRegistry,
} from '../../shared/installer-contract.js';

// These golden vectors are the single source of truth the bash (install.sh) and
// PowerShell (install.ps1) installers must agree with. They lock in the must-fix
// parsing behavior (UF1/UF2/UF4) and the registry resolution that the daemon's
// auto-upgrade preflight depends on (UF11).

describe('normalizeRegistryBase', () => {
  it('adds a single trailing slash and accepts http(s)', () => {
    expect(normalizeRegistryBase('https://mirrors.cloud.tencent.com/npm')).toBe(
      'https://mirrors.cloud.tencent.com/npm/',
    );
    expect(normalizeRegistryBase('https://registry.npmjs.org/')).toBe('https://registry.npmjs.org/');
  });

  it('rejects non-urls and empty/garbage', () => {
    expect(normalizeRegistryBase('')).toBeNull();
    expect(normalizeRegistryBase('  ')).toBeNull();
    expect(normalizeRegistryBase('not-a-url')).toBeNull();
    expect(normalizeRegistryBase('https://')).toBeNull();
    expect(normalizeRegistryBase(undefined)).toBeNull();
    expect(normalizeRegistryBase(42)).toBeNull();
  });
});

describe('pickUpgradeRegistry', () => {
  it('prefers install.json config over ambient', () => {
    expect(
      pickUpgradeRegistry({
        configRegistry: INSTALLER_MIRROR_NPM_REGISTRY,
        ambientRegistry: 'https://registry.npmjs.org/',
      }),
    ).toBe(INSTALLER_MIRROR_NPM_REGISTRY);
  });

  it('falls back to ambient when config is absent/invalid (legacy ~/.npmrc users)', () => {
    expect(
      pickUpgradeRegistry({ configRegistry: undefined, ambientRegistry: INSTALLER_MIRROR_NPM_REGISTRY }),
    ).toBe(INSTALLER_MIRROR_NPM_REGISTRY);
    expect(
      pickUpgradeRegistry({ configRegistry: 'garbage', ambientRegistry: INSTALLER_MIRROR_NPM_REGISTRY }),
    ).toBe(INSTALLER_MIRROR_NPM_REGISTRY);
  });

  it('defaults to the official registry when nothing is set', () => {
    expect(pickUpgradeRegistry({})).toBe(INSTALLER_OFFICIAL_NPM_REGISTRY);
    expect(pickUpgradeRegistry({ configRegistry: '', ambientRegistry: '' })).toBe(
      INSTALLER_OFFICIAL_NPM_REGISTRY,
    );
  });
});

describe('parseShasumsLine (UF1/UF2)', () => {
  const sample = [
    '1111111111111111111111111111111111111111111111111111111111111111  node-v24.4.0-linux-arm64.tar.gz',
    '2222222222222222222222222222222222222222222222222222222222222222  node-v24.4.0-linux-x64.tar.xz',
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  node-v24.4.0-linux-x64.tar.gz',
    '3333333333333333333333333333333333333333333333333333333333333333  node-v24x4x0-linux-x64.tar.gz',
  ].join('\n');

  it('matches the artifact as a whole field, not a suffix/regex', () => {
    expect(parseShasumsLine(sample, 'node-v24.4.0-linux-x64.tar.gz')).toBe(
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    );
  });

  it('does not confuse .tar.xz / dotted-wildcard lookalikes', () => {
    // A naive `.` regex or suffix match could match the .tar.xz or the
    // node-v24x4x0 lookalike — whole-field equality must not.
    expect(parseShasumsLine(sample, 'node-v24.4.0-win-x64.zip')).toBeNull();
  });

  it('handles CRLF and finds entries on any line (not just the last)', () => {
    const crlf = sample.replace(/\n/g, '\r\n');
    expect(parseShasumsLine(crlf, 'node-v24.4.0-linux-arm64.tar.gz')).toBe(
      '1111111111111111111111111111111111111111111111111111111111111111',
    );
  });

  it('returns null when the artifact is absent', () => {
    expect(parseShasumsLine(sample, 'node-v99.0.0-linux-x64.tar.gz')).toBeNull();
  });
});

describe('pickLatestNodeVersion (UF4)', () => {
  const versions = ['v24.4.0', 'v24.11.0', 'v24.9.0', 'v22.1.0', 'v20.0.0'];

  it('picks the highest patch for the major, order-independent', () => {
    expect(pickLatestNodeVersion(versions, 24)).toBe('v24.11.0');
    expect(pickLatestNodeVersion([...versions].reverse(), 24)).toBe('v24.11.0');
    expect(pickLatestNodeVersion(versions, 22)).toBe('v22.1.0');
  });

  it('does not let v2 match v24 etc. (anchored major)', () => {
    expect(pickLatestNodeVersion(versions, 2)).toBeNull();
  });

  it('returns null for an absent major', () => {
    expect(pickLatestNodeVersion(versions, 18)).toBeNull();
  });
});

describe('version policy constants stay in sync with the scripts', () => {
  it('min/default majors', () => {
    expect(INSTALLER_NODE_MIN_MAJOR).toBe(22);
    expect(INSTALLER_NODE_DEFAULT_MAJOR).toBe(24);
  });
});
