import { describe, expect, it } from 'vitest';
import { REMOTE_DESKTOP_ACCESS_MODE, REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';
import {
  CONTROLLED_NODE_CAPABILITIES,
  CONTROLLED_NODE_CAPABILITY_MAX_ITEMS,
  parseAdvertisedControlledNodeCapabilities,
  validateControlledNodeCapabilities,
} from '../../shared/controlled-node-capabilities.js';
import {
  REMOTE_DESKTOP_ACTOR_SOURCE,
  REMOTE_DESKTOP_ADAPTER_CAPABILITIES,
  REMOTE_DESKTOP_BROWSER_CLAIM,
  REMOTE_DESKTOP_BOOTSTRAP_PROOF,
  REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
  REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
  REMOTE_DESKTOP_CONSENT_CANCEL_REASON,
  REMOTE_DESKTOP_PRE_PROOF_FORBIDDEN_FIELDS,
  REMOTE_DESKTOP_PUBLIC_LOOKUP_UNAVAILABLE,
  REMOTE_DESKTOP_CONSENT_MSG,
  REMOTE_DESKTOP_ENDPOINT_KIND,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LINK_DURATION_MS,
  REMOTE_DESKTOP_LINK_KIND,
  REMOTE_DESKTOP_LINK_LIMITS,
  REMOTE_DESKTOP_LINK_TOKEN,
  REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
  REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
  REMOTE_DESKTOP_NODE_CONTEXT_MSG,
  REMOTE_DESKTOP_PRESENTATION_SOURCE,
  REMOTE_DESKTOP_PRIVACY_ADMISSION,
  REMOTE_DESKTOP_PRIVACY_MSG,
  REMOTE_DESKTOP_PRIVACY_LIMITS,
  REMOTE_DESKTOP_PRIVACY_PHASE,
  REMOTE_DESKTOP_PUBLIC_ID,
  REMOTE_DESKTOP_REDACTED_AUDIT_FIELDS,
  REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY,
  REMOTE_DESKTOP_SHELL_MSG,
  REMOTE_DESKTOP_SHELL_RECOVERY_REASON,
  REMOTE_DESKTOP_WALL_OPERATION,
  containsRemoteDesktopPreProofDisclosure,
  containsRemoteDesktopSecretField,
  isAcceptableRemoteDesktopPublicNodeId,
  isCanonicalRemoteDesktopLinkToken,
  isCompleteRemoteDesktopPrivacyAck,
  isMonotonicRemoteDesktopLinkMutation,
  isProhibitedRemoteDesktopPublicIdPattern,
  isRemoteDesktopActorRenewable,
  isRemoteDesktopLinkDurationMs,
  isRemoteDesktopPrivacyEpochCurrent,
  isRemoteDesktopPreProofResponseSafe,
  isRemoteDesktopPrivacyTransitionAllowed,
  isRemoteDesktopShellLaunchContextCurrent,
  isRemoteDesktopStepUpGrantUsable,
  parseRemoteDesktopLinkFragment,
  redactRemoteDesktopAuditRecord,
  remoteDesktopAdapterReadiness,
  remoteDesktopExpiryIdempotencyKey,
  remoteDesktopBrowserClaimSignaturePreimage,
  remoteDesktopBootstrapSignaturePreimage,
  remoteDesktopLinkTokenHashPreimage,
  resolveRemoteDesktopDeadline,
  selectRemoteDesktopExecutionEndpoint,
  validateRemoteDesktopBootstrapRedemption,
  validateRemoteDesktopBootstrapProof,
  validateRemoteDesktopClaimChallenge,
  validateRemoteDesktopClaimProof,
  validateRemoteDesktopConsentMessage,
  validateRemoteDesktopLinkCreateRequest,
  validateRemoteDesktopNodeAuthorityContext,
  validateRemoteDesktopPasswordMutation,
  validateRemoteDesktopPrivacyMessage,
  validateRemoteDesktopShellLaunchContext,
  validateRemoteDesktopShellMessage,
  validateRemoteDesktopStepUpGrant,
  validateRemoteDesktopWallMutation,
  type RemoteDesktopLinkActor,
  type RemoteDesktopPrivacyAck,
  type RemoteDesktopPrivacyEpoch,
} from '../../shared/remote-desktop-access.js';

const ID = 'a'.repeat(24);
const HOST = `host-${'b'.repeat(20)}`;
const TOKEN = 'A'.repeat(REMOTE_DESKTOP_LINK_TOKEN.ENCODED_LENGTH);
const HASH = 'a'.repeat(REMOTE_DESKTOP_LINK_TOKEN.HASH_LENGTH);
const CLAIM_CHALLENGE_ID = 'C'.repeat(REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ID_ENCODED_LENGTH);
const CLAIM_CHALLENGE = 'D'.repeat(REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ENCODED_LENGTH);
const CLAIM_SPKI = 'E'.repeat(REMOTE_DESKTOP_BROWSER_CLAIM.PUBLIC_KEY_SPKI_ENCODED_LENGTH);
const CLAIM_THUMBPRINT = 'F'.repeat(REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_ENCODED_LENGTH);
const CLAIM_SIGNATURE = 'G'.repeat(REMOTE_DESKTOP_BROWSER_CLAIM.SIGNATURE_ENCODED_LENGTH);

describe('canonical host and execution endpoint', () => {
  const controlled = {
    kind: REMOTE_DESKTOP_ENDPOINT_KIND.CONTROLLED_NODE,
    serverId: 'srv-controlled-0000000000',
    endpointGeneration: 2,
  };
  const full = {
    kind: REMOTE_DESKTOP_ENDPOINT_KIND.FULL_DAEMON,
    serverId: 'srv-full-00000000000000',
    endpointGeneration: 5,
  };

  it('prefers the hosted controlled node only while that relationship is active', () => {
    expect(selectRemoteDesktopExecutionEndpoint([full, controlled], true)).toBe(controlled);
    expect(selectRemoteDesktopExecutionEndpoint([full, controlled], false)).toBe(full);
  });

  it('returns nothing rather than guessing when no qualified endpoint exists', () => {
    expect(selectRemoteDesktopExecutionEndpoint([controlled], false)).toBeUndefined();
  });
});

describe('controlled-node canonical-host context', () => {
  it('accepts the exact Server-owned host and connection generation', () => {
    expect(validateRemoteDesktopNodeAuthorityContext({
      type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT,
      hostId: HOST,
      daemonGeneration: 7,
    })).toEqual({
      ok: true,
      value: {
        type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT,
        hostId: HOST,
        daemonGeneration: 7,
      },
    });
  });

  it('accepts only an exact unavailable context so stale host authority can be cleared', () => {
    expect(validateRemoteDesktopNodeAuthorityContext({
      type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.UNAVAILABLE,
      daemonGeneration: 8,
    })).toEqual({
      ok: true,
      value: {
        type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.UNAVAILABLE,
        daemonGeneration: 8,
      },
    });
    expect(validateRemoteDesktopNodeAuthorityContext({
      type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.UNAVAILABLE,
      hostId: HOST,
      daemonGeneration: 8,
    }).ok).toBe(false);
  });

  it.each([
    ['the endpoint server id in place of a canonical host id', {
      type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT,
      hostId: 'short',
      daemonGeneration: 7,
    }],
    ['a missing Server generation', {
      type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT,
      hostId: HOST,
    }],
    ['an unknown authority field', {
      type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT,
      hostId: HOST,
      daemonGeneration: 7,
      token: 'must-not-travel',
    }],
  ] as const)('rejects %s', (_label, value) => {
    expect(validateRemoteDesktopNodeAuthorityContext(value).ok).toBe(false);
  });
});

describe('public node id rejection sampling', () => {
  it('rejects every documented weak pattern', () => {
    // four or more zeros in total
    expect(isProhibitedRemoteDesktopPublicIdPattern(5_000_000_001)).toBe(true);
    // a run of four equal digits
    expect(isProhibitedRemoteDesktopPublicIdPattern(5_111_123_456)).toBe(true);
    // strictly ascending and descending runs of four, without wrap
    expect(isProhibitedRemoteDesktopPublicIdPattern(5_123_456_789)).toBe(true);
    expect(isProhibitedRemoteDesktopPublicIdPattern(9_876_543_210)).toBe(true);
    // two- and three-digit motifs spanning six consecutive digits
    expect(isProhibitedRemoteDesktopPublicIdPattern(5_121_212_987)).toBe(true);
    expect(isProhibitedRemoteDesktopPublicIdPattern(5_123_123_987)).toBe(true);
  });

  it('accepts ordinary values so the range is not vacuously empty', () => {
    expect(isProhibitedRemoteDesktopPublicIdPattern(5_849_267_135)).toBe(false);
    expect(isAcceptableRemoteDesktopPublicNodeId(5_849_267_135)).toBe(true);
    expect(isAcceptableRemoteDesktopPublicNodeId(6_284_937_165)).toBe(true);
  });

  it('does not treat 9 as ascending into 0', () => {
    // 8,9,0,1 wraps; the rule is explicitly "without wrap", so this run alone
    // must not reject. Kept as its own case because an implementation using
    // modulo arithmetic would silently reject far more candidates.
    const digits = [5, 6, 8, 9, 0, 1, 7, 3, 4, 2];
    const value = Number(digits.join(''));
    expect(isProhibitedRemoteDesktopPublicIdPattern(value)).toBe(false);
  });

  it('bounds the range and rejects out-of-range values', () => {
    expect(isAcceptableRemoteDesktopPublicNodeId(REMOTE_DESKTOP_PUBLIC_ID.MIN - 1)).toBe(false);
    expect(isAcceptableRemoteDesktopPublicNodeId(REMOTE_DESKTOP_PUBLIC_ID.MAX + 1)).toBe(false);
    expect(isAcceptableRemoteDesktopPublicNodeId('5849267135')).toBe(false);
  });
});

describe('link policy and monotonic mutation', () => {
  const control = {
    hostId: HOST,
    kind: REMOTE_DESKTOP_LINK_KIND.UNATTENDED,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    durationMs: REMOTE_DESKTOP_LINK_DURATION_MS.D7,
    label: 'ops laptop',
  } as const;

  it('accepts exactly the five committed durations', () => {
    for (const duration of Object.values(REMOTE_DESKTOP_LINK_DURATION_MS)) {
      expect(isRemoteDesktopLinkDurationMs(duration)).toBe(true);
    }
    expect(isRemoteDesktopLinkDurationMs(2 * 60 * 60 * 1000)).toBe(false);
    expect(isRemoteDesktopLinkDurationMs(REMOTE_DESKTOP_LINK_DURATION_MS.D30 + 1)).toBe(false);
  });

  it('allows narrowing and rejects every escalation', () => {
    expect(isMonotonicRemoteDesktopLinkMutation(control, { mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW })).toBe(true);
    expect(isMonotonicRemoteDesktopLinkMutation(control, { durationMs: REMOTE_DESKTOP_LINK_DURATION_MS.H24 })).toBe(true);
    expect(isMonotonicRemoteDesktopLinkMutation(control, { label: 'renamed' })).toBe(true);

    const view = { ...control, mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW } as const;
    expect(isMonotonicRemoteDesktopLinkMutation(view, { mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL })).toBe(false);
    expect(isMonotonicRemoteDesktopLinkMutation(control, { durationMs: REMOTE_DESKTOP_LINK_DURATION_MS.D30 })).toBe(false);
    expect(isMonotonicRemoteDesktopLinkMutation(control, { kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED })).toBe(false);
    expect(isMonotonicRemoteDesktopLinkMutation(control, { hostId: `other-${'c'.repeat(18)}` })).toBe(false);
  });

  it('refuses to give an attended link an expiry', () => {
    const attended = { ...control, kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED, durationMs: undefined } as const;
    expect(isMonotonicRemoteDesktopLinkMutation(attended, { durationMs: REMOTE_DESKTOP_LINK_DURATION_MS.H1 })).toBe(false);
  });
});

describe('actor renewal', () => {
  const base: RemoteDesktopLinkActor = {
    source: REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK,
    auditId: ID,
    hostId: HOST,
    endpointGeneration: 1,
    modeCeiling: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    authorityGeneration: 3,
    expiryRevision: 2,
    expiresAt: 10_000,
    linkId: `link-${'d'.repeat(19)}`,
    browserKeyThumbprint: 'thumb-1',
  };

  it('renews an unchanged current authority', () => {
    expect(isRemoteDesktopActorRenewable(base, { ...base }, 9_000)).toBe(true);
  });

  it('treats a raised expiry revision as a deadline change, not an invalidation', () => {
    expect(isRemoteDesktopActorRenewable(base, { ...base, expiryRevision: 3 }, 9_000)).toBe(true);
  });

  it('refuses upgrade, host move, claim transfer, stale generation and expiry', () => {
    expect(isRemoteDesktopActorRenewable(base, { ...base, modeCeiling: REMOTE_DESKTOP_ACCESS_MODE.CONTROL }, 9_000)).toBe(false);
    expect(isRemoteDesktopActorRenewable(base, { ...base, hostId: `other-${'e'.repeat(18)}` }, 9_000)).toBe(false);
    expect(isRemoteDesktopActorRenewable(base, { ...base, browserKeyThumbprint: 'thumb-2' }, 9_000)).toBe(false);
    expect(isRemoteDesktopActorRenewable(base, { ...base, authorityGeneration: 4 }, 9_000)).toBe(false);
    expect(isRemoteDesktopActorRenewable(base, { ...base }, 10_000)).toBe(false);
    expect(isRemoteDesktopActorRenewable(
      base,
      { ...base, source: REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK },
      9_000,
    )).toBe(false);
  });
});

describe('bearer wire format', () => {
  it('accepts only canonical base64url of the frozen length', () => {
    expect(isCanonicalRemoteDesktopLinkToken(TOKEN)).toBe(true);
    expect(isCanonicalRemoteDesktopLinkToken(`${TOKEN}=`)).toBe(false);
    expect(isCanonicalRemoteDesktopLinkToken(TOKEN.slice(0, -1))).toBe(false);
    expect(isCanonicalRemoteDesktopLinkToken(`${TOKEN.slice(0, -1)}+`)).toBe(false);
    expect(isCanonicalRemoteDesktopLinkToken(`${TOKEN.slice(0, -1)}/`)).toBe(false);
  });

  it('parses only the exact versioned fragment', () => {
    expect(parseRemoteDesktopLinkFragment(`#invite=v1.${TOKEN}`)).toBe(TOKEN);
    expect(parseRemoteDesktopLinkFragment(`invite=v1.${TOKEN}`)).toBe(TOKEN);
    expect(parseRemoteDesktopLinkFragment(`#invite=v2.${TOKEN}`)).toBeUndefined();
    expect(parseRemoteDesktopLinkFragment(`#other=v1.${TOKEN}`)).toBeUndefined();
    expect(parseRemoteDesktopLinkFragment('#invite=v1.short')).toBeUndefined();
  });

  it('builds the exact domain-separated preimage and refuses a wrong length', () => {
    const raw = new Uint8Array(REMOTE_DESKTOP_LINK_TOKEN.RAW_BYTES).fill(7);
    const preimage = remoteDesktopLinkTokenHashPreimage(raw);
    const domain = new TextEncoder().encode(REMOTE_DESKTOP_LINK_TOKEN.HASH_DOMAIN);
    expect(preimage.byteLength).toBe(domain.byteLength + 1 + raw.byteLength);
    expect([...preimage.slice(0, domain.byteLength)]).toEqual([...domain]);
    expect(preimage[domain.byteLength]).toBe(REMOTE_DESKTOP_LINK_TOKEN.HASH_DOMAIN_SEPARATOR_BYTE);
    expect(() => remoteDesktopLinkTokenHashPreimage(new Uint8Array(16))).toThrow();
  });
});

describe('owner mutation validators', () => {
  const create = {
    hostId: HOST,
    creationRequestId: TOKEN,
    tokenHashVersion: REMOTE_DESKTOP_LINK_TOKEN.HASH_VERSION,
    tokenHash: HASH,
    kind: REMOTE_DESKTOP_LINK_KIND.UNATTENDED,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    label: 'ops laptop',
    durationMs: REMOTE_DESKTOP_LINK_DURATION_MS.H6,
  };

  it('accepts a well-formed creation and rejects unknown keys', () => {
    expect(validateRemoteDesktopLinkCreateRequest(create).ok).toBe(true);
    expect(validateRemoteDesktopLinkCreateRequest({ ...create, extra: 1 }).ok).toBe(false);
  });

  it('requires an exact duration for unattended and none for attended', () => {
    expect(validateRemoteDesktopLinkCreateRequest({ ...create, durationMs: 90 * 60 * 1000 }).ok).toBe(false);
    const { durationMs: _drop, ...noDuration } = create;
    expect(validateRemoteDesktopLinkCreateRequest(noDuration).ok).toBe(false);
    expect(validateRemoteDesktopLinkCreateRequest({
      ...noDuration,
      kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED,
    }).ok).toBe(true);
    expect(validateRemoteDesktopLinkCreateRequest({
      ...create,
      kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED,
    }).ok).toBe(false);
  });

  it('never accepts a raw bearer alongside the hash', () => {
    expect(validateRemoteDesktopLinkCreateRequest({ ...create, token: TOKEN }).ok).toBe(false);
    expect(validateRemoteDesktopLinkCreateRequest({ ...create, tokenHash: HASH.toUpperCase() }).ok).toBe(false);
  });

  it('bounds password mutations and forbids a password on disable', () => {
    const set = { hostId: HOST, action: 'set' as const, requestId: TOKEN, password: 'correct horse battery' };
    expect(validateRemoteDesktopPasswordMutation(set).ok).toBe(true);
    expect(validateRemoteDesktopPasswordMutation({ ...set, password: 'short' }).ok).toBe(false);
    expect(validateRemoteDesktopPasswordMutation({ ...set, password: 'x'.repeat(300) }).ok).toBe(false);
    expect(validateRemoteDesktopPasswordMutation({
      hostId: HOST, action: 'disable', requestId: TOKEN, password: 'still here',
    }).ok).toBe(false);
    expect(validateRemoteDesktopPasswordMutation({
      hostId: HOST, action: 'disable', requestId: TOKEN,
    }).ok).toBe(true);
  });
});

describe('step-up grants', () => {
  const grant = {
    grantId: ID,
    accountSessionId: `sess-${'f'.repeat(19)}`,
    hostId: HOST,
    actionDigest: HASH,
    requestId: TOKEN,
    expiresAt: 5_000,
  };

  it('validates shape and rejects a non-digest action', () => {
    expect(validateRemoteDesktopStepUpGrant(grant).ok).toBe(true);
    expect(validateRemoteDesktopStepUpGrant({ ...grant, actionDigest: 'nope' }).ok).toBe(false);
  });

  it('cannot authorize a different host, action, request or an expired attempt', () => {
    const expected = {
      accountSessionId: grant.accountSessionId,
      hostId: grant.hostId,
      actionDigest: grant.actionDigest,
      requestId: grant.requestId,
    };
    expect(isRemoteDesktopStepUpGrantUsable(grant, expected, 4_999)).toBe(true);
    expect(isRemoteDesktopStepUpGrantUsable(grant, expected, 5_000)).toBe(false);
    expect(isRemoteDesktopStepUpGrantUsable(grant, { ...expected, hostId: `other-${'g'.repeat(18)}` }, 4_000)).toBe(false);
    expect(isRemoteDesktopStepUpGrantUsable(grant, { ...expected, actionDigest: 'b'.repeat(64) }, 4_000)).toBe(false);
    expect(isRemoteDesktopStepUpGrantUsable(grant, { ...expected, requestId: 'B'.repeat(43) }, 4_000)).toBe(false);
  });
});

describe('claim proof and bootstrap redemption', () => {
  const challenge = {
    keyAlgorithm: REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM,
    challengeId: CLAIM_CHALLENGE_ID,
    challenge: CLAIM_CHALLENGE,
    expiresAt: 60_000,
  };
  const proof = {
    keyAlgorithm: REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM,
    challengeId: CLAIM_CHALLENGE_ID,
    challenge: CLAIM_CHALLENGE,
    browserPublicKeySpki: CLAIM_SPKI,
    browserKeyThumbprint: CLAIM_THUMBPRINT,
    signature: CLAIM_SIGNATURE,
  };

  it('accepts only the frozen P-256 challenge and proof shapes', () => {
    expect(validateRemoteDesktopClaimChallenge(challenge).ok).toBe(true);
    expect(validateRemoteDesktopClaimProof(proof).ok).toBe(true);
    expect(validateRemoteDesktopClaimProof({ ...proof, linkId: ID }).ok).toBe(false);
    expect(validateRemoteDesktopClaimProof({ ...proof, signature: `${CLAIM_SIGNATURE}=` }).ok).toBe(false);
    expect(validateRemoteDesktopClaimProof({ ...proof, browserPublicKeySpki: CLAIM_SPKI.slice(1) }).ok).toBe(false);
    expect(validateRemoteDesktopClaimProof({ ...proof, password: 'hunter2' }).ok).toBe(false);
  });

  it('freezes the domain-separated signature preimage and rejects wrong byte lengths', () => {
    const challengeIdBytes = new Uint8Array(REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ID_BYTES).fill(1);
    const challengeBytes = new Uint8Array(REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_BYTES).fill(2);
    const thumbprintBytes = new Uint8Array(REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_BYTES).fill(3);
    const preimage = remoteDesktopBrowserClaimSignaturePreimage(
      challengeIdBytes,
      challengeBytes,
      thumbprintBytes,
    );
    const domain = new TextEncoder().encode(REMOTE_DESKTOP_BROWSER_CLAIM.SIGNATURE_DOMAIN);
    expect(Array.from(preimage.slice(0, domain.length))).toEqual(Array.from(domain));
    expect(preimage[domain.length]).toBe(REMOTE_DESKTOP_BROWSER_CLAIM.SIGNATURE_DOMAIN_SEPARATOR_BYTE);
    expect(preimage.slice(-REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_BYTES)).toEqual(thumbprintBytes);
    expect(() => remoteDesktopBrowserClaimSignaturePreimage(
      challengeIdBytes.slice(1),
      challengeBytes,
      thumbprintBytes,
    )).toThrow('remote_desktop_browser_claim_preimage_length');
  });

  it('validates redemption and rejects an unknown actor source', () => {
    const redemption = {
      ticketId: ID,
      hostId: HOST,
      serverId: `srv-${'h'.repeat(20)}`,
      source: REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      credentialGeneration: 4,
      browserPublicKeySpki: CLAIM_SPKI,
      browserKeyThumbprint: CLAIM_THUMBPRINT,
      expiresAt: 1_000,
    };
    expect(validateRemoteDesktopBootstrapRedemption(redemption).ok).toBe(true);
    expect(validateRemoteDesktopBootstrapRedemption({ ...redemption, source: 'local_admin' }).ok).toBe(false);
    expect(validateRemoteDesktopBootstrapRedemption({ ...redemption, rawToken: TOKEN }).ok).toBe(false);
  });

  it('requires a private-key signature to redeem a copied bootstrap ticket', () => {
    const bootstrapProof = {
      ticket: TOKEN,
      browserKeyThumbprint: CLAIM_THUMBPRINT,
      signature: CLAIM_SIGNATURE,
    };
    expect(validateRemoteDesktopBootstrapProof(bootstrapProof).ok).toBe(true);
    expect(validateRemoteDesktopBootstrapProof({ ...bootstrapProof, signature: 'short' }).ok).toBe(false);
    expect(validateRemoteDesktopBootstrapProof({ ...bootstrapProof, ticket: `${TOKEN}=` }).ok).toBe(false);

    const ticketBytes = new Uint8Array(REMOTE_DESKTOP_BOOTSTRAP_PROOF.TICKET_BYTES).fill(4);
    const thumbprintBytes = new Uint8Array(REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_BYTES).fill(5);
    const preimage = remoteDesktopBootstrapSignaturePreimage(ticketBytes, thumbprintBytes);
    const domain = new TextEncoder().encode(REMOTE_DESKTOP_BOOTSTRAP_PROOF.SIGNATURE_DOMAIN);
    expect(Array.from(preimage.slice(0, domain.length))).toEqual(Array.from(domain));
    expect(preimage[domain.length]).toBe(REMOTE_DESKTOP_BOOTSTRAP_PROOF.SIGNATURE_DOMAIN_SEPARATOR_BYTE);
    expect(preimage.slice(-REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_BYTES)).toEqual(thumbprintBytes);
    expect(() => remoteDesktopBootstrapSignaturePreimage(ticketBytes.slice(1), thumbprintBytes))
      .toThrow('remote_desktop_bootstrap_preimage_length');
  });
});

describe('consent messages', () => {
  const request = {
    type: REMOTE_DESKTOP_CONSENT_MSG.REQUEST,
    approvalId: ID,
    hostId: HOST,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    requesterLabel: 'browser on 203.0.113.7',
    createdAt: 1_000,
    deadlineAt: 1_000 + REMOTE_DESKTOP_LINK_LIMITS.CONSENT_DEADLINE_MS,
    daemonGeneration: 9,
  };

  it('accepts a bounded request and rejects credential-bearing extras', () => {
    expect(validateRemoteDesktopConsentMessage(request).ok).toBe(true);
    expect(validateRemoteDesktopConsentMessage({ ...request, linkToken: TOKEN }).ok).toBe(false);
    expect(validateRemoteDesktopConsentMessage({ ...request, capability: 'remote.desktop' }).ok).toBe(false);
  });

  it('rejects a non-advancing or unbounded deadline', () => {
    expect(validateRemoteDesktopConsentMessage({ ...request, deadlineAt: request.createdAt }).ok).toBe(false);
    expect(validateRemoteDesktopConsentMessage({
      ...request,
      deadlineAt: request.createdAt + REMOTE_DESKTOP_LINK_LIMITS.CONSENT_DEADLINE_MS + 1,
    }).ok).toBe(false);
  });

  it('accepts only enumerated decisions and cancel reasons', () => {
    expect(validateRemoteDesktopConsentMessage({
      type: REMOTE_DESKTOP_CONSENT_MSG.RESULT, approvalId: ID, decision: 'approved', daemonGeneration: 9,
    }).ok).toBe(true);
    expect(validateRemoteDesktopConsentMessage({
      type: REMOTE_DESKTOP_CONSENT_MSG.RESULT, approvalId: ID, decision: 'maybe', daemonGeneration: 9,
    }).ok).toBe(false);
    expect(validateRemoteDesktopConsentMessage({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      approvalId: ID,
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.PROTECTED_DESKTOP,
    }).ok).toBe(true);
    expect(validateRemoteDesktopConsentMessage({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL, approvalId: ID, reason: 'because',
    }).ok).toBe(false);
  });

  it('advertises the OS adapter capabilities without exceeding the bound', () => {
    for (const capability of REMOTE_DESKTOP_ADAPTER_CAPABILITIES) {
      expect(CONTROLLED_NODE_CAPABILITIES as readonly string[]).toContain(capability);
    }
    expect(CONTROLLED_NODE_CAPABILITIES.length).toBeLessThanOrEqual(CONTROLLED_NODE_CAPABILITY_MAX_ITEMS);
    // A full advertisement must still validate, or a compliant node would be
    // rejected at authentication the moment every adapter is present.
    expect(validateControlledNodeCapabilities([...CONTROLLED_NODE_CAPABILITIES]).ok).toBe(true);
  });
});

describe('management privacy contracts', () => {
  const epoch: RemoteDesktopPrivacyEpoch = {
    hostId: HOST,
    epochId: `epoch-${'i'.repeat(18)}`,
    revision: 4,
    phase: REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE,
    admission: REMOTE_DESKTOP_PRIVACY_ADMISSION.CLOSED,
    presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
    executionEndpointServerId: `srv-${'j'.repeat(20)}`,
    leaseExpiresAt: 60_000,
    routeSnapshot: [
      { routeId: `route-${'k'.repeat(18)}`, routeGeneration: 2 },
      { routeId: `route-${'l'.repeat(18)}`, routeGeneration: 7 },
    ],
    workerGeneration: 11,
    acknowledgedRoutes: [],
  };
  const ack: RemoteDesktopPrivacyAck = {
    type: REMOTE_DESKTOP_PRIVACY_MSG.ACK,
    hostId: epoch.hostId,
    epochId: epoch.epochId,
    revision: epoch.revision,
    workerGeneration: epoch.workerGeneration,
    routes: [...epoch.routeSnapshot],
  };

  it('carries no session, token or password by construction', () => {
    expect(validateRemoteDesktopPrivacyMessage({
      type: REMOTE_DESKTOP_PRIVACY_MSG.BEGIN,
      hostId: HOST,
      epochId: epoch.epochId,
      revision: 4,
      presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.MANAGEMENT_WEB,
      deadlineAt: 1_000,
      routeSnapshot: epoch.routeSnapshot,
    }).ok).toBe(true);
    expect(validateRemoteDesktopPrivacyMessage({
      type: REMOTE_DESKTOP_PRIVACY_MSG.BEGIN,
      hostId: HOST,
      epochId: epoch.epochId,
      revision: 4,
      presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.MANAGEMENT_WEB,
      deadlineAt: 1_000,
      routeSnapshot: epoch.routeSnapshot,
      accountSessionId: 'sess',
    }).ok).toBe(false);
  });

  it('accepts a complete acknowledgement only from the owning pod', () => {
    expect(isCompleteRemoteDesktopPrivacyAck(epoch, ack, epoch.executionEndpointServerId)).toBe(true);
    expect(isCompleteRemoteDesktopPrivacyAck(epoch, ack, `srv-${'z'.repeat(20)}`)).toBe(false);
  });

  it('fails closed on a stale revision, replaced worker or partial route set', () => {
    expect(isCompleteRemoteDesktopPrivacyAck(epoch, { ...ack, revision: 3 }, epoch.executionEndpointServerId)).toBe(false);
    expect(isCompleteRemoteDesktopPrivacyAck(epoch, { ...ack, workerGeneration: 12 }, epoch.executionEndpointServerId)).toBe(false);
    expect(isCompleteRemoteDesktopPrivacyAck(
      epoch,
      { ...ack, routes: [epoch.routeSnapshot[0]!] },
      epoch.executionEndpointServerId,
    )).toBe(false);
    // Right count, wrong generation: a reconnected route must not be counted
    // as the one that was snapshotted.
    expect(isCompleteRemoteDesktopPrivacyAck(
      epoch,
      { ...ack, routes: [epoch.routeSnapshot[0]!, { routeId: epoch.routeSnapshot[1]!.routeId, routeGeneration: 8 }] },
      epoch.executionEndpointServerId,
    )).toBe(false);
  });

  it('rejects duplicate route ids in an acknowledgement', () => {
    expect(validateRemoteDesktopPrivacyMessage({
      ...ack,
      routes: [epoch.routeSnapshot[0]!, epoch.routeSnapshot[0]!],
    }).ok).toBe(false);
  });

  it('treats recovery_required as terminal', () => {
    expect(isRemoteDesktopPrivacyTransitionAllowed(
      REMOTE_DESKTOP_PRIVACY_PHASE.STARTING, REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE,
    )).toBe(true);
    expect(isRemoteDesktopPrivacyTransitionAllowed(
      REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE, REMOTE_DESKTOP_PRIVACY_PHASE.RECOVERY_REQUIRED,
    )).toBe(true);
    expect(isRemoteDesktopPrivacyTransitionAllowed(
      REMOTE_DESKTOP_PRIVACY_PHASE.RECOVERY_REQUIRED, REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE,
    )).toBe(false);
    expect(isRemoteDesktopPrivacyTransitionAllowed(
      REMOTE_DESKTOP_PRIVACY_PHASE.STARTING, REMOTE_DESKTOP_PRIVACY_PHASE.ENDING,
    )).toBe(false);
  });

  it('requires a current active epoch with closed admission for secret operations', () => {
    const presented = { epochId: epoch.epochId, revision: epoch.revision };
    expect(isRemoteDesktopPrivacyEpochCurrent(epoch, presented)).toBe(true);
    expect(isRemoteDesktopPrivacyEpochCurrent(epoch, { ...presented, revision: 3 })).toBe(false);
    expect(isRemoteDesktopPrivacyEpochCurrent(
      { ...epoch, admission: REMOTE_DESKTOP_PRIVACY_ADMISSION.OPEN },
      presented,
    )).toBe(false);
    expect(isRemoteDesktopPrivacyEpochCurrent(
      { ...epoch, phase: REMOTE_DESKTOP_PRIVACY_PHASE.ENDING },
      presented,
    )).toBe(false);
  });
});

describe('outbox effects and CAS wall', () => {
  it('keys natural expiry on link, revision and expiry', () => {
    expect(remoteDesktopExpiryIdempotencyKey('link-1', 2, 9_000)).toBe('link-1:2:9000');
    expect(remoteDesktopExpiryIdempotencyKey('link-1', 3, 9_000))
      .not.toBe(remoteDesktopExpiryIdempotencyKey('link-1', 2, 9_000));
  });

  it('never lets a renewal outlive a shortened deadline', () => {
    expect(resolveRemoteDesktopDeadline(20_000, 9_000)).toBe(9_000);
    expect(resolveRemoteDesktopDeadline(5_000, 9_000)).toBe(5_000);
  });

  it('rejects an invalid CAS revision, oversized or duplicated membership', () => {
    const mutation = {
      operation: REMOTE_DESKTOP_WALL_OPERATION.ADD,
      expectedRevision: 3,
      hostIds: [HOST],
    };
    expect(validateRemoteDesktopWallMutation(mutation).ok).toBe(true);
    expect(validateRemoteDesktopWallMutation({ ...mutation, expectedRevision: -1 }).ok).toBe(false);
    expect(validateRemoteDesktopWallMutation({ ...mutation, expectedRevision: 1.5 }).ok).toBe(false);
    expect(validateRemoteDesktopWallMutation({ ...mutation, hostIds: [HOST, HOST] }).ok).toBe(false);
    expect(validateRemoteDesktopWallMutation({
      ...mutation,
      hostIds: Array.from({ length: 17 }, (_unused, index) => `host-${String(index).padStart(19, '0')}`),
    }).ok).toBe(false);
    expect(validateRemoteDesktopWallMutation({ ...mutation, operation: 'replace' }).ok).toBe(false);
  });
});

describe('audit redaction', () => {
  it('strips every forbidden field at any depth', () => {
    const record = {
      hostId: HOST,
      token: TOKEN,
      nested: { password: 'hunter2', keep: 1, deeper: [{ verifier: 'v', keep: 2 }] },
    };
    const redacted = redactRemoteDesktopAuditRecord(record) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain(TOKEN);
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
    expect(JSON.stringify(redacted)).toContain('"keep":1');
    expect(JSON.stringify(redacted)).toContain('"keep":2');
    expect(redacted.hostId).toBe(HOST);
  });

  it('detects a secret-shaped field nested inside an otherwise valid body', () => {
    expect(containsRemoteDesktopSecretField({ a: { b: [{ launchSecret: 'x' }] } })).toBe(true);
    expect(containsRemoteDesktopSecretField({ a: { b: [{ ok: 'x' }] } })).toBe(false);
    // Every declared field must actually be detected, not just the obvious ones.
    for (const field of REMOTE_DESKTOP_REDACTED_AUDIT_FIELDS) {
      expect(containsRemoteDesktopSecretField({ [field]: 'x' })).toBe(true);
    }
  });
});

describe('signed shell launch context', () => {
  const context = {
    hostId: HOST,
    launchId: `launch-${'m'.repeat(17)}`,
    issuedAt: 1_000,
    expiresAt: 1_000 + REMOTE_DESKTOP_PRIVACY_LIMITS.LAUNCH_CONTEXT_TTL_MS,
    endpointGeneration: 3,
  };

  it('accepts the exact bounded shape', () => {
    expect(validateRemoteDesktopShellLaunchContext(context).ok).toBe(true);
  });

  it('rejects unknown keys and any attempt to carry management authority', () => {
    expect(validateRemoteDesktopShellLaunchContext({ ...context, extra: 1 }).ok).toBe(false);
    expect(validateRemoteDesktopShellLaunchContext({ ...context, accountSessionId: 'sess' }).ok).toBe(false);
    // The context grants no management authority; a token or password inside it
    // would be exactly the escalation the design forbids.
    expect(validateRemoteDesktopShellLaunchContext({ ...context, launchSecret: 'x' }).ok).toBe(false);
    expect(validateRemoteDesktopShellLaunchContext({ ...context, password: 'x' }).ok).toBe(false);
  });

  it('rejects a non-advancing or unbounded lifetime', () => {
    expect(validateRemoteDesktopShellLaunchContext({ ...context, expiresAt: context.issuedAt }).ok).toBe(false);
    expect(validateRemoteDesktopShellLaunchContext({
      ...context,
      expiresAt: context.issuedAt + REMOTE_DESKTOP_PRIVACY_LIMITS.LAUNCH_CONTEXT_TTL_MS + 1,
    }).ok).toBe(false);
  });

  it('rejects an oversized serialized body', () => {
    const bloated = { ...context, launchId: 'n'.repeat(REMOTE_DESKTOP_PRIVACY_LIMITS.LAUNCH_CONTEXT_BYTES) };
    expect(validateRemoteDesktopShellLaunchContext(bloated).ok).toBe(false);
  });

  it('stops speaking for a host whose endpoint generation moved on', () => {
    const expected = { hostId: HOST, endpointGeneration: 3 };
    expect(isRemoteDesktopShellLaunchContextCurrent(context, expected, context.expiresAt - 1)).toBe(true);
    expect(isRemoteDesktopShellLaunchContextCurrent(context, expected, context.expiresAt)).toBe(false);
    expect(isRemoteDesktopShellLaunchContextCurrent(context, { ...expected, endpointGeneration: 4 }, 1_500)).toBe(false);
    expect(isRemoteDesktopShellLaunchContextCurrent(
      context, { ...expected, hostId: `other-${'o'.repeat(18)}` }, 1_500,
    )).toBe(false);
  });

  it('validates only exact secret-free launch and recovery channel messages', () => {
    expect(validateRemoteDesktopShellMessage({
      type: REMOTE_DESKTOP_SHELL_MSG.LAUNCH,
      context,
    }).ok).toBe(true);
    expect(validateRemoteDesktopShellMessage({
      type: REMOTE_DESKTOP_SHELL_MSG.LAUNCH,
      context: { ...context, accountSessionId: 'must-not-cross-node-channel' },
    }).ok).toBe(false);
    expect(validateRemoteDesktopShellMessage({
      type: REMOTE_DESKTOP_SHELL_MSG.RECOVERY_REQUIRED,
      hostId: HOST,
      epochId: `epoch-${'p'.repeat(18)}`,
      endpointGeneration: 3,
      reason: REMOTE_DESKTOP_SHELL_RECOVERY_REASON.CLIPBOARD_WATCHDOG_CRASHED,
    }).ok).toBe(true);
    expect(validateRemoteDesktopShellMessage({
      type: REMOTE_DESKTOP_SHELL_MSG.RECOVERY_REQUIRED,
      hostId: HOST,
      epochId: `epoch-${'p'.repeat(18)}`,
      endpointGeneration: 3,
      reason: 'cleanup_succeeded_without_proof',
    }).ok).toBe(false);
    expect(validateRemoteDesktopShellMessage({
      type: REMOTE_DESKTOP_SHELL_MSG.RECOVERY_REQUIRED,
      hostId: HOST,
      epochId: `epoch-${'p'.repeat(18)}`,
      endpointGeneration: 3,
      reason: REMOTE_DESKTOP_SHELL_RECOVERY_REASON.SHELL_CRASHED,
      token: TOKEN,
    }).ok).toBe(false);
  });
});

describe('pre-proof disclosure boundary', () => {
  it('returns one bounded shape and nothing else', () => {
    expect(isRemoteDesktopPreProofResponseSafe(REMOTE_DESKTOP_PUBLIC_LOOKUP_UNAVAILABLE)).toBe(true);
    expect(isRemoteDesktopPreProofResponseSafe({
      keyAlgorithm: REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM,
      challengeId: CLAIM_CHALLENGE_ID,
      challenge: CLAIM_CHALLENGE,
      expiresAt: 60_000,
    })).toBe(true);
    expect(isRemoteDesktopPreProofResponseSafe({ status: 'unavailable', serverId: 'srv-1' })).toBe(false);
    expect(isRemoteDesktopPreProofResponseSafe({ status: 'retired' })).toBe(false);
    expect(isRemoteDesktopPreProofResponseSafe({})).toBe(false);
  });

  it('detects every forbidden field, including nested in an error body', () => {
    for (const field of REMOTE_DESKTOP_PRE_PROOF_FORBIDDEN_FIELDS) {
      expect(containsRemoteDesktopPreProofDisclosure({ [field]: 'x' })).toBe(true);
    }
    expect(containsRemoteDesktopPreProofDisclosure({ error: { detail: { serverId: 'srv-1' } } })).toBe(true);
    expect(containsRemoteDesktopPreProofDisclosure({ status: 'unavailable' })).toBe(false);
  });

  it('refuses a body nested deeper than it can inspect', () => {
    let deep: unknown = { serverId: 'srv-1' };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    // Fails closed: an unscannable body is a reason to refuse, not to trust.
    expect(containsRemoteDesktopPreProofDisclosure(deep)).toBe(true);
  });

  it('keeps serverId out of every pre-proof contract but allows it after proof', () => {
    // Structural, not incidental: redemption happens after proof, so it is the
    // only contract in this module that may name a routing key.
    expect(validateRemoteDesktopClaimProof({
      keyAlgorithm: REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM,
      challengeId: CLAIM_CHALLENGE_ID,
      challenge: CLAIM_CHALLENGE,
      browserPublicKeySpki: CLAIM_SPKI,
      browserKeyThumbprint: CLAIM_THUMBPRINT,
      signature: CLAIM_SIGNATURE,
      serverId: 'srv-1',
    }).ok).toBe(false);
    expect(validateRemoteDesktopLinkCreateRequest({
      hostId: HOST,
      creationRequestId: TOKEN,
      tokenHashVersion: REMOTE_DESKTOP_LINK_TOKEN.HASH_VERSION,
      tokenHash: HASH,
      kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      label: 'x',
      serverId: 'srv-1',
    }).ok).toBe(false);
  });
});

describe('cross-platform protocol drift', () => {
  it('names no operating system in shared, Server, or Web authority semantics', async () => {
    const { readFile } = await import('node:fs/promises');
    const sources = await Promise.all([
      '../../shared/remote-desktop-access.ts',
      '../../shared/controlled-node-capabilities.ts',
      '../../server/src/services/remote-desktop-guest-authority.ts',
      '../../server/src/services/remote-desktop-management-privacy.ts',
      '../../web/src/api/remote-desktop-wall.ts',
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
    const code = sources.join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // Decision 11: shared names describe consent, privacy, authority and
    // presentation without an OS. A drifting implementation usually adds the
    // platform to a value first ('windows_consent'), so scan code, not prose.
    for (const token of [/\bwindows\b/i, /\bwin32\b/i, /\bhwnd\b/i, /\bdxgi\b/i, /\bmacos\b/i, /\bdarwin\b/i, /\blinux\b/i]) {
      expect(code).not.toMatch(token);
    }
  });

  it('keeps every advertised adapter capability platform-neutral', () => {
    for (const capability of REMOTE_DESKTOP_ADAPTER_CAPABILITIES) {
      expect(capability).not.toMatch(/windows|win32|macos|darwin|linux/i);
    }
  });

  it('cancels on a wrong host with its own reason, not a mode mismatch', () => {
    // A wrong mode is a question the owner could still answer; a wrong host
    // means the request reached the wrong desktop and no local answer helps.
    expect(REMOTE_DESKTOP_CONSENT_CANCEL_REASON.HOST_MISMATCH)
      .not.toBe(REMOTE_DESKTOP_CONSENT_CANCEL_REASON.MODE_MISMATCH);
    expect(validateRemoteDesktopConsentMessage({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      approvalId: ID,
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.HOST_MISMATCH,
    }).ok).toBe(true);
  });
});

describe('decision 11 adapter capability matrix', () => {
  const ADAPTER_CONCERNS = [
    { concern: 'local_consent', capability: REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY },
    { concern: 'signed_account_shell', capability: REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY },
    { concern: 'capture_privacy', capability: REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY },
    { concern: 'input', capability: REMOTE_DESKTOP_INPUT_CAPABILITY },
    { concern: 'lock_screen_support', capability: REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY },
    { concern: 'branding', capability: REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY },
    { concern: 'local_disclosure', capability: REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY },
  ] as const;

  it('registers the complete matrix within the 32-item advertisement bound', () => {
    const nonAdapter = CONTROLLED_NODE_CAPABILITIES.length - ADAPTER_CONCERNS.length;
    // This is the assertion that previously failed at 16: a compliant node
    // advertising every adapter would have been rejected at authentication.
    expect(nonAdapter + ADAPTER_CONCERNS.length).toBeLessThanOrEqual(CONTROLLED_NODE_CAPABILITY_MAX_ITEMS);
    expect(REMOTE_DESKTOP_ADAPTER_CAPABILITIES).toHaveLength(7);
  });

  it('validates a full known advertisement', () => {
    expect(validateControlledNodeCapabilities([...CONTROLLED_NODE_CAPABILITIES]).ok).toBe(true);
  });

  it('registers each advertised capability exactly once', () => {
    for (const entry of ADAPTER_CONCERNS) {
      const hits = (CONTROLLED_NODE_CAPABILITIES as readonly string[])
        .filter((value) => value === entry.capability);
      expect(hits).toHaveLength(1);
    }
    expect(new Set(CONTROLLED_NODE_CAPABILITIES).size).toBe(CONTROLLED_NODE_CAPABILITIES.length);
  });

  it('does not infer local management or consent from legacy capture', () => {
    const legacy = [REMOTE_DESKTOP_CAPABILITY];
    expect(validateControlledNodeCapabilities(legacy)).toEqual({ ok: true, value: legacy });
    expect(remoteDesktopAdapterReadiness(legacy)).toEqual({
      localConsent: false,
      signedAccountShell: false,
      capturePrivacy: false,
      input: false,
      lockScreen: false,
      canonicalBranding: false,
      localDisclosure: false,
      controlledComputerManagement: false,
    });
    // Existing authenticated capture remains independently discoverable.
    expect(legacy).toContain(REMOTE_DESKTOP_CAPABILITY);
  });

  it('requires every protective local-management capability', () => {
    const full = [...REMOTE_DESKTOP_ADAPTER_CAPABILITIES];
    expect(remoteDesktopAdapterReadiness(full).controlledComputerManagement).toBe(true);
    for (const capability of [
      REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY,
      REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
      REMOTE_DESKTOP_INPUT_CAPABILITY,
      REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
    ]) {
      expect(remoteDesktopAdapterReadiness(full.filter((entry) => entry !== capability))
        .controlledComputerManagement).toBe(false);
    }
  });

  it('keeps rollback-era unknown capability rows inert', () => {
    const parsed = parseAdvertisedControlledNodeCapabilities([
      REMOTE_DESKTOP_CAPABILITY,
      'remote.desktop.future_adapter.v9',
    ]);
    expect(parsed).toEqual({ ok: true, value: [REMOTE_DESKTOP_CAPABILITY] });
    if (!parsed.ok) throw new Error('expected bounded advertisement');
    expect(remoteDesktopAdapterReadiness(parsed.value).controlledComputerManagement).toBe(false);
    expect(remoteDesktopAdapterReadiness(parsed.value).localConsent).toBe(false);
  });
});
