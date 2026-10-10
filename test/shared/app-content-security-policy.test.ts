import { describe, expect, it } from 'vitest';
import { APP_CSP_DIRECTIVES, buildAppContentSecurityPolicy } from '../../shared/app-content-security-policy.js';

const parse = (policy: string) => new Map(policy.split('; ').map((part) => {
  const [name, ...sources] = part.split(' ');
  return [name!, sources] as const;
}));

describe('app Content-Security-Policy', () => {
  const policy = parse(buildAppContentSecurityPolicy());

  it('lets the composer preview and the lightbox use the blob: URL of a picked file', () => {
    // The live header had `img-src 'self' data: https:`: the chip's preview <img src="blob:..."> was blocked
    // ("violates ... img-src") and showed nothing, and the lightbox's Save / Copy (fetch of that blob) was blocked by connect-src.
    expect(policy.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'https:']);
    expect(policy.get('connect-src')).toContain('blob:');
  });

  it('allows blob: nowhere else, and adds nothing broader', () => {
    const withBlob = [...policy].filter(([, sources]) => sources.includes('blob:')).map(([name]) => name).sort();
    expect(withBlob).toEqual(['connect-src', 'img-src', 'worker-src']);
    for (const [, sources] of policy) {
      expect(sources).not.toContain('*');
      expect(sources).not.toContain("'unsafe-eval'");
      // `data:` stays an image source only.
    }
    expect([...policy].filter(([, sources]) => sources.includes('data:')).map(([name]) => name)).toEqual(['img-src']);
    expect(policy.get('default-src')).toEqual(["'self'"]);
    expect(policy.get('script-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(policy.get('connect-src')).toEqual(["'self'", 'wss:', 'ws:', 'https://api.github.com', 'blob:']);
  });

  it('is the one definition the header is built from, in a stable order', () => {
    expect(buildAppContentSecurityPolicy()).toBe(buildAppContentSecurityPolicy(APP_CSP_DIRECTIVES));
    expect(Object.keys(APP_CSP_DIRECTIVES)).toEqual(['default-src', 'script-src', 'style-src', 'connect-src', 'worker-src', 'img-src', 'font-src', 'frame-ancestors']);
  });
});
