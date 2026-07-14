import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  controlledNodeDownloadErrorKey,
  downloadControlledNodeExecutable,
  beginControlledNodeDesktopDownload,
} from '../api.js';
import {
  artifactSelectionKey,
  buildControlledNodeDownloadTargets,
  listAvailableExecutables,
  revokeMachine,
  setMachineExecEnabled,
  type ControlledNodeArtifactMetadata,
  type ControlledNodeArtifactSelection,
  type ControlledNodeOs,
} from '../api/machines.js';
import { useMachines } from '../hooks/useMachines.js';
import { isNative } from '../native.js';

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatExpiryTime(expiresAt: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(expiresAt));
  } catch {
    return new Date(expiresAt).toLocaleString();
  }
}

function artifactMetaLine(
  artifact: ControlledNodeArtifactMetadata | undefined,
  t: (key: string, opts?: Record<string, string>) => string,
): string | null {
  if (!artifact) return null;
  const parts: string[] = [];
  parts.push(artifact.arch);
  if (artifact.sizeBytes > 0) parts.push(formatByteSize(artifact.sizeBytes));
  if (parts.length === 0) return null;
  return t('controlled_nodes.artifact_meta', { detail: parts.join(' · ') });
}

function downloadLabel(
  target: ControlledNodeArtifactSelection,
  t: (key: string, opts?: Record<string, string>) => string,
): string {
  return t('controlled_nodes.download_target', {
    os: t(`controlled_nodes.os_${target.os}`),
    arch: target.arch,
  });
}

function findArtifactForTarget(
  artifacts: ControlledNodeArtifactMetadata[],
  target: ControlledNodeArtifactSelection,
): ControlledNodeArtifactMetadata | undefined {
  return artifacts.find((a) => a.os === target.os && a.arch === target.arch);
}

const PLATFORM_PRESENTATION: Record<ControlledNodeOs, { glyph: string; name: string }> = {
  win: { glyph: '⊞', name: 'Windows' },
  mac: { glyph: '⌘', name: 'macOS' },
  linux: { glyph: '◇', name: 'Linux' },
};

