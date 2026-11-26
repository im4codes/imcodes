import { describe, expect, it } from 'vitest';

type Actor =
  | 'owner_management_web'
  | 'owner_management_web_with_pending_route'
  | 'owner_management_web_with_active_route'
  | 'owner_signed_shell_with_privacy_epoch'
  | 'owner_signed_shell_without_privacy_epoch'
  | 'logged_out_shell'
  | 'node_credential'
  | 'local_administrator'
  | 'account_viewer'
  | 'account_participant'
  | 'attended_guest_view'
  | 'attended_guest_control'
  | 'unattended_guest_view'
  | 'unattended_guest_control'
  | 'password_guest_control'
  | 'direct_api_bypass'
  | 'unrelated_account'
  | 'anonymous_unproven';

type Operation =
  | 'public_id.rotate'
  | 'link.create'
  | 'link.reduce_to_view'
  | 'link.shorten'
  | 'link.revoke'
  | 'password.set_change_disable'
  | 'privacy.begin.management_web'
  | 'privacy.begin.signed_shell'
  | 'guest.route.view'
  | 'guest.route.control'
  | 'wall.read'
  | 'wall.mutate';

type Decision = 'allow' | 'deny' | 'fail_closed';

interface MatrixRow {
  actor: Actor;
  operation: Operation;
  expected: Decision;
  reason: string;
}

const OWNER_MUTATIONS: Operation[] = [
  'public_id.rotate',
  'link.create',
  'link.reduce_to_view',
  'link.shorten',
  'link.revoke',
  'password.set_change_disable',
  'wall.mutate',
];

const ROUTE_OPERATIONS: Operation[] = ['guest.route.view', 'guest.route.control'];

const REQUIRED_ACTORS: Actor[] = [
  'owner_management_web',
  'owner_management_web_with_pending_route',
  'owner_management_web_with_active_route',
  'owner_signed_shell_with_privacy_epoch',
  'owner_signed_shell_without_privacy_epoch',
  'logged_out_shell',
  'node_credential',
  'local_administrator',
  'account_viewer',
  'account_participant',
  'attended_guest_view',
  'attended_guest_control',
  'unattended_guest_view',
  'unattended_guest_control',
  'password_guest_control',
  'direct_api_bypass',
  'unrelated_account',
  'anonymous_unproven',
];

function decisionFor(actor: Actor, operation: Operation): MatrixRow {
  if (actor === 'owner_management_web') {
    if (operation === 'privacy.begin.management_web') {
      return { actor, operation, expected: 'allow', reason: 'Owner Web may open empty-snapshot privacy epoch.' };
    }
    if (OWNER_MUTATIONS.includes(operation)) {
      const reason = operation === 'public_id.rotate' || operation === 'link.create'
        ? 'Current Owner Web session may rotate/create without Passkey; secret creation still requires an empty privacy snapshot.'
        : 'Owner Web with fresh step-up and empty privacy snapshot may mutate.';
      return { actor, operation, expected: 'allow', reason };
    }
    if (operation === 'wall.read') {
      return { actor, operation, expected: 'allow', reason: 'Owner may read workspace/wall state.' };
    }
  }

  if (actor === 'owner_management_web_with_pending_route' || actor === 'owner_management_web_with_active_route') {
    if (operation === 'privacy.begin.management_web' || OWNER_MUTATIONS.includes(operation)) {
      return { actor, operation, expected: 'fail_closed', reason: 'Ordinary Web cannot expose secrets while a pending/active route may capture.' };
    }
    if (operation === 'wall.read') {
      return { actor, operation, expected: 'allow', reason: 'Read-only wall metadata is non-secret.' };
    }
  }

  if (actor === 'owner_signed_shell_with_privacy_epoch') {
    if (operation === 'privacy.begin.signed_shell') {
      return { actor, operation, expected: 'allow', reason: 'Signed shell may coordinate shielding for active routes.' };
    }
    if (OWNER_MUTATIONS.includes(operation)) {
      return { actor, operation, expected: 'allow', reason: 'Owner session plus qualified privacy epoch and step-up may mutate.' };
    }
    if (operation === 'wall.read') return { actor, operation, expected: 'allow', reason: 'Owner may read workspace/wall state.' };
  }

  if (actor === 'attended_guest_view' || actor === 'unattended_guest_view') {
    if (operation === 'guest.route.view') return { actor, operation, expected: 'allow', reason: 'Proof-bound View guest may start View route only.' };
    if (operation === 'guest.route.control') return { actor, operation, expected: 'deny', reason: 'View ceiling forbids Control upgrade.' };
  }

  if (actor === 'attended_guest_control' || actor === 'unattended_guest_control' || actor === 'password_guest_control') {
    if (ROUTE_OPERATIONS.includes(operation)) return { actor, operation, expected: 'allow', reason: 'Proof-bound Control guest may start route within granted mode.' };
  }

  if (actor === 'account_viewer') {
    if (operation === 'wall.read' || operation === 'guest.route.view') {
      return { actor, operation, expected: 'allow', reason: 'Account Viewer may view presentation but not manage access.' };
    }
    if (operation === 'guest.route.control') return { actor, operation, expected: 'deny', reason: 'Viewer cannot control.' };
  }

  if (actor === 'account_participant') {
    if (operation === 'wall.read' || ROUTE_OPERATIONS.includes(operation)) {
      return { actor, operation, expected: 'allow', reason: 'Participant may use authenticated route but not access management.' };
    }
  }

  const hardDeniedActors: Actor[] = [
    'owner_signed_shell_without_privacy_epoch',
    'logged_out_shell',
    'node_credential',
    'local_administrator',
    'direct_api_bypass',
    'unrelated_account',
    'anonymous_unproven',
  ];
  if (hardDeniedActors.includes(actor)) {
    return {
      actor,
      operation,
      expected: actor === 'direct_api_bypass' ? 'fail_closed' : 'deny',
      reason: 'No current Owner account session, action-bound step-up, or qualified privacy epoch for this operation.',
    };
  }

  return { actor, operation, expected: 'deny', reason: 'No matrix rule grants this actor/operation pair.' };
}

