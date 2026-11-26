import {
  DIRECT_CONNECTIVITY_CANDIDATE_TYPE,
  type DirectConnectivityCandidateType,
  type DirectFileTransferIceServerConfig,
} from './direct-file-transfer.js';

/** Browser-compatible shape kept DOM-free so daemon/server/shared tests may import it. */
export interface WebRtcIceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export function toWebRtcIceServers(
  iceServers: readonly DirectFileTransferIceServerConfig[],
): WebRtcIceServerConfig[] {
  return iceServers.map((entry) => typeof entry === 'string'
    ? { urls: entry }
    : {
        urls: [...entry.urls],
        ...(entry.username ? { username: entry.username } : {}),
        ...(entry.credential ? { credential: entry.credential } : {}),
      });
}

/** Parse the standardized `typ` token without retaining the candidate address. */
export function readWebRtcCandidateType(
  candidate: string,
  declaredType?: string | null,
): DirectConnectivityCandidateType | null {
  const rawType = declaredType?.toLowerCase()
    ?? /\btyp\s+([a-z0-9_-]+)/i.exec(candidate)?.[1]?.toLowerCase();
  return Object.values(DIRECT_CONNECTIVITY_CANDIDATE_TYPE).includes(
    rawType as DirectConnectivityCandidateType,
  )
    ? rawType as DirectConnectivityCandidateType
    : null;
}

/** Queue ICE until the remote description is installed, then flush in arrival order. */
export class PendingWebRtcCandidates<T> {
  private readonly values: T[] = [];

  get size(): number {
    return this.values.length;
  }

  push(candidate: T): void {
    this.values.push(candidate);
  }

  async flush(add: (candidate: T) => void | Promise<void>): Promise<void> {
    while (this.values.length > 0) {
      const candidate = this.values.shift();
      if (candidate !== undefined) await add(candidate);
    }
  }

  clear(): void {
    this.values.length = 0;
  }
}
