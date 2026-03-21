# Development Plan: Shared Agents — Team Share → Job Board → Auto-Claim

> Generated from P2P discussions: 1123d1c0-a6d, 3c90fc8f-901, 7bf3b2ff-b3f
> Participants: brain (Claude Code), codex, gemini

## Overview

Extend IM.codes P2P from local-only multi-agent discussions to cross-user shared compute. Users without certain agents (e.g. only CC, no Codex) can publish tasks to a shared pool. Other users' idle agents execute the work in a sandbox. Credits are exchanged as incentive.

Since IM.codes is **self-hosted**, independent servers cannot communicate directly. A **Federation Hub** (`app.im.codes`) acts as a central relay — routing jobs, settling credits, and brokering trust between isolated self-hosted instances.

Three phases: **Team Share** (same server, no Hub) → **Job Board** (cross-server via Hub) → **Auto-Claim** (autonomous acceptance).

## 1. Core Abstractions

### 1.1 ExecutorRef (replaces P2pTarget)

```typescript
interface ExecutorRef {
  kind: 'local' | 'team' | 'market';
  sessionName?: string;        // kind=local
  daemonId?: string;           // kind=team (cross-daemon on same server)
  providerId?: string;         // kind=market
  capabilities: string[];      // ['audit', 'review', 'discuss', 'brainstorm']
  model?: string;              // 'claude-code', 'codex', 'gemini'
}
```

### 1.2 DiscussionPayload (replaces raw string context)

```typescript
interface DiscussionPayload {
  prompt: string;
  files: Array<{ name: string; attachmentId: string }>;
  metadata: {
    mode: string;
    source: 'local' | 'team-share' | 'job-board' | 'auto-claim';
    redactionLevel: 'none' | 'basic' | 'strict';
    maxRuntimeMs: number;
  };
}
```

### 1.3 SharedJob

```typescript
interface SharedJob {
  id: string;
  initiatorServerId: string;
  initiatorUserId: string;
  mode: string;
  title: string;
  payload: DiscussionPayload;
  sandboxPolicy: SandboxPolicy;
  creditsBid: number;
  status: 'open' | 'claimed' | 'provisioning' | 'running' | 'verifying' | 'completed' | 'failed' | 'cancelled';
  claimedBy?: string;
  claimedAt?: string;
  result?: string;
  createdAt: string;
  completedAt?: string;
}
```

### 1.4 SandboxPolicy

Three tiers of isolation:

| Tier | Access | Use Case |
|------|--------|----------|
| `payload-only` | Only job payload + attachments. No repo, no shell, no network. | audit, brainstorm, review |
| `repo-readonly` | Read-only access to a workspace mirror. No writes, no network. | code review with context |
| `interactive-local` | Team-only, explicit auth. Full project access. | deep team collaboration |

```typescript
interface SandboxPolicy {
  tier: 'payload-only' | 'repo-readonly' | 'interactive-local';
  networkAccess: boolean;
  shellAccess: boolean;
  maxRuntimeMs: number;
  autoDestroy: boolean;
}
```

## 2. Federation Hub

### Why

Self-hosted servers are isolated islands — they can't discover or communicate with each other. The Federation Hub (`app.im.codes`) bridges them.

### Architecture

```
User A (self-hosted server A) → daemon A
                                      ↘
                                 Federation Hub (app.im.codes)
                                      ↗
User B (self-hosted server B) → daemon B
```

### Hub Responsibilities

