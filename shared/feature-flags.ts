export const MEMORY_FEATURE_FLAGS = [
  'mem.feature.scope_registry_extensions',
  'mem.feature.user_private_sync',
  'mem.feature.self_learning',
  'mem.feature.namespace_registry',
  'mem.feature.observation_store',
  'mem.feature.quick_search',
  'mem.feature.citation',
  'mem.feature.cite_count',
  'mem.feature.cite_drift_badge',
  'mem.feature.md_ingest',
  'mem.feature.preferences',
  'mem.feature.skills',
  'mem.feature.skill_auto_creation',
  'mem.feature.org_shared_authored_standards',
] as const;

export type MemoryFeatureFlag = (typeof MEMORY_FEATURE_FLAGS)[number];

export const FEATURE_FLAG_VALUE_PRECEDENCE = [
  'runtime_config_override',
  'persisted_config',
  'environment_startup_default',
  'registry_default',
] as const;
export type FeatureFlagValueSource = (typeof FEATURE_FLAG_VALUE_PRECEDENCE)[number];

export type MemoryFeatureRuntimeSource = 'local_daemon_config' | 'server_config' | 'local_or_server_config';

export interface MemoryFeatureFlagDefinition {
  flag: MemoryFeatureFlag;
  defaultValue: boolean;
  runtimeSource: MemoryFeatureRuntimeSource;
  dependencies: readonly MemoryFeatureFlag[];
  requiredPrerequisites: readonly string[];
  observedBy: readonly string[];
  disabledBehavior: string;
}

export type MemoryFeatureFlagValues = Partial<Record<MemoryFeatureFlag, boolean>>;
export type MemoryFeaturePrerequisites = Partial<Record<string, boolean>>;
export interface MemoryFeatureFlagResolutionLayers {
  runtimeConfigOverride?: MemoryFeatureFlagValues;
  persistedConfig?: MemoryFeatureFlagValues;
  environmentStartupDefault?: MemoryFeatureFlagValues;
  readFailed?: boolean;
}

const FLAG = {
  scopeRegistryExtensions: 'mem.feature.scope_registry_extensions',
  userPrivateSync: 'mem.feature.user_private_sync',
  selfLearning: 'mem.feature.self_learning',
  namespaceRegistry: 'mem.feature.namespace_registry',
  observationStore: 'mem.feature.observation_store',
  quickSearch: 'mem.feature.quick_search',
  citation: 'mem.feature.citation',
  citeCount: 'mem.feature.cite_count',
  citeDriftBadge: 'mem.feature.cite_drift_badge',
  mdIngest: 'mem.feature.md_ingest',
  preferences: 'mem.feature.preferences',
  skills: 'mem.feature.skills',
  skillAutoCreation: 'mem.feature.skill_auto_creation',
  orgSharedAuthoredStandards: 'mem.feature.org_shared_authored_standards',
} as const satisfies Record<string, MemoryFeatureFlag>;

export const MEMORY_FEATURE_FLAGS_BY_NAME = FLAG;

