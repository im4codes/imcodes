import { Component } from 'preact';
import type { ComponentChildren } from 'preact';

interface Props {
  fallback?: ComponentChildren;
  children: ComponentChildren;
}

interface State {
  error: Error | null;
}

/** Detect dynamic import failures caused by stale chunk hashes after deployment. */
function isChunkLoadError(error: Error): boolean {
  const msg = error.message || '';
  return msg.includes('Failed to fetch dynamically imported module')
    || msg.includes('Loading chunk')
    || msg.includes('Loading CSS chunk')
    || (error.name === 'TypeError' && msg.includes('Failed to fetch'));
}

/** Catches render errors in children — prevents one broken panel from crashing the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary]', error);
    // Dynamic import failure after deployment (stale chunk hash) — auto-reload once
    if (isChunkLoadError(error) && !sessionStorage.getItem('chunk_reload')) {
      sessionStorage.setItem('chunk_reload', '1');
      window.location.reload();
    }
  }

  render() {
    if (this.state.error) {
      // Clear the one-shot reload guard so future deploys can trigger it again
      try { sessionStorage.removeItem('chunk_reload'); } catch { /* ignore */ }
      return this.props.fallback ?? (
        <div style={{ padding: 12, fontSize: 11, color: '#ef4444', textAlign: 'center' }}>
          {isChunkLoadError(this.state.error)
            ? 'App updated — reload to continue'
            : 'Component error — tap to retry'}
          <button
            style={{ display: 'block', margin: '8px auto', background: '#1e293b', border: '1px solid #334155', color: '#94a3b8', padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}
            onClick={() => isChunkLoadError(this.state.error!) ? window.location.reload() : this.setState({ error: null })}
          >
            {isChunkLoadError(this.state.error) ? 'Reload' : 'Retry'}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
