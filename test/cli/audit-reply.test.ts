import { describe, expect, it, vi } from 'vitest';
import { runAuditReplyCommand, type AuditReplyCommandDeps } from '../../src/cli/audit-reply.js';

const CAPABILITY = 'A'.repeat(32);

function deps(patch: Partial<AuditReplyCommandDeps> = {}): AuditReplyCommandDeps {
  return {
    detectSender: vi.fn().mockResolvedValue('deck_sub_a'),
    resolveHookPort: vi.fn().mockResolvedValue(43210),
    readText: vi.fn((path: string) => path.endsWith('validations.json')
      ? JSON.stringify([{ kind: 'test', label: 'focused', outcome: 'passed', summary: '1 passed' }])
      : 'Reviewed.'),
    post: vi.fn().mockResolvedValue({ ok: true }),
    ...patch,
  };
}

const options = {
  attemptId: 'attempt-1',
  capability: CAPABILITY,
  verdict: 'PASS',
  findingsFile: 'findings.txt',
  validationsFile: 'validations.json',
};

describe('audit-reply CLI boundary', () => {
  it('binds the detected sender and submits one strict envelope', async () => {
    const d = deps();
    await expect(runAuditReplyCommand(options, d)).resolves.toBeUndefined();
    expect(d.post).toHaveBeenCalledWith(43210, expect.objectContaining({
      version: 'peer_audit_reply_v1',
      attemptId: 'attempt-1',
      verdict: 'PASS',
    }), 'deck_sub_a');
  });

  it('fails explicitly when daemon ingress is unavailable and has no fallback dependency', async () => {
    const d = deps({ resolveHookPort: vi.fn().mockResolvedValue(null) });
    await expect(runAuditReplyCommand(options, d)).rejects.toThrow('daemon ingress unavailable');
    expect(d.post).not.toHaveBeenCalled();
    expect(Object.keys(d)).not.toContain('sendKeys');
  });

  it('rejects missing sender and malformed/static-only PASS locally', async () => {
    await expect(runAuditReplyCommand(options, deps({ detectSender: vi.fn().mockResolvedValue('') })))
      .rejects.toThrow('managed current session');
    await expect(runAuditReplyCommand(options, deps({
      readText: vi.fn((path: string) => path.endsWith('validations.json') ? '[]' : 'Reviewed.'),
    }))).rejects.toThrow('insufficient_validation_evidence');
  });

  it('redacts the one-time capability from daemon and network errors', async () => {
    const rejected = deps({ post: vi.fn().mockResolvedValue({ ok: false, error: 'invalid_capability' }) });
    await expect(runAuditReplyCommand(options, rejected)).rejects.not.toThrow(CAPABILITY);
    const offline = deps({ post: vi.fn().mockRejectedValue(new Error('peer-audit daemon ingress unavailable')) });
    await expect(runAuditReplyCommand(options, offline)).rejects.not.toThrow(CAPABILITY);
  });
});
