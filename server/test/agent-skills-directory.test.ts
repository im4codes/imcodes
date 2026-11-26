import { describe, expect, it, vi } from 'vitest';
import { AGENT_SKILLS_DIRECTORY } from '../../shared/agent-skills.js';
import { createAgentSkillsDirectory } from '../src/services/agent-skills-directory.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('skills.sh directory', () => {
  it('returns only well-formed search results, most installed first', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      skills: [
        { skillId: 'wecomcli-doc', source: 'wecomteam/wecom-cli', installs: 21564 },
        { skillId: 'pdf', source: 'anthropics/skills', installs: 90000 },
        { skillId: 'Bad Name', source: 'a/b', installs: 5 },
        { skillId: 'evil', source: '--all', installs: 5 },
        { skillId: 'deep', source: 'a/b/c', installs: 5 },
        { skillId: 'no-count', source: 'x/y' },
      ],
    }));
    const directory = createAgentSkillsDirectory({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await directory.search('docs')).toEqual([
      { name: 'pdf', source: 'anthropics/skills', installs: 90000 },
      { name: 'wecomcli-doc', source: 'wecomteam/wecom-cli', installs: 21564 },
      { name: 'no-count', source: 'x/y', installs: 0 },
    ]);
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown as [string])[0]));
    expect(`${url.origin}${url.pathname}`).toBe(AGENT_SKILLS_DIRECTORY.SEARCH_URL);
    expect(url.searchParams.get('q')).toBe('docs');
  });

  it('reads each auditor\'s verdict and drops anything malformed', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      'wecomcli-doc': {
        ath: { risk: 'safe', analyzedAt: '2026-09-16T16:12:56.867Z' },
        socket: { risk: 'safe', alerts: 0, score: 90 },
        snyk: { risk: 'LOW' },
        '<script>': { risk: 'safe' },
        broken: { risk: 42 },
      },
      'not-asked-for': { ath: { risk: 'critical' } },
    }));
    const directory = createAgentSkillsDirectory({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await directory.audit('WeComTeam/wecom-cli', ['wecomcli-doc'])).toEqual({
      'wecomcli-doc': [
        { auditor: 'ath', risk: 'safe', analyzedAt: '2026-09-16T16:12:56.867Z' },
        { auditor: 'socket', risk: 'safe', score: 90 },
        { auditor: 'snyk', risk: 'low' },
      ],
    });
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown as [string])[0]));
    expect(url.searchParams.get('source')).toBe('WeComTeam/wecom-cli');
    expect(url.searchParams.get('skills')).toBe('wecomcli-doc');
  });

  it('asks skills.sh once per query within the cache window', async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => jsonResponse({ skills: [] }));
    const directory = createAgentSkillsDirectory({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now });
    await directory.search('Docs');
    await directory.search('docs');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 61_000;
    await directory.search('docs');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails rather than returning something it does not understand', async () => {
    for (const response of [jsonResponse({}, 500), jsonResponse({ unexpected: true })]) {
      const directory = createAgentSkillsDirectory({ fetchImpl: (async () => response) as unknown as typeof fetch });
      await expect(directory.search('anything')).rejects.toThrow();
    }
  });
});
