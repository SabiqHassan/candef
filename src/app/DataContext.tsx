import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DataLoadError, defaultDataSource, type DataSource } from "../data/dataSource";
import { indexSnapshot, type SnapshotIndex } from "../domain";

const Ctx = createContext<SnapshotIndex | null>(null);

export function useData(): SnapshotIndex {
  const v = useContext(Ctx);
  if (!v) throw new Error("useData must be used inside <DataProvider>");
  return v;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; index: SnapshotIndex };

export function DataProvider({
  children,
  source = defaultDataSource,
}: {
  children: ReactNode;
  source?: DataSource;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    source
      .load()
      .then((snap) => {
        if (!alive) return;
        const index = indexSnapshot(snap);
        performance.mark("candef:indexed");
        setState({ status: "ready", index });
      })
      .catch(
        (e: unknown) =>
          alive &&
          setState({
            status: "error",
            // Only our own, visitor-readable messages are shown; anything else is a bug to report.
            message:
              e instanceof DataLoadError
                ? e.message
                : "Something unexpected went wrong while preparing the data.",
          }),
      );
    return () => {
      alive = false;
    };
  }, [source, attempt]);

  if (state.status === "loading")
    return (
      <div className="boot" role="status">
        Loading the company universe…
      </div>
    );
  if (state.status === "error")
    return (
      <div className="boot" role="alert">
        <p>The dataset could not be loaded. {state.message}</p>
        <p>
          <button
            type="button"
            className="boot-action"
            onClick={() => {
              setState({ status: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </p>
        {import.meta.env.DEV && (
          <p className="boot-dev">
            Developer note: run <code>npm run data:demo</code> to build the demonstration dataset,
            then reload.
          </p>
        )}
      </div>
    );
  return <Ctx.Provider value={state.index}>{children}</Ctx.Provider>;
}
