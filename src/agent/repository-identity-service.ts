import { createHash } from 'node:crypto';
import type { CanonicalRepositoryId, RepositoryAlias } from '../../shared/context-types.js';
import { parseRemoteUrl } from '../repo/detector.js';

export interface RepositoryIdentityInput {
  cwd?: string;
  originUrl?: string | null;
}

export interface RepositoryIdentityService {
  resolve(input: RepositoryIdentityInput): CanonicalRepositoryId;
  buildAlias(originUrl: string): RepositoryAlias | null;
  buildExplicitMigrationAlias(canonicalKey: string, aliasOriginUrl: string): RepositoryAlias | null;
}

function sha(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}

function canonicalPart(value: string): string {
  return value.trim().toLowerCase();
}

type CanonicalParts = {
  host: string;
  owner: string;
  repo: string;
};

export function parseCanonicalRepositoryKey(key: string): CanonicalParts | null {
  const trimmed = key.trim();
  const match = /^([^/]+)\/([^/]+)\/([^/]+)$/.exec(trimmed);
  if (!match) return null;
  return {
    host: canonicalPart(match[1]),
    owner: canonicalPart(match[2]),
    repo: canonicalPart(match[3]),
  };
}

export class GitOriginRepositoryIdentityService implements RepositoryIdentityService {
  resolve(input: RepositoryIdentityInput): CanonicalRepositoryId {
    const originUrl = input.originUrl?.trim();
    if (originUrl) {
      const parsed = parseRemoteUrl(originUrl);
      if (parsed) {
        const host = canonicalPart(parsed.host);
        const owner = canonicalPart(parsed.owner);
        const repo = canonicalPart(parsed.repo);
        return {
          kind: 'git-origin',
          key: `${host}/${owner}/${repo}`,
          host,
          owner,
          repo,
          originUrl,
        };
      }
    }

    const cwd = input.cwd?.trim() || 'unknown-cwd';
    return {
      kind: 'local-fallback',
      key: `local/${sha(cwd)}`,
      originUrl: undefined,
    };
  }

  buildAlias(originUrl: string): RepositoryAlias | null {
    const canonical = this.resolve({ originUrl });
    if (canonical.kind !== 'git-origin') return null;
    return {
      aliasKey: originUrl.trim(),
      canonicalKey: canonical.key,
      reason: 'ssh-https-equivalent',
    };
  }

  buildExplicitMigrationAlias(canonicalKey: string, aliasOriginUrl: string): RepositoryAlias | null {
    const canonical = parseCanonicalRepositoryKey(canonicalKey);
    const alias = parseRemoteUrl(aliasOriginUrl.trim());
    if (!canonical || !alias) return null;
    if (canonical.owner !== canonicalPart(alias.owner) || canonical.repo !== canonicalPart(alias.repo)) return null;
    return {
      aliasKey: aliasOriginUrl.trim(),
      canonicalKey,
      reason: 'explicit-migration',
    };
  }
}
