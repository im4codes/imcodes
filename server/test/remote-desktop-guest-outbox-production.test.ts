import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Database } from '../src/db/client.js';
import {
  PostgresRemoteDesktopGuestOutboxDeliveryAdapter,
  RemoteDesktopGuestBackgroundRuntime,
  reconcileRemoteDesktopEndpointOnReconnect,
  type RemoteDesktopGuestOutboxEnvelope,
  type RemoteDesktopGuestOutboxExecutionTarget,
} from '../src/services/remote-desktop-guest-outbox-worker.js';

function routeEvent(overrides: Partial<RemoteDesktopGuestOutboxEnvelope> = {}): RemoteDesktopGuestOutboxEnvelope {
  return {
    id: 'effect-1',
    idempotencyKey: 'link-1:2:1000',
    sequence: 1,
    authorityKind: 'link',
    effect: 'terminal',
    scope: 'route',
    hostId: 'host-1',
    targetServerId: 'server-1',
    targetRouteId: 'route-1',
    actorAuditId: 'audit-link-1',
    authorityGeneration: 4,
    expiryRevision: 2,
    commitRevision: 5,
    routeGeneration: 7,
    createdAt: 1_000,
    sloAnchorAt: 1_000,
    retainUntil: 20_000,
    attempt: 1,
    ...overrides,
  } as RemoteDesktopGuestOutboxEnvelope;
}

function hostEvent(): RemoteDesktopGuestOutboxEnvelope {
  return routeEvent({
    scope: 'host',
    targetServerId: null,
    targetRouteId: null,
    routeGeneration: null,
    actorAuditId: 'link:link-1',
  });
}

function passwordEvent(overrides: Partial<RemoteDesktopGuestOutboxEnvelope> = {}): RemoteDesktopGuestOutboxEnvelope {
  return {
    id: 'password-effect-1',
    idempotencyKey: 'password-terminal:host-1:5:route-password-1:7',
    sequence: 2,
    authorityKind: 'password',
    effect: 'terminal',
    scope: 'route',
    hostId: 'host-1',
    targetServerId: 'server-1',
    targetRouteId: 'route-password-1',
    actorAuditId: 'password-audit-1',
    sessionAuditId: 'password-session-1',
    passwordGeneration: 5,
    routeGeneration: 7,
    createdAt: 1_000,
    sloAnchorAt: 1_000,
    retainUntil: 20_000,
    attempt: 1,
    ...overrides,
  } as RemoteDesktopGuestOutboxEnvelope;
}

class ProductionAdapterDb {
  now = 1_500;
  endpoints = ['server-1'];
  liveHostRoutes: Array<Record<string, unknown>> = [];
  reconnectRoutes: Array<{ host_id: string; route_id: string; route_generation: number }> = [];
  routeAuthority: Record<string, unknown> | null = {
    route_state: 'active',
    session_state: 'active',
    actor_audit_id: 'audit-link-1',
    execution_server_id: 'server-1',
    session_authority_generation: 4,
    session_expiry_revision: 2,
    link_id: 'link-1',
    link_state: 'expired',
    link_access_mode: 'control',
    link_authority_generation: 4,
    link_expiry_revision: 2,
    link_commit_revision: 5,
    link_expires_at: 1_000,
  };
  hostAuthority: Record<string, unknown> | null = {
    link_id: 'link-1', state: 'expired', authority_generation: 4,
    expiry_revision: 2, commit_revision: 5,
  };
  closed: string[] = [];

  private normalize(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const normalized = this.normalize(sql);
    if (normalized.includes('clock_timestamp()')) return { now_ms: this.now } as T;
    if (normalized.includes('from remote_desktop_host_routes as routes')
      && normalized.includes('join remote_desktop_guest_sessions as sessions')) {
      const [_routeId, generation] = params;
      if (generation !== 7) return null;
      return this.routeAuthority as T | null;
    }
    if (normalized.includes('from remote_desktop_guest_links')
      && normalized.includes("('link:' || id)")) return this.hostAuthority as T | null;
    if (normalized.includes('from remote_desktop_host_endpoints')) {
      const [serverId, hostId] = params;
      return this.endpoints.includes(String(serverId)) && hostId === 'host-1'
        ? { host_id: 'host-1' } as T
        : null;
    }
    if (normalized.includes('from remote_desktop_management_privacy')) return null;
    throw new Error(`Unhandled queryOne: ${normalized}`);
  }

