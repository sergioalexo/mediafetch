import React from "react";

type Props = { children: React.ReactNode };
type State = { error: Error | null };

/**
 * A render error anywhere in the tree used to unmount everything and leave an
 * empty window that could only be fixed by restarting the app. Show what broke
 * instead, and offer a reload that keeps the process alive.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center bg-background p-6">
        <div className="max-w-lg space-y-3 rounded-xl border p-6">
          <div className="text-lg font-semibold text-foreground">Something went wrong</div>
          <p className="text-sm text-muted-foreground">
            MediaFetch hit an unexpected error. Downloads already running are unaffected —
            reloading the window is usually enough.
          </p>
          <pre className="max-h-40 select-text overflow-auto rounded-lg bg-secondary/50 p-3 font-mono text-[11px] text-muted-foreground">
            {String(error.stack || error.message || error)}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Reload
            </button>
            <button
              onClick={() => this.setState({ error: null })}
              className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-accent"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }
}
