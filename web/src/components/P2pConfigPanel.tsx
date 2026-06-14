/**
 * P2pConfigPanel — modal settings panel for P2P config mode.
 * Lets the user configure per-session participation and modes, plus round count.
 */
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { usePref } from '../hooks/usePref.js';
import { useExecutionRouting } from '../hooks/useExecutionRouting.js';
import { p2pSessionConfigLegacyPrefKeys, p2pSessionConfigPrefKey } from '../constants/prefs.js';
import { parseP2pSavedConfig, serializeP2pSavedConfig } from '../preferences/p2p-config-pref.js';
import { P2pComboManager } from './P2pComboManager.js';
import { useP2pCustomCombos } from './p2p-combos.js';
import { AdvancedWorkflowCanvasEditor } from './AdvancedWorkflowCanvasEditor.js';
import {
  isP2pMemberEligibleSession,
  sanitizeP2pSavedConfig,
  sanitizeP2pSessionConfig,
  type P2pSavedConfig,
  type P2pSessionConfig,
} from '@shared/p2p-modes.js';
import { BUILT_IN_ADVANCED_PRESETS } from '@shared/p2p-advanced.js';
import { MAX_P2P_PARTICIPANTS } from '@shared/p2p-config-events.js';
import { materializeOldAdvancedConfigToWorkflowDraft } from '@shared/p2p-workflow-materialize.js';
import {
  P2P_CAPABILITY_FRESHNESS_TTL_MS,
  P2P_FORBIDDEN_ENVELOPE_FIELD_NAMES,
  P2P_WORKFLOW_CAPABILITY_V1,
  P2P_WORKFLOW_SCHEMA_VERSION,
} from '@shared/p2p-workflow-constants.js';
import type {
  P2pWorkflowDraft,
  P2pWorkflowLaunchEnvelope,
} from '@shared/p2p-workflow-types.js';
import { isFutureWorkflowSchema } from '@shared/p2p-workflow-validators.js';
import {
  P2P_WORKFLOW_DEFAULT_TITLE,
  P2P_WORKFLOW_LIBRARY_MAX_ENTRIES,
  addWorkflowToLibrary,
  duplicateWorkflowInLibrary,
  generateWorkflowDraftId,
  getActiveWorkflowFromConfig,
  migrateLegacyWorkflowDraft,
  normalizeWorkflowLibrary,
  removeWorkflowFromLibrary,
  replaceActiveWorkflowInConfig,
} from '@shared/p2p-workflow-library.js';
import type {
  P2pAdvancedPresetKey,
  P2pAdvancedRound,
  P2pContextReducerConfig,
  P2pContextReducerMode,
} from '@shared/p2p-advanced.js';

interface SessionRow {
  name: string;
  agentType: string;
  state: string;
  role?: string | null;
  /** DAEMON-AUTHORITATIVE execution-template eligibility (optional; absent on
   *  legacy daemons). When present it overrides client-side recomputation. */
  executionTemplateEligible?: boolean;
  executionTemplateIneligibleReason?: string;
}

interface SubSessionRow {
  sessionName: string;
  type: string;
  label?: string | null;
  parentSession?: string | null;
  state: string;
  /** DAEMON-AUTHORITATIVE execution-template eligibility (optional). */
  executionTemplateEligible?: boolean;
  executionTemplateIneligibleReason?: string;
}

/** Daemon capability snapshot view used by the panel to gate advanced launch.
 *  Mirrors the structure of `DaemonCapabilitySnapshot` in `web/src/ws-client.ts`,
 *  but is declared here so the component does not depend on the WS client at
 *  type level (tests can pass a plain object). */
export interface P2pConfigPanelCapabilitySnapshot {
  daemonId: string;
  capabilities: string[];
  helloEpoch: number;
  sentAt: number;
  observedAt: number;
}

export interface P2pConfigPanelCapabilitySource {
  /** Read the most recent daemon.hello snapshot, or null if none seen. */
  getSnapshot(): P2pConfigPanelCapabilitySnapshot | null;
  /** Subscribe to snapshot changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Audit fix (7c2570e9 follow-up to e940d73f-a8e / N4) — single source
   * of truth for "is the daemon capability state currently stale?".
   *
   * The panel previously computed staleness inline via
   * `Date.now() - capabilitySnapshot.observedAt > TTL`. That broke the
   * N4 fix because `observedAt` is set only on `daemon.hello`, which
   * fires once at WS connect and on capability change — never on
   * routine heartbeats. Long-lived browser pages tripped TTL forever.
   *
   * The WsClient implementation now keys staleness on a separate
   * `daemonLastSeenAt` clock that is bumped by every daemon-originated
   * message (whitelisted in `DAEMON_ORIGIN_MESSAGE_TYPES`). Routing
   * panel staleness through this method ensures the panel and the WS
   * client agree.
   *
   * Optional for backwards compatibility with tests that pass a plain
   * object source — the panel falls back to the inline observedAt
   * check when this method is absent.
   */
  isStale?(now?: number): boolean;
}

interface Props {
  sessions: SessionRow[];
  subSessions: SubSessionRow[];
  /** Active main session name — only show sessions scoped to this one by default */
  activeSession?: string | null;
  /** Active server ID — P2P participant names are server-local, so saved config must be too. */
  serverId?: string | null;
  initialTab?: 'participants' | 'combos' | 'advanced' | 'execution';
  onClose: () => void;
  onSave: (config: P2pSavedConfig) => void;
  onPersistDaemonConfig?: (scopeSession: string, config: P2pSavedConfig) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  /** Optional source of daemon capability snapshots (from WsClient). When
   *  omitted, the panel treats capability state as stale and disables advanced
   *  launch — that is the safe default until the caller wires up a source. */
  daemonCapabilitySource?: P2pConfigPanelCapabilitySource | null;
}

const EXCLUDED_TYPES = new Set(['shell', 'script']);
const SESSION_MODES = ['audit', 'review', 'plan', 'brainstorm', 'discuss', 'skip'] as const;
const ROUND_OPTIONS = [1, 2, 3, 5] as const;
const DEFAULT_P2P_ROUNDS = 1;
type AgentFlavorFilter = 'sdk' | 'cli';

export interface P2pWorkflowLaunchContextInput {
  sessionName?: string;
  projectDir?: string;
  cwd?: string;
  userText?: string;
  locale?: string;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOldAdvancedConfig(config: P2pSavedConfig): boolean {
  return Boolean(config.advancedPresetKey || config.advancedRounds?.length || config.advancedRunTimeoutMinutes != null || config.contextReducer);
}

const FORBIDDEN_ENVELOPE_FIELDS = new Set<string>(P2P_FORBIDDEN_ENVELOPE_FIELD_NAMES);

function findForbiddenEnvelopeField(value: unknown): string | null {
  if (!isRecord(value) && !Array.isArray(value)) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenEnvelopeField(item);
      if (found) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      FORBIDDEN_ENVELOPE_FIELDS.has(key) ||
      normalized.endsWith('token') ||
      normalized.endsWith('secret') ||
      normalized.endsWith('apikey') ||
      normalized === 'env' ||
      normalized === 'environment'
    ) {
      return key;
    }
    const found = findForbiddenEnvelopeField(nested);
    if (found) return found;
  }
  return null;
}

function isLaunchableDraft(value: unknown): value is P2pWorkflowDraft {
  if (!isRecord(value)) return false;
  return value.schemaVersion === P2P_WORKFLOW_SCHEMA_VERSION &&
    typeof value.id === 'string' &&
    Array.isArray(value.nodes) &&
    value.nodes.length > 0 &&
    Array.isArray(value.edges);
}

function isLaunchableEnvelope(value: unknown): value is P2pWorkflowLaunchEnvelope {
  if (!isRecord(value) || findForbiddenEnvelopeField(value)) return false;
  return value.workflowSchemaVersion === P2P_WORKFLOW_SCHEMA_VERSION &&
    value.workflowKind === 'advanced' &&
    (value.advancedDraft === undefined || isLaunchableDraft(value.advancedDraft));
}

function compactLaunchContext(input: P2pWorkflowLaunchContextInput | undefined): P2pWorkflowLaunchEnvelope['launchContext'] | undefined {
  const projectRoot = input?.projectDir?.trim() || input?.cwd?.trim();
  const launchContext: NonNullable<P2pWorkflowLaunchEnvelope['launchContext']> = {};
  if (input?.sessionName?.trim()) launchContext.sessionName = input.sessionName.trim();
  if (projectRoot) launchContext.projectRoot = projectRoot;
  if (input?.userText?.trim()) launchContext.userText = input.userText.trim();
  if (input?.locale?.trim()) launchContext.locale = input.locale.trim();
  return Object.keys(launchContext).length > 0 ? launchContext : undefined;
}

export function buildP2pWorkflowLaunchEnvelopeFromConfig(
  config: P2pSavedConfig,
  launchContextInput?: P2pWorkflowLaunchContextInput,
): P2pWorkflowLaunchEnvelope | null {
  const launchContext = compactLaunchContext(launchContextInput);
  // R3 PR-α follow-up — UI-managed allowlist. The authoritative list is
  // owned by `config.allowedExecutables` (edited in `P2pConfigPanel`).
  // We surface it on every fresh envelope build AND patch it onto a
  // pre-saved envelope when the user has edited the list since the
  // envelope was first computed (so the saved envelope path doesn't drift
  // from the latest UI state).
  const allowedExecutables = sanitizeAllowedExecutables(config.allowedExecutables);
  const savedEnvelope = config.workflowLaunchEnvelope ? cloneJson(config.workflowLaunchEnvelope) : null;
  if (savedEnvelope) {
    const candidate = {
      ...savedEnvelope,
      ...(launchContext ? { launchContext: { ...(savedEnvelope.launchContext ?? {}), ...launchContext } } : {}),
      ...(allowedExecutables.length > 0 ? { allowedExecutables } : {}),
    };
    if (isLaunchableEnvelope(candidate)) return candidate;
  }

  // R3 v2 PR-ι — Resolve the active workflow through the centralised
  // helper so the launch path and the UI agree on which entry of the
  // library the envelope captures. `getActiveWorkflowFromConfig` falls
  // back to the legacy `workflowDraft` field for pre-PR-ι configs that
  // were saved before the library refactor.
  const activeWorkflow = getActiveWorkflowFromConfig(config);
  let draft: P2pWorkflowDraft | null = activeWorkflow ? cloneJson(activeWorkflow) : null;
  if (!draft && hasOldAdvancedConfig(config)) {
    try {
      draft = materializeOldAdvancedConfigToWorkflowDraft({
        advancedPresetKey: config.advancedPresetKey,
        advancedRounds: config.advancedRounds,
        advancedRunTimeoutMinutes: config.advancedRunTimeoutMinutes,
      });
    } catch {
      draft = null;
    }
  }
  if (!draft) return null;
  if (!isLaunchableDraft(draft) || findForbiddenEnvelopeField(draft)) return null;
  const envelope: P2pWorkflowLaunchEnvelope = {
    workflowSchemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
    workflowKind: 'advanced',
    advancedDraft: draft,
    requiredDaemonCapabilities: [P2P_WORKFLOW_CAPABILITY_V1],
    ...(launchContext ? { launchContext } : {}),
    ...(allowedExecutables.length > 0 ? { allowedExecutables } : {}),
  };
  return isLaunchableEnvelope(envelope) ? envelope : null;
}

