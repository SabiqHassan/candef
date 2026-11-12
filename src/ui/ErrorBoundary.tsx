import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps a rendering error on one page from taking the whole application down: the navigation stays
 * and the visitor gets a way forward instead of a blank screen. It resets when `resetKey` changes
 * (the route), so moving to another page recovers. The message is deliberately plain; the technical
 * detail is available for a bug report but never replaces the explanation.
 */
export class ErrorBoundary extends Component<
  {
    resetKey: string;
    children: ReactNode;
    /** Replaces the page-level message (null shows nothing, for parts that degrade on their own). */
    fallback?: ReactNode;
    onError?: (error: Error) => void;
  },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Reaches the browser console (and any future error reporting); never shown as the explanation.
    console.error("CANDEF page error:", error, info.componentStack);
    this.props.onError?.(error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div className="page" tabIndex={0} role="region" aria-label="Something went wrong">
        <div className="page-inner">
          <h1>This page could not be displayed</h1>
          <p>
            Something in the data or the page did not behave as expected. Nothing has been lost: the
            other pages still work.
          </p>
          <p>
            <a href="/">Return to the explorer</a> · <a href="/methodology">Coverage and method</a>{" "}
            ·{" "}
            <button type="button" className="boot-action" onClick={() => window.location.reload()}>
              Reload this page
            </button>
          </p>
          <details>
            <summary>Technical detail for a bug report</summary>
            <pre>{error.message}</pre>
          </details>
        </div>
      </div>
    );
  }
}
