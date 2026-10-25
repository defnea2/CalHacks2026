import { Component, type ReactNode } from 'react';
import { eventLog } from '../lib/debug';

/** Keeps a render error in one screen from blanking the tab; logs it for the harness. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  componentDidCatch(err: unknown) {
    eventLog.log('ui.render_error', { error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
  render() {
    if (this.state.error)
      return (
        <div data-testid="render-error" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          Something went wrong: {this.state.error}
        </div>
      );
    return this.props.children;
  }
}
