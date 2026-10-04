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

  it('projects cancellation provenance for daemon notices and keeps missing reasons explicit', () => {
    const parsed = parseTaskPairNotification(
      '[IM.codes task tsk_cancel "Handoff context"] status=cancelled CANCEL reason="user stopped after review" executor=deck_exec auditor=deck_aud',
    );
    expect(parsed?.payload).toMatchObject({
<<<<<<< HEAD
      verb: 'CANCEL', toStatus: 'cancelled', cancelReason: 'user stopped after review', executor: 'deck_exec', auditor: 'deck_aud',
    });
    expect(parsed?.payload).not.toHaveProperty('cancelActor');
    expect(parsed?.payload).not.toHaveProperty('cancelSource');
    const old = parseTaskPairNotification('[IM.codes task tsk_old] CANCEL status=cancelled');
    expect(old?.payload).toMatchObject({ verb: 'CANCEL', toStatus: 'cancelled' });
    expect(old?.payload).not.toHaveProperty('cancelActor');
    expect(old?.payload).not.toHaveProperty('cancelSource');
=======
      verb: 'CANCEL', toStatus: 'cancelled', cancelActor: 'daemon', cancelSource: 'daemon',
      cancelReason: 'user stopped after review', executor: 'deck_exec', auditor: 'deck_aud',
    });
    const old = parseTaskPairNotification('[IM.codes task tsk_old] CANCEL status=cancelled');
    expect(old?.payload).toMatchObject({ verb: 'CANCEL', toStatus: 'cancelled', cancelActor: 'daemon', cancelSource: 'daemon' });
>>>>>>> 0803ccbc1 (feat(task-pairs): preserve cancellation provenance)
    expect(old?.payload).not.toHaveProperty('cancelReason');
  });
});
