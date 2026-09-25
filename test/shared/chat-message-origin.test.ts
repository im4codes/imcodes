import { describe, expect, it } from 'vitest';
import {
  CHAT_MESSAGE_ORIGINS,
  USER_MESSAGE_ORIGIN_FIELDS,
  classifyUserMessageOrigin,
} from '../../shared/chat-message-origin.js';
import {
  AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER,
  AGENT_DELEGATION_SENDER_MARKER,
} from '../../shared/agent-delegation.js';
import { CRON_CONTROL_PROTOCOL, CRON_RUN_TIMELINE } from '../../shared/cron-types.js';
import { TASK_PAIR_AUTOMATION_KIND } from '../../shared/task-pair.js';
import { SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND } from '../../shared/supervision-config.js';

const agentDelivery = (text: string) =>
  `${AGENT_DELEGATION_SENDER_MARKER}\nMessage from IM.codes session: deck_sub_0g0i8s4f (label: Cx2)\n\n${text}`;

describe('classifyUserMessageOrigin', () => {
  it('keeps the human own input as user, from any client', () => {
    expect(classifyUserMessageOrigin({ text: 'please fix the login page' })).toBe(CHAT_MESSAGE_ORIGINS.USER);
    // web/mobile sends carry a commandId; voice and resends look the same on the timeline
    expect(classifyUserMessageOrigin({ text: '语音输入：修一下登录页', commandId: 'cmd_1' })).toBe(CHAT_MESSAGE_ORIGINS.USER);
    expect(classifyUserMessageOrigin({ text: 'a\nb', batchedCount: 2, allowDuplicate: true })).toBe(CHAT_MESSAGE_ORIGINS.USER);
    // another human in a shared tab is still a human
    expect(classifyUserMessageOrigin({ text: 'hi', sharedActor: { actorDisplayName: 'Ann' } })).toBe(CHAT_MESSAGE_ORIGINS.USER);
    expect(classifyUserMessageOrigin(undefined)).toBe(CHAT_MESSAGE_ORIGINS.USER);
  });

  it('keeps a human message that merely mentions a protocol marker as user', () => {
    expect(classifyUserMessageOrigin({ text: `why did ${AGENT_DELEGATION_SENDER_MARKER} show up?` }))
      .toBe(CHAT_MESSAGE_ORIGINS.USER);
    expect(classifyUserMessageOrigin({ text: 'what does automation: true mean?' })).toBe(CHAT_MESSAGE_ORIGINS.USER);
  });

  it('classifies agent-to-agent deliveries as agent', () => {
    expect(classifyUserMessageOrigin({ text: agentDelivery('收到，本次复审已结束。') })).toBe(CHAT_MESSAGE_ORIGINS.AGENT);
    expect(classifyUserMessageOrigin({ text: agentDelivery('ok'), sharedActor: { actorDisplayName: 'Cx2' } }))
      .toBe(CHAT_MESSAGE_ORIGINS.AGENT);
    expect(classifyUserMessageOrigin({ text: `${AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER}\nDelegation ID: x` }))
      .toBe(CHAT_MESSAGE_ORIGINS.AGENT);
  });

  it('classifies daemon injections as system', () => {
    for (const payload of [
      { text: 'Heartbeat', automation: true, automationKind: SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND },
      { text: 'nudge', automation: true, automationKind: TASK_PAIR_AUTOMATION_KIND },
      { text: 'provisioning', automationKind: 'supervision-provisioning' },
      { text: 'run the report', [CRON_RUN_TIMELINE.PAYLOAD_KEY]: { scheduleId: 's1' } },
      { text: `${CRON_CONTROL_PROTOCOL.OPEN_TAG}id="x">run</imcodes-cron-control>` },
      { text: 'discuss', p2pRunId: 'run_1', p2pDiscussionId: 'd1' },
      { text: 'implement the change', commandId: 'cmd_2', [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.SYSTEM },
    ]) {
      expect(classifyUserMessageOrigin(payload), JSON.stringify(payload)).toBe(CHAT_MESSAGE_ORIGINS.SYSTEM);
    }
  });

  it('ignores an unknown origin stamp', () => {
    expect(classifyUserMessageOrigin({ text: 'hi', [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: 'robot' })).toBe(CHAT_MESSAGE_ORIGINS.USER);
  });
});
