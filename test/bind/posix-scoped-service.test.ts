import { describe, expect, it } from 'vitest';
import { resolvePosixDaemonServicePaths } from '../../src/util/posix-daemon-service.js';

describe('POSIX daemon service identity', () => {
  it('uses historical service names only for the default state home', () => {
    const paths = resolvePosixDaemonServicePaths({
      HOME: '/tmp/account',
      IMCODES_DEFAULT_HOME: '/tmp/account',
      IMCODES_HOME: '/tmp/account/.imcodes',
    });

    expect(paths.scoped).toBe(false);
    expect(paths.launchAgentLabel).toBe('imcodes.daemon');
    expect(paths.systemdUnitName).toBe('imcodes.service');
    expect(paths.launchAgentPath).toContain('/imcodes.daemon.plist');
    expect(paths.systemdUnitPath).toContain('/imcodes.service');
  });

  it('gives a scoped POSIX home an isolated label/unit and never the default paths', () => {
    const paths = resolvePosixDaemonServicePaths({
      HOME: '/tmp/account',
      IMCODES_DEFAULT_HOME: '/tmp/account',
      IMCODES_HOME: '/tmp/scoped/.imcodes',
    });

    expect(paths.scoped).toBe(true);
    expect(paths.launchAgentLabel).toMatch(/^imcodes\.daemon\.[0-9a-f]{12}$/);
    expect(paths.systemdUnitName).toMatch(/^imcodes\.[0-9a-f]{12}\.service$/);
    expect(paths.launchAgentPath).not.toContain('/imcodes.daemon.plist');
    expect(paths.systemdUnitPath).not.toContain('/imcodes.service');
    expect(paths.legacyLaunchAgentPath).toContain('/cc.imcodes.daemon.plist');
  });

  it('honors an explicit scoped home even when HOME is unset', () => {
    const paths = resolvePosixDaemonServicePaths({
      IMCODES_DEFAULT_HOME: '/tmp/account',
      IMCODES_HOME: '/tmp/scoped/.imcodes',
    });

    expect(paths.scoped).toBe(true);
    expect(paths.stateHome).toBe('/tmp/scoped/.imcodes');
  });
});

