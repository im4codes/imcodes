import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(new URL('../../src/daemon/history-retention-clock.mjs', import.meta.url));
function inZone(zone: string, expression: string): unknown {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {nextHistoryCleanupAt as next} from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(${expression}));`],
  { env: { ...process.env, TZ: zone }, encoding: 'utf8' }));
}

describe('server local 03:00 calendar schedule', () => {
  it('waits until next 03:00, including equal time, month/year rollovers and daemon-local timezone', () => {
    for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
      expect(inZone(zone, `[
        new Date(next(new Date(2040,11,31,2,59,59,999).getTime())).toString().includes('03:00:00'),
        new Date(next(new Date(2040,11,31,3).getTime())).getFullYear(),
        new Date(next(new Date(2040,11,31,3).getTime())).getDate(),
        next(new Date(2040,11,31,2).getTime())-new Date(2040,11,31,2).getTime()
      ]`)).toEqual([true, 2041, 1, 3_600_000]);
    }
  });

  it('DST spring/fall remain calendar 03:00, not a drifting 24h timer', () => {
    expect(inZone('America/New_York', `[
      (next(new Date(2026,2,7,3).getTime())-new Date(2026,2,7,3).getTime())/3600000,
      (next(new Date(2026,9,31,3).getTime())-new Date(2026,9,31,3).getTime())/3600000
    ]`)).toEqual([23, 25]);
    // Helsinki skips 03:00 in spring and repeats it in autumn. Normalize the
    // missing slot forward and never repeat the fall-back slot on that day.
    expect(inZone('Europe/Helsinki', `[
      new Date(next(new Date(2026,2,29,2).getTime())).getHours(),
      new Date(next(new Date(2026,9,25,3,30).getTime())).getDate(),
      new Date(next(new Date(2026,9,25,3,30).getTime())).getHours()
    ]`)).toEqual([4, 26, 3]);
  });
});
