import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_ADAPTER_CAPABILITIES,
  REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY,
  REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY,
  remoteDesktopAdapterReadiness,
} from '../../shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_ADAPTER_CONTRACT_BEHAVIOR,
  REMOTE_DESKTOP_PLATFORM_ADAPTER_FIXTURES,
} from '../fixtures/remote-desktop-platform-adapters.js';

describe('remote desktop platform adapter fixtures', () => {
  it('applies one complete contract to every platform', () => {
    const required = Object.values(REMOTE_DESKTOP_ADAPTER_CONTRACT_BEHAVIOR);
    expect(REMOTE_DESKTOP_PLATFORM_ADAPTER_FIXTURES.map((fixture) => fixture.platform))
      .toEqual(['windows', 'macos', 'linux']);
    for (const fixture of REMOTE_DESKTOP_PLATFORM_ADAPTER_FIXTURES) {
      expect(fixture.requiredBehaviors).toEqual(required);
      expect(fixture.permissionsQualified).toBe(false);
      expect(fixture.requiredOsPermissions.length).toBeGreaterThan(0);
      expect(fixture.advertisedCapabilities.every((capability) => (
        REMOTE_DESKTOP_ADAPTER_CAPABILITIES.includes(capability)
      ))).toBe(true);
    }
  });

  it('does not pretend future native adapters or permissions exist', () => {
    for (const fixture of REMOTE_DESKTOP_PLATFORM_ADAPTER_FIXTURES.filter(
      (entry) => entry.implementation === 'contract_only',
    )) {
      expect(fixture.advertisedCapabilities).toEqual([]);
      expect(remoteDesktopAdapterReadiness(fixture.advertisedCapabilities)
        .controlledComputerManagement).toBe(false);
    }
  });

  it('records the current worker gap without weakening the common contract', () => {
    const current = REMOTE_DESKTOP_PLATFORM_ADAPTER_FIXTURES[0];
    expect(current?.advertisedCapabilities).not.toContain(REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY);
    expect(current?.advertisedCapabilities).not.toContain(REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY);
    expect(remoteDesktopAdapterReadiness(current?.advertisedCapabilities)
      .controlledComputerManagement).toBe(false);
  });
});