  async query<T>(sql: string): Promise<T[]> {
    const normalized = this.normalize(sql);
    if (normalized.includes('from remote_desktop_host_endpoints')) {
      return this.endpoints.map((server_id) => ({ server_id })) as T[];
    }
    if (normalized.includes('join remote_desktop_guest_sessions as sessions')) {
      return this.liveHostRoutes as T[];
    }
    if (normalized.includes('where execution_server_id = $1')) {
      return this.reconnectRoutes as T[];
    }
    throw new Error(`Unhandled query: ${normalized}`);
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const normalized = this.normalize(sql);
    if (normalized.startsWith('update remote_desktop_host_routes')) {
      this.closed.push(`${String(params[0])}:${String(params[1])}`);
      return { changes: 1 };
    }
    if (normalized.startsWith('update remote_desktop_guest_sessions')) return { changes: 1 };
    throw new Error(`Unhandled execute: ${normalized}`);
  }

  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return fn(this as unknown as Database);
  }

  asDatabase(): Database {
    return this as unknown as Database;
  }
}

function target(available = true) {
  const apply = vi.fn<RemoteDesktopGuestOutboxExecutionTarget['apply']>(() => ({ status: 'applied' }));
  return {
    value: { isAvailable: () => available, apply } satisfies RemoteDesktopGuestOutboxExecutionTarget,
    apply,
  };
}

