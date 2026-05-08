import {
  DEFAULT_SHARED_SKILL_ENFORCEMENT,
  SHARED_SKILL_LAYERS,
  classifyUserSkillLayer,
  isSharedSkillLayer,
  skillMatchesProject,
  type SkillLayer,
  type SkillProjectContext,
  type SkillSource,
} from './skill-store.js';
import {
  renderSkillEnvelope,
  type SkillEnvelopeSanitizeOptions,
} from './skill-envelope.js';

export const ORDINARY_SKILL_PRECEDENCE = [
  'project_escape_hatch',
  'user_project',
  'user_default',
  'workspace_shared',
  'org_shared',
  'builtin_fallback',
] as const satisfies readonly SkillLayer[];

export const ENFORCED_SKILL_POLICY_PRECEDENCE = [
  'workspace_shared',
  'org_shared',
] as const satisfies readonly SkillLayer[];

export type SkillSelectionKind = 'ordinary' | 'additive' | 'enforced';

export interface SkillSelectionCandidate {
  source: SkillSource;
  key: string;
  effectiveLayer: SkillLayer;
}

export interface SelectedSkill {
  source: SkillSource;
  key: string;
  effectiveLayer: SkillLayer;
  selectionKind: SkillSelectionKind;
}

export interface SkillLayerDiagnostic {
  key: string;
  consideredLayers: readonly SkillLayer[];
  selectedLayers: readonly SkillLayer[];
  hiddenByEnforcedLayer?: SkillLayer;
  conflictResolved: boolean;
}

export interface SkillSelectionResult {
  selected: readonly SelectedSkill[];
  ordinary: readonly SelectedSkill[];
  additive: readonly SelectedSkill[];
  enforced: readonly SelectedSkill[];
  diagnostics: readonly SkillLayerDiagnostic[];
}

export interface RenderedSelectedSkill extends SelectedSkill {
  text: string;
}

export interface DroppedSelectedSkill extends SelectedSkill {
  reason: string;
}

export interface RenderSelectedSkillsResult {
  rendered: readonly RenderedSelectedSkill[];
  dropped: readonly DroppedSelectedSkill[];
  text: string;
}

const ORDINARY_SKILL_LAYER_RANK: ReadonlyMap<SkillLayer, number> = new Map(
  ORDINARY_SKILL_PRECEDENCE.map((layer, index) => [layer, index]),
);

const ENFORCED_SKILL_LAYER_RANK: ReadonlyMap<SkillLayer, number> = new Map(
  ENFORCED_SKILL_POLICY_PRECEDENCE.map((layer, index) => [layer, index]),
);

function rankLayer(layer: SkillLayer, ranks: ReadonlyMap<SkillLayer, number>): number {
  return ranks.get(layer) ?? Number.MAX_SAFE_INTEGER;
}

function isHigherPriority(candidate: SkillSelectionCandidate, current: SkillSelectionCandidate | undefined): boolean {
  if (!current) return true;
  return rankLayer(candidate.effectiveLayer, ORDINARY_SKILL_LAYER_RANK)
    < rankLayer(current.effectiveLayer, ORDINARY_SKILL_LAYER_RANK);
}

function isHigherEnforcedPriority(candidate: SkillSelectionCandidate, current: SkillSelectionCandidate | undefined): boolean {
  if (!current) return true;
  return rankLayer(candidate.effectiveLayer, ENFORCED_SKILL_LAYER_RANK)
    < rankLayer(current.effectiveLayer, ENFORCED_SKILL_LAYER_RANK);
}

function getEffectiveLayer(source: SkillSource, projectContext?: SkillProjectContext): SkillLayer | null {
  if (source.layer === 'user_default' || source.layer === 'user_project') {
    return classifyUserSkillLayer(source.metadata, projectContext);
  }
  if (source.layer === 'project_escape_hatch') {
    return source.metadata.project && !skillMatchesProject(source.metadata, projectContext)
      ? null
      : 'project_escape_hatch';
  }
  if (source.metadata.project && !skillMatchesProject(source.metadata, projectContext)) {
    return null;
  }
  return source.layer;
}

export function toSkillSelectionCandidates(
  sources: readonly SkillSource[],
  projectContext?: SkillProjectContext,
): readonly SkillSelectionCandidate[] {
  const candidates: SkillSelectionCandidate[] = [];
  for (const source of sources) {
    const effectiveLayer = getEffectiveLayer(source, projectContext);
    if (!effectiveLayer) continue;
    candidates.push({
      source,
      key: source.key,
      effectiveLayer,
    });
  }
  return candidates;
}

export function selectOrdinarySkillByKey(
  sources: readonly SkillSource[],
  projectContext?: SkillProjectContext,
): ReadonlyMap<string, SkillSelectionCandidate> {
  const selected = new Map<string, SkillSelectionCandidate>();
  for (const candidate of toSkillSelectionCandidates(sources, projectContext)) {
    const current = selected.get(candidate.key);
    if (isHigherPriority(candidate, current)) {
      selected.set(candidate.key, candidate);
    }
  }
  return selected;
}

