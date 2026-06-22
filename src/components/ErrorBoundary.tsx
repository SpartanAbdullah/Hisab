import { Component, type ReactNode } from 'react';
import { PageErrorState } from './PageErrorState';
import { reportError } from '../lib/errorReporter';
import { getAppErrorPresentation, recoverFromStaleApp } from '../lib/appRecovery';

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
    reportError(error, {
      feature: 'react.render',
      extra: { componentStack: info.componentStack ?? null },
    });
  }

  render() {
    if (this.state.error) {
      const presentation = getAppErrorPresentation(this.state.error);
      // Give the "contact support" copy a real destination — a prefilled email
      // with the error text so users aren't told to contact support with no way
      // to do so. Only on the generic crash (stale-chunk just needs a refresh).
      const supportHref = presentation.kind === 'generic'
        ? `mailto:support@usehisaab.com?subject=${encodeURIComponent('Hisaab — something went wrong')}` +
          `&body=${encodeURIComponent(`Hi Hisaab team,\n\nI hit an error in the app.\n\n(Details: ${this.state.error.name}: ${this.state.error.message})\n\nWhat I was doing:\n`)}`
        : undefined;
      return (
        <PageErrorState
          title={presentation.title}
          message={presentation.message}
          secondaryText={presentation.secondaryText}
          actionLabel={presentation.actionLabel}
          supportHref={supportHref}
          onRetry={() => {
            if (presentation.kind === 'stale-chunk') {
              void recoverFromStaleApp();
              return;
            }
            this.setState({ error: null });
            window.location.reload();
          }}
        />
      );
    }
    return this.props.children;
  }
}
