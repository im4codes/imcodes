import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from '../../src/util/redact-secrets.js';

let seed = 0xC0FFEE;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed;
}
function pick(chars: string, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += chars[rand() % chars.length];
  return out;
}

const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const lower = 'abcdefghijklmnopqrstuvwxyz0123456789';
const hex = '0123456789abcdef';
const b64 = `${alnum}+/`;
const url = `${alnum}_-`;

// Prefixes assembled from short fragments so GitHub secret-scanning never
// sees a literal `sk_live_…`, `sk-ant-…`, etc. in source. The runtime
// concatenation produces the same shape the redactor regex must match.
const BEARER_PREFIX = 'Bea' + 'rer ';
const ANTHROPIC_PREFIX = 's' + 'k-' + 'ant-';
const GITHUB_PREFIX = 'g' + 'hp_';
const AWS_PREFIX = 'AK' + 'IA';
const GOOGLE_PREFIX = 'AI' + 'za';
const JWT_PREFIX = 'ey' + 'J';
const SLACK_PREFIX = 'x' + 'oxb-';
const STRIPE_PREFIX = 's' + 'k_' + 'live_';
const OPENAI_PREFIX = 'se' + 'ss-';

describe('redactSensitiveText generated corpus', () => {
  it('redacts 1000 generated examples for each baseline provider pattern', () => {
    const generators: Array<{ tag: string; make: () => string }> = [
      { tag: 'bearer', make: () => `${BEARER_PREFIX}${pick(`${url}.~+/:=`, 32)}` },
      { tag: 'anthropic_key', make: () => `${ANTHROPIC_PREFIX}${pick(url, 27)}A` },
      { tag: 'github_token', make: () => `${GITHUB_PREFIX}${pick(alnum, 30)}` },
      { tag: 'aws_key', make: () => `${AWS_PREFIX}${pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16)}` },
      { tag: 'google_key', make: () => `${GOOGLE_PREFIX}${pick(url, 34)}A` },
      { tag: 'jwt', make: () => `${JWT_PREFIX}${pick(url, 12)}.${JWT_PREFIX}${pick(url, 12)}.${pick(url, 18)}` },
      { tag: 'password', make: () => `password=${pick(`${lower}-_`, 16)}` },
      { tag: 'slack', make: () => `${SLACK_PREFIX}${pick(alnum, 18)}` },
      { tag: 'stripe', make: () => `${STRIPE_PREFIX}${pick(alnum, 24)}` },
      { tag: 'openai_session', make: () => `${OPENAI_PREFIX}${pick(alnum, 20)}` },
      { tag: 'gcp_pem', make: () => `-----BEGIN PRIVATE KEY-----\n${pick(b64, 80)}\n-----END PRIVATE KEY-----` },
      { tag: 'hex40', make: () => pick(hex, 40) },
      { tag: 'base64', make: () => pick(b64, 72) },
    ];
    for (const generator of generators) {
      for (let i = 0; i < 1000; i++) {
        const sample = generator.make();
        expect(redactSensitiveText(sample), `${generator.tag}:${sample}`).toContain(`[REDACTED:${generator.tag}]`);
      }
    }
  });
});
