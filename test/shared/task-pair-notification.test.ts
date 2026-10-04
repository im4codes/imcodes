import { describe, expect, it } from 'vitest';
import { parseTaskPairNotification } from '../../shared/task-pair-notification.js';

describe('task-pair notification thinking metadata', () => {
  it('keeps thinking levels from marker attributes when the assistant body has no prose fields', () => {
    const parsed = parseTaskPairNotification(
      '[IM.codes task tsk_attrs "Thinking attrs"]\n'
        + '<!-- IMCODES_TASK DISPATCH tsk_attrs executor=deck_exec auditor=deck_aud executorthinking=high auditorthinking=medium -->',
    );
    expect(parsed?.payload).toMatchObject({
      executor: 'deck_exec',
      auditor: 'deck_aud',
      executorThinking: 'high',
      auditorThinking: 'medium',
    });
  });

  it('leaves missing thinking unset for old notices instead of inventing a level', () => {
    const parsed = parseTaskPairNotification(
      '[IM.codes task tsk_legacy "Legacy"]\n'
        + '<!-- IMCODES_TASK DISPATCH tsk_legacy executor=deck_exec auditor=deck_aud -->',
    );
    expect(parsed?.payload).not.toHaveProperty('executorThinking');
    expect(parsed?.payload).not.toHaveProperty('auditorThinking');
  });
});