function matrix(rows = REQUIRED_ACTORS.flatMap((actor) => ([
  ...OWNER_MUTATIONS,
  'privacy.begin.management_web',
  'privacy.begin.signed_shell',
  'guest.route.view',
  'guest.route.control',
  'wall.read',
] as Operation[]).map((operation) => decisionFor(actor, operation)))): MatrixRow[] {
  return rows;
}

function blockingMatrixFindings(rows: readonly MatrixRow[]): string[] {
  const key = (row: Pick<MatrixRow, 'actor' | 'operation'>) => `${row.actor}:${row.operation}`;
  const map = new Map(rows.map((row) => [key(row), row]));
  const findings: string[] = [];
  for (const actor of REQUIRED_ACTORS) {
    const hasAny = rows.some((row) => row.actor === actor);
    if (!hasAny) findings.push(`missing actor ${actor}`);
  }
  for (const actor of ['node_credential', 'local_administrator', 'logged_out_shell', 'direct_api_bypass'] as Actor[]) {
    for (const operation of OWNER_MUTATIONS) {
      const row = map.get(`${actor}:${operation}`);
      if (!row || row.expected === 'allow') findings.push(`${actor} must not ${operation}`);
    }
  }
  for (const actor of ['owner_management_web_with_pending_route', 'owner_management_web_with_active_route'] as Actor[]) {
    const row = map.get(`${actor}:link.create`);
    if (!row || row.expected !== 'fail_closed') findings.push(`${actor} must fail closed before secret-bearing link.create`);
  }
  const shell = map.get('owner_signed_shell_with_privacy_epoch:password.set_change_disable');
  if (!shell || shell.expected !== 'allow') findings.push('signed shell with qualified epoch must remain an allowed Owner path');
  const unproven = map.get('anonymous_unproven:guest.route.view');
  if (!unproven || unproven.expected === 'allow') findings.push('anonymous pre-proof caller must not route');
  return findings;
}

describe('remote desktop 14.2 authorization matrix qualification gate', () => {
  it('enumerates every required actor and keeps management authority Owner scoped with per-operation step-up/privacy', () => {
    const rows = matrix();
    expect(blockingMatrixFindings(rows)).toEqual([]);
    expect(rows).toContainEqual(expect.objectContaining({
      actor: 'owner_management_web', operation: 'link.create', expected: 'allow',
      reason: expect.stringContaining('without Passkey'),
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      actor: 'owner_management_web_with_active_route', operation: 'link.create', expected: 'fail_closed',
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      actor: 'node_credential', operation: 'password.set_change_disable', expected: 'deny',
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      actor: 'local_administrator', operation: 'public_id.rotate', expected: 'deny',
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      actor: 'direct_api_bypass', operation: 'link.revoke', expected: 'fail_closed',
    }));
  });

  it('preserves guest route ceilings while denying guest access-management authority', () => {
    const rows = matrix();
    expect(rows).toContainEqual(expect.objectContaining({
      actor: 'attended_guest_view', operation: 'guest.route.view', expected: 'allow',
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      actor: 'attended_guest_view', operation: 'guest.route.control', expected: 'deny',
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      actor: 'password_guest_control', operation: 'guest.route.control', expected: 'allow',
    }));
    for (const actor of ['attended_guest_control', 'unattended_guest_control', 'password_guest_control'] as Actor[]) {
      expect(rows).toContainEqual(expect.objectContaining({
        actor, operation: 'link.create', expected: 'deny',
      }));
    }
  });

  it('positive control: reports a representative node-credential or active-route management bypass', () => {
    const broken = matrix().map((row) => {
      if (row.actor === 'node_credential' && row.operation === 'link.create') return { ...row, expected: 'allow' as const };
      if (row.actor === 'owner_management_web_with_active_route' && row.operation === 'link.create') return { ...row, expected: 'allow' as const };
      return row;
    });
    expect(blockingMatrixFindings(broken)).toEqual(expect.arrayContaining([
      'node_credential must not link.create',
      'owner_management_web_with_active_route must fail closed before secret-bearing link.create',
    ]));
  });
});
