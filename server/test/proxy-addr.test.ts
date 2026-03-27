/**
 * Verify that proxy-addr correctly handles arbitrary CIDR masks
 * (including /12, /20, etc.) — the gaps that the old hand-rolled
 * isTrustedProxy() had.
 *
 * Both the HTTP middleware and the WS upgrade handler compile their
 * trust function from TRUSTED_PROXIES using proxy-addr.compile(), so
 * testing it here covers both paths.
 */
import { describe, it, expect } from 'vitest';
import proxyAddr from 'proxy-addr';

function makeReq(remoteAddress: string, xff?: string) {
  return {
    socket: { remoteAddress },
    headers: xff ? { 'x-forwarded-for': xff } : {},
  };
}

function resolveIp(req: ReturnType<typeof makeReq>, trustedCidrs: string[]) {
  const trust = proxyAddr.compile(trustedCidrs);
  return proxyAddr(req as never, trust);
}

describe('proxy-addr CIDR trust — covers /12, /20, arbitrary masks', () => {
  describe('no trusted proxies', () => {
    it('returns socket IP regardless of XFF', () => {
      expect(resolveIp(makeReq('1.2.3.4', '10.0.0.1, 1.2.3.4'), [])).toBe('1.2.3.4');
    });
  });

  describe('/24 — common case', () => {
    it('strips trusted proxy from XFF', () => {
      expect(resolveIp(makeReq('192.168.1.1', '203.0.113.5, 192.168.1.1'), ['192.168.1.0/24'])).toBe('203.0.113.5');
    });
  });

  describe('/12 — 172.16.0.0/12 covers 172.16–172.31.x.x', () => {
    it('trusts 172.20.0.1 (inside /12) and returns real client', () => {
      expect(resolveIp(makeReq('172.20.0.1', '203.0.113.5, 172.20.0.1'), ['172.16.0.0/12'])).toBe('203.0.113.5');
    });

    it('does NOT trust 172.32.0.1 (outside /12)', () => {
      // Socket is 172.32.0.1 which is outside 172.16/12 — not trusted
      expect(resolveIp(makeReq('172.32.0.1', '203.0.113.5, 172.32.0.1'), ['172.16.0.0/12'])).toBe('172.32.0.1');
    });

    it('trusts 172.16.0.1 (boundary — inside /12)', () => {
      expect(resolveIp(makeReq('172.16.0.1', '203.0.113.5, 172.16.0.1'), ['172.16.0.0/12'])).toBe('203.0.113.5');
    });

    it('trusts 172.31.255.255 (boundary — inside /12)', () => {
      expect(resolveIp(makeReq('172.31.255.255', '203.0.113.5, 172.31.255.255'), ['172.16.0.0/12'])).toBe('203.0.113.5');
    });
  });

  describe('/20 — arbitrary non-octet-aligned mask', () => {
    it('trusts 10.0.0.x inside 10.0.0.0/20', () => {
      expect(resolveIp(makeReq('10.0.0.5', '203.0.113.5, 10.0.0.5'), ['10.0.0.0/20'])).toBe('203.0.113.5');
    });

    it('does NOT trust 10.0.16.1 (outside /20)', () => {
      expect(resolveIp(makeReq('10.0.16.1', '203.0.113.5, 10.0.16.1'), ['10.0.0.0/20'])).toBe('10.0.16.1');
    });
  });

  describe('multi-hop chain', () => {
    it('strips multiple trusted proxy hops to find real client', () => {
      // client → proxy1(10.0.0.1) → proxy2(10.0.0.2) → our server(10.0.0.3)
      const ip = resolveIp(
        makeReq('10.0.0.3', '203.0.113.5, 10.0.0.1, 10.0.0.2'),
        ['10.0.0.0/8'],
      );
      expect(ip).toBe('203.0.113.5');
    });

    it('stops at first untrusted hop', () => {
      // XFF: realClient, untrusted-middle, trusted-proxy
      const ip = resolveIp(
        makeReq('10.0.0.1', '203.0.113.5, 1.2.3.4, 10.0.0.1'),
        ['10.0.0.0/8'],
      );
      expect(ip).toBe('1.2.3.4');
    });
  });

  describe('.env.example representative values', () => {
    const envExample = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';
    const cidrs = envExample.split(',').map((s) => s.trim());

    it('all three ranges are trusted correctly', () => {
      expect(resolveIp(makeReq('10.1.2.3', 'real-client, 10.1.2.3'), cidrs)).toBe('real-client');
      expect(resolveIp(makeReq('172.20.5.6', 'real-client, 172.20.5.6'), cidrs)).toBe('real-client');
      expect(resolveIp(makeReq('192.168.0.50', 'real-client, 192.168.0.50'), cidrs)).toBe('real-client');
    });

    it('public IP is not trusted', () => {
      expect(resolveIp(makeReq('8.8.8.8', 'real-client, 8.8.8.8'), cidrs)).toBe('8.8.8.8');
    });
  });
});