describe('remote desktop guest outbox production adapter', () => {
  it('wires one due/outbox/listener runtime into Server startup and graceful shutdown', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain('new RemoteDesktopGuestDueWorker(');
    expect(source).toContain('new PostgresRemoteDesktopGuestOutboxListener(envConfig.DATABASE_URL)');
    expect(source).toContain('new RemoteDesktopGuestOutboxWorker(');
    expect(source).toContain('await guestBackgroundRuntime.start()');
    expect(source).toContain('await guestBackgroundRuntime.stop()');
    expect(source.indexOf('await guestBackgroundRuntime.start()'))
      .toBeLessThan(source.indexOf('const app = buildApp(env)'));
    expect(source).toContain('new RemoteDesktopManagementPrivacyWorker(');
    expect(source).toContain('setRemoteDesktopManagementPrivacyDispatcher((command) =>');
    expect(source).toContain('managementPrivacyWorker.start()');
    expect(source).toContain('managementPrivacyWorker.stop()');
    expect(source).toContain('setRemoteDesktopManagementPrivacyDispatcher(null)');
    expect(source.indexOf('managementPrivacyWorker.start()'))
      .toBeLessThan(source.indexOf('const app = buildApp(env)'));
  });

  it('leaves route effects pending on wrong pod or route generation', async () => {
    const db = new ProductionAdapterDb();
    const absent = new PostgresRemoteDesktopGuestOutboxDeliveryAdapter(db.asDatabase(), () => null);
    expect(await absent.ownsTarget('server-1', routeEvent())).toBe(false);

    const local = target();
    const adapter = new PostgresRemoteDesktopGuestOutboxDeliveryAdapter(
      db.asDatabase(),
      () => local.value,
    );
    expect(await adapter.deliver('server-1', routeEvent({ routeGeneration: 8 })))
      .toEqual({ status: 'not_owner' });
    expect(await adapter.deliver('server-1', routeEvent({ authorityGeneration: 5 })))
      .toEqual({ status: 'not_owner' });
    expect(local.apply).not.toHaveBeenCalled();
  });

  it('applies an exact route once and treats a durably closed redelivery as duplicate', async () => {
    const db = new ProductionAdapterDb();
    const local = target();
    const adapter = new PostgresRemoteDesktopGuestOutboxDeliveryAdapter(
      db.asDatabase(),
      () => local.value,
    );
    expect(await adapter.deliver('server-1', routeEvent())).toEqual({ status: 'applied' });
    expect(local.apply).toHaveBeenCalledWith(routeEvent(), 'route-1', 7, {
      authorityKind: 'link', actorAuditId: 'audit-link-1', authorityGeneration: 4,
      expiryRevision: 2, commitRevision: 5,
    });
    expect(db.closed).toContain('route-1:7');

    db.routeAuthority = { ...db.routeAuthority, route_state: 'closed', session_state: 'closed' };
    expect(await adapter.deliver('server-1', routeEvent())).toEqual({ status: 'duplicate' });
    expect(local.apply).toHaveBeenCalledTimes(1);
  });

  it('does not strand terminal host/endpoint revocation while the link row remains active', async () => {
    const db = new ProductionAdapterDb();
    db.routeAuthority = { ...db.routeAuthority, link_state: 'active' };
    const local = target();
    const adapter = new PostgresRemoteDesktopGuestOutboxDeliveryAdapter(
      db.asDatabase(),
      () => local.value,
    );
    await expect(adapter.deliver('server-1', routeEvent())).resolves.toEqual({ status: 'applied' });
    expect(local.apply).toHaveBeenCalledOnce();
  });

  it('accepts only monotonic downgrade and deadline authority transitions', async () => {
    const db = new ProductionAdapterDb();
    const local = target();
    const adapter = new PostgresRemoteDesktopGuestOutboxDeliveryAdapter(
      db.asDatabase(),
      () => local.value,
    );
    db.routeAuthority = {
      ...db.routeAuthority,
      link_state: 'active', link_access_mode: 'view',
      link_authority_generation: 5, link_commit_revision: 6,
    };
    const downgrade = routeEvent({
      effect: 'downgrade', idempotencyKey: 'down:1',
      authorityGeneration: 5, commitRevision: 6,
    });
    await expect(adapter.deliver('server-1', downgrade)).resolves.toEqual({ status: 'applied' });

    db.routeAuthority = {
      ...db.routeAuthority,
      session_expiry_revision: 1, link_expiry_revision: 2,
      link_expires_at: 2_000, link_commit_revision: 6,
    };
    const deadline = routeEvent({
      effect: 'deadline_update', idempotencyKey: 'deadline:1',
      expiryRevision: 2, commitRevision: 6, deadlineAt: 2_000,
    });
    await expect(adapter.deliver('server-1', deadline)).resolves.toEqual({ status: 'applied' });
    expect(local.apply).toHaveBeenNthCalledWith(1, downgrade, 'route-1', 7, {
      authorityKind: 'link', actorAuditId: 'audit-link-1', authorityGeneration: 5,
      expiryRevision: 2, commitRevision: 6,
    });
    expect(local.apply).toHaveBeenNthCalledWith(2, deadline, 'route-1', 7, {
      authorityKind: 'link', actorAuditId: 'audit-link-1', authorityGeneration: 4,
      expiryRevision: 2, commitRevision: 6,
    });

    db.routeAuthority = {
      ...db.routeAuthority,
      session_expiry_revision: 1, link_expiry_revision: 3,
      link_expires_at: 1_500, link_commit_revision: 7,
    };
    const delayedDeadline = routeEvent({
      effect: 'deadline_update', idempotencyKey: 'deadline:delayed',
      expiryRevision: 2, commitRevision: 6, deadlineAt: 2_000,
    });
    await expect(adapter.deliver('server-1', delayedDeadline))
      .resolves.toEqual({ status: 'applied' });
    expect(local.apply).toHaveBeenNthCalledWith(3, {
      ...delayedDeadline,
      deadlineAt: 1_500,
    }, 'route-1', 7, {
      authorityKind: 'link', actorAuditId: 'audit-link-1', authorityGeneration: 4,
      expiryRevision: 2, commitRevision: 6,
    });
  });

  it('applies password terminal only to the exact older session and credential generation', async () => {
    const db = new ProductionAdapterDb();
    db.routeAuthority = {
      route_state: 'active',
      session_state: 'active',
      session_id: 'password-session-1',
      session_actor_kind: 'node_password',
      actor_audit_id: 'password-audit-1',
      execution_server_id: 'server-1',
      session_authority_generation: 4,
      session_expiry_revision: null,
      session_password_generation: 4,
      password_credential_generation: 5,
      link_id: null,
      link_state: null,
      link_access_mode: null,
      link_authority_generation: null,
      link_expiry_revision: null,
      link_commit_revision: null,
      link_expires_at: null,
    };
    const local = target();
    const adapter = new PostgresRemoteDesktopGuestOutboxDeliveryAdapter(
      db.asDatabase(),
      () => local.value,
    );
    await expect(adapter.deliver('server-1', passwordEvent())).resolves.toEqual({ status: 'applied' });
    expect(local.apply).toHaveBeenCalledWith(passwordEvent(), 'route-password-1', 7, {
      authorityKind: 'password',
      actorAuditId: 'password-audit-1',
      sessionAuditId: 'password-session-1',
      passwordGeneration: 5,
    });
    expect(db.closed).toContain('route-password-1:7');

    db.routeAuthority = { ...db.routeAuthority, route_state: 'closed', session_state: 'closed' };
    await expect(adapter.deliver('server-1', passwordEvent()))
      .resolves.toEqual({ status: 'duplicate' });
    expect(local.apply).toHaveBeenCalledTimes(1);

    db.closed = [];
    local.apply.mockClear();
    db.routeAuthority = { ...db.routeAuthority, route_state: 'active', session_state: 'active' };
    await expect(adapter.deliver('server-1', passwordEvent({ passwordGeneration: 4 })))
      .resolves.toEqual({ status: 'not_owner' });
    await expect(adapter.deliver('server-1', passwordEvent({ passwordGeneration: 6 })))
      .resolves.toEqual({ status: 'not_owner' });
    await expect(adapter.deliver('server-1', passwordEvent({ sessionAuditId: 'other-session' })))
      .resolves.toEqual({ status: 'not_owner' });
    await expect(adapter.deliver('server-1', passwordEvent({ routeGeneration: 8 })))
      .resolves.toEqual({ status: 'not_owner' });
    expect(local.apply).not.toHaveBeenCalled();
  });

  it('resolves host expiry only to a locally owned canonical endpoint and reconciles no revival', async () => {
    const db = new ProductionAdapterDb();
    const local = target();
    const adapter = new PostgresRemoteDesktopGuestOutboxDeliveryAdapter(
      db.asDatabase(),
      (serverId) => serverId === 'server-1' ? local.value : null,
    );
    expect(await adapter.resolveHostTarget(hostEvent())).toBe('server-1');
    expect(await adapter.deliver('server-1', hostEvent())).toEqual({ status: 'duplicate' });
    expect(local.apply).not.toHaveBeenCalled();

    db.endpoints = ['server-other'];
    expect(await adapter.resolveHostTarget(hostEvent())).toBeNull();
  });

  it('terminates a raced live route for host expiry but leaves another pod pending', async () => {
    const db = new ProductionAdapterDb();
    db.liveHostRoutes = [{
      route_id: 'route-raced', route_generation: 7,
      execution_server_id: 'server-1', actor_audit_id: 'link:link-1',
      authority_generation: 4, expiry_revision: 2,
    }];
    const local = target();
    const adapter = new PostgresRemoteDesktopGuestOutboxDeliveryAdapter(
      db.asDatabase(),
      (serverId) => serverId === 'server-1' ? local.value : null,
    );
    expect(await adapter.resolveHostTarget(hostEvent())).toBe('server-1');
    expect(await adapter.deliver('server-1', hostEvent())).toEqual({ status: 'applied' });
    expect(local.apply).toHaveBeenCalledWith(hostEvent(), 'route-raced', 7, {
      authorityKind: 'link', actorAuditId: 'link:link-1', authorityGeneration: 4,
      expiryRevision: 2, commitRevision: 5,
    });
    expect(db.closed).toContain('route-raced:7');

    db.liveHostRoutes = [{
      ...db.liveHostRoutes[0], execution_server_id: 'server-other',
    }];
    expect(await adapter.resolveHostTarget(hostEvent())).toBeNull();
  });

  it('closes stale durable routes before reconnect authority becomes ready', async () => {
    const db = new ProductionAdapterDb();
    db.reconnectRoutes = [
      { host_id: 'host-1', route_id: 'route-old', route_generation: 6 },
      { host_id: 'host-1', route_id: 'route-password-old', route_generation: 7 },
    ];
    await expect(reconcileRemoteDesktopEndpointOnReconnect(db.asDatabase(), 'server-1'))
      .resolves.toBe(2);
    expect(db.closed).toContain('route-old:6');
    expect(db.closed).toContain('route-password-old:7');
  });

  it('starts both pod workers and waits for both graceful stops', async () => {
    const order: string[] = [];
    let resolveDue!: () => void;
    let resolveOutbox!: () => void;
    const due = {
      start: () => { order.push('due:start'); },
      stop: () => new Promise<void>((resolve) => {
        order.push('due:stop'); resolveDue = resolve;
      }),
    };
    const outbox = {
      start: async () => { order.push('outbox:start'); },
      stop: () => new Promise<void>((resolve) => {
        order.push('outbox:stop'); resolveOutbox = resolve;
      }),
    };
    const runtime = new RemoteDesktopGuestBackgroundRuntime(due, outbox);
    await runtime.start();
    expect(order).toEqual(['due:start', 'outbox:start']);
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveDue();
    resolveOutbox();
    await stopping;
    expect(order).toEqual(['due:start', 'outbox:start', 'due:stop', 'outbox:stop']);
  });
});
