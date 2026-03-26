import { Component } from 'preact';
import type { ComponentChildren } from 'preact';

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
  }

  render() {
    if (this.state.error) {
      return this.props.fallback ?? (
        <div style={{ padding: 12, fontSize: 11, color: '#ef4444', textAlign: 'center' }}>
          Component error — tap to retry
          <button
            style={{ display: 'block', margin: '8px auto', background: '#1e293b', border: '1px solid #334155', color: '#94a3b8', padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
