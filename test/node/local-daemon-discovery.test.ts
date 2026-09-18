import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROLLED_NODE_LOCAL_DAEMON_CREDENTIAL_MAX_BYTES } from '../../shared/controlled-node-host-link.js';
import { discoverLocalDaemonServerIds, localUserHomes } from '../../src/node/local-daemon-discovery.js';

const SERVER_URL = 'https://im.example/';
const roots: string[] = [];

async function home(name: string, credential?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-local-daemon-'));
  roots.push(root);
  const dir = join(root, name);
  await mkdir(join(dir, '.imcodes'), { recursive: true });
  if (credential !== undefined) await writeFile(join(dir, '.imcodes', 'server.json'), credential);
  return dir;
}

function binding(serverId: unknown, workerUrl: string): string {
  return JSON.stringify({ serverId, token: `token-of-${String(serverId)}`, workerUrl, serverName: 'box', boundAt: 1 });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local daemon discovery', () => {
  it('returns only ids of daemons bound to this same server, de-duplicated and sorted', async () => {
    const homes = [
      await home('k', binding('daemon-k', 'https://im.example')),
      await home('ai', binding('daemon-ai', 'https://im.example/api/bind')),
      await home('other', binding('daemon-elsewhere', 'https://other.example')),
      await home('broken', '{not json'),
      await home('unsafe', binding('../etc/passwd', 'https://im.example')),
      await home('huge', ' '.repeat(CONTROLLED_NODE_LOCAL_DAEMON_CREDENTIAL_MAX_BYTES + 1)),
      await home('none'),
      await home('again', binding('daemon-k', 'https://im.example')),
    ];
    const ids = await discoverLocalDaemonServerIds({ serverUrl: SERVER_URL, homes });
    expect(ids).toEqual(['daemon-ai', 'daemon-k']);
    // Nothing but ids comes back: a token can never be forwarded from here.
    expect(ids.join(' ')).not.toContain('token');
  });

  it('looks in the system account and user homes of each platform', async () => {
    const linux = await localUserHomes('linux');
    expect(linux).toEqual(expect.arrayContaining([homedir(), '/root']));
    const mac = await localUserHomes('darwin');
    expect(mac).toEqual(expect.arrayContaining([homedir(), '/var/root']));
    expect(mac.some((path) => path.endsWith('/Shared'))).toBe(false);
  });
});
