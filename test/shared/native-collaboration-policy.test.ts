import { describe, expect, it } from 'vitest';
import {
  NATIVE_COLLABORATION_CLASSIFIER_MAX_CHARS,
  NATIVE_COLLABORATION_PARTICIPATION,
  NATIVE_COLLABORATION_POLICY_NOTICE_MARKER,
  NATIVE_COLLABORATION_POLICY_VERSION,
  NATIVE_COLLABORATION_TASK_SIGNALS as SIGNAL,
  NATIVE_COLLABORATION_UNCLASSIFIED_REASONS as UNCLASSIFIED_REASON,
  buildNativeCollaborationRerouteNotice,
  classifyNativeCollaborationRequest,
  denyNativeCollaborationGateUnavailable,
  formatNativeCollaborationPolicyNotice,
  formatNativeCollaborationSignals,
  readNativeCollaborationClassification,
} from '../../shared/native-collaboration-policy.js';

const task = NATIVE_COLLABORATION_PARTICIPATION.TASK;
const analysis = NATIVE_COLLABORATION_PARTICIPATION.ANALYSIS;
const unclassified = NATIVE_COLLABORATION_PARTICIPATION.UNCLASSIFIED;

describe('native collaboration task-participation policy', () => {
  it.each([
    // Task participation: every class the Brain must route through IM.codes.
    ['Implement the retry queue in src/daemon/send-tool.ts and add tests', SIGNAL.IMPLEMENTATION],
    ['Please fix the failing CI job and make it green', SIGNAL.IMPLEMENTATION],
    ['Investigate and repair the broken reconnect path', SIGNAL.IMPLEMENTATION],
    ['Write tests for the new parser', SIGNAL.IMPLEMENTATION],
    ['修复这个问题并补测试', SIGNAL.IMPLEMENTATION],
    ['负责实现这个功能', SIGNAL.IMPLEMENTATION],
    ['Audit the frozen bundle and report findings', SIGNAL.AUDIT],
    ['Re-audit the repaired revision', SIGNAL.AUDIT],
    ['Review the diff for regressions', SIGNAL.AUDIT],
    ['Run a peer audit on the latest changes', SIGNAL.AUDIT],
    ['复审上一轮的修复', SIGNAL.AUDIT],
    ['审计这个冻结包的改动', SIGNAL.AUDIT],
    ['Return PASS or REWORK with evidence', SIGNAL.TASK_VERDICT],
    ['Continue asg_n2a on tsk_n27 and record progress', SIGNAL.IMCODES_AUTHORITY],
    ['Call supervision_task_finish when validation passes', SIGNAL.IMCODES_AUTHORITY],
    ['Reply through peer_audit_reply for auto-audit-b2d1bd0aafbb18895b39f6e6', SIGNAL.IMCODES_AUTHORITY],
    ['git commit the result and push the branch', SIGNAL.REPOSITORY_GATE],
    ['Open a pull request with these changes', SIGNAL.REPOSITORY_GATE],
    ['Deploy to production after the build', SIGNAL.REPOSITORY_GATE],
    ['Restart the daemon on 211', SIGNAL.REPOSITORY_GATE],
    ['提交代码并推送到远端', SIGNAL.REPOSITORY_GATE],
    ['执行部署并验证', SIGNAL.REPOSITORY_GATE],
  ])('treats %j as task participation (%s)', (prompt, expectedSignal) => {
    const result = classifyNativeCollaborationRequest(prompt);
    expect(result.participation).toBe(task);
    expect(result.signals).toContain(expectedSignal);
  });

  it.each([
    // Analysis stays allowed: native agents remain useful and visible.
    'Search the codebase for every caller of drainResend and summarize them',
    'Explain how the transport relay projects tool calls',
    'Review the code in src/agent to understand the restore path',
    'Analyze why the previous fix failed and list hypotheses',
    'Summarize the audit findings from the last three rounds',
    'Compare two caching strategies and recommend one',
    'Why did the deploy fail yesterday? Read the logs',
    'how do they implement caching in this library',
    '分析部署日志里的超时原因',
    '分析这个功能的实现原理',
    '调研回滚原因并总结',
    '总结上一轮审计结论',
  ])('treats %j as analysis', (prompt) => {
    expect(classifyNativeCollaborationRequest(prompt)).toEqual({
      participation: analysis,
      signals: [],
      readOnlyDeclared: false,
    });
  });

  it('never lets a read-only declaration exempt negated or interrogative work wording from being analysis', () => {
    expect(classifyNativeCollaborationRequest('Read-only: investigate and fix-candidate analysis, then fix nothing'))
      .toMatchObject({ participation: analysis, readOnlyDeclared: true, signals: [] });
    expect(classifyNativeCollaborationRequest('只读分析：修复这个问题需要改哪些文件？不要修改'))
      .toMatchObject({ participation: analysis, readOnlyDeclared: true });

    // Read-only never neutralizes audit, verdict, authority or gates.
    expect(classifyNativeCollaborationRequest('Read-only audit of the frozen bundle'))
      .toMatchObject({ participation: task, readOnlyDeclared: true, signals: [SIGNAL.AUDIT] });
    expect(classifyNativeCollaborationRequest('read-only: decide PASS/REWORK'))
      .toMatchObject({ participation: task, signals: [SIGNAL.TASK_VERDICT] });
    expect(classifyNativeCollaborationRequest('do not modify anything, just continue tsk_abc123'))
      .toMatchObject({ participation: task, signals: [SIGNAL.IMCODES_AUTHORITY] });
    expect(classifyNativeCollaborationRequest('No code changes; git push the existing branch'))
      .toMatchObject({ participation: task, signals: [SIGNAL.REPOSITORY_GATE] });
  });

  it('reports every matched signal in a stable order', () => {
    const result = classifyNativeCollaborationRequest([
      'Fix tsk_n27, re-audit it, answer PASS or REWORK, then git push the branch',
      undefined,
    ]);
    expect(result.signals).toEqual([
      SIGNAL.IMCODES_AUTHORITY,
      SIGNAL.TASK_VERDICT,
      SIGNAL.REPOSITORY_GATE,
      SIGNAL.AUDIT,
      SIGNAL.IMPLEMENTATION,
    ]);
  });

  it('bounds classifier input without losing leading signals', () => {
    const long = `Implement the feature. ${'x'.repeat(NATIVE_COLLABORATION_CLASSIFIER_MAX_CHARS * 2)}`;
    expect(classifyNativeCollaborationRequest(long).participation).toBe(task);
  });

  it.each([
    // R1 fail-open counterexamples: common task imperatives.
    ['Add a retry queue and tests to the send tool'],
    ['Build the reconnect feature for the relay'],
    ['Create a migration for the queue table'],
    ['Remove the legacy drain path and update the callers'],
    ['Could you fix the login bug?'],
    ['Explore the relay, then implement the retry queue'],
    ['能不能帮我修复这个问题？'],
    ['新增一个重试队列'],
  ])('treats the task imperative %j as implementation', (prompt) => {
    expect(classifyNativeCollaborationRequest(prompt)).toMatchObject({
      participation: task, signals: [SIGNAL.IMPLEMENTATION],
    });
  });

  it('lets no read-only declaration anywhere cancel a conflicting directive', () => {
    expect(classifyNativeCollaborationRequest('Read-only analysis of the relay. Now implement the retry queue.'))
      .toMatchObject({ participation: task, readOnlyDeclared: true, signals: [SIGNAL.IMPLEMENTATION] });
    expect(classifyNativeCollaborationRequest('只读分析这个模块。然后修复这个问题'))
      .toMatchObject({ participation: task, readOnlyDeclared: true, signals: [SIGNAL.IMPLEMENTATION] });
    // Negated and genuinely interrogative work wording is not a directive.
    expect(classifyNativeCollaborationRequest('Do not implement anything; trace how reconnect replays pending messages'))
      .toMatchObject({ participation: analysis, signals: [] });
    expect(classifyNativeCollaborationRequest('How would you fix the login bug?'))
      .toMatchObject({ participation: analysis, signals: [] });
    // Gates are negatable too, and only in directive text.
    expect(classifyNativeCollaborationRequest('Read-only: explain the release flow. Do not git push anything.'))
      .toMatchObject({ participation: analysis, signals: [] });
  });

  it('reads the head AND the tail of oversized input, and never calls the unread middle analysis', () => {
    const filler = 'x'.repeat(NATIVE_COLLABORATION_CLASSIFIER_MAX_CHARS);
    expect(classifyNativeCollaborationRequest(`Explain the relay. ${filler} Now implement the retry queue.`))
      .toMatchObject({ participation: task, signals: [SIGNAL.IMPLEMENTATION] });
    expect(classifyNativeCollaborationRequest(`Explain the relay. ${filler} ${filler} Summarize it.`)).toEqual({
      participation: unclassified, signals: [], readOnlyDeclared: false,
      unclassifiedReason: UNCLASSIFIED_REASON.INPUT_TRUNCATED,
    });
  });

  it.each([
    ['Handle the flaky reconnect test', UNCLASSIFIED_REASON.UNRECOGNIZED_INSTRUCTION],
    ['Tidy up the imports in the relay', UNCLASSIFIED_REASON.UNRECOGNIZED_INSTRUCTION],
    ['Explore the module and tidy the imports', UNCLASSIFIED_REASON.UNRECOGNIZED_INSTRUCTION],
    ['The reconnect path in the relay.', UNCLASSIFIED_REASON.NO_ANALYSIS_INTENT],
    ['', UNCLASSIFIED_REASON.NO_ANALYSIS_INTENT],
    ['この関数を直してください', UNCLASSIFIED_REASON.UNRECOGNIZED_INSTRUCTION],
  ])('fails closed on %j as unclassified (%s)', (prompt, reason) => {
    expect(classifyNativeCollaborationRequest(prompt)).toEqual({
      participation: unclassified, signals: [], readOnlyDeclared: false, unclassifiedReason: reason,
    });
  });

  it.each([
    'Could you explain how the relay projects tool calls?',
    'I want you to explain the restore path in src/agent',
    'src/daemon/send-tool.ts: explain the retry logic',
    'The relay drops messages after reconnect. Find where the queue is flushed.',
    '- Find all callers of drainResend\n- Summarize their error handling',
    'Take a look at the logs and tell me what happened',
    'Check whether the retry queue is persisted',
    '请分析这个模块并总结',
  ])('keeps the analysis request %j allowed', (prompt) => {
    expect(classifyNativeCollaborationRequest(prompt)).toMatchObject({ participation: analysis, signals: [] });
  });

  it('reads classification metadata strictly', () => {
    const wire = formatNativeCollaborationSignals([SIGNAL.AUDIT, SIGNAL.IMPLEMENTATION]);
    expect(readNativeCollaborationClassification(task, wire)).toEqual({
      participation: task,
      signals: [SIGNAL.AUDIT, SIGNAL.IMPLEMENTATION],
    });
    expect(readNativeCollaborationClassification(analysis, '')).toEqual({ participation: analysis, signals: [] });
    expect(readNativeCollaborationClassification(unclassified, '')).toEqual({ participation: unclassified, signals: [] });
    expect(readNativeCollaborationClassification(unclassified, SIGNAL.AUDIT)).toBeUndefined();
    // Forged or malformed metadata is dropped rather than trusted.
    expect(readNativeCollaborationClassification(task, '')).toBeUndefined();
    expect(readNativeCollaborationClassification(task, 'made_up')).toBeUndefined();
    expect(readNativeCollaborationClassification(analysis, SIGNAL.AUDIT)).toBeUndefined();
    expect(readNativeCollaborationClassification('owner', SIGNAL.AUDIT)).toBeUndefined();
    expect(readNativeCollaborationClassification(undefined, undefined)).toBeUndefined();
  });

  it('builds a reroute notice naming the exact IM.codes route', () => {
    const denied = JSON.parse(buildNativeCollaborationRerouteNotice({
      provider: 'claude-code-sdk',
      toolName: 'Agent',
      signals: [SIGNAL.IMPLEMENTATION],
      enforcement: 'denied_before_execution',
    }));
    expect(denied).toMatchObject({
      policy: NATIVE_COLLABORATION_POLICY_VERSION,
      outcome: 'native_agent_task_participation_denied',
      signals: [SIGNAL.IMPLEMENTATION],
      requiredRoute: ['send_list_targets', 'send_message with task {objective, acceptance}'],
    });
    expect(denied).not.toHaveProperty('nativeAgentOutput');

    const observed = JSON.parse(buildNativeCollaborationRerouteNotice({
      provider: 'codex-sdk',
      toolName: 'spawn_agent',
      signals: [SIGNAL.AUDIT],
      enforcement: 'observed_after_start',
    }));
    expect(observed.outcome).toBe('native_agent_task_participation_turn_stopped');
    expect(observed.turn).toMatch(/stopped the turn/);
    expect(observed.nativeAgentOutput).toMatch(/re-dispatch the task through IM\.codes/);
    expect(observed).not.toHaveProperty('retry');
    expect(denied).not.toHaveProperty('retry');
  });

  it('builds the fail-closed decision of a gate that could not evaluate', () => {
    const decision = denyNativeCollaborationGateUnavailable({ provider: 'claude-code-sdk', toolName: 'Task' });
    expect(decision.allow).toBe(false);
    if (decision.allow) return;
    expect(decision.signals).toEqual([]);
    const [marker, header, ...body] = decision.reason.split('\n');
    expect(marker).toBe(NATIVE_COLLABORATION_POLICY_NOTICE_MARKER);
    expect(header).toBe('Trusted IM.codes runtime policy notice (not a user request).');
    const notice = JSON.parse(body.join('\n'));
    expect(notice).toMatchObject({
      policy: NATIVE_COLLABORATION_POLICY_VERSION,
      outcome: 'native_agent_request_denied_policy_unavailable',
      provider: 'claude-code-sdk',
      tool: 'Task',
      signals: [],
      requiredRoute: ['send_list_targets', 'send_message with task {objective, acceptance}'],
    });
    expect(notice.retry).toMatch(/read-only analysis/);
    expect(notice).not.toHaveProperty('nativeAgentOutput');
    expect(formatNativeCollaborationPolicyNotice('{"a":1}'))
      .toBe(`${NATIVE_COLLABORATION_POLICY_NOTICE_MARKER}\nTrusted IM.codes runtime policy notice (not a user request).\n{"a":1}`);
  });
});
