import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  CAPABILITY_KIND,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_STATE,
  type CapabilityBinding,
  type CapabilityKind,
} from '@shared/capability-management.js';
import {
  CapabilityRequestError,
  listCapabilities,
  manageCapability,
  type CapabilitySummaryView,
} from '../api/capabilities.js';

interface Props {
  kind: CapabilityKind;
  serverId?: string;
}

function kindKey(kind: CapabilityKind): 'mcp' | 'skills' {
  return kind === CAPABILITY_KIND.MCP ? 'mcp' : 'skills';
}

function isInstalled(item: CapabilitySummaryView): boolean {
  return item.state !== CAPABILITY_STATE.REMOVED && item.state !== CAPABILITY_STATE.TOMBSTONED;
}

function bindingLabel(binding: CapabilityBinding, t: (key: string, options?: Record<string, unknown>) => string): string {
  const scope = t(`capabilities.scope.${binding.scope}`);
  return binding.scopeId
    ? t('sharedContext.management.capabilityBindingTarget', { scope, target: binding.scopeId })
    : scope;
}

/** Read-only inventory plus exact-binding deletion for Shared Context. */
export function CapabilityInventoryPanel({ kind, serverId }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<CapabilitySummaryView[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyBindingId, setBusyBindingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!serverId) {
      setItems([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await listCapabilities(serverId);
      setItems(response.items);
    } catch {
      setItems([]);
      setError(t('sharedContext.management.capabilityInventoryLoadError'));
    } finally {
      setLoading(false);
    }
  }, [serverId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items
      .filter((item) => item.kind === kind && isInstalled(item))
      .filter((item) => !needle || [item.name, item.sourceLabel, item.version, ...(item.tools ?? [])]
        .some((value) => value != null && String(value).toLowerCase().includes(needle)))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [items, kind, query]);

  const removeBinding = async (item: CapabilitySummaryView, binding: CapabilityBinding) => {
    const confirmed = globalThis.confirm?.(t('sharedContext.management.capabilityDeleteConfirm', {
      name: item.name,
      binding: bindingLabel(binding, t),
    })) ?? true;
    if (!confirmed || !serverId) return;
    setBusyBindingId(binding.id);
    setError(null);
    try {
      await manageCapability(item.id, {
        action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
        bindingId: binding.id,
        scope: binding.scope,
        expectedRevision: item.revision,
        userIntent: t('sharedContext.management.capabilityDeleteIntent', { name: item.name }),
      }, serverId);
      await load();
    } catch (removeError) {
      setError(removeError instanceof CapabilityRequestError && removeError.safeMessage
        ? removeError.safeMessage
        : t('sharedContext.management.capabilityDeleteError'));
    } finally {
      setBusyBindingId(null);
    }
  };

  const key = kindKey(kind);
  const titleId = `shared-context-${key}-inventory-title`;
  return (
    <section class="capabilities-panel shared-context-capability-panel" aria-labelledby={titleId}>
      <header class="capabilities-panel-header">
        <div>
          <h2 id={titleId}>{t(`sharedContext.management.capabilityInventory.${key}.title`)}</h2>
          <p>{t(`sharedContext.management.capabilityInventory.${key}.description`)}</p>
        </div>
        <button class="capability-button" type="button" onClick={() => void load()} disabled={!serverId || loading}>
          {t('sharedContext.refresh')}
        </button>
      </header>

      <p class="capability-muted">{t('sharedContext.management.capabilityInventory.chatInstallHint')}</p>

      {!serverId ? (
        <div class="capability-empty">{t('sharedContext.management.capabilityInventory.noServer')}</div>
      ) : (
        <div class="capability-inventory-toolbar">
          <input
            type="search"
            value={query}
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
            placeholder={t('sharedContext.management.capabilityInventory.searchPlaceholder')}
            aria-label={t('sharedContext.management.capabilityInventory.searchLabel')}
          />
        </div>
      )}

      {error ? (
        <div class="capability-inline-alert" role="alert">
          <span>{error}</span>
          <button class="capability-link-button" type="button" onClick={() => void load()}>{t('capabilities.retry')}</button>
        </div>
      ) : null}

      {serverId && loading ? (
        <div class="capability-empty" aria-busy="true">{t('common.loading')}</div>
      ) : serverId && visibleItems.length === 0 ? (
        <div class="capability-empty">{t(`sharedContext.management.capabilityInventory.${key}.empty`)}</div>
      ) : serverId ? (
        <div class="capability-inventory" data-testid={`${key}-capability-inventory`}>
          {visibleItems.map((item) => (
            <article key={item.id} class="capability-item">
              <header>
                <div>
                  <span class="capability-kind">{t(`capabilities.kind.${item.kind}`)}</span>
                  <h3>{item.name}</h3>
                </div>
                <span class={`capability-state capability-state-${item.state}`}>{t(`capabilities.state.${item.state}`)}</span>
              </header>
              <dl class="capability-facts">
                <dt>{t('capabilities.scopeLabel')}</dt><dd>{t(`capabilities.scope.${item.scope}`)}</dd>
                {item.version ? <><dt>{t('capabilities.versionLabel')}</dt><dd>{item.version}</dd></> : null}
                {item.sourceLabel ? <><dt>{t('capabilities.sourceLabel')}</dt><dd>{item.sourceLabel}</dd></> : null}
                {item.readiness ? <><dt>{t('capabilities.readinessLabel')}</dt><dd>{t(`capabilities.readiness.${item.readiness}`)}</dd></> : null}
              </dl>
              {item.tools?.length ? (
                <div class="capability-chip-row">
                  {item.tools.map((tool) => <code key={tool}>{tool}</code>)}
                </div>
              ) : null}
              <div class="capability-binding-list">
                {(item.bindings ?? []).map((binding) => (
                  <div key={binding.id} class="capability-binding-row">
                    <div>
                      <strong>{bindingLabel(binding, t)}</strong>
                      <span class="capability-muted">{t(binding.active
                        ? 'sharedContext.management.capabilityInventory.bindingActive'
                        : 'sharedContext.management.capabilityInventory.bindingInactive')}</span>
                    </div>
                    <button
                      class="capability-button capability-button-danger"
                      type="button"
                      disabled={busyBindingId !== null}
                      onClick={() => void removeBinding(item, binding)}
                    >
                      {busyBindingId === binding.id
                        ? t('capabilities.working')
                        : t('sharedContext.management.capabilityInventory.delete')}
                    </button>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
