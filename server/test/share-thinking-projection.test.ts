import { describe, expect, it } from 'vitest';
import { filterShareDaemonMessage, type ShareScopedSocketState } from '../src/ws/share-policy.js';
import { TRANSPORT_EFFORT_LEVELS } from '../../shared/effort-levels.js';
import type { ShareTarget } from '../../shared/tab-sharing.js';

const serverId = 'share-thinking-server';
const parent = 'deck_proj_brain';
const child = 'deck_sub_child';
const targets: ShareTarget[] = [
  { kind:'server',serverId },
  { kind:'main',serverId,sessionName:parent },
  { kind:'subsession',serverId,subSessionId:'child' },
];
function socket(target: ShareTarget, role:'viewer'|'participant' = 'participant'): ShareScopedSocketState {
  return { userId:'shared-user',actorDisplayName:'Shared User',ticketId:'ticket',target,connectedAt:1,
    coveredSessionNames:target.kind==='main'?(target.sessionName===parent?[parent,child]:[target.sessionName]):undefined,
    snapshot:{target,effectiveRole:role,historyCutoffAt:0,nextCoverageRecheckAt:null,coveringShareIds:['share'],primaryShareId:'share',authorizedAt:1},
  };
}
function rows(effort:unknown) {
  return { name:child,state:'running',agentType:'codex-sdk',activeModel:'gpt-6.1-sol',effort,
    transportConfig:{env:{TOKEN:'must-not-leak'}},providerSessionId:'private-id',requestedModel:'private-request',
    planLabel:'private-plan',ccPreset:'private-preset',codexCreditsBalance:'99',
  };
}
function message(kind:'session_list'|'subsession.created', effort:unknown) {
  const row=rows(effort);
  return kind==='session_list'?{type:kind,sessions:[row]}:
    {type:kind,...row,id:'child',sessionName:child,parentSession:parent,sessionType:'codex-sdk'};
}
function projected(kind:'session_list'|'subsession.created', effort:unknown, state:ShareScopedSocketState) {
  const result=filterShareDaemonMessage(message(kind,effort),state);
  return kind==='session_list'?(result?.sessions as Array<Record<string,unknown>>)?.[0]:result;
}

describe.each(['session_list','subsession.created'] as const)('shared thinking projection: %s', kind => {
  it.each(targets)('keeps every bounded effort value for participant scope $kind', target => {
    for(const effort of TRANSPORT_EFFORT_LEVELS) {
      const row=projected(kind,effort,socket(target));
      expect(row?.effort).toBe(effort);
      for(const key of ['transportConfig','providerSessionId','requestedModel','planLabel','ccPreset','codexCreditsBalance']) {
        expect(row).not.toHaveProperty(key);
      }
    }
  });
  it.each(targets)('does not expand viewer configuration visibility for scope $kind', target => {
    expect(projected(kind,'max',socket(target,'viewer'))).not.toHaveProperty('effort');
  });
  it('refuses malformed, missing and unbounded effort values', () => {
    for (const effort of [undefined,null,'','HIGH','secret-token',{},['max'],'x'.repeat(10_000)]) {
      expect(projected(kind,effort,socket(targets[0]))).not.toHaveProperty('effort');
    }
  });
  it('keeps session-scope isolation', () => {
    const state=socket({kind:'main',serverId,sessionName:'deck_other_brain'});
    const result=filterShareDaemonMessage(message(kind,'max'),state);
    if(kind==='session_list')expect(result?.sessions).toEqual([]);
    else expect(result).toBeNull();
  });
  it('keeps the latest switched level through serial broadcasts and reconnect bootstrap', () => {
    for(const effort of ['max','xhigh','medium'] as const) {
      expect(projected(kind,effort,socket(targets[0]))?.effort).toBe(effort);
    }
    expect(projected(kind,'medium',socket(targets[0]))?.effort).toBe('medium');
  });
});