export function ControlledNodesPanel() {
  const { t, i18n } = useTranslation();
  const { machines, loading, error, refetch } = useMachines();

  const [artifacts, setArtifacts] = useState<ControlledNodeArtifactMetadata[]>([]);
  const [downloadTargets, setDownloadTargets] = useState<ControlledNodeArtifactSelection[]>([]);
  const [availLoading, setAvailLoading] = useState(true);
  const [availError, setAvailError] = useState<string | null>(null);

  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [ticketExpiryByKey, setTicketExpiryByKey] = useState<Partial<Record<string, number>>>({});

  const [actionError, setActionError] = useState<string | null>(null);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);

  const sortedTargets = useMemo(() => downloadTargets, [downloadTargets]);
  const availableOses = useMemo(
    () => [...new Set(downloadTargets.map((d) => d.os))],
    [downloadTargets],
  );

  const refreshAvailability = useCallback(() => {
    setAvailLoading(true);
    setAvailError(null);
    listAvailableExecutables()
      .then((res) => {
        setArtifacts(res.artifacts);
        setDownloadTargets(buildControlledNodeDownloadTargets(res));
      })
      .catch(() => setAvailError(t('controlled_nodes.availability_error')))
      .finally(() => setAvailLoading(false));
  }, [t]);

  useEffect(() => { refreshAvailability(); }, [refreshAvailability]);

  const onDownload = async (target: ControlledNodeArtifactSelection) => {
    const key = artifactSelectionKey(target);
    setDownloadingKey(key);
    setDownloadError(null);
    let desktopWindow: Window | null = null;
    if (!isNative()) {
      try {
        desktopWindow = beginControlledNodeDesktopDownload();
      } catch (err) {
        setDownloadError(t(controlledNodeDownloadErrorKey(err)));
        setDownloadingKey(null);
        return;
      }
    }
    try {
      const ticket = await downloadControlledNodeExecutable(target, { desktopWindow });
      setTicketExpiryByKey((prev) => ({ ...prev, [key]: ticket.expiresAt }));
    } catch (err) {
      setDownloadError(t(controlledNodeDownloadErrorKey(err)));
    } finally {
      setDownloadingKey(null);
    }
  };

  const onToggleExec = async (serverId: string, next: boolean) => {
    setActionError(null);
    setBusyServerId(serverId);
    try {
      await setMachineExecEnabled(serverId, next);
      await refetch();
    } catch {
      setActionError(t('controlled_nodes.error_generic'));
    } finally {
      setBusyServerId(null);
    }
  };

  const onRevoke = async (serverId: string) => {
    if (!window.confirm(t('controlled_nodes.revoke_confirm'))) return;
    setActionError(null);
    setBusyServerId(serverId);
    try {
      await revokeMachine(serverId);
      await refetch();
    } catch {
      setActionError(t('controlled_nodes.error_generic'));
    } finally {
      setBusyServerId(null);
    }
  };

  const usageOsKeys: Array<{ os: ControlledNodeOs; key: string }> = [
    { os: 'win', key: 'controlled_nodes.usage_win_run' },
    { os: 'mac', key: 'controlled_nodes.usage_mac_run' },
    { os: 'linux', key: 'controlled_nodes.usage_linux_run' },
  ];

  const showEmptyCatalog = !availLoading && !availError && sortedTargets.length === 0;
  const onlineMachineCount = machines.filter((machine) => machine.online).length;
  const execEnabledMachineCount = machines.filter((machine) => machine.execEnabled).length;

  return (
    <div class="controlled-nodes-panel">
      <div class="controlled-nodes-grid" aria-hidden="true" />

      <header class="controlled-nodes-hero">
        <div class="controlled-nodes-hero-copy">
          <span class="controlled-nodes-kicker" aria-hidden="true">
            <span class="controlled-nodes-kicker-signal" /> NODE GRID // SECURE RELAY
          </span>
          <h2>{t('controlled_nodes.title')}</h2>
        </div>
        <div class="controlled-nodes-metrics">
          <div class="controlled-nodes-metric">
            <strong>{machines.length}</strong>
            <span>{t('controlled_nodes.machines_title')}</span>
          </div>
          <div class="controlled-nodes-metric is-online">
            <strong>{onlineMachineCount}</strong>
            <span>{t('controlled_nodes.online')}</span>
          </div>
          <div class="controlled-nodes-metric is-exec">
            <strong>{execEnabledMachineCount}</strong>
            <span>{t('controlled_nodes.exec_on')}</span>
          </div>
        </div>
      </header>

      <section class="controlled-nodes-section controlled-nodes-machines-section">
        <div class="controlled-nodes-machines-header">
          <div class="controlled-nodes-section-heading">
            <span class="controlled-nodes-section-index">01</span>
            <h3>{t('controlled_nodes.machines_title')}</h3>
          </div>
          <button
            type="button"
            class="controlled-nodes-refresh"
            onClick={() => refetch()}
            disabled={loading}
          >
            <span class={loading ? 'controlled-nodes-refresh-icon is-spinning' : 'controlled-nodes-refresh-icon'} aria-hidden="true">↻</span>
            {t('controlled_nodes.refresh')}
          </button>
        </div>
        {actionError && <p class="controlled-nodes-error" role="alert">{actionError}</p>}
        {error && <p class="controlled-nodes-error" role="alert">{t('controlled_nodes.error_generic')}</p>}
        {!loading && machines.length === 0 && (
          <div class="controlled-nodes-empty">
            <span class="controlled-nodes-empty-radar" aria-hidden="true"><i /></span>
            <p>{t('controlled_nodes.empty')}</p>
          </div>
        )}
        <ul class="controlled-nodes-machine-list">
          {machines.map((m) => (
            <li key={m.serverId} class={`controlled-nodes-machine-row ${m.online ? 'is-online' : 'is-offline'}`}>
              <span class="controlled-nodes-machine-rail" aria-hidden="true" />
              <div class="controlled-nodes-machine-info">
                <div class="controlled-nodes-machine-heading">
                  <span class="controlled-nodes-machine-name">{m.displayName}</span>
                  <span class={`controlled-nodes-status ${m.online ? 'online' : 'offline'}`}>
                    <i aria-hidden="true" />
                    {m.online ? t('controlled_nodes.online') : t('controlled_nodes.offline')}
                  </span>
                </div>
                <div class="controlled-nodes-machine-meta">
                  <code>{m.refName}</code>
                  {m.os && <span>{m.os.toUpperCase()}</span>}
                </div>
              </div>
              <div class="controlled-nodes-machine-actions">
                <button
                  type="button"
                  class={`controlled-nodes-exec-toggle ${m.execEnabled ? 'is-enabled' : 'is-disabled'}`}
                  disabled={busyServerId === m.serverId}
                  aria-pressed={m.execEnabled}
                  onClick={() => onToggleExec(m.serverId, !m.execEnabled)}
                >
                  <span class="controlled-nodes-toggle-track" aria-hidden="true"><i /></span>
                  <span>{m.execEnabled ? t('controlled_nodes.exec_on') : t('controlled_nodes.exec_off')}</span>
                </button>
                <button
                  type="button"
                  class="controlled-nodes-revoke"
                  disabled={busyServerId === m.serverId}
                  onClick={() => onRevoke(m.serverId)}
                >
                  <span aria-hidden="true">×</span> {t('controlled_nodes.revoke')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section class="controlled-nodes-section controlled-nodes-download-section">
        <div class="controlled-nodes-section-heading">
          <span class="controlled-nodes-section-index">02</span>
          <h3>{t('controlled_nodes.add_title')}</h3>
        </div>
        {availLoading && <p class="controlled-nodes-muted">{t('controlled_nodes.loading_availability')}</p>}
        {availError && <p class="controlled-nodes-error" role="alert">{availError}</p>}
        {showEmptyCatalog && (
          <p class="controlled-nodes-muted">{t('controlled_nodes.no_executables')}</p>
        )}
        <div class="controlled-nodes-downloads">
          {sortedTargets.map((target) => {
            const key = artifactSelectionKey(target);
            const meta = artifactMetaLine(findArtifactForTarget(artifacts, target), t);
            const expiry = ticketExpiryByKey[key];
            const isDownloading = downloadingKey === key;
            const platform = PLATFORM_PRESENTATION[target.os];
            return (
              <div key={key} class={`controlled-nodes-download-item is-${target.os}`}>
                <div class="controlled-nodes-platform">
                  <span class="controlled-nodes-platform-glyph" aria-hidden="true">{platform.glyph}</span>
                  <div class="controlled-nodes-platform-copy">
                    <strong>{platform.name}</strong>
                    {meta && <span class="controlled-nodes-artifact-meta">{meta}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  class="controlled-nodes-download-btn"
                  disabled={isDownloading}
                  onClick={() => onDownload(target)}
                >
                  <span>{isDownloading ? t('controlled_nodes.loading_download') : downloadLabel(target, t)}</span>
                  <span class="controlled-nodes-download-arrow" aria-hidden="true">↓</span>
                </button>
                {expiry != null && (
                  <span class="controlled-nodes-ticket-expiry">
                    {t('controlled_nodes.ticket_expires_at', {
                      time: formatExpiryTime(expiry, i18n.language),
                    })}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {downloadError && <p class="controlled-nodes-error" role="alert">{downloadError}</p>}
      </section>

      <section class="controlled-nodes-section controlled-nodes-usage-section">
        <div class="controlled-nodes-section-heading">
          <span class="controlled-nodes-section-index">03</span>
          <h3>{t('controlled_nodes.usage_title')}</h3>
        </div>
        <ol class="controlled-nodes-usage">
          {[t('controlled_nodes.usage_step1'), t('controlled_nodes.usage_step2'), t('controlled_nodes.usage_step3')]
            .map((step, index) => (
              <li key={index}>
                <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <p>{step}</p>
              </li>
            ))}
        </ol>
        {availableOses.length > 0 && (
          <ul class="controlled-nodes-usage-os">
            {usageOsKeys
              .filter(({ os }) => availableOses.includes(os))
              .map(({ os, key }) => (
                <li key={os}>
                  <strong>{PLATFORM_PRESENTATION[os].name}</strong>
                  <span>{t(key)}</span>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}