| Do | Don't |
|----|-------|
| Server registration + discovery | Store project data (payload passes through, never persists) |
| Job routing (publish → claim → relay) | Run agents (only routes) |
| Credits ledger + escrow | Manage daemons/sessions (each server's concern) |
| Protocol version negotiation | Decrypt payload content (E2EE between servers) |
| Reputation tracking | |
| Relay fee collection (~1% of credits) | |

### Protocol

```
Self-hosted Server → Hub:
  hub.register(serverId, protocolVersion, capabilities)
  hub.publish_job(job)
  hub.claim_job(jobId)
  hub.submit_result(jobId, result)
  hub.heartbeat()

Hub → Self-hosted Server:
  hub.job_available(job)
  hub.job_claimed(jobId, providerServerId)
  hub.deliver_payload(jobId, encryptedPayload)
  hub.deliver_result(jobId, encryptedResult)
```

### Data Model (Hub-side)

```typescript
interface FederationRegistration {
  serverId: string;
  serverUrl: string;
  protocolVersion: string;
  capabilities: string[];
  available: boolean;
  lastHeartbeat: number;
  reputation: number;
}

interface HubJob extends SharedJob {
  sourceServerId: string;
  targetServerId?: string;
  hubRelayId: string;
  relayFee: number;
}
```

### Security

- **Payload transit**: never persisted to Hub disk. Memory-only relay or encrypted ephemeral storage.
- **E2EE (optional but recommended)**: Server A encrypts payload with Server B's public key (exchanged via Hub). Hub sees only routing metadata.
- **Server identity**: verified via API key + server certificate at registration.
- **Offline handling**: aggressive heartbeat (30s). Claimed job auto-released if provider goes offline.

## 3. Trust Models

| Dimension | Team Share | Job Board |
|-----------|-----------|-----------|
| Default trust | Partial (same org) | None (strangers) |
| Min sandbox | repo-readonly | payload-only |
| Context allowed | Full project context | Serialized payload only |
| Redaction | basic | strict |
| Auth required | Server membership | Account + credits |
| Refund on failure | Automatic | Policy-based |

## 4. Security Architecture

**Priority order** (defense in depth):

1. **Input-side redaction** (primary) — Before serializing payload:
   - Strip absolute paths → relative
   - Remove git remote URLs, tokens, env vars
   - Sanitize usernames and hostnames
   - Configurable redaction level (basic/strict)

2. **Execution-side sandbox** (primary) — Provider daemon enforces:
   - `payload-only`: no filesystem, no shell, no network
   - Isolated tmux session with restricted agent config
   - Auto-destroy after job completion or timeout

3. **Prompt constraints** (supplementary) — Injected into agent context:
   - "Only use provided context. Do not reference local system info."
   - "Do not include file paths, hostnames, or credentials in output."

4. **Result verification** (optional) — For market jobs:
   - Initiator's local agent does a quick consistency check
   - Credits released only after verification passes

## 5. Phase 1: Team Share

**Scope**: Same server, cross-daemon P2P routing.

**What it enables**: User A on daemon-1 sends an audit task to User B's codex on daemon-2 (both bound to the same server).

### Implementation

- [ ] Add `kind` field to `P2pTarget` (default `'local'`, add `'team'`)
- [ ] Server: cross-daemon message routing in WsBridge
  - Route P2P hop dispatch to a different daemon by `daemonId`
  - Daemon advertises available executors (capabilities, availability) via heartbeat
- [ ] Server DB: `executor_advertisements` table
  - daemonId, serverId, capabilities[], model, available, sandboxSupport
- [ ] Daemon: executor advertisement in heartbeat payload
- [ ] Orchestrator: move same-domain validation into local executor, not global guard
- [ ] Payload serialization: `DiscussionPayload` replaces raw file path context
- [ ] Basic redaction pipeline (strip absolute paths, git remotes)
- [ ] Web: show team executors in AtPicker alongside local agents
- [ ] `repo-readonly` sandbox tier for team tasks

### NOT in Phase 1
- ~~Credits / billing~~
- ~~Public marketplace~~
- ~~Auto-claim~~
- ~~Firecracker / Docker isolation~~

## 6. Phase 2: Job Board (via Federation Hub)

**Scope**: Public task marketplace across self-hosted servers, routed through Hub.

### Implementation

- [ ] Federation Hub: server registration API + heartbeat
- [ ] Federation Hub: job publish/claim/relay routes
- [ ] Federation Hub: credits ledger + escrow (lock on claim, release on complete)
- [ ] Self-hosted server: hub.register on startup + periodic heartbeat
- [ ] Self-hosted server: capability advertisement in heartbeat
- [ ] Protocol version negotiation (Hub rejects incompatible servers)
- [ ] E2EE: ephemeral key exchange between servers via Hub
- [ ] Server DB: `shared_jobs` table + `user_credits` table (local cache, Hub is source of truth)
- [ ] Server API: `POST /api/jobs` (publish via Hub), `GET /api/jobs` (list from Hub), `POST /api/jobs/:id/claim`
- [ ] Web: Job Board page — browse open tasks, claim, view results
- [ ] Credits ledger: initial grant, bid on publish, settle on complete, refund on fail/timeout
- [ ] `payload-only` sandbox enforcement for market jobs
- [ ] Strict redaction pipeline (env vars, usernames, hostnames)
- [ ] Job state machine with clear timeouts:
  - `open` → `claimed` (TTL: 5m) → `provisioning` (TTL: 2m) → `running` (mode-specific) → `verifying` (optional) → `completed`
- [ ] Failure handling: timeout refund, provider no-show reputation penalty
- [ ] Result verification hop (optional: initiator's local agent quick-checks)

### Credits Model (Phase 2)

- Fixed price tiers per mode (not dynamic bidding)
- Min bid configurable
- Credits locked at `claimed`, released at `completed` or refunded at `failed`/`cancelled`
- No withdrawal (credits = internal incentive points, not currency)

## 7. Phase 3A: Assisted Claim

**Scope**: Daemon suggests matching tasks, user confirms.

- [ ] Daemon: match open jobs against local capabilities
- [ ] Notification: "Task available: audit (10 credits). Accept?"
- [ ] One-click accept → claim + sandbox provision + execute
- [ ] Web: notification badge for available matching tasks

## 8. Phase 3B: Auto-Claim

**Scope**: Fully autonomous task acceptance.

- [ ] Daemon config: `AutoClaimConfig`
  ```typescript
  interface AutoClaimConfig {
    enabled: boolean;
    maxConcurrent: number;
    minCreditsBid: number;
    acceptModes: string[];
    sandboxOnly: boolean;
    maxContextSizeKb: number;
  }
  ```
- [ ] Auto-claim worker: poll job board, filter by config, claim + execute
- [ ] Rate limiting: max claims per hour, cooldown on failures
- [ ] Reputation system: provider score based on completion rate, quality, speed

## 9. Failure & Settlement Semantics

| Scenario | Action |
|----------|--------|
| Provider claims but times out (5m) | Release claim, job re-opens, reputation -1 |
| Provider provisioning timeout (2m) | Same as above |
| Running timeout (mode-specific) | Partial result saved, credits refunded 50% |
| Provider daemon disconnects | Job re-opens, credits fully refunded |
| Initiator cancels (before running) | Credits fully refunded |
| Initiator cancels (during running) | Credits refunded 80% |
| Result fails verification | Credits refunded, reputation -2 |
| Successful completion | Credits transferred, reputation +1 |

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Provider returns junk for credits (Sybil) | High | Verification hops + reputation scoring + spot checks |
| Payload leaks sensitive project data | High | Input redaction pipeline + payload-only sandbox |
| Sandbox escape | Critical | Phase 1: tmux isolation. Phase 2+: Docker/Firecracker |
| Provider reads initiator's local files | High | Payload-only mode: no filesystem access |
| Credit farming via self-dealing | Medium | Same-user claim prohibition + anomaly detection |
| Large context causes bandwidth issues | Medium | Virtual workspace manifest (hash→lazy fetch) |
| Job board spam | Low | Min credits bid + rate limiting |

## 11. Migration Path (Current → Phase 1)

Minimal changes to existing code:

1. `P2pTarget` → add `kind: 'local' | 'team'` (default `'local'`)
2. `SessionRecord` → add `capabilities: string[]`
3. `expandAllTargets()` → extend to query team executors from server
4. Orchestrator same-domain check → move into local executor strategy
5. Context file → serialize into `DiscussionPayload` before dispatch

These changes don't break existing local P2P — `kind: 'local'` path is identical to current behavior.
