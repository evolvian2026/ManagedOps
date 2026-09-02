import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorMessage } from '../lib/api';

/**
 * The four states every data-driven view must handle (spec 9.6). Having them as
 * shared components is what stops a screen from quietly shipping with only the
 * populated one.
 */

export function LoadingState({ label = 'Loading', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="h-14 animate-pulse rounded-md border border-line bg-surface-sunk"
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/**
 * Always shows what actually failed. Collapsing a specific server message into
 * "something went wrong" is what makes a real bug untriageable from a screenshot.
 */
export function ErrorState({
  error,
  onRetry,
  title = 'This did not load',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-md border border-danger/30 bg-danger-wash px-5 py-4 text-sm"
    >
      <p className="font-semibold text-danger">{title}</p>
      <p className="mt-1 text-ink">{errorMessage(error)}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-danger/40 bg-surface px-3 py-1.5 font-medium text-danger hover:bg-danger-wash"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

interface BoundaryProps {
  children: ReactNode;
  /** Names the area, so the message says what broke rather than "the page". */
  area?: string;
}

interface BoundaryState {
  error: Error | null;
}

/**
 * Wraps every route. A render-time crash degrades to this panel instead of an
 * unexplained blank page — the failure mode that makes one undefined field look
 * like a dead application.
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Render failed in ${this.props.area ?? 'the application'}:`, error, info);
  }

  private reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="m-6 rounded-md border border-danger/30 bg-danger-wash p-6">
        <h2 className="text-base font-semibold text-danger">
          {this.props.area ? `${this.props.area} could not be displayed` : 'Something broke'}
        </h2>
        <p className="mt-1 max-w-prose text-sm text-ink">
          The rest of ManagedOps is still working. Reloading this section usually clears it; if it
          keeps happening, report what you were doing.
        </p>
        <p className="mt-3 font-mono text-xs break-words text-ink-soft">{error.message}</p>
        <button
          type="button"
          onClick={this.reset}
          className="mt-4 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-hover"
        >
          Reload this section
        </button>
      </div>
    );
  }
}