/**
 * R3 PR-α follow-up — UI-side hygiene before the envelope hits the wire.
 * Server-side validator (`validateP2pWorkflowLaunchEnvelope.allowedExecutables`)
 * enforces the same shape, but doing it client-side avoids round-tripping
 * obviously-bad entries.
 */
function sanitizeAllowedExecutables(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > 256) continue;
    // Reject any character outside visible ASCII (matches
    // `P2P_REQUEST_ID_ASCII_PATTERN` server-side).
    if (!/^[\x21-\x7e]+$/.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= 64) break;
  }
  return result.sort();
}

function getAgentFlavor(agentType: string): AgentFlavorFilter {
  if (agentType === 'claude-code' || agentType === 'codex' || agentType === 'gemini' || agentType === 'opencode') return 'cli';
  return 'sdk';
}

const headerStyle: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '16px 20px 12px',
  borderBottom: '1px solid #334155',
};

const titleStyle: Record<string, string | number> = {
  margin: 0,
  fontSize: 15,
  fontWeight: 600,
  color: '#f1f5f9',
};

const closeBtnStyle: Record<string, string | number> = {
  background: 'none',
  border: 'none',
  color: '#64748b',
  fontSize: 20,
  cursor: 'pointer',
  lineHeight: 1,
  padding: 0,
};

const bodyStyle: Record<string, string | number> = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '12px 20px',
};

const tabsStyle: Record<string, string | number> = {
  display: 'flex',
  gap: 8,
  padding: '0 20px 12px',
  borderBottom: '1px solid #334155',
};

const tabStyle = (active: boolean): Record<string, string | number> => ({
  padding: '6px 12px',
  borderRadius: 999,
  border: `1px solid ${active ? '#3b82f6' : '#475569'}`,
  background: active ? '#1d4ed840' : '#0f172a',
  color: active ? '#bfdbfe' : '#94a3b8',
  fontSize: 12,
  fontWeight: active ? 600 : 500,
  cursor: 'pointer',
});

const rowStyle: Record<string, string | number> = {
  display: 'grid',
  gridTemplateColumns: '18px minmax(0, 1fr) minmax(110px, auto)',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  borderRadius: 6,
  background: '#0f172a',
  border: '1px solid #334155',
  minWidth: 0,
};

const checkboxStyle: Record<string, string | number> = {
  accentColor: '#3b82f6',
  width: 15,
  height: 15,
  cursor: 'pointer',
  flexShrink: 0,
};


const badgeStyle: Record<string, string | number> = {
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: 4,
  background: '#334155',
  color: '#94a3b8',
  flexShrink: 0,
};

const selectStyle: Record<string, string | number> = {
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 5,
  color: '#e2e8f0',
  fontSize: 12,
  padding: '3px 6px',
  cursor: 'pointer',
  flexShrink: 0,
};

const sectionLabelStyle: Record<string, string | number> = {
  fontSize: 11,
  fontWeight: 600,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginTop: 14,
  marginBottom: 6,
};

const agentGridStyle = (mobile: boolean): Record<string, string | number> => ({
  display: 'grid',
  gridTemplateColumns: mobile ? '1fr' : 'repeat(2, minmax(0, 1fr))',
  gap: 10,
});

const sectionCardStyle: Record<string, string | number> = {
  background: '#111827',
  border: '1px solid #334155',
  borderRadius: 10,
  padding: 14,
};

const roundsBtnStyle = (active: boolean): Record<string, string | number> => ({
  padding: '4px 12px',
  borderRadius: 6,
  border: `1px solid ${active ? '#3b82f6' : '#475569'}`,
  background: active ? '#1d4ed840' : '#1e293b',
  color: active ? '#93c5fd' : '#e2e8f0',
  fontSize: 13,
  fontWeight: active ? 600 : 400,
  cursor: 'pointer',
});

const footerStyle: Record<string, string | number> = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '12px 20px',
  borderTop: '1px solid #334155',
};

const btnSecondaryStyle: Record<string, string | number> = {
  padding: '6px 16px',
  borderRadius: 6,
  border: '1px solid #475569',
  background: 'none',
  color: '#94a3b8',
  fontSize: 13,
  cursor: 'pointer',
};