export const MEMORY_FEATURE_FLAG_REGISTRY = {
  [FLAG.scopeRegistryExtensions]: {
    flag: FLAG.scopeRegistryExtensions,
    defaultValue: false,
    runtimeSource: 'local_or_server_config',
    dependencies: [],
    requiredPrerequisites: [],
    observedBy: ['daemon', 'server', 'web', 'namespace_registry'],
    disabledBehavior: 'Legacy scopes remain accepted; new user_private writes fail closed except migration/backfill reads.',
  },
  [FLAG.userPrivateSync]: {
    flag: FLAG.userPrivateSync,
    defaultValue: false,
    runtimeSource: 'local_or_server_config',
    dependencies: [FLAG.scopeRegistryExtensions, FLAG.namespaceRegistry, FLAG.observationStore],
    requiredPrerequisites: [],
    observedBy: ['daemon_replication_runner', 'server_owner_private_sync', 'startup_selection', 'memory_search'],
    disabledBehavior: 'user_private remains daemon-local owner-only; no owner-private server reads or writes are attempted.',
  },
  [FLAG.selfLearning]: {
    flag: FLAG.selfLearning,
    defaultValue: false,
    runtimeSource: 'local_daemon_config',
    dependencies: [FLAG.namespaceRegistry, FLAG.observationStore],
    requiredPrerequisites: [],
    observedBy: ['materialization_pipeline', 'compression_pipeline'],
    disabledBehavior: 'Classification, dedup, and durable extraction are skipped; projection commits remain readable.',
  },
  [FLAG.namespaceRegistry]: {
    flag: FLAG.namespaceRegistry,
    defaultValue: false,
    runtimeSource: 'local_or_server_config',
    dependencies: [],
    requiredPrerequisites: [],
    observedBy: ['daemon_storage', 'server_storage'],
    disabledBehavior: 'No new namespace records outside migration/backfill; legacy projection reads remain available.',
  },
  [FLAG.observationStore]: {
    flag: FLAG.observationStore,
    defaultValue: false,
    runtimeSource: 'local_or_server_config',
    dependencies: [FLAG.namespaceRegistry],
    requiredPrerequisites: [],
    observedBy: ['daemon_storage', 'server_storage', 'materialization', 'preferences', 'skills'],
    disabledBehavior: 'No new observation rows; projections remain readable.',
  },
  [FLAG.quickSearch]: {
    flag: FLAG.quickSearch,
    defaultValue: false,
    runtimeSource: 'server_config',
    dependencies: [FLAG.namespaceRegistry],
    requiredPrerequisites: [],
    observedBy: ['web_search_ui', 'server_search_rpc', 'daemon_search_rpc'],
    disabledBehavior: 'Search UI is hidden; endpoint returns the same disabled envelope without search jobs.',
  },
  [FLAG.citation]: {
    flag: FLAG.citation,
    defaultValue: false,
    runtimeSource: 'server_config',
    dependencies: [FLAG.quickSearch],
    requiredPrerequisites: [],
    observedBy: ['web_composer', 'citation_rpc'],
    disabledBehavior: 'Citation UI is hidden and RPC rejects with the same disabled envelope; no citation rows.',
  },
  [FLAG.citeCount]: {
    flag: FLAG.citeCount,
    defaultValue: false,
    runtimeSource: 'server_config',
    dependencies: [FLAG.citation],
    requiredPrerequisites: [],
    observedBy: ['citation_store', 'search_ranking'],
    disabledBehavior: 'No new count increments; existing counts are ignored in ranking without deleting data.',
  },
  [FLAG.citeDriftBadge]: {
    flag: FLAG.citeDriftBadge,
    defaultValue: false,
    runtimeSource: 'server_config',
    dependencies: [FLAG.citation],
    requiredPrerequisites: [],
    observedBy: ['web_citation_renderer'],
    disabledBehavior: 'Drift badge is hidden; citation identity is preserved when citations are enabled.',
  },
  [FLAG.mdIngest]: {
    flag: FLAG.mdIngest,
    defaultValue: false,
    runtimeSource: 'local_daemon_config',
    dependencies: [FLAG.namespaceRegistry, FLAG.observationStore],
    requiredPrerequisites: [],
    observedBy: ['session_bootstrap', 'md_ingest_worker'],
    disabledBehavior: 'No markdown reads, parses, or ingest jobs.',
  },
  [FLAG.preferences]: {
    flag: FLAG.preferences,
    defaultValue: false,
    runtimeSource: 'local_daemon_config',
    dependencies: [FLAG.namespaceRegistry, FLAG.observationStore],
    requiredPrerequisites: [],
    observedBy: ['daemon_send_handler', 'preference_store'],
    disabledBehavior: '@pref: lines pass through as text and are not persisted or stripped.',
  },
  [FLAG.skills]: {
    flag: FLAG.skills,
    defaultValue: false,
    runtimeSource: 'local_or_server_config',
    dependencies: [FLAG.namespaceRegistry, FLAG.observationStore],
    requiredPrerequisites: [],
    observedBy: ['skill_loader', 'render_policy', 'admin_api'],
    disabledBehavior: 'Loader returns an empty set; render policy skips skills; admin writes are rejected or disabled.',
  },
  [FLAG.skillAutoCreation]: {
    flag: FLAG.skillAutoCreation,
    defaultValue: false,
    runtimeSource: 'local_daemon_config',
    dependencies: [FLAG.skills, FLAG.selfLearning],
    requiredPrerequisites: [],
    observedBy: ['background_skill_review_worker'],
    disabledBehavior: 'No skill-review jobs are claimed or created; existing skills still load when skills are enabled.',
  },
  [FLAG.orgSharedAuthoredStandards]: {
    flag: FLAG.orgSharedAuthoredStandards,
    defaultValue: false,
    runtimeSource: 'server_config',
    dependencies: [FLAG.scopeRegistryExtensions],
    requiredPrerequisites: ['shared_context_document_migrations', 'shared_context_version_migrations', 'shared_context_binding_migrations'],
    observedBy: ['server_shared_context_routes', 'authored_context_resolver', 'web_diagnostics'],
    disabledBehavior: 'Org-wide authored standard mutation/selection is rejected or skipped without leaking inventory.',
  },
} as const satisfies Record<MemoryFeatureFlag, MemoryFeatureFlagDefinition>;

