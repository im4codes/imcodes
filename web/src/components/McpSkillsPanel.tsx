import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  CAPABILITY_CONFIRMATION_DECISION,
  CAPABILITY_ERROR,
  CAPABILITY_KIND,
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  CAPABILITY_LIMITS,
  isCapabilityCredentialFreeHttpsUrl,
  type CapabilityBinding,
  type CapabilityKind,
  type CapabilityManagementAction,
  type CapabilityScope,
  type CapabilitySource,
} from '@shared/capability-management.js';
import {
  cancelCapabilityOperation,
  decideCapabilityOperation,
  getCapabilityOperation,
  installCapability,
  listCapabilities,
  manageCapability,
  CapabilityManageAmbiguousError,
  CapabilityRequestError,
  type CapabilityOperationView,
  type CapabilitySummaryView,
} from '../api/capabilities.js';
import { CapabilityOperationCard } from './CapabilityOperationCard.js';
import {
  setCapabilityOperationSnapshot,
  setCapabilityOperationSnapshots,
  useCapabilityOperationSnapshots,
} from '../capability-operation-store.js';
import { parseCapabilityMcpImport } from '../capability-import.js';

interface Props {
  serverId?: string | null;
  canAskAi?: boolean;
  onAskAi?: (source: string) => void;
}

interface ManualUpdateTarget {
  item: CapabilitySummaryView;
  binding: CapabilityBinding;
}

interface PendingLocalManageRetry {
  item: CapabilitySummaryView;
  action: CapabilityManagementAction;
  versionId?: string;
  binding: CapabilityBinding;
  requestId?: string;
}

