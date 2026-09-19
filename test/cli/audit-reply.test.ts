import { describe, expect, it, vi } from 'vitest';
import { runAuditReplyCommand, type AuditReplyCommandDeps } from '../../src/cli/audit-reply.js';

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
  taskId: 'supervision_task_1',
  assignmentId: 'supervision_assignment_1',
  attemptId: 'attempt-1',
  revision: 'revision-1',
  receiptKind: 'final',
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
      taskId: 'supervision_task_1',
      assignmentId: 'supervision_assignment_1',
      attemptId: 'attempt-1',
      revision: 'revision-1',
      receiptKind: 'final',
      verdict: 'PASS',
    }), 'deck_sub_a');
    expect(vi.mocked(d.post).mock.calls[0]?.[1]).not.toHaveProperty('replyCapability');
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

  it('surfaces structured daemon and network errors without a token fallback', async () => {
    const rejected = deps({ post: vi.fn().mockResolvedValue({ ok: false, error: 'attempt_mismatch' }) });
    await expect(runAuditReplyCommand(options, rejected)).rejects.toThrow('attempt_mismatch');
    const offline = deps({ post: vi.fn().mockRejectedValue(new Error('peer-audit daemon ingress unavailable')) });
    await expect(runAuditReplyCommand(options, offline)).rejects.toThrow('daemon ingress unavailable');
  });
});