function selectedFromCandidate(candidate: SkillSelectionCandidate, selectionKind: SkillSelectionKind): SelectedSkill {
  return {
    source: candidate.source,
    key: candidate.key,
    effectiveLayer: candidate.effectiveLayer,
    selectionKind,
  };
}

function buildDiagnostics(
  grouped: ReadonlyMap<string, SkillSelectionCandidate[]>,
  selected: readonly SelectedSkill[],
  enforcedByKey: ReadonlyMap<string, SkillSelectionCandidate>,
): readonly SkillLayerDiagnostic[] {
  const selectedByKey = new Map<string, SkillLayer[]>();
  for (const entry of selected) {
    const layers = selectedByKey.get(entry.key) ?? [];
    layers.push(entry.effectiveLayer);
    selectedByKey.set(entry.key, layers);
  }
  return [...grouped].map(([key, candidates]) => {
    const selectedLayers = selectedByKey.get(key) ?? [];
    return {
      key,
      consideredLayers: candidates.map((candidate) => candidate.effectiveLayer),
      selectedLayers,
      hiddenByEnforcedLayer: enforcedByKey.get(key)?.effectiveLayer,
      conflictResolved: candidates.length > selectedLayers.length || enforcedByKey.has(key),
    };
  });
}

export function resolveSkillSelection(
  sources: readonly SkillSource[],
  projectContext?: SkillProjectContext,
): SkillSelectionResult {
  const candidates = toSkillSelectionCandidates(sources, projectContext);
  const grouped = new Map<string, SkillSelectionCandidate[]>();
  for (const candidate of candidates) {
    const entries = grouped.get(candidate.key) ?? [];
    entries.push(candidate);
    grouped.set(candidate.key, entries);
  }

  const enforcedByKey = new Map<string, SkillSelectionCandidate>();
  for (const candidate of candidates) {
    if (!isSharedSkillLayer(candidate.effectiveLayer) || candidate.source.enforcement !== 'enforced') continue;
    const current = enforcedByKey.get(candidate.key);
    if (isHigherEnforcedPriority(candidate, current)) {
      enforcedByKey.set(candidate.key, candidate);
    }
  }

  const ordinaryByKey = new Map<string, SkillSelectionCandidate>();
  for (const candidate of candidates) {
    if (enforcedByKey.has(candidate.key)) continue;
    if (candidate.source.enforcement === 'enforced') continue;
    const current = ordinaryByKey.get(candidate.key);
    if (isHigherPriority(candidate, current)) {
      ordinaryByKey.set(candidate.key, candidate);
    }
  }

  const additive: SelectedSkill[] = [];
  for (const candidate of candidates) {
    if (enforcedByKey.has(candidate.key)) continue;
    if (!SHARED_SKILL_LAYERS.includes(candidate.effectiveLayer as never)) continue;
    if ((candidate.source.enforcement ?? DEFAULT_SHARED_SKILL_ENFORCEMENT) !== 'additive') continue;
    const ordinary = ordinaryByKey.get(candidate.key);
    if (!ordinary || ordinary.source === candidate.source) continue;
    const ordinaryIsUserOrProject = ordinary.effectiveLayer === 'project_escape_hatch'
      || ordinary.effectiveLayer === 'user_project'
      || ordinary.effectiveLayer === 'user_default';
    if (!ordinaryIsUserOrProject) continue;
    additive.push(selectedFromCandidate(candidate, 'additive'));
  }

  const enforced = [...enforcedByKey.values()].map((candidate) => selectedFromCandidate(candidate, 'enforced'));
  const ordinary = [...ordinaryByKey.values()].map((candidate) => selectedFromCandidate(candidate, 'ordinary'));
  const selected = [...enforced, ...ordinary, ...additive];
  return {
    selected,
    ordinary,
    additive,
    enforced,
    diagnostics: buildDiagnostics(grouped, selected, enforcedByKey),
  };
}

export function renderSelectedSkills(
  selected: readonly SelectedSkill[],
  options?: SkillEnvelopeSanitizeOptions,
): RenderSelectedSkillsResult {
  const rendered: RenderedSelectedSkill[] = [];
  const dropped: DroppedSelectedSkill[] = [];
  for (const skill of selected) {
    try {
      rendered.push({
        ...skill,
        text: renderSkillEnvelope(skill.source.content, options),
      });
    } catch (error) {
      dropped.push({
        ...skill,
        reason: error instanceof Error ? error.message : 'skill_render_failed',
      });
    }
  }
  return {
    rendered,
    dropped,
    text: rendered.map((entry) => entry.text).join('\n\n'),
  };
}
