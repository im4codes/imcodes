import { Component } from 'preact';
import type { ComponentChildren } from 'preact';
import i18next from 'i18next';
import { dispatchAppUpdateRequired, getLoadedWebBuildId, isChunkLoadFailure } from '../app-update.js';

interface Props {
  fallback?: ComponentChildren;
  children: ComponentChildren;
}

interface State {
  error: Error | null;
}

/**
 * localStorage ring of recent boundary crashes. The chat-area "组件错误" had
 * been recurring for months and was undiagnosable because the boundary
 * swallowed the error: nothing surfaced it and nothing persisted it. Keep the
 * last few crashes (message + stack head + component stack head + build id)
 * so a screenshot or a quick localStorage dump identifies the culprit.
 */
const ERROR_BOUNDARY_LOG_KEY = 'imcodes_error_boundary_log';
const ERROR_BOUNDARY_LOG_MAX = 10;

interface BoundaryErrorRecord {
  at: number;
  buildId: string | null;
  message: string;
  stack?: string;
  componentStack?: string;
}

function persistBoundaryError(record: BoundaryErrorRecord): void {
  try {
    const raw = window.localStorage.getItem(ERROR_BOUNDARY_LOG_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed : [];
    list.push(record);
    window.localStorage.setItem(
      ERROR_BOUNDARY_LOG_KEY,
      JSON.stringify(list.slice(-ERROR_BOUNDARY_LOG_MAX)),
    );
  } catch { /* storage unavailable/full — never let diagnostics crash the fallback */ }
}

function headLines(text: string | undefined | null, lines: number): string | undefined {
  if (!text) return undefined;
  return text.split('\n').slice(0, lines).join('\n');
}

/** Catches render errors in children — prevents one broken panel from crashing the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo?: { componentStack?: string }) {
    console.error('[ErrorBoundary]', error, errorInfo?.componentStack);
    persistBoundaryError({
      at: Date.now(),
      buildId: getLoadedWebBuildId(),
      message: error?.message ? String(error.message) : String(error),
      stack: headLines(error?.stack, 6),
      componentStack: headLines(errorInfo?.componentStack, 6),
    });
    if (isChunkLoadFailure(error)) {
      dispatchAppUpdateRequired({
        reason: 'chunk_load_failed',
        loadedBuildId: getLoadedWebBuildId(),
        blocking: true,
      });
    }
  }

  render() {
    if (this.state.error) {
      const chunkLoadFailure = isChunkLoadFailure(this.state.error);
      const detail = this.state.error?.message ? String(this.state.error.message) : String(this.state.error);
      return this.props.fallback ?? (
        <div style={{ padding: 12, fontSize: 11, color: '#ef4444', textAlign: 'center' }}>
          {chunkLoadFailure
            ? i18next.t('appUpdate.error_reload_message', 'App updated — reload to continue')
            : i18next.t('appUpdate.error_retry_message', 'Component error — tap to retry')}
          <button
            style={{ display: 'block', margin: '8px auto', background: '#1e293b', border: '1px solid #334155', color: '#94a3b8', padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}
            onClick={() => chunkLoadFailure ? window.location.reload() : this.setState({ error: null })}
          >
            {chunkLoadFailure
              ? i18next.t('appUpdate.reload', 'Reload')
              : i18next.t('appUpdate.retry', 'Retry')}
          </button>
          {!chunkLoadFailure && (
            // Raw error message (dynamic data, not a translatable label) so a
            // screenshot of this fallback is enough to identify the crash.
            <div style={{ marginTop: 6, fontSize: 10, color: '#64748b', wordBreak: 'break-all', maxWidth: 480, marginLeft: 'auto', marginRight: 'auto' }}>
              {detail.slice(0, 300)}
            </div>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
