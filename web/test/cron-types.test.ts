/**
 * @vitest-environment jsdom
 *
 * Tests for cron shared types imported via @shared alias in web.
 */
import { describe, it, expect } from 'vitest';
import { CRON_STATUS, CRON_MSG, type CronAction, type CronJobStatus } from '@shared/cron-types';

describe('Cron shared types — web import', () => {
  it('CRON_STATUS has all expected statuses', () => {
    expect(CRON_STATUS.ACTIVE).toBe('active');
    expect(CRON_STATUS.PAUSED).toBe('paused');
    expect(CRON_STATUS.EXPIRED).toBe('expired');
    expect(CRON_STATUS.ERROR).toBe('error');
  });

  it('CRON_MSG has dispatch type', () => {
    expect(CRON_MSG.DISPATCH).toBe('cron.dispatch');
  });

  it('CronAction discriminated union accepts command type', () => {
    const action: CronAction = { type: 'command', command: 'run tests' };
    expect(action.type).toBe('command');
    if (action.type === 'command') {
      expect(action.command).toBe('run tests');
    }
  });

  it('CronAction discriminated union accepts p2p type', () => {
    const action: CronAction = {
      type: 'p2p',
      topic: 'review code',
      mode: 'review',
      participants: ['w1', 'w2'],
      rounds: 2,
    };
    expect(action.type).toBe('p2p');
    if (action.type === 'p2p') {
      expect(action.participants).toEqual(['w1', 'w2']);
      expect(action.rounds).toBe(2);
    }
  });

  it('CronJobStatus type accepts valid statuses', () => {
    const statuses: CronJobStatus[] = ['active', 'paused', 'expired', 'error'];
    expect(statuses).toHaveLength(4);
  });
});
