import { Component } from 'preact';
import type { ComponentChildren } from 'preact';
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
      return this.props.fallback ?? (
        <div style={{ padding: 12, fontSize: 11, color: '#ef4444', textAlign: 'center' }}>
          {isChunkLoadFailure(this.state.error)
            ? 'App updated — reload to continue'
            : 'Component error — tap to retry'}
          <button
            style={{ display: 'block', margin: '8px auto', background: '#1e293b', border: '1px solid #334155', color: '#94a3b8', padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}
            onClick={() => isChunkLoadFailure(this.state.error!) ? window.location.reload() : this.setState({ error: null })}
          >
            {isChunkLoadFailure(this.state.error) ? 'Reload' : 'Retry'}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