async function settleWithConcurrency<TInput, TOutput>(
  inputs: readonly TInput[],
  concurrency: number,
  task: (input: TInput) => Promise<TOutput>,
): Promise<Array<PromiseSettledResult<TOutput>>> {
  const results = new Array<PromiseSettledResult<TOutput>>(inputs.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (cursor < inputs.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: 'fulfilled', value: await task(inputs[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function safeSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function replaceCapability(items: CapabilitySummaryView[], next: CapabilitySummaryView): CapabilitySummaryView[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [next, ...items];
  if (items[index]!.revision >= next.revision) return items;
  const result = [...items];
  result[index] = next;
  return result;
}

function actionsFor(item: CapabilitySummaryView): CapabilityManagementAction[] {
  if (item.availableActions !== undefined) return item.availableActions;
  switch (item.state) {
    case CAPABILITY_STATE.ACTIVE:
      return [CAPABILITY_MANAGE_ACTION.DISABLE, CAPABILITY_MANAGE_ACTION.ROLLBACK, CAPABILITY_MANAGE_ACTION.UNINSTALL];
    case CAPABILITY_STATE.DISABLED:
      return [CAPABILITY_MANAGE_ACTION.ENABLE, CAPABILITY_MANAGE_ACTION.ROLLBACK, CAPABILITY_MANAGE_ACTION.UNINSTALL];
    case CAPABILITY_STATE.TOMBSTONED:
      return [CAPABILITY_MANAGE_ACTION.RESTORE];
    case CAPABILITY_STATE.REMOVED:
      return [];
    default:
      return [CAPABILITY_MANAGE_ACTION.DISABLE, CAPABILITY_MANAGE_ACTION.UNINSTALL];
  }
}

function normalizeManualSkillSource(source: string): CapabilitySource | null {
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(source)) {
    return { kind: CAPABILITY_SOURCE_KIND.LOCAL_PATH, value: source };
  }
  if (!isCapabilityCredentialFreeHttpsUrl(source)) return null;
  try {
    const url = new URL(source);
    const segments = url.pathname.split('/').filter(Boolean);
    const host = url.hostname.toLowerCase();
    const isExplicitGit = url.pathname.endsWith('.git');
    const isGitHubRepository = host === 'github.com' && segments.length === 2 && !segments[1]?.includes('.');
    const isBitbucketRepository = host === 'bitbucket.org' && segments.length === 2 && !segments[1]?.includes('.');
    const isGitLabRepository = host === 'gitlab.com' && segments.length >= 2 && !segments.includes('-') && !segments[segments.length - 1]?.includes('.');
    return {
      kind: isExplicitGit || isGitHubRepository || isBitbucketRepository || isGitLabRepository
        ? CAPABILITY_SOURCE_KIND.REPOSITORY
        : CAPABILITY_SOURCE_KIND.URL,
      value: url.toString(),
    };
  } catch {
    return null;
  }
}

function normalizeManualMcpUrl(source: string): CapabilitySource | null {
  if (isCapabilityCredentialFreeHttpsUrl(source)) {
    try {
      const url = new URL(source);
      return { kind: CAPABILITY_SOURCE_KIND.URL, value: url.toString() };
    } catch {
      return null;
    }
  }
  return null;
}

function bindingScopedAction(action: CapabilityManagementAction): boolean {
  return action === CAPABILITY_MANAGE_ACTION.ENABLE
    || action === CAPABILITY_MANAGE_ACTION.DISABLE
    || action === CAPABILITY_MANAGE_ACTION.UNINSTALL
    || action === CAPABILITY_MANAGE_ACTION.RESTORE;
}

function applicableBindings(item: CapabilitySummaryView, action: CapabilityManagementAction): CapabilityBinding[] {
  const bindings = [...(item.bindings ?? [])];
  const filtered = action === CAPABILITY_MANAGE_ACTION.ENABLE || action === CAPABILITY_MANAGE_ACTION.RESTORE
    ? bindings.filter((binding) => !binding.active)
    : action === CAPABILITY_MANAGE_ACTION.DISABLE || action === CAPABILITY_MANAGE_ACTION.UNINSTALL
      ? bindings.filter((binding) => binding.active)
      : bindings;
  return filtered.length ? filtered : bindings;
}

function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `capability-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function McpSkillsPanel({ serverId, canAskAi = false, onAskAi }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<CapabilitySummaryView[]>([]);
  const operations = useCapabilityOperationSnapshots(serverId);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [showManual, setShowManual] = useState(false);
  const [manualKind, setManualKind] = useState<CapabilityKind>(CAPABILITY_KIND.SKILL);
  const [manualScope, setManualScope] = useState<CapabilityScope>(CAPABILITY_SCOPE.ACCOUNT);
  const [manualSource, setManualSource] = useState('');
  const [manualFileName, setManualFileName] = useState('');
  const [manualUpdateTarget, setManualUpdateTarget] = useState<ManualUpdateTarget | null>(null);
  const [aiSource, setAiSource] = useState('');
  const [pendingAction, setPendingAction] = useState<{ item: CapabilitySummaryView; action: CapabilityManagementAction; bindings?: CapabilityBinding[] } | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<{ item: CapabilitySummaryView; bindings: CapabilityBinding[] } | null>(null);
  const [pendingLocalManageId, setPendingLocalManageId] = useState<string | null>(null);
  const [pendingLocalManageRetry, setPendingLocalManageRetry] = useState<PendingLocalManageRetry | null>(null);
  const [pendingInstallIds, setPendingInstallIds] = useState<ReadonlySet<string>>(() => new Set());
  const [rollbackVersion, setRollbackVersion] = useState('');
  const [selectedBindingId, setSelectedBindingId] = useState('');
  const manageDialogRef = useRef<HTMLDivElement>(null);
  const manageTriggerRef = useRef<HTMLButtonElement | null>(null);
  const manualFileRef = useRef<HTMLInputElement>(null);

  const closeManageDialog = useCallback(() => {
    setPendingAction(null);
    setPendingUpdate(null);
    setRollbackVersion('');
    setSelectedBindingId('');
    queueMicrotask(() => manageTriggerRef.current?.focus());
  }, []);

  const publishOperation = useCallback((next: CapabilityOperationView | null) => {
    setCapabilityOperationSnapshot(serverId, next);
  }, [serverId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listCapabilities(serverId);
      setItems(response.items);
      if (response.operations) setCapabilityOperationSnapshots(serverId, response.operations, true);
    } catch {
      setError(t('capabilities.loadError'));
    } finally {
      setLoading(false);
    }
  }, [publishOperation, serverId, t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    if (!online) return;
    void load();
  }, [online, load]);

  useEffect(() => {
    if (!pendingAction && !pendingUpdate) return;
    const dialog = manageDialogRef.current;
    const firstControl = dialog?.querySelector<HTMLElement>('button:not([disabled]), select:not([disabled])');
    firstControl?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        closeManageDialog();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled])')];
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [busy, closeManageDialog, pendingAction, pendingUpdate]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== 'all' && item.kind !== filter && item.state !== filter) return false;
      if (!normalized) return true;
      return [item.name, item.kind, item.state, item.scope, item.version, item.sourceLabel, ...(item.tools ?? [])]
        .some((value) => value != null && String(value).toLowerCase().includes(normalized));
    });
  }, [filter, items, query]);

  const startManualInstall = async () => {
    if (!manualSource.trim() || !online) return;
    let sources: CapabilitySource[] = [];
    let invalidEntries = 0;
    if (manualKind === CAPABILITY_KIND.MCP) {
      const directUrl = normalizeManualMcpUrl(manualSource.trim());
      if (directUrl) sources = [directUrl];
      else {
        try {
          const parsed = parseCapabilityMcpImport(manualSource, manualFileName || undefined);
          sources = parsed.definitions.map((definition) => ({
            kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
            mcpConfig: { ...definition },
          }));
          invalidEntries = parsed.invalidEntries;
        } catch (parseError) {
          if (parseError instanceof Error && parseError.message === 'capability_import_too_many_entries') {
            setError(t('capabilities.importTooLarge'));
            return;
          }
          sources = [];
        }
      }
    } else {
      const source = normalizeManualSkillSource(manualSource.trim());
      if (source) sources = [source];
    }
    if (manualUpdateTarget && sources.length > 1) {
      setError(t('capabilities.updateSingleSource'));
      return;
    }
    if (!sources.length) {
      setError(t(manualKind === CAPABILITY_KIND.MCP ? 'capabilities.mcpConfigInvalid' : 'capabilities.skillSourceInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const results = await settleWithConcurrency(
        sources,
        CAPABILITY_LIMITS.INSTALL_BATCH_CONCURRENCY,
        (source) => installCapability({
          request: {
            ...(manualUpdateTarget ? {
              capabilityId: manualUpdateTarget.item.id,
              bindingId: manualUpdateTarget.binding.id,
            } : {}),
            kind: manualKind,
            scope: manualUpdateTarget?.binding.scope ?? manualScope,
            ...(manualUpdateTarget?.binding.scopeId ? { scopeId: manualUpdateTarget.binding.scopeId } : {}),
            ...(manualUpdateTarget ? { providers: manualUpdateTarget.binding.providers, machines: manualUpdateTarget.binding.machines } : {}),
            source,
            idempotencyKey: newIdempotencyKey(),
            userIntent: t(manualUpdateTarget ? 'capabilities.manualUpdateIntent' : 'capabilities.manualInstallIntent', {
              name: manualUpdateTarget?.item.name,
            }),
          },
          serverId: serverId ?? undefined,
        }),
      );
      const completed = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      const rejected = results.flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : []);
      if (!completed.length) throw rejected[0] ?? new Error('capability_install_batch_failed');
      setCapabilityOperationSnapshots(serverId, completed);
      if (invalidEntries || completed.length !== sources.length) {
        const partial = t('capabilities.importPartial', {
          installed: completed.length,
          failed: invalidEntries + sources.length - completed.length,
        });
        const requestError = rejected.find((reason) => reason instanceof CapabilityRequestError) as CapabilityRequestError | undefined;
        setError(requestError
          ? `${partial} ${t('capabilities.operationError', { code: requestError.safeMessage ?? requestError.reason })}`
          : partial);
      }
      setShowManual(false);
      setManualSource('');
      setManualFileName('');
      setManualUpdateTarget(null);
    } catch (installError) {
      setError(installError instanceof CapabilityRequestError
        ? t('capabilities.operationError', { code: installError.safeMessage ?? installError.reason })
        : t('capabilities.installStartError'));
    } finally {
      setBusy(false);
    }
  };

  const chooseManualFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > CAPABILITY_LIMITS.AUDIT_ENVELOPE_BYTES) {
      setError(t('capabilities.importTooLarge'));
      return;
    }
    try {
      const content = await file.text();
      if (new TextEncoder().encode(content).length > CAPABILITY_LIMITS.AUDIT_ENVELOPE_BYTES) {
        setError(t('capabilities.importTooLarge'));
        return;
      }
      setManualSource(content);
      setManualFileName(file.name);
      setError(null);
    } catch {
      setError(t('capabilities.importReadError'));
    }
  };

  const decide = async (
    operation: CapabilityOperationView,
    decision: typeof CAPABILITY_CONFIRMATION_DECISION[keyof typeof CAPABILITY_CONFIRMATION_DECISION],
  ) => {
    setBusy(true);
    setError(null);
    if (decision === CAPABILITY_CONFIRMATION_DECISION.INSTALL) {
      setPendingInstallIds((current) => new Set(current).add(operation.id));
    }
    try {
      publishOperation(await decideCapabilityOperation(operation, decision, serverId));
    } catch (confirmationError) {
      try { publishOperation(await getCapabilityOperation(operation.id, serverId)); } catch { /* Polling retains the visible uncertain commit boundary. */ }
      setError(confirmationError instanceof CapabilityRequestError && confirmationError.reason === CAPABILITY_ERROR.RATE_LIMITED
        ? t('capabilities.operationError', { code: confirmationError.safeMessage ?? confirmationError.reason })
        : t('capabilities.confirmationError'));
    } finally {
      setPendingInstallIds((current) => {
        const next = new Set(current);
        next.delete(operation.id);
        return next;
      });
      setBusy(false);
    }
  };

  const cancelOperation = async (operation: CapabilityOperationView) => {
    setBusy(true);
    setError(null);
    try {
      publishOperation(await cancelCapabilityOperation(operation, serverId));
    } catch (cancellationError) {
      try { publishOperation(await getCapabilityOperation(operation.id, serverId)); } catch { /* Preserve the last server-confirmed operation. */ }
      setError(cancellationError instanceof CapabilityRequestError && cancellationError.reason === CAPABILITY_ERROR.RATE_LIMITED
        ? t('capabilities.operationError', { code: cancellationError.safeMessage ?? cancellationError.reason })
        : t('capabilities.confirmationError'));
    } finally {
      setBusy(false);
    }
  };

  const executeManage = async (
    item: CapabilitySummaryView,
    action: CapabilityManagementAction,
    versionId?: string,
    binding?: CapabilityBinding,
  ) => {
    if (!online) return;
    const waitsForLocalAck = binding?.scope === CAPABILITY_SCOPE.LOCAL;
    if (waitsForLocalAck) {
      setPendingLocalManageId(item.id);
      setPendingLocalManageRetry((current) => current?.item.id === item.id ? null : current);
    }
    setBusy(true);
    setError(null);
    try {
      const next = await manageCapability(item.id, {
        action,
        ...(binding ? { bindingId: binding.id, scope: binding.scope } : {}),
        expectedRevision: item.revision,
        versionId,
        userIntent: t(`capabilities.manageTitle.${safeSuffix(action)}`, { name: item.name }),
      }, serverId);
      setItems((current) => replaceCapability(current, next));
      if (waitsForLocalAck) setPendingLocalManageRetry(null);
      if (pendingAction) closeManageDialog();
    } catch (manageError) {
      if (manageError instanceof CapabilityManageAmbiguousError) {
        const bindings = manageError.choices.map((choice) => ({
          id: choice.bindingId,
          scope: choice.scope,
          scopeId: choice.scopeId,
          providers: [],
          machines: [],
          active: true,
        }));
        setPendingAction({ item, action, bindings });
        setSelectedBindingId('');
      } else {
        let authoritativeItem: CapabilitySummaryView | undefined;
        try {
          const response = await listCapabilities(serverId);
          setItems(response.items);
          authoritativeItem = response.items.find((candidate) => candidate.id === item.id);
          if (response.operations) setCapabilityOperationSnapshots(serverId, response.operations, true);
        } catch { /* Preserve the last server-confirmed inventory if reconciliation is unavailable. */ }
        if (waitsForLocalAck
          && binding
          && manageError instanceof CapabilityRequestError
          && manageError.reason === CAPABILITY_ERROR.RUNTIME_PENDING
          && manageError.retryable
          && (!authoritativeItem || authoritativeItem.revision <= item.revision)) {
          setPendingLocalManageRetry({
            item: authoritativeItem ?? item,
            action,
            versionId,
            binding,
            requestId: manageError.requestId,
          });
        } else if (waitsForLocalAck) {
          setPendingLocalManageRetry(null);
        }
        if (manageError instanceof CapabilityRequestError
          && (manageError.reason === CAPABILITY_ERROR.RATE_LIMITED || manageError.reason === CAPABILITY_ERROR.RUNTIME_PENDING)) {
          setError(t('capabilities.operationError', { code: manageError.safeMessage ?? manageError.reason }));
        } else {
          setError(t('capabilities.manageError'));
        }
      }
    } finally {
      if (waitsForLocalAck) setPendingLocalManageId(null);
      setBusy(false);
    }
  };

  const beginManage = (
    item: CapabilitySummaryView,
    action: CapabilityManagementAction,
    trigger: HTMLButtonElement,
  ) => {
    manageTriggerRef.current = trigger;
    if (action === CAPABILITY_MANAGE_ACTION.ROLLBACK) {
      setPendingAction({ item, action });
      return;
    }
    if (!bindingScopedAction(action)) {
      void executeManage(item, action);
      return;
    }
    const bindings = applicableBindings(item, action);
    if (bindings.length === 1) {
      void executeManage(item, action, undefined, bindings[0]);
      return;
    }
    if (bindings.length === 0) {
      setError(t('capabilities.manageBindingMissing'));
      return;
    }
    setPendingAction({ item, action, bindings });
    setSelectedBindingId('');
  };

  const openUpdateForm = (item: CapabilitySummaryView, binding: CapabilityBinding) => {
    setManualUpdateTarget({ item, binding });
    setManualKind(item.kind);
    setManualScope(binding.scope);
    setManualSource('');
    setManualFileName('');
    setShowManual(true);
    setError(null);
  };

  const beginUpdate = (item: CapabilitySummaryView, trigger: HTMLButtonElement) => {
    manageTriggerRef.current = trigger;
    const bindings = (item.bindings ?? []).filter((binding) => binding.active);
    const candidates = bindings.length ? bindings : [...(item.bindings ?? [])];
    if (candidates.length === 1) {
      openUpdateForm(item, candidates[0]!);
      return;
    }
    if (candidates.length === 0) {
      setError(t('capabilities.manageBindingMissing'));
      return;
    }
    setPendingUpdate({ item, bindings: candidates });
    setSelectedBindingId('');
  };

  const submitAskAi = () => {
    const source = aiSource.trim();
    if (!source || !canAskAi || !onAskAi) return;
    onAskAi(source);
  };

  return (
    <section class="capabilities-panel" aria-labelledby="capabilities-panel-title">
      <header class="capabilities-panel-header">
        <div>
          <span class="capability-eyebrow">{t('capabilities.eyebrow')}</span>
          <h2 id="capabilities-panel-title">{t('capabilities.title')}</h2>
          <p>{t('capabilities.description')}</p>
        </div>
      </header>

      <div class="capability-ask-ai">
        <label for="capability-ai-source">{t('capabilities.askAiLabel')}</label>
        <div class="capability-source-row">
          <input
            id="capability-ai-source"
            value={aiSource}
            onInput={(event) => setAiSource((event.target as HTMLInputElement).value)}
            placeholder={t('capabilities.askAiPlaceholder')}
          />
          <button
            class="capability-button capability-button-primary"
            disabled={!aiSource.trim() || !canAskAi}
            onClick={submitAskAi}
          >
            {t('capabilities.askAiAction')}
          </button>
        </div>
        {!canAskAi && <p class="capability-muted">{t('capabilities.askAiNeedsSession')}</p>}
        <button class="capability-link-button" onClick={() => setShowManual((value) => !value)} aria-expanded={showManual}>
          {showManual ? t('capabilities.hideManual') : t('capabilities.showManual')}
        </button>
      </div>

      {showManual && (
        <div class="capability-manual-form">
          {manualUpdateTarget && (
            <div class="capability-update-target" role="status">
              <span>{t('capabilities.updateTarget', { name: manualUpdateTarget.item.name })}</span>
              <button class="capability-link-button" onClick={() => setManualUpdateTarget(null)}>{t('capabilities.cancelUpdate')}</button>
            </div>
          )}
          {!serverId && <div class="capability-inline-alert" role="alert">{t('capabilities.manualNeedsServer')}</div>}
          <div class="capability-form-grid">
            <label>
              <span>{t('capabilities.kindLabel')}</span>
              <select disabled={Boolean(manualUpdateTarget)} value={manualKind} onInput={(event) => setManualKind((event.target as HTMLSelectElement).value as CapabilityKind)}>
                <option value={CAPABILITY_KIND.SKILL}>{t('capabilities.kind.skill')}</option>
                <option value={CAPABILITY_KIND.MCP}>{t('capabilities.kind.mcp')}</option>
              </select>
            </label>
            <label>
              <span>{t('capabilities.scopeLabel')}</span>
              <select disabled={Boolean(manualUpdateTarget)} value={manualScope} onInput={(event) => setManualScope((event.target as HTMLSelectElement).value as CapabilityScope)}>
                <option value={CAPABILITY_SCOPE.ACCOUNT}>{t('capabilities.scope.account')}</option>
                <option value={CAPABILITY_SCOPE.LOCAL}>{t('capabilities.scope.local')}</option>
              </select>
            </label>
          </div>
          <label>
            <span>{t('capabilities.manualSourceLabel')}</span>
            <textarea
              value={manualSource}
              onInput={(event) => setManualSource((event.target as HTMLTextAreaElement).value)}
              placeholder={t('capabilities.manualSourcePlaceholder')}
              rows={4}
            />
          </label>
          <p class="capability-muted">{t('capabilities.manualSafetyHint')}</p>
          {manualKind === CAPABILITY_KIND.MCP && (
            <div class="capability-file-import">
              <input
                ref={manualFileRef}
                type="file"
                accept=".json,.jsonc,.toml,application/json,text/plain"
                onInput={(event) => void chooseManualFile(event)}
                aria-label={t('capabilities.importFileLabel')}
              />
              <button class="capability-button" type="button" onClick={() => manualFileRef.current?.click()}>
                {t('capabilities.importFileAction')}
              </button>
              {manualFileName && <span class="capability-muted">{manualFileName}</span>}
            </div>
          )}
          <button class="capability-button capability-button-primary" disabled={busy || !online || !serverId || !manualSource.trim()} onClick={startManualInstall}>
            {busy ? t('capabilities.working') : t(manualUpdateTarget ? 'capabilities.scanUpdateAndReview' : 'capabilities.scanAndReview')}
          </button>
        </div>
      )}

      {error && (
        <div class="capability-inline-alert" role="alert">
          <span>{error}</span>
          <button class="capability-link-button" onClick={() => void load()}>{t('capabilities.retry')}</button>
        </div>
      )}

      {operations.map((operation) => {
        const visibleOperation = pendingInstallIds.has(operation.id) ? {
          ...operation,
          state: CAPABILITY_INSTALL_STATE.INSTALLING,
          canConfirm: false,
          canCancel: false,
        } : operation;
        return (
        <CapabilityOperationCard
          key={operation.id}
          operation={visibleOperation}
          busy={busy}
          offline={!online}
          onInstall={() => void decide(operation, CAPABILITY_CONFIRMATION_DECISION.INSTALL)}
          onCancel={() => void cancelOperation(operation)}
          onRetry={() => void getCapabilityOperation(operation.id, serverId).then(publishOperation).catch(() => setError(t('capabilities.statusRefreshError')))}
        />
        );
      })}

      <div class="capability-inventory-toolbar">
        <input
          type="search"
          value={query}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          placeholder={t('capabilities.searchPlaceholder')}
          aria-label={t('capabilities.searchLabel')}
        />
        <select value={filter} onInput={(event) => setFilter((event.target as HTMLSelectElement).value)} aria-label={t('capabilities.filterLabel')}>
          <option value="all">{t('capabilities.filter.all')}</option>
          <option value={CAPABILITY_KIND.SKILL}>{t('capabilities.filter.skill')}</option>
          <option value={CAPABILITY_KIND.MCP}>{t('capabilities.filter.mcp')}</option>
          <option value={CAPABILITY_STATE.DEGRADED}>{t('capabilities.filter.degraded')}</option>
          <option value={CAPABILITY_STATE.RUNTIME_PENDING}>{t('capabilities.filter.runtime_pending')}</option>
        </select>
      </div>

      {loading ? (
        <div class="capability-empty" aria-busy="true">{t('common.loading')}</div>
      ) : filtered.length === 0 ? (
        <div class="capability-empty">{t(items.length ? 'capabilities.noMatches' : 'capabilities.empty')}</div>
      ) : (
        <div class="capability-inventory">
          {filtered.map((item) => (
            <article key={item.id} class="capability-item">
              <header>
                <div>
                  <span class="capability-kind">{t(`capabilities.kind.${safeSuffix(item.kind)}`)}</span>
                  <h3>{item.name}</h3>
                </div>
                <span class={`capability-state capability-state-${safeSuffix(item.state)}`}>{t(`capabilities.state.${safeSuffix(item.state)}`)}</span>
              </header>
              <dl class="capability-facts">
                <dt>{t('capabilities.scopeLabel')}</dt><dd>{t(`capabilities.scope.${safeSuffix(item.scope)}`)}</dd>
                {item.version && <><dt>{t('capabilities.versionLabel')}</dt><dd>{item.version}</dd></>}
                {item.sourceLabel && <><dt>{t('capabilities.sourceLabel')}</dt><dd>{item.sourceLabel}</dd></>}
                {item.readiness && <><dt>{t('capabilities.readinessLabel')}</dt><dd>{t(`capabilities.readiness.${safeSuffix(item.readiness)}`)}</dd></>}
              </dl>
              {!!item.tools?.length && <div class="capability-chip-row">{item.tools.map((tool) => <code key={tool}>{tool}</code>)}</div>}
              {!!item.permissions?.length && <div class="capability-chip-row">{item.permissions.map((permission) => <span key={permission}>{permission}</span>)}</div>}
              {(item.hasScripts || item.hasExecutables || !!item.stdioCommand?.length) && (
                <div class="capability-risk-summary">{t('capabilities.warningCount', { count: Number(item.hasScripts) + Number(item.hasExecutables) + Number(!!item.stdioCommand?.length) })}</div>
              )}
              {item.credentialsRetained && (
                <p class="capability-credential-note">{t('capabilities.credentialsRetained')}</p>
              )}
              {pendingLocalManageId === item.id && (
                <p class="capability-muted" role="status">{t('capabilities.working')}</p>
              )}
              {pendingLocalManageId !== item.id && pendingLocalManageRetry?.item.id === item.id && (
                <div class="capability-inline-alert" role="status">
                  <span>{t('capabilities.readiness.runtime_pending')}</span>
                  <button
                    class="capability-link-button"
                    disabled={!online || busy}
                    onClick={() => void executeManage(
                      items.find((candidate) => candidate.id === item.id) ?? pendingLocalManageRetry.item,
                      pendingLocalManageRetry.action,
                      pendingLocalManageRetry.versionId,
                      pendingLocalManageRetry.binding,
                    )}
                  >
                    {t('capabilities.retry')}
                  </button>
                </div>
              )}
              <div class="capability-item-actions">
                <button
                  class="capability-button"
                  disabled={busy || !online}
                  onClick={(event) => beginUpdate(item, event.currentTarget)}
                >
                  {t('capabilities.action.update')}
                </button>
                {actionsFor(item).map((action) => (
                  <button
                    key={action}
                    class={`capability-button ${action === CAPABILITY_MANAGE_ACTION.UNINSTALL || action === CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS ? 'capability-button-danger' : ''}`}
                    disabled={busy || !online}
                    onClick={(event) => {
                      beginManage(item, action, event.currentTarget);
                    }}
                  >
                    {t(`capabilities.action.${safeSuffix(action)}`)}
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}

      {pendingAction && (
        <div class="capability-confirm-overlay" role="presentation" onClick={() => !busy && closeManageDialog()}>
          <div ref={manageDialogRef} class="capability-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="capability-manage-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="capability-manage-title">{t(`capabilities.manageTitle.${safeSuffix(pendingAction.action)}`, { name: pendingAction.item.name })}</h3>
            <p>{t(`capabilities.manageHint.${safeSuffix(pendingAction.action)}`, { scope: t(`capabilities.scope.${safeSuffix(pendingAction.item.scope)}`) })}</p>
            {pendingAction.action === CAPABILITY_MANAGE_ACTION.ROLLBACK && (
              <label>
                <span>{t('capabilities.rollbackVersion')}</span>
                <select value={rollbackVersion} onInput={(event) => setRollbackVersion((event.target as HTMLSelectElement).value)}>
                  <option value="">{t('capabilities.chooseVersion')}</option>
                  {(pendingAction.item.availableVersions ?? []).map((version) => <option key={version.id} value={version.id}>{version.label}</option>)}
                </select>
              </label>
            )}
            {pendingAction.bindings && (
              <label>
                <span>{t('capabilities.chooseBinding')}</span>
                <select value={selectedBindingId} onInput={(event) => setSelectedBindingId((event.target as HTMLSelectElement).value)}>
                  <option value="">{t('capabilities.chooseBindingPlaceholder')}</option>
                  {pendingAction.bindings.map((binding) => (
                    <option key={binding.id} value={binding.id}>
                      {t(`capabilities.scope.${safeSuffix(binding.scope)}`)}{binding.scopeId ? ` · ${binding.scopeId}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div class="capability-operation-actions">
              <button
                class={`capability-button ${pendingAction.action === CAPABILITY_MANAGE_ACTION.UNINSTALL || pendingAction.action === CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS ? 'capability-button-danger' : 'capability-button-primary'}`}
                disabled={busy || !online
                  || (pendingAction.action === CAPABILITY_MANAGE_ACTION.ROLLBACK && !rollbackVersion)
                  || Boolean(pendingAction.bindings && !selectedBindingId)}
                onClick={() => void executeManage(
                  pendingAction.item,
                  pendingAction.action,
                  rollbackVersion,
                  pendingAction.bindings?.find((binding) => binding.id === selectedBindingId),
                )}
                autofocus
              >
                {busy ? t('capabilities.working') : t(`capabilities.action.${safeSuffix(pendingAction.action)}`)}
              </button>
              <button class="capability-button" disabled={busy} onClick={closeManageDialog}>{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {pendingUpdate && (
        <div class="capability-confirm-overlay" role="presentation" onClick={() => !busy && closeManageDialog()}>
          <div ref={manageDialogRef} class="capability-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="capability-update-binding-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="capability-update-binding-title">{t('capabilities.chooseUpdateBinding', { name: pendingUpdate.item.name })}</h3>
            <label>
              <span>{t('capabilities.chooseBinding')}</span>
              <select value={selectedBindingId} onInput={(event) => setSelectedBindingId((event.target as HTMLSelectElement).value)}>
                <option value="">{t('capabilities.chooseBindingPlaceholder')}</option>
                {pendingUpdate.bindings.map((binding) => (
                  <option key={binding.id} value={binding.id}>
                    {t(`capabilities.scope.${safeSuffix(binding.scope)}`)}{binding.scopeId ? ` · ${binding.scopeId}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <div class="capability-operation-actions">
              <button
                class="capability-button capability-button-primary"
                disabled={!selectedBindingId}
                onClick={() => {
                  const binding = pendingUpdate.bindings.find((candidate) => candidate.id === selectedBindingId);
                  if (!binding) return;
                  const item = pendingUpdate.item;
                  closeManageDialog();
                  openUpdateForm(item, binding);
                }}
              >
                {t('capabilities.continueUpdate')}
              </button>
              <button class="capability-button" onClick={closeManageDialog}>{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
