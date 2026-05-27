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

/** Catches render errors in children — prevents one broken panel from crashing the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary]', error);
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
        </div>
      );
    }
    return this.props.children;
  }
}