const MEMORY_FEATURE_FLAG_SET: ReadonlySet<string> = new Set(MEMORY_FEATURE_FLAGS);

export function isMemoryFeatureFlag(value: unknown): value is MemoryFeatureFlag {
  return typeof value === 'string' && MEMORY_FEATURE_FLAG_SET.has(value);
}

export function getMemoryFeatureFlagDefinition(flag: MemoryFeatureFlag): MemoryFeatureFlagDefinition {
  return MEMORY_FEATURE_FLAG_REGISTRY[flag];
}

export function memoryFeatureFlagEnvKey(flag: MemoryFeatureFlag): string {
  return `IMCODES_${flag.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function resolveMemoryFeatureFlagValue(
  flag: MemoryFeatureFlag,
  layers: MemoryFeatureFlagResolutionLayers,
): boolean {
  if (layers.readFailed) return false;
  const runtime = layers.runtimeConfigOverride?.[flag];
  if (runtime !== undefined) return runtime;
  const persisted = layers.persistedConfig?.[flag];
  if (persisted !== undefined) return persisted;
  const environmentDefault = layers.environmentStartupDefault?.[flag];
  if (environmentDefault !== undefined) return environmentDefault;
  return MEMORY_FEATURE_FLAG_REGISTRY[flag].defaultValue;
}

export function resolveEffectiveMemoryFeatureFlags(
  layers: MemoryFeatureFlagResolutionLayers,
  prerequisites: MemoryFeaturePrerequisites = {},
): Record<MemoryFeatureFlag, boolean> {
  if (layers.readFailed) {
    return Object.fromEntries(MEMORY_FEATURE_FLAGS.map((flag) => [flag, false])) as Record<MemoryFeatureFlag, boolean>;
  }
  const requested = Object.fromEntries(
    MEMORY_FEATURE_FLAGS.map((flag) => [flag, resolveMemoryFeatureFlagValue(flag, layers)]),
  ) as Record<MemoryFeatureFlag, boolean>;
  return computeEffectiveMemoryFeatureFlags(requested, prerequisites);
}

export function resolveEffectiveMemoryFeatureFlagValue(
  flag: MemoryFeatureFlag,
  layers: MemoryFeatureFlagResolutionLayers,
  prerequisites: MemoryFeaturePrerequisites = {},
): boolean {
  return resolveEffectiveMemoryFeatureFlags(layers, prerequisites)[flag];
}

export function computeEffectiveMemoryFeatureFlags(
  requested: MemoryFeatureFlagValues,
  prerequisites: MemoryFeaturePrerequisites = {},
): Record<MemoryFeatureFlag, boolean> {
  const effective = Object.fromEntries(MEMORY_FEATURE_FLAGS.map((flag) => [flag, false])) as Record<MemoryFeatureFlag, boolean>;

  const visit = (flag: MemoryFeatureFlag, stack: readonly MemoryFeatureFlag[]): boolean => {
    if (effective[flag]) return true;
    if (requested[flag] !== true) return false;
    if (stack.includes(flag)) return false;
    const definition = MEMORY_FEATURE_FLAG_REGISTRY[flag];
    const dependenciesEnabled = definition.dependencies.every((dependency) => visit(dependency, [...stack, flag]));
    const prerequisitesAvailable = definition.requiredPrerequisites.every((name) => prerequisites[name] === true);
    effective[flag] = dependenciesEnabled && prerequisitesAvailable;
    return effective[flag];
  };

  for (const flag of MEMORY_FEATURE_FLAGS) {
    visit(flag, []);
  }
  return effective;
}
