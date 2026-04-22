import { Component, type ReactNode } from 'react';
import { PageErrorState } from './PageErrorState';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Catches render-time errors so a single broken component doesn't white-screen
// the whole app. Reset is location-scoped — clicking "Try again" forces a
// reload of the current route, which is the cheapest honest recovery path
// (the broken component's state has already been torn down by React).
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[ErrorBoundary] render crash', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <PageErrorState
          title="Something broke"
          message={this.state.error.message || 'An unexpected error occurred while rendering this page.'}
          onRetry={() => {
            this.setState({ error: null });
            window.location.reload();
          }}
        />
      );
    }
    return this.props.children;
  }
}