const btnPrimaryStyle: Record<string, string | number> = {
  padding: '6px 16px',
  borderRadius: 6,
  border: '1px solid #3b82f6',
  background: '#3b82f6',
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

export function P2pConfigPanel({
  sessions,
  subSessions,
  activeSession,
  serverId,
  initialTab = 'participants',
  onClose,
  onSave,
  onPersistDaemonConfig,
  daemonCapabilitySource,
}: Props) {
  const { t } = useTranslation();
  const [agentFlavorFilter, setAgentFlavorFilter] = useState<AgentFlavorFilter>('sdk');
  const [activeTab, setActiveTab] = useState<'participants' | 'combos' | 'advanced' | 'execution'>(initialTab);
  const { customCombos, saveCustomCombos } = useP2pCustomCombos();
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Build combined eligible session list (exclude shell/script).
  // If activeSession is a sub-session, resolve its parent for scope filtering.
  const scopeSession = (() => {
    if (!activeSession) return null;
    if (activeSession.startsWith('deck_sub_')) {
      const parentRef = subSessions.find(s => s.sessionName === activeSession)?.parentSession;
      return parentRef ?? activeSession;
    }
    return activeSession;
  })();

  const allEligible: Array<{ key: string; shortName: string; agentType: string; flavor: AgentFlavorFilter }> = [];
  const seen = new Set<string>();

  for (const s of sessions) {
    if (EXCLUDED_TYPES.has(s.agentType)) continue;
    if (scopeSession && s.name !== scopeSession) continue;
    if (!isP2pMemberEligibleSession(s.name, { scopeSession, role: s.role })) continue;
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    const shortName = s.name.split('_').pop() || s.name;
    allEligible.push({ key: s.name, shortName, agentType: s.agentType, flavor: getAgentFlavor(s.agentType) });
  }

  for (const s of subSessions) {
    if (EXCLUDED_TYPES.has(s.type)) continue;
    if (scopeSession && s.parentSession && s.parentSession !== scopeSession) continue;
    if (!isP2pMemberEligibleSession(s.sessionName, { scopeSession })) continue;
    if (seen.has(s.sessionName)) continue;
    seen.add(s.sessionName);
    const shortName = s.label || s.sessionName;
    allEligible.push({ key: s.sessionName, shortName, agentType: s.type, flavor: getAgentFlavor(s.type) });
  }

  const visibleEligible = allEligible.filter((entry) => entry.flavor === agentFlavorFilter);

  // ── Dedicated execution routing (clone) preference ──────────────────────
  // GLOBAL enabled flag + per-project template session. Reading/saving here
  // only persists the preference; it NEVER dispatches an execution.
  const executionRouting = useExecutionRouting(serverId ?? null);
  // Eligibility is DAEMON-AUTHORITATIVE: the daemon computes
  // `executionTemplateEligible` (+ an ineligibility reason code) per session and
  // the UI renders that rather than recomputing eligibility client-side.
  //
  // Candidate population (matches the pre-existing template scoping):
  //   - Sub-sessions in scope are the real templates → daemon flag applied; a
  //     missing flag (legacy daemon that doesn't project it onto sub-sessions)
  //     falls back to eligible so an old daemon doesn't hide every candidate.
  //   - Sibling/worker MAIN sessions appear only when the daemon explicitly
  //     marks them eligible (`=== true`); the orchestrator/scope session itself
  //     is never listed.
  // shell/script types and the current calling session are always excluded.
  const executionTemplateScan = useMemo(() => {
    const eligible: Array<{ key: string; shortName: string }> = [];
    const ineligible: Array<{ key: string; shortName: string; reason?: string }> = [];
    const seenExec = new Set<string>();
    const pushEligible = (key: string, shortName: string) => {
      if (seenExec.has(key)) return;
      seenExec.add(key);
      eligible.push({ key, shortName });
    };
    const pushIneligible = (key: string, shortName: string, reason?: string) => {
      if (seenExec.has(key)) return;
      seenExec.add(key);
      ineligible.push({ key, shortName, reason });
    };
    // Sibling main/worker sessions: include only when the daemon authoritatively
    // marks eligible. The scope (orchestrator) session is never a template.
    for (const s of sessions) {
      if (EXCLUDED_TYPES.has(s.agentType)) continue;
      if (s.name === scopeSession) continue;
      if (activeSession && s.name === activeSession) continue;
      const shortName = s.name.split('_').pop() || s.name;
      if (s.executionTemplateEligible === true) pushEligible(s.name, shortName);
      else if (s.executionTemplateEligible === false) pushIneligible(s.name, shortName, s.executionTemplateIneligibleReason);
      // undefined (legacy main-session flag absent) → not surfaced as a template.
    }
    // Sub-sessions in scope: the primary template source.
    for (const s of subSessions) {
      if (EXCLUDED_TYPES.has(s.type)) continue;
      if (scopeSession && s.parentSession && s.parentSession !== scopeSession) continue;
      if (activeSession && s.sessionName === activeSession) continue;
      const shortName = s.label || s.sessionName;
      if (s.executionTemplateEligible === false) pushIneligible(s.sessionName, shortName, s.executionTemplateIneligibleReason);
      else pushEligible(s.sessionName, shortName); // true OR legacy-undefined
    }
    return { eligible, ineligible };
  }, [sessions, subSessions, scopeSession, activeSession]);
  const executionTemplateCandidates = executionTemplateScan.eligible;
  const executionTemplateIneligible = executionTemplateScan.ineligible;
  const selectedTemplate = executionRouting.templateSessionName;
  // "reselect required" when routing is enabled but the saved template is
  // missing or no longer a valid (daemon-eligible) candidate in the project.
  const templateReselectRequired = executionRouting.enabled
    && (!selectedTemplate || !executionTemplateCandidates.some((c) => c.key === selectedTemplate));

  // Local config state: per-session enabled + mode
  const [sessionCfg, setSessionCfg] = useState<P2pSessionConfig>({});
  const [rounds, setRounds] = useState(DEFAULT_P2P_ROUNDS);
  const [hopTimeoutMinutes, setHopTimeoutMinutes] = useState(8);
  const [extraPrompt, setExtraPrompt] = useState('');
  // R3 v2 PR-θ — these state vars retain saved-config compatibility for
  // legacy "old-advanced" presets that round-trip through `P2pSavedConfig`.
  // Their authoring UI was retired with the canvas-only refactor (no toggle
  // surface), but they are still rehydrated on load and re-emitted on save
  // so users with pre-existing `advancedPresetKey`/`advancedRounds` configs
  // do not silently lose data.
  const [advancedPresetKey, setAdvancedPresetKey] = useState<P2pAdvancedPresetKey | ''>('');
  const [advancedRounds, setAdvancedRounds] = useState<P2pAdvancedRound[] | undefined>(undefined);
  const [advancedRunTimeoutMinutes, setAdvancedRunTimeoutMinutes] = useState(30);
  const [contextReducerMode, setContextReducerMode] = useState<P2pContextReducerMode | ''>('');
  const [contextReducerSession, setContextReducerSession] = useState('');
  const [contextReducerTemplate, setContextReducerTemplate] = useState('');
  // R3 v2 PR-ι — Workflow library state. `workflowLibrary` is the master
  // list, `activeWorkflowId` selects the entry the canvas + launch
  // envelope currently target. The legacy `workflowDraft` mirror is kept
  // because some downstream code still reads it directly (e.g. saved
  // envelope diffing); it is always derived from
  // `workflowLibrary[activeWorkflowId]` via the helper module so the two
  // representations cannot drift.
  const [workflowLibrary, setWorkflowLibrary] = useState<P2pWorkflowDraft[]>([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | undefined>(undefined);
  const workflowDraft = useMemo(
    () => getActiveWorkflowFromConfig({
      sessions: {},
      rounds: 0,
      workflowLibrary,
      activeWorkflowId,
    }) ?? undefined,
    [workflowLibrary, activeWorkflowId],
  );
  /*
   * R3 v2 PR-ξ — True when ANY workflow in the library has at least one
   * script node. Drives whether the allowed-executables section is
   * surfaced at all. The allowlist is hard-enforced at script bind +
   * spawn time (`script_executable_denied`); for workflows with no
   * script nodes the allowlist is irrelevant and hiding it removes a
   * lot of cognitive noise from the advanced tab.
   */
  const workflowHasScriptNode = useMemo(
    () => workflowLibrary.some((wf) => Array.isArray(wf.nodes)
      && wf.nodes.some((node) => node?.nodeKind === 'script')),
    [workflowLibrary],
  );
  const [workflowLaunchEnvelope, setWorkflowLaunchEnvelope] = useState<P2pWorkflowLaunchEnvelope | undefined>(undefined);
  // R3 PR-α follow-up — UI-managed script executable allowlist. Round-trips
  // through `P2pSavedConfig.allowedExecutables` (userPref) and is written
  // into every advanced launch envelope via
  // `buildP2pWorkflowLaunchEnvelopeFromConfig`. The daemon merges this
  // into the bind-time `P2pStaticPolicy.allowedExecutables`.
  const [allowedExecutables, setAllowedExecutables] = useState<string[]>([]);
  const [allowedExecutableDraft, setAllowedExecutableDraft] = useState('');
  /*
   * R3 v2 PR-ξ — User feedback: the allowlist UI was always visible
   * for any advanced workflow (since the bootstrap auto-creates a
   * draft). For workflows that don't use script nodes (the common
   * case — most users design LLM-only graphs), the visible allowlist
   * is intrusive noise that suggests a configuration burden where
   * none exists. Hide the section entirely unless EITHER:
   *   1. Some workflow in the library actually has a `script` node, OR
   *   2. The user already has entries (so they explicitly opted in).
   * When relevant we still default to a COLLAPSED disclosure — users
   * have to click to open it.
   */
  const [allowedExecutablesExpanded, setAllowedExecutablesExpanded] = useState(false);
  const [advancedMigrationNeeded, setAdvancedMigrationNeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const formDirtyRef = useRef(false);
  const seededConfigKeyRef = useRef<string | null>(null);

  // ── Daemon capability tracking ───────────────────────────────────────────
  // Subscribe to daemon.hello snapshots; absent or stale snapshots disable
  // advanced launch. Never trust a stale snapshot — TTL is enforced per
  // `P2P_CAPABILITY_FRESHNESS_TTL_MS` from shared constants.
  const [capabilitySnapshot, setCapabilitySnapshot] = useState<P2pConfigPanelCapabilitySnapshot | null>(
    () => daemonCapabilitySource?.getSnapshot() ?? null,
  );
  // Tick used to re-evaluate freshness when no message arrives but the TTL
  // window elapses; without it a stale snapshot would still appear valid in
  // the rendered UI until the next external state change.
  const [, setCapabilityClockTick] = useState(0);
  useEffect(() => {
    if (!daemonCapabilitySource) {
      setCapabilitySnapshot(null);
      return;
    }
    setCapabilitySnapshot(daemonCapabilitySource.getSnapshot());
    const unsubscribe = daemonCapabilitySource.subscribe(() => {
      setCapabilitySnapshot(daemonCapabilitySource.getSnapshot());
    });
    return unsubscribe;
  }, [daemonCapabilitySource]);
  useEffect(() => {
    if (!capabilitySnapshot) return;
    // Audit fix (7c2570e9 follow-up to e940d73f-a8e / N4) — re-evaluate
    // freshness on a steady poll instead of a single timeout pinned to
    // `observedAt`. Now that staleness is derived from the WS client's
    // `daemonLastSeenAt` (which bumps on every daemon-originated message)
    // the panel must re-render periodically so it picks up the moving
    // freshness signal even when the snapshot object itself has not
    // changed since the first `daemon.hello`.
    //
    // Poll cadence is half the TTL so the worst-case lag between daemon
    // going silent and the banner appearing is bounded by `TTL + TTL/2`.
    const interval = setInterval(
      () => setCapabilityClockTick((tick) => tick + 1),
      Math.max(1_000, Math.floor(P2P_CAPABILITY_FRESHNESS_TTL_MS / 2)),
    );
    return () => clearInterval(interval);
  }, [capabilitySnapshot]);

  const advancedEnvelopePreview = useMemo(() => {
    if (!workflowLaunchEnvelope && workflowLibrary.length === 0 && !advancedPresetKey) return null;
    const draft: P2pSavedConfig = {
      sessions: {},
      rounds,
      updatedAt: Date.now(),
      hopTimeoutMinutes,
      extraPrompt: extraPrompt.trim() || undefined,
      advancedPresetKey: advancedPresetKey || undefined,
      advancedRounds,
      advancedRunTimeoutMinutes: advancedPresetKey ? advancedRunTimeoutMinutes : undefined,
      workflowLibrary,
      activeWorkflowId,
      workflowLaunchEnvelope,
      ...(allowedExecutables.length > 0 ? { allowedExecutables } : {}),
    };
    return buildP2pWorkflowLaunchEnvelopeFromConfig(draft, { sessionName: scopeSession ?? undefined });
  }, [advancedPresetKey, advancedRounds, advancedRunTimeoutMinutes, allowedExecutables, activeWorkflowId, extraPrompt, hopTimeoutMinutes, rounds, scopeSession, workflowLibrary, workflowLaunchEnvelope]);

  const hasAdvancedConfig = Boolean(advancedPresetKey || workflowDraft || workflowLaunchEnvelope);
  const futureSchemaDetected = useMemo(() => {
    if (workflowLaunchEnvelope && isFutureWorkflowSchema(workflowLaunchEnvelope)) return true;
    if (workflowDraft && isFutureWorkflowSchema(workflowDraft)) return true;
    if (advancedEnvelopePreview && isFutureWorkflowSchema(advancedEnvelopePreview)) return true;
    return false;
  }, [advancedEnvelopePreview, workflowDraft, workflowLaunchEnvelope]);

  const requiredCapabilities = useMemo(() => {
    if (!hasAdvancedConfig) return [] as string[];
    const required = new Set<string>([P2P_WORKFLOW_CAPABILITY_V1]);
    const envelopeCaps = advancedEnvelopePreview?.requiredDaemonCapabilities;
    if (Array.isArray(envelopeCaps)) {
      for (const cap of envelopeCaps) if (typeof cap === 'string' && cap) required.add(cap);
    }
    return [...required];
  }, [advancedEnvelopePreview, hasAdvancedConfig]);

  // Audit fix (7c2570e9 follow-up to e940d73f-a8e / N4) — prefer the
  // capability source's own `isStale()` so the panel and the WS client
  // share one definition of staleness. Falls back to the legacy inline
  // check (snapshot.observedAt + TTL) only when the source does not
  // implement the new method (test fixtures that pass plain objects).
  const capabilityStale = (() => {
    if (!capabilitySnapshot) return true;
    if (daemonCapabilitySource && typeof daemonCapabilitySource.isStale === 'function') {
      return daemonCapabilitySource.isStale();
    }
    return (Date.now() - capabilitySnapshot.observedAt) > P2P_CAPABILITY_FRESHNESS_TTL_MS;
  })();
  const missingCapabilities = useMemo(() => {
    if (!hasAdvancedConfig || capabilityStale || !capabilitySnapshot) return [] as string[];
    const have = new Set(capabilitySnapshot.capabilities);
    return requiredCapabilities.filter((cap) => !have.has(cap));
  }, [capabilitySnapshot, capabilityStale, hasAdvancedConfig, requiredCapabilities]);
  const missingRequiredCapability = missingCapabilities.length > 0;

  /** Save-time block. Future schemas cannot be safely re-serialised by an
   *  older client, so refuse the Save action entirely. Capability staleness
   *  and unaccepted migration are surfaced as banners but do NOT block Save —
   *  Save is the migration-acceptance action and configures (not launches)
   *  the workflow. The actual launch path (`appendOptionalAdvancedP2pConfig`
   *  in `SessionControls`) is gated separately when the envelope is sent. */
  const saveBlocked = hasAdvancedConfig && futureSchemaDetected;

  /** Aggregate launch-disabled signal exposed via a data attribute and used
   *  for assistive text. Kept as a single boolean to mirror the design's
   *  "advancedLaunchDisabled" gate. Aligns with smart-p2p-upgrade 9.5–9.7. */
  const advancedLaunchDisabled = hasAdvancedConfig && (
    advancedMigrationNeeded
    || futureSchemaDetected
    || capabilityStale
    || missingRequiredCapability
  );
  const readOnlyMode = futureSchemaDetected;

  const markFormDirty = () => {
    formDirtyRef.current = true;
  };

  const enabledSdkParticipants = useMemo(
    () => allEligible.filter((entry) => entry.flavor === 'sdk').filter((entry) => {
      const cfg = sessionCfg[entry.key];
      return !!cfg?.enabled && cfg.mode !== 'skip';
    }),
    [allEligible, sessionCfg],
  );

  // Config key uses server + main session (sub-sessions follow parent config).
  const configKey = scopeSession ? p2pSessionConfigPrefKey(scopeSession, serverId) : null;
  const p2pConfigPref = usePref<P2pSavedConfig>(configKey, {
    legacyKey: scopeSession ? p2pSessionConfigLegacyPrefKeys(scopeSession) : undefined,
    parse: parseP2pSavedConfig,
    serialize: serializeP2pSavedConfig,
  });
  const loading = Boolean(configKey && !p2pConfigPref.loaded);
  // Load saved config — per-session key with legacy global fallback
  useEffect(() => {
    const parsed = p2pConfigPref.value;
    if (!parsed) return;
    if (formDirtyRef.current && seededConfigKeyRef.current === configKey) return;
    const sanitized = sanitizeP2pSavedConfig(parsed, { scopeSession });
    seededConfigKeyRef.current = configKey;
    formDirtyRef.current = false;
    setSessionCfg(sanitized.sessions ?? {});
    setRounds(sanitized.rounds ?? DEFAULT_P2P_ROUNDS);
    setHopTimeoutMinutes(sanitized.hopTimeoutMinutes ?? 8);
    setExtraPrompt(sanitized.extraPrompt ?? '');
    setAdvancedPresetKey(sanitized.advancedPresetKey ?? '');
    setAdvancedRounds(sanitized.advancedRounds);
    setAdvancedRunTimeoutMinutes(sanitized.advancedRunTimeoutMinutes ?? 30);
    setContextReducerMode(sanitized.contextReducer?.mode ?? '');
    setContextReducerSession(sanitized.contextReducer?.sessionName ?? '');
    setContextReducerTemplate(sanitized.contextReducer?.templateSession ?? '');
    setAllowedExecutables(Array.isArray(sanitized.allowedExecutables)
      ? sanitized.allowedExecutables.filter((entry): entry is string => typeof entry === 'string')
      : []);
    setAllowedExecutableDraft('');
    // R3 v2 PR-ι — Lift any legacy single `workflowDraft` into the
    // workflow library before hydrating UI state. The migration is
    // idempotent + non-destructive, so users with mixed-shape configs
    // (saved by older clients still on the rolling-deploy window) load
    // cleanly into the library editor.
    const migrated = migrateLegacyWorkflowDraft(sanitized);
    const materializedEnvelope = buildP2pWorkflowLaunchEnvelopeFromConfig(migrated, {
      sessionName: scopeSession ?? undefined,
    });
    const initialLibrary = normalizeWorkflowLibrary(
      migrated.workflowLibrary
        ?? (materializedEnvelope?.advancedDraft ? [materializedEnvelope.advancedDraft] : []),
    );
    setWorkflowLibrary(initialLibrary);
    const desiredActive = migrated.activeWorkflowId
      ?? initialLibrary.find((entry) => entry.id === sanitized.activeWorkflowId)?.id
      ?? initialLibrary[0]?.id;
    setActiveWorkflowId(desiredActive);
    setWorkflowLaunchEnvelope(sanitized.workflowLaunchEnvelope ?? materializedEnvelope ?? undefined);
    const needsMigration = hasOldAdvancedConfig(sanitized) && !sanitized.workflowDraft && !sanitized.workflowLaunchEnvelope && initialLibrary.length === 0;
    setAdvancedMigrationNeeded(needsMigration);
  }, [configKey, p2pConfigPref.value, scopeSession]);

  useEffect(() => {
    if (contextReducerMode === 'reuse_existing_session') {
      const stillEligible = enabledSdkParticipants.some((entry) => entry.key === contextReducerSession);
      if (!stillEligible) setContextReducerSession(enabledSdkParticipants[0]?.key ?? '');
      return;
    }
    if (contextReducerMode === 'clone_sdk_session') {
      const stillEligible = enabledSdkParticipants.some((entry) => entry.key === contextReducerTemplate);
      if (!stillEligible) setContextReducerTemplate(enabledSdkParticipants[0]?.key ?? '');
      return;
    }
    setContextReducerSession('');
    setContextReducerTemplate('');
  }, [contextReducerMode, contextReducerSession, contextReducerTemplate, enabledSdkParticipants]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  /*
   * R3 v2 PR-θ + PR-ι — Auto-bootstrap a starter workflow when the user
   * lands on the advanced tab with an empty workflow library. The
   * canvas editor refuses to render without an active workflow, so
   * without this a brand-new user would see an empty tab and have no
   * path forward. The starter contains a single root LLM node so
   * validation passes immediately; users can rename / reshape / add
   * more entries from the canvas + library sidebar.
   */
  useEffect(() => {
    if (activeTab !== 'advanced') return;
    if (workflowLibrary.length > 0 || workflowLaunchEnvelope || advancedPresetKey) return;
    const starter: P2pWorkflowDraft = {
      schemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
      id: generateWorkflowDraftId(),
      title: t('p2p.tab.advanced_workflow_starter_title', P2P_WORKFLOW_DEFAULT_TITLE),
      nodes: [
        { id: 'node_1', title: t('p2p.tab.advanced_workflow_starter_node_title', 'Start'), nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' },
      ],
      edges: [],
      rootNodeId: 'node_1',
    };
    setWorkflowLibrary([starter]);
    setActiveWorkflowId(starter.id);
    markFormDirty();
  }, [activeTab, workflowLibrary.length, workflowLaunchEnvelope, advancedPresetKey, t]);

  const toggleEnabled = (key: string) => {
    markFormDirty();
    const eligibleKeys = new Set(allEligible.map((entry) => entry.key));
    setSessionCfg((prev) => {
      const sanitizedPrev = sanitizeP2pSessionConfig(prev, { scopeSession });
      const cur = prev[key] ?? { enabled: false, mode: 'audit' };
      const willEnable = !cur.enabled;
      const willCountAsParticipant = willEnable && cur.mode !== 'skip';
      if (willCountAsParticipant) {
        // Enforce hard cap at toggle time so the UI never lets a user select
        // more than MAX_P2P_PARTICIPANTS. Count only currently eligible
        // sessions: old saved configs can contain stale/closed/other-scope
        // entries, and those are pruned on save, so they must not block a
        // user from selecting the visible in-scope participants.
        const currentlyEnabledCount = Object.entries(sanitizedPrev).filter(
          ([k, e]) => k !== key && eligibleKeys.has(k) && e?.enabled === true && e.mode !== 'skip',
        ).length;
        if (currentlyEnabledCount >= MAX_P2P_PARTICIPANTS) {
          setSaveError(
            t('p2p.settings_max_participants', 'Team is limited to {{max}} participants. Disable one before enabling another.', {
              max: MAX_P2P_PARTICIPANTS,
            }),
          );
          return prev;
        }
        setSaveError(null);
      }
      return { ...sanitizedPrev, [key]: { ...cur, enabled: willEnable } };
    });
  };

  const setMode = (key: string, mode: string) => {
    markFormDirty();
    const eligibleKeys = new Set(allEligible.map((entry) => entry.key));
    setSessionCfg((prev) => {
      const sanitizedPrev = sanitizeP2pSessionConfig(prev, { scopeSession });
      const cur = prev[key] ?? { enabled: false, mode: 'audit' };
      const willCountAsParticipant = cur.enabled && mode !== 'skip';
      const didCountAsParticipant = cur.enabled && cur.mode !== 'skip';
      if (willCountAsParticipant && !didCountAsParticipant) {
        const currentlyEnabledCount = Object.entries(sanitizedPrev).filter(
          ([k, e]) => k !== key && eligibleKeys.has(k) && e?.enabled === true && e.mode !== 'skip',
        ).length;
        if (currentlyEnabledCount >= MAX_P2P_PARTICIPANTS) {
          setSaveError(
            t('p2p.settings_max_participants', 'Team is limited to {{max}} participants. Disable one before enabling another.', {
              max: MAX_P2P_PARTICIPANTS,
            }),
          );
          return prev;
        }
      }
      setSaveError(null);
      return { ...sanitizedPrev, [key]: { ...cur, mode } };
    });
  };

  /*
   * R3 v2 PR-λ — Save now accepts a `keepOpen` option so the workflow
   * library editor can persist incremental changes without dismissing
   * the whole panel. The original `Save & Close` semantics are preserved
   * (default `keepOpen: false`); the footer renders TWO buttons.
   */
  const handleSave = async (options: { keepOpen?: boolean } = {}) => {
    // Hard gate: a future-version draft/projection cannot be safely re-saved
    // by this client — it would silently re-serialise unknown fields. Refuse
    // and surface a translated diagnostic. The Save button is also disabled
    // in the UI; this is defense in depth.
    if (saveBlocked) {
      setSaveError(t('p2p.workflow.diagnostics.unsupported_schema_version'));
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveWarning(null);
    // Only keep entries for currently eligible sessions — drop stale entries
    // from old/closed sessions or other daemons to prevent config rot.
    const merged: P2pSessionConfig = {};
    for (const e of allEligible) {
      merged[e.key] = sessionCfg[e.key] ?? { enabled: false, mode: 'audit' };
    }
    // Enforce cap at save time too (defense-in-depth: stale configs loaded
    // from disk may already exceed the cap; the daemon also enforces this
    // gate, but we surface the error here for immediate UX feedback).
    const enabledCount = Object.values(merged).filter((entry) => entry.enabled === true && entry.mode !== 'skip').length;
    if (enabledCount > MAX_P2P_PARTICIPANTS) {
      setSaveError(
        t('p2p.settings_max_participants', 'Team is limited to {{max}} participants. Disable {{over}} before saving.', {
          max: MAX_P2P_PARTICIPANTS,
          over: enabledCount - MAX_P2P_PARTICIPANTS,
        }),
      );
      setSaving(false);
      return;
    }
    let contextReducer: P2pContextReducerConfig | undefined;
    if (advancedPresetKey && contextReducerMode === 'reuse_existing_session' && contextReducerSession) {
      contextReducer = { mode: 'reuse_existing_session', sessionName: contextReducerSession };
    } else if (advancedPresetKey && contextReducerMode === 'clone_sdk_session' && contextReducerTemplate) {
      contextReducer = { mode: 'clone_sdk_session', templateSession: contextReducerTemplate };
    }
    const resolvedAdvancedRounds = advancedPresetKey
      ? (advancedRounds ? JSON.parse(JSON.stringify(advancedRounds)) as P2pAdvancedRound[] : JSON.parse(JSON.stringify(BUILT_IN_ADVANCED_PRESETS[advancedPresetKey])) as P2pAdvancedRound[])
      : undefined;
    // R3 v2 PR-ι — normalize the in-memory library before save so any
    // mid-edit invalid entries are dropped and the entry cap is enforced
    // before the config touches storage.
    const normalizedLibrary = normalizeWorkflowLibrary(workflowLibrary);
    const resolvedActiveId = activeWorkflowId
      && normalizedLibrary.some((entry) => entry.id === activeWorkflowId)
      ? activeWorkflowId
      : normalizedLibrary[0]?.id;
    const oldAdvancedCfg: P2pSavedConfig = {
      sessions: merged,
      rounds,
      updatedAt: Date.now(),
      hopTimeoutMinutes,
      extraPrompt: extraPrompt.trim() || undefined,
      advancedPresetKey: advancedPresetKey || undefined,
      advancedRounds: resolvedAdvancedRounds,
      advancedRunTimeoutMinutes: advancedPresetKey ? advancedRunTimeoutMinutes : undefined,
      contextReducer,
      workflowLibrary: normalizedLibrary,
      activeWorkflowId: resolvedActiveId,
      workflowLaunchEnvelope,
      ...(allowedExecutables.length > 0 ? { allowedExecutables } : {}),
    };
    const envelope = buildP2pWorkflowLaunchEnvelopeFromConfig(oldAdvancedCfg, {
      sessionName: scopeSession ?? undefined,
    });
    if ((advancedPresetKey || normalizedLibrary.length > 0 || workflowLaunchEnvelope) && !envelope) {
      setSaveError(t('p2p.settings_workflow_migration_error'));
      setSaving(false);
      return;
    }
    const cfg: P2pSavedConfig = {
      sessions: merged,
      rounds,
      updatedAt: oldAdvancedCfg.updatedAt,
      hopTimeoutMinutes,
      extraPrompt: oldAdvancedCfg.extraPrompt,
      // R3 v2 PR-ι — Persist the full library + active id. Also keep
      // `workflowDraft` in sync as the legacy mirror so older clients
      // (mid-rolling-deploy) continue to launch the active workflow
      // from the single-draft slot. Library size always >= active count.
      ...(normalizedLibrary.length > 0 ? {
        workflowLibrary: normalizedLibrary,
        activeWorkflowId: resolvedActiveId,
      } : {}),
      ...(envelope ? { workflowDraft: envelope.advancedDraft, workflowLaunchEnvelope: envelope } : {}),
      // R3 PR-α follow-up — Persist the UI-managed allowlist so it
      // round-trips through userPref and is available to the next
      // envelope build.
      ...(allowedExecutables.length > 0 ? { allowedExecutables } : {}),
    };
    try {
      if (configKey) await p2pConfigPref.save(cfg);
      let daemonPersistResult: { ok: boolean; error?: string } | undefined;
      if (scopeSession && onPersistDaemonConfig) {
        daemonPersistResult = await onPersistDaemonConfig(scopeSession, cfg);
      }
      onSave(cfg);
      formDirtyRef.current = false;
      seededConfigKeyRef.current = configKey;
      if (daemonPersistResult && !daemonPersistResult.ok) {
        setSaveWarning(t('p2p.settings_save_warning', 'Saved to your account, but the local daemon copy failed to update. Retry or reconnect the daemon.'));
        setSaving(false);
        return;
      }
      setSaving(false);
      // R3 v2 PR-λ — Honor `keepOpen` so the user can continue editing
      // the workflow library after a save without re-opening the panel.
      if (!options.keepOpen) onClose();
      return;
    } catch {
      setSaveError(t('p2p.settings_save_error', 'Failed to save Team settings. Check your connection and try again.'));
    }
    setSaving(false);
  };

  const getEntry = (key: string) => sessionCfg[key] ?? { enabled: false, mode: 'audit' };

  // R3 v2 PR-θ — old-advanced authoring (preset selector, rounds editor,
  // context-reducer dropdowns) was retired with the canvas-only refactor.
  // The state vars above stay for round-trip compatibility, but interactive
  // editing is now done exclusively through `AdvancedWorkflowCanvasEditor`
  // in the new `advanced` tab. `BUILT_IN_ADVANCED_PRESETS` is still imported
  // because `handleSave` resolves preset → rounds when round-tripping a
  // legacy `advancedPresetKey` config that has no explicit `advancedRounds`.

  const overlayStyle: Record<string, string | number> = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: isMobile ? 'flex-start' : 'center',
    justifyContent: 'center',
    zIndex: 9999,
    padding: isMobile ? 'calc(env(safe-area-inset-top, 0px) + 12px) 0 0' : 16,
  };
  const mobilePanelHeight = 'calc(var(--vvh, 100dvh) - env(safe-area-inset-top, 0px) - 12px)';
  const mobileFooterStyle: Record<string, string | number> = {
    ...footerStyle,
    padding: '12px 20px calc(env(safe-area-inset-bottom, 0px) + 16px)',
  };
  const panelStyle: Record<string, string | number> = {
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: isMobile ? 0 : 10,
    /*
     * R3 v2 PR-λ — Panel widened from 780 → 1400 px on desktop. The
     * advanced tab now hosts the workflow library list + name input +
     * canvas editor + allowed-executables section + capability
     * banners; at 780 px those sections were getting cramped. Mobile
     * stays at full viewport width.
     */
    width: isMobile ? '100vw' : 'min(1400px, calc(100vw - 32px))',
    maxWidth: isMobile ? '100vw' : 1400,
    height: isMobile ? mobilePanelHeight : 'auto',
    maxHeight: isMobile ? mobilePanelHeight : '90vh',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    boxShadow: isMobile ? 'none' : '0 8px 32px rgba(0,0,0,0.5)',
    overflow: 'hidden',
  };

  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={panelStyle} data-readonly-mode={readOnlyMode ? 'true' : 'false'}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={titleStyle}>{t('p2p.settings_title')}</h2>
          <button style={closeBtnStyle} onClick={onClose}>✕</button>
        </div>
        <div style={tabsStyle}>
          <button type="button" style={tabStyle(activeTab === 'participants')} onClick={() => setActiveTab('participants')}>
            {t('p2p.picker.agents')}
          </button>
          <button type="button" style={tabStyle(activeTab === 'combos')} onClick={() => setActiveTab('combos')}>
            {t('p2p.combo_label')}
          </button>
          {/* R3 v2 PR-θ — dedicated tab for the visual advanced workflow
              canvas. Separates the simple mode-pipeline editor (combos)
              from the full graph editor (workflow) so users have an
              obvious entry point. Empty drafts auto-bootstrap on entry. */}
          <button
            type="button"
            style={tabStyle(activeTab === 'advanced')}
            onClick={() => setActiveTab('advanced')}
            data-testid="p2p-tab-advanced"
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span>{t('p2p.tab.advanced_workflow', '高级工作流')}</span>
              <span class="p2p-alpha-badge">{t('p2p.alpha_badge', 'Alpha')}</span>
            </span>
          </button>
          <button
            type="button"
            style={tabStyle(activeTab === 'execution')}
            onClick={() => setActiveTab('execution')}
            data-testid="p2p-tab-execution"
          >
            {t('settings.executionRouting.title')}
          </button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 24, color: '#64748b', fontSize: 13 }}>…</div>
          ) : (
            activeTab === 'participants' ? (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <button
                    type="button"
                    style={tabStyle(agentFlavorFilter === 'sdk')}
                    onClick={() => setAgentFlavorFilter('sdk')}
                  >
                    {t('p2p.settings_filter_sdk', 'SDK')}
                  </button>
                  <button
                    type="button"
                    style={tabStyle(agentFlavorFilter === 'cli')}
                    onClick={() => setAgentFlavorFilter('cli')}
                  >
                    {t('p2p.settings_filter_cli', 'CLI')}
                  </button>
                </div>

                <div style={sectionCardStyle}>
                  <div style={{ ...sectionLabelStyle, marginTop: 0 }}>{t('p2p.picker.agents')}</div>
                  {visibleEligible.length === 0 && (
                    <div style={{ color: '#64748b', fontSize: 13, padding: '8px 0' }}>
                      {t('p2p.picker.no_agents_available')}
                    </div>
                  )}
                  <div style={agentGridStyle(isMobile)}>
                  {visibleEligible.map((e) => {
                    const entry = getEntry(e.key);
                    return (
                      <div key={e.key} style={{ ...rowStyle, opacity: entry.enabled ? 1 : 0.6 }}>
                        <input
                          type="checkbox"
                          style={checkboxStyle}
                          checked={entry.enabled}
                          onChange={() => toggleEnabled(e.key)}
                        />
                        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.shortName}</span>
                          <span style={{ ...badgeStyle, width: 'fit-content', fontSize: 10 }}>{e.agentType}</span>
                        </div>
                        <select
                          style={{ ...selectStyle, width: '100%', minWidth: 110, fontSize: 12, padding: '5px 8px' }}
                          value={entry.mode}
                          disabled={!entry.enabled}
                          onChange={(ev) => setMode(e.key, (ev.target as HTMLSelectElement).value)}
                        >
                          {SESSION_MODES.map((m) => (
                            <option key={m} value={m}>
                              {m === 'skip' ? t('p2p.settings_skip') : t(`p2p.mode.${m}`, m.charAt(0).toUpperCase() + m.slice(1))}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                  </div>
                </div>

                <div style={{ ...sectionCardStyle, marginTop: 12 }}>
                  <div style={{ ...sectionLabelStyle, marginTop: 0 }}>{t('p2p.settings_process_title', 'Team discussion flow')}</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>
                    {t('p2p.settings_process_body', 'Team mode runs a discussion-summary-implementation-review loop. One round completes the loop once; additional rounds use the previous implementation result as context for another audit/review pass so agents can catch missed requirements, regression risks, edge cases, and test gaps before the work is considered done.')}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 12, marginTop: 12 }}>
                  <div style={sectionCardStyle}>
                    <div style={{ ...sectionLabelStyle, marginTop: 0 }}>{t('p2p.settings_rounds')}</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {ROUND_OPTIONS.map((r) => (
                        <button
                          key={r}
                          type="button"
                          style={roundsBtnStyle(rounds === r)}
                          onClick={() => {
                            markFormDirty();
                            setRounds(r);
                          }}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
                      {t('p2p.settings_rounds_hint')}
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6, lineHeight: 1.5 }}>
                      {t('p2p.settings_rounds_explanation')}
                    </div>
                  </div>

                  <div style={sectionCardStyle}>
                    <div style={{ ...sectionLabelStyle, marginTop: 0 }}>{t('p2p.settings_hop_timeout', 'Hop Timeout')}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={hopTimeoutMinutes}
                        onInput={(e) => {
                          const v = parseInt((e.target as HTMLInputElement).value, 10);
                          if (v >= 1 && v <= 10) {
                            markFormDirty();
                            setHopTimeoutMinutes(v);
                          }
                        }}
                        style={{
                          width: 72,
                          background: '#0f172a',
                          border: '1px solid #334155',
                          borderRadius: 5,
                          color: '#e2e8f0',
                          fontSize: 13,
                          padding: '6px 8px',
                          textAlign: 'center',
                          outline: 'none',
                        }}
                      />
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>{t('p2p.settings_hop_timeout_unit', 'minutes per hop')}</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
                      {t('p2p.settings_hop_timeout_hint', 'How long to wait for each agent to respond. Increase for complex tasks.')}
                    </div>
                  </div>
                </div>

                <div style={{ ...sectionCardStyle, marginTop: 12 }}>
                  <div style={{ ...sectionLabelStyle, marginTop: 0 }}>{t('p2p.settings_extra_prompt')}</div>
                  <textarea
                    value={extraPrompt}
                    onInput={(e) => {
                      markFormDirty();
                      setExtraPrompt((e.target as HTMLTextAreaElement).value);
                    }}
                    placeholder={t('p2p.settings_extra_prompt_hint')}
                    rows={3}
                    style={{
                      width: '100%',
                      background: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: 6,
                      color: '#e2e8f0',
                      fontFamily: 'inherit',
                      fontSize: 13,
                      padding: '8px 10px',
                      resize: 'vertical',
                      outline: 'none',
                    }}
                  />
                </div>

              </>
            ) : activeTab === 'combos' ? (
              <>
                <div style={sectionCardStyle}>
                  <div style={{ ...sectionLabelStyle, marginTop: 0 }}>{t('p2p.combo_label')}</div>
                  <P2pComboManager
                    customCombos={customCombos}
                    onCustomCombosChange={saveCustomCombos}
                  />
                </div>
              </>
            ) : activeTab === 'execution' ? (
              /*
               * Dedicated execution routing (clone) tab. Toggling/selecting
               * here only persists the preference — it never dispatches an
               * execution. The template select lists only eligible non-main
               * sessions of the current project (the current session is
               * excluded; shell/script and brain/host are already filtered).
               */
              <>
                <div style={sectionCardStyle} data-testid="exec-routing-section">
                  <div style={{ ...sectionLabelStyle, marginTop: 0 }}>
                    {t('settings.executionRouting.title')}
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      style={checkboxStyle}
                      checked={executionRouting.enabled}
                      data-testid="exec-routing-enabled"
                      onChange={(e) => {
                        void executionRouting.setEnabled((e.target as HTMLInputElement).checked);
                      }}
                    />
                    <span style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600 }}>
                      {t('settings.executionRouting.enableLabel')}
                    </span>
                  </label>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, lineHeight: 1.5 }}>
                    {t('settings.executionRouting.enableHint')}
                  </div>

                  <div style={{ ...sectionLabelStyle, marginBottom: 6 }}>
                    {t('settings.executionRouting.templateLabel')}
                  </div>
                  <select
                    style={{ ...selectStyle, width: '100%', minWidth: 0, fontSize: 13, padding: '6px 8px' }}
                    value={selectedTemplate ?? ''}
                    disabled={!executionRouting.enabled}
                    data-testid="exec-routing-template"
                    onChange={(ev) => {
                      const v = (ev.target as HTMLSelectElement).value;
                      void executionRouting.setTemplateSessionName(v || null);
                    }}
                  >
                    <option value="">{t('settings.executionRouting.templateNone')}</option>
                    {executionTemplateCandidates.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.shortName}
                      </option>
                    ))}
                    {/* Daemon-authoritative ineligible sessions are shown
                        (disabled) with their reason so the user understands
                        why a session is not selectable, instead of it silently
                        vanishing. The reason is an EXECUTION_CLONE error code;
                        localize it, falling back to the raw code. */}
                    {executionTemplateIneligible.map((c) => {
                      const reasonText = c.reason
                        ? t(`settings.executionRouting.ineligibleReason.${c.reason}`, c.reason)
                        : '';
                      return (
                        <option key={c.key} value={c.key} disabled>
                          {reasonText
                            ? t('settings.executionRouting.ineligibleOption', '{{name}} — {{reason}}', {
                                name: c.shortName,
                                reason: reasonText,
                              })
                            : c.shortName}
                        </option>
                      );
                    })}
                  </select>
                  {executionTemplateCandidates.length === 0 && (
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
                      {t('settings.executionRouting.noCandidates')}
                    </div>
                  )}
                  {templateReselectRequired && (
                    <div
                      style={{ fontSize: 11, color: '#fbbf24', marginTop: 6, lineHeight: 1.5 }}
                      data-testid="exec-routing-reselect"
                    >
                      {t('settings.executionRouting.reselectRequired')}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, lineHeight: 1.5 }}>
                    {t('settings.executionRouting.templateHint')}
                  </div>
                </div>
              </>
            ) : (
              /*
               * Advanced Workflow tab shell. Single home for the
               * full canvas-based graph editor plus every advanced-config
               * block (migration banner, allowed-executables allowlist,
               * future-schema banner, capability stale/missing banners).
               * The participants tab no longer holds any advanced UI —
               * users always reach the canvas through this tab. A brand-
               * new user who clicks the tab gets an empty starter draft
               * auto-bootstrapped (see useEffect above) so the canvas
               * never appears blank without an entry path.
               */
              <>
                <div
                  style={{ ...sectionCardStyle, marginTop: 0, color: '#94a3b8', fontSize: 12, lineHeight: 1.5 }}
                  data-testid="p2p-advanced-tab-intro"
                >
                  {t('p2p.tab.advanced_workflow_intro', 'Design a directed Team workflow. Nodes are agent rounds (LLM, script, or logic gates); edges control routing. Edits here override the simple round/mode pipeline configured under Agents.')}
                </div>
                <div
                  class="p2p-alpha-notice"
                  data-testid="p2p-advanced-alpha-notice"
                  title={t('p2p.alpha_hint', 'Experimental capability; not formally validated yet.')}
                >
                  <span class="p2p-alpha-badge">{t('p2p.alpha_badge', 'Alpha')}</span>
                  <span>{t('p2p.tab.advanced_workflow_alpha_notice', 'Experimental capability; not formally validated yet. Prefer preset combos for critical work.')}</span>
                </div>

                {(advancedMigrationNeeded || workflowLaunchEnvelope) && (
                  <div style={{ ...sectionCardStyle, marginTop: 12, borderColor: advancedMigrationNeeded ? '#f59e0b' : '#334155' }}>
                    <div style={{ ...sectionLabelStyle, marginTop: 0 }}>
                      {t('p2p.settings_workflow_migration_title')}
                    </div>
                    <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.5 }}>
                      {advancedMigrationNeeded
                        ? t('p2p.settings_workflow_migration_body')
                        : t('p2p.settings_workflow_migration_ready')}
                    </div>
                  </div>
                )}

                {!workflowDraft && !workflowLaunchEnvelope && !advancedPresetKey && (
                  <div
                    style={{ ...sectionCardStyle, marginTop: 12, color: '#94a3b8', fontSize: 12, lineHeight: 1.5 }}
                    data-testid="p2p-advanced-empty-hint"
                  >
                    {t('p2p.tab.advanced_workflow_empty_hint', 'Initializing a blank workflow draft. Add nodes and edges in the canvas below to design your Team pipeline.')}
                  </div>
                )}

                {/*
                 * R3 v2 PR-ι — Workflow library manager. Users can store up
                 * to `P2P_WORKFLOW_LIBRARY_MAX_ENTRIES` named workflows per
                 * scope-session and switch the active one for the next P2P
                 * launch. Naming, duplication, and deletion all flow
                 * through the shared helpers in `p2p-workflow-library.ts`
                 * so the UI and the launch envelope agree on which entry
                 * the canvas + envelope-build path target.
                 */}
                {workflowLibrary.length > 0 && (
                  <div
                    style={{ ...sectionCardStyle, marginTop: 12 }}
                    data-testid="p2p-workflow-library-section"
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ ...sectionLabelStyle, marginTop: 0, marginBottom: 0 }}>
                        {t('p2p.workflow.library.title', 'Workflow library')}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          disabled={readOnlyMode || workflowLibrary.length >= P2P_WORKFLOW_LIBRARY_MAX_ENTRIES}
                          data-testid="p2p-workflow-library-new"
                          style={{
                            padding: '4px 10px', borderRadius: 5, border: '1px solid #475569',
                            background: '#1e293b', color: '#cbd5e1', fontSize: 11,
                            cursor: readOnlyMode || workflowLibrary.length >= P2P_WORKFLOW_LIBRARY_MAX_ENTRIES ? 'not-allowed' : 'pointer',
                          }}
                          onClick={() => {
                            const fresh: P2pWorkflowDraft = {
                              schemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
                              id: generateWorkflowDraftId(),
                              title: t('p2p.tab.advanced_workflow_starter_title', P2P_WORKFLOW_DEFAULT_TITLE),
                              nodes: [
                                { id: 'node_1', title: t('p2p.tab.advanced_workflow_starter_node_title', 'Start'), nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' },
                              ],
                              edges: [],
                              rootNodeId: 'node_1',
                            };
                            const seed: P2pSavedConfig = { sessions: {}, rounds: 0, workflowLibrary, activeWorkflowId };
                            const next = addWorkflowToLibrary(seed, fresh, { activate: true });
                            setWorkflowLibrary(next.workflowLibrary ?? []);
                            setActiveWorkflowId(next.activeWorkflowId);
                            setWorkflowLaunchEnvelope(undefined);
                            markFormDirty();
                          }}
                        >
                          {t('p2p.workflow.library.new', '+ New')}
                        </button>
                        <button
                          type="button"
                          disabled={readOnlyMode || !activeWorkflowId || workflowLibrary.length >= P2P_WORKFLOW_LIBRARY_MAX_ENTRIES}
                          data-testid="p2p-workflow-library-duplicate"
                          style={{
                            padding: '4px 10px', borderRadius: 5, border: '1px solid #475569',
                            background: '#1e293b', color: '#cbd5e1', fontSize: 11,
                            cursor: readOnlyMode || !activeWorkflowId || workflowLibrary.length >= P2P_WORKFLOW_LIBRARY_MAX_ENTRIES ? 'not-allowed' : 'pointer',
                          }}
                          onClick={() => {
                            if (!activeWorkflowId) return;
                            const seed: P2pSavedConfig = { sessions: {}, rounds: 0, workflowLibrary, activeWorkflowId };
                            const next = duplicateWorkflowInLibrary(seed, activeWorkflowId, t('p2p.workflow.library.copy_suffix', ' (copy)'));
                            setWorkflowLibrary(next.workflowLibrary ?? []);
                            setActiveWorkflowId(next.activeWorkflowId);
                            setWorkflowLaunchEnvelope(undefined);
                            markFormDirty();
                          }}
                        >
                          {t('p2p.workflow.library.duplicate', 'Duplicate')}
                        </button>
                        <button
                          type="button"
                          disabled={readOnlyMode || !activeWorkflowId || workflowLibrary.length <= 1}
                          data-testid="p2p-workflow-library-delete"
                          style={{
                            padding: '4px 10px', borderRadius: 5, border: '1px solid #7f1d1d',
                            background: '#1e293b', color: '#fca5a5', fontSize: 11,
                            cursor: readOnlyMode || !activeWorkflowId || workflowLibrary.length <= 1 ? 'not-allowed' : 'pointer',
                          }}
                          onClick={() => {
                            if (!activeWorkflowId) return;
                            const target = workflowLibrary.find((entry) => entry.id === activeWorkflowId);
                            if (!target) return;
                            const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
                              ? window.confirm(t('p2p.workflow.library.delete_confirm', 'Delete workflow "{{title}}"? This cannot be undone.', { title: target.title ?? P2P_WORKFLOW_DEFAULT_TITLE }))
                              : true;
                            if (!ok) return;
                            const seed: P2pSavedConfig = { sessions: {}, rounds: 0, workflowLibrary, activeWorkflowId };
                            const next = removeWorkflowFromLibrary(seed, activeWorkflowId);
                            setWorkflowLibrary(next.workflowLibrary ?? []);
                            setActiveWorkflowId(next.activeWorkflowId);
                            setWorkflowLaunchEnvelope(undefined);
                            markFormDirty();
                          }}
                        >
                          {t('p2p.workflow.library.delete', 'Delete')}
                        </button>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5, marginTop: 6 }}>
                      {t('p2p.workflow.library.hint', 'Saved workflows for this session. The active one is sent to Team launches. Up to {{max}} entries.', { max: P2P_WORKFLOW_LIBRARY_MAX_ENTRIES })}
                    </div>
                    <ul
                      style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}
                      data-testid="p2p-workflow-library-list"
                    >
                      {workflowLibrary.map((entry) => {
                        const isActive = entry.id === activeWorkflowId;
                        return (
                          <li
                            key={entry.id}
                            data-testid={`p2p-workflow-library-entry-${entry.id}`}
                            data-active={isActive ? 'true' : 'false'}
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
                              background: isActive ? '#1d4ed840' : '#0b1220',
                              border: `1px solid ${isActive ? '#3b82f6' : '#1e293b'}`,
                              borderRadius: 5, padding: '6px 10px',
                              cursor: 'pointer',
                            }}
                            onClick={() => {
                              if (entry.id === activeWorkflowId) return;
                              setActiveWorkflowId(entry.id);
                              setWorkflowLaunchEnvelope(undefined);
                              markFormDirty();
                            }}
                          >
                            <span style={{ fontSize: 13, color: isActive ? '#bfdbfe' : '#e2e8f0', fontWeight: isActive ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {entry.title?.trim() ? entry.title : t('p2p.tab.advanced_workflow_starter_title', P2P_WORKFLOW_DEFAULT_TITLE)}
                            </span>
                            {isActive && (
                              <span style={{ ...badgeStyle, background: '#1e3a8a', color: '#bfdbfe', fontSize: 10 }}>
                                {t('p2p.workflow.library.active_badge', 'Active')}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {/*
                 * R3 v2 PR-θ — Advanced Workflow tab. Keep this marker close
                 * to the canvas + allowlist mounts so the source-level
                 * regression guard proves both live in this branch even as
                 * the explanatory/library UI above evolves.
                 */}
                {workflowDraft && (
                  <div style={{ ...sectionCardStyle, marginTop: 12 }} data-testid="p2p-workflow-name-section">
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span style={{ ...sectionLabelStyle, marginTop: 0, marginBottom: 0 }}>
                        {t('p2p.workflow.library.name_label', 'Workflow name')}
                      </span>
                      <input
                        type="text"
                        value={workflowDraft.title ?? ''}
                        disabled={readOnlyMode}
                        maxLength={128}
                        placeholder={t('p2p.workflow.library.name_placeholder', 'e.g. Audit + plan workflow')}
                        data-testid="p2p-workflow-name-input"
                        onInput={(event) => {
                          const value = (event.target as HTMLInputElement).value;
                          const next: P2pWorkflowDraft = { ...workflowDraft, title: value };
                          const seed: P2pSavedConfig = { sessions: {}, rounds: 0, workflowLibrary, activeWorkflowId };
                          const updated = replaceActiveWorkflowInConfig(seed, next);
                          setWorkflowLibrary(updated.workflowLibrary ?? []);
                          setActiveWorkflowId(updated.activeWorkflowId);
                          setWorkflowLaunchEnvelope(undefined);
                          markFormDirty();
                        }}
                        style={{
                          width: '100%', background: '#0f172a', border: '1px solid #334155', borderRadius: 6,
                          color: '#e2e8f0', fontSize: 13, padding: '7px 9px', outline: 'none',
                        }}
                      />
                    </label>
                  </div>
                )}

                {workflowDraft && (
                  <div style={{ marginTop: 12 }}>
                    <AdvancedWorkflowCanvasEditor
                      value={workflowDraft}
                      readOnly={readOnlyMode}
                      onChange={(next) => {
                        markFormDirty();
                        // R3 v2 PR-ι — Route the canvas edit through the
                        // library so the active entry stays in sync. The
                        // helper preserves the active id even when the
                        // editor returns a new draft object.
                        const seed: P2pSavedConfig = { sessions: {}, rounds: 0, workflowLibrary, activeWorkflowId };
                        const updated = replaceActiveWorkflowInConfig(seed, next);
                        setWorkflowLibrary(updated.workflowLibrary ?? []);
                        setActiveWorkflowId(updated.activeWorkflowId);
                        // Strip the launch envelope so Save will re-derive a
                        // fresh one from the edited draft. Keeps the editor as
                        // the single source of truth while the dialog is open.
                        setWorkflowLaunchEnvelope(undefined);
                      }}
                    />
                  </div>
                )}

                {/*
                 * R3 PR-α follow-up + R3 v2 PR-ξ — UI-managed script
                 * executable allowlist. The allowlist itself is hard-
                 * enforced at script bind + spawn time
                 * (`script_executable_denied`). Per PR-ξ user feedback,
                 * we now hide the section entirely when:
                 *   - The workflow library has NO script nodes, AND
                 *   - The user has not previously configured entries
                 * — so LLM-only workflows (the common case) don't see
                 * irrelevant security configuration noise. When the
                 * section IS surfaced, it stays collapsed by default
                 * behind a disclosure button so the user explicitly
                 * opens it when needed.
                 */}
                {workflowDraft && (workflowHasScriptNode || allowedExecutables.length > 0) && (
                  <div
                    style={{ ...sectionCardStyle, marginTop: 12 }}
                    data-testid="p2p-allowed-executables-section"
                    data-readonly={readOnlyMode ? 'true' : 'false'}
                    data-relevant={workflowHasScriptNode ? 'true' : 'false'}
                  >
                    <button
                      type="button"
                      onClick={() => setAllowedExecutablesExpanded((expanded) => !expanded)}
                      data-testid="p2p-allowed-executables-toggle"
                      aria-expanded={allowedExecutablesExpanded}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        color: '#cbd5e1',
                      }}
                    >
                      <div style={{ ...sectionLabelStyle, marginTop: 0, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span>{allowedExecutablesExpanded ? '▾' : '▸'}</span>
                        <span>{t('p2p.workflow.allowed_executables.title', 'Allowed script executables')}</span>
                        {allowedExecutables.length > 0 && (
                          <span style={{
                            fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999,
                            background: '#1e3a8a', color: '#bfdbfe',
                          }}>
                            {allowedExecutables.length}
                          </span>
                        )}
                      </div>
                      {workflowHasScriptNode && allowedExecutables.length === 0 && (
                        <span style={{ fontSize: 10, color: '#fbbf24' }}>
                          {t('p2p.workflow.allowed_executables.script_nodes_need_entries', 'Required for script nodes')}
                        </span>
                      )}
                    </button>
                    {allowedExecutablesExpanded && (
                    <>
                    <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5, marginTop: 6 }}>
                      {t('p2p.workflow.allowed_executables.hint', 'Hard-enforced at script spawn time. Add absolute paths (e.g. /usr/bin/jq) or PATH-relative names that script nodes are permitted to invoke. LLM-only workflows do not need any entries here.')}
                    </div>
                    {!readOnlyMode && (
                      <div
                        style={{ display: 'flex', gap: 6, marginTop: 8 }}
                        data-testid="p2p-allowed-executables-add-row"
                      >
                        <input
                          type="text"
                          value={allowedExecutableDraft}
                          placeholder={t('p2p.workflow.allowed_executables.placeholder', '/usr/bin/jq')}
                          onInput={(event) => setAllowedExecutableDraft((event.target as HTMLInputElement).value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              const trimmed = allowedExecutableDraft.trim();
                              if (!trimmed) return;
                              if (allowedExecutables.includes(trimmed)) { setAllowedExecutableDraft(''); return; }
                              if (allowedExecutables.length >= 64) return;
                              if (trimmed.length > 256) return;
                              if (!/^[\x21-\x7e]+$/.test(trimmed)) return;
                              setAllowedExecutables([...allowedExecutables, trimmed].sort());
                              setAllowedExecutableDraft('');
                              markFormDirty();
                              // Force the saved envelope to be re-derived
                              // from the latest UI state on Save.
                              setWorkflowLaunchEnvelope(undefined);
                            }
                          }}
                          style={{
                            flex: 1, background: '#0f172a', border: '1px solid #334155', borderRadius: 5,
                            color: '#e2e8f0', fontSize: 12, padding: '6px 8px', outline: 'none',
                          }}
                          aria-label={t('p2p.workflow.allowed_executables.input_label', 'New executable path')}
                          data-testid="p2p-allowed-executables-input"
                          maxLength={256}
                        />
                        <button
                          type="button"
                          style={{
                            padding: '4px 10px', borderRadius: 5, border: '1px solid #475569',
                            background: '#1e293b', color: '#cbd5e1', fontSize: 11, cursor: 'pointer',
                          }}
                          data-testid="p2p-allowed-executables-add"
                          disabled={
                            allowedExecutableDraft.trim().length === 0
                            || allowedExecutables.length >= 64
                            || allowedExecutables.includes(allowedExecutableDraft.trim())
                          }
                          onClick={() => {
                            const trimmed = allowedExecutableDraft.trim();
                            if (!trimmed) return;
                            if (allowedExecutables.includes(trimmed)) { setAllowedExecutableDraft(''); return; }
                            if (allowedExecutables.length >= 64) return;
                            if (trimmed.length > 256) return;
                            if (!/^[\x21-\x7e]+$/.test(trimmed)) return;
                            setAllowedExecutables([...allowedExecutables, trimmed].sort());
                            setAllowedExecutableDraft('');
                            markFormDirty();
                            setWorkflowLaunchEnvelope(undefined);
                          }}
                        >
                          {t('p2p.workflow.allowed_executables.add', 'Add')}
                        </button>
                      </div>
                    )}
                    {allowedExecutables.length === 0 ? (
                      <div
                        style={{ marginTop: 8, fontSize: 11, color: '#64748b' }}
                        data-testid="p2p-allowed-executables-empty"
                      >
                        {t('p2p.workflow.allowed_executables.empty', 'No executables allowed yet. Script nodes will be rejected at bind time.')}
                      </div>
                    ) : (
                      <ul
                        style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}
                        data-testid="p2p-allowed-executables-list"
                      >
                        {allowedExecutables.map((entry) => (
                          <li
                            key={entry}
                            data-testid={`p2p-allowed-executables-entry-${entry}`}
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
                              background: '#0b1220', border: '1px solid #1e293b', borderRadius: 5, padding: '4px 8px',
                            }}
                          >
                            <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#e2e8f0', wordBreak: 'break-all' }}>{entry}</span>
                            {!readOnlyMode && (
                              <button
                                type="button"
                                style={{
                                  padding: '2px 7px', borderRadius: 4, border: '1px solid #475569',
                                  background: '#1e293b', color: '#cbd5e1', fontSize: 11, cursor: 'pointer',
                                }}
                                aria-label={t('p2p.workflow.allowed_executables.remove', 'Remove')}
                                data-testid={`p2p-allowed-executables-remove-${entry}`}
                                onClick={() => {
                                  setAllowedExecutables(allowedExecutables.filter((value) => value !== entry));
                                  markFormDirty();
                                  setWorkflowLaunchEnvelope(undefined);
                                }}
                              >×</button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    </>
                    )}
                  </div>
                )}

                {hasAdvancedConfig && futureSchemaDetected && (
                  <div
                    style={{ ...sectionCardStyle, marginTop: 12, borderColor: '#f97316' }}
                    role="alert"
                    data-testid="p2p-future-schema-banner"
                  >
                    <div style={{ ...sectionLabelStyle, marginTop: 0, color: '#fdba74' }}>
                      {t('p2p.workflow.diagnostics.unsupported_schema_version')}
                    </div>
                    <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.5 }}>
                      {t('p2p.workflow.diagnostics.unknown_future_schema_read_only')}
                    </div>
                  </div>
                )}

                {hasAdvancedConfig && !futureSchemaDetected && capabilityStale && (
                  <div
                    style={{ ...sectionCardStyle, marginTop: 12, borderColor: '#f59e0b' }}
                    role="alert"
                    data-testid="p2p-capability-stale-banner"
                  >
                    <div style={{ ...sectionLabelStyle, marginTop: 0, color: '#fcd34d' }}>
                      {t('p2p.workflow.diagnostics.capability_stale')}
                    </div>
                  </div>
                )}

                {hasAdvancedConfig && !futureSchemaDetected && !capabilityStale && missingRequiredCapability && (
                  <div
                    style={{ ...sectionCardStyle, marginTop: 12, borderColor: '#f87171' }}
                    role="alert"
                    data-testid="p2p-missing-capability-banner"
                  >
                    <div style={{ ...sectionLabelStyle, marginTop: 0, color: '#fca5a5' }}>
                      {t('p2p.workflow.diagnostics.missing_required_capability')}
                    </div>
                    <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.5 }}>
                      {missingCapabilities.join(', ')}
                    </div>
                  </div>
                )}
              </>
            )
          )}
        </div>

        {/* Footer */}
        <div style={isMobile ? mobileFooterStyle : footerStyle}>
          {(saveError || saveWarning) && (
            <div style={{ flex: 1, alignSelf: 'center', color: saveError ? '#fca5a5' : '#fcd34d', fontSize: 12, paddingRight: 12 }}>
              {saveError ?? saveWarning}
            </div>
          )}
          <button style={btnSecondaryStyle} onClick={onClose}>{t('p2p.settings_close')}</button>
          {/*
           * R3 v2 PR-λ — User feedback: "高级工作流的保存按钮, 应该是
           * 保存当前编辑的工作流而不是, 关闭整个窗口". The footer now
           * exposes TWO buttons:
           *   - "Save" (default): persists changes AND keeps the panel
           *     open so users can continue editing the workflow library.
           *   - "Save & Close": preserves the original behaviour for
           *     users who want one click to save + dismiss.
           */}
          <button
            style={{ ...btnSecondaryStyle, color: '#bfdbfe', borderColor: '#3b82f6', opacity: saving || saveBlocked ? 0.6 : 1, cursor: saveBlocked ? 'not-allowed' : 'pointer' }}
            onClick={() => { void handleSave({ keepOpen: true }); }}
            disabled={saving || loading || saveBlocked}
            data-testid="p2p-save-keep-open"
            data-advanced-launch-disabled={advancedLaunchDisabled ? 'true' : 'false'}
            data-save-blocked={saveBlocked ? 'true' : 'false'}
          >
            {t('p2p.settings_save')}
          </button>
          <button
            style={{ ...btnPrimaryStyle, opacity: saving || saveBlocked ? 0.6 : 1, cursor: saveBlocked ? 'not-allowed' : 'pointer' }}
            onClick={() => { void handleSave(); }}
            disabled={saving || loading || saveBlocked}
            data-testid="p2p-save-and-close"
            data-advanced-launch-disabled={advancedLaunchDisabled ? 'true' : 'false'}
            data-save-blocked={saveBlocked ? 'true' : 'false'}
          >
            {t('p2p.settings_save_and_close', 'Save & Close')}
          </button>
        </div>
      </div>
    </div>
  );
}

// `AdvancedWorkflowDraftEditor` was the v1a list-based editor. R3 follow-up
// (87fd4db8-ff5) folded the visual canvas editor into v1a per user request
// "no toggle, no two surfaces". The list editor has been removed entirely;
// `AdvancedWorkflowCanvasEditor` (in `./AdvancedWorkflowCanvasEditor.tsx`)
// is the single authoring surface.
