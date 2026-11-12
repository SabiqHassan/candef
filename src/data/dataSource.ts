/**
 * Data access boundary (ARCHITECTURE §3). The UI only talks to a DataSource; today it is a static
 * snapshot, later an API. Swapping implementations must not touch components.
 */
import {
  SNAPSHOT_SCHEMA_VERSION,
  type Snapshot,
  type SnapshotManifest,
} from "../domain/schema/snapshot";

export interface DataSource {
  load(): Promise<Snapshot>;
}

/**
 * Why a dataset could not be loaded, in terms a visitor can act on. `message` is shown to people,
 * so it never contains developer instructions or parser jargon.
 */
export type LoadFailure = "network" | "http" | "damaged" | "incompatible" | "timeout";
export class DataLoadError extends Error {
  constructor(
    readonly kind: LoadFailure,
    message: string,
  ) {
    super(message);
  }
}

export class SnapshotIncompatibleError extends DataLoadError {
  constructor(found: string) {
    super(
      "incompatible",
      `This version of CANDEF cannot read the current data (data format ${found}, expected ${SNAPSHOT_SCHEMA_VERSION}). Reloading the page usually fetches the matching version.`,
    );
  }
}

/** Whole-load budget. A snapshot that has not arrived by then is treated as failed, not pending. */
export const LOAD_TIMEOUT_MS = 45_000;

/** The top-level parts every reader of a snapshot depends on; checked before anything renders. */
const REQUIRED_PARTS = [
  "meta",
  "taxonomy",
  "organizations",
  "rounds",
  "agreements",
  "acquisitions",
  "assertions",
  "sources",
  "graph",
  "coverage",
];
function assertSnapshotShape(snap: unknown): asserts snap is Snapshot {
  const ok =
    typeof snap === "object" &&
    snap !== null &&
    REQUIRED_PARTS.every((k) => (snap as Record<string, unknown>)[k] != null) &&
    Array.isArray((snap as Record<string, unknown>).organizations);
  if (!ok)
    throw new DataLoadError(
      "damaged",
      "The data file arrived incomplete or damaged. Please try again.",
    );
}

export class StaticSnapshotSource implements DataSource {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = LOAD_TIMEOUT_MS,
  ) {}

  async load(): Promise<Snapshot> {
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.timeoutMs);
    try {
      return await this.fetchSnapshot(abort.signal);
    } catch (e) {
      if (timedOut)
        throw new DataLoadError(
          "timeout",
          "Loading the data took too long. Check your connection and try again.",
        );
      if (e instanceof DataLoadError) throw e;
      throw new DataLoadError(
        "network",
        "The data could not be reached. Check your connection and try again.",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchSnapshot(signal: AbortSignal): Promise<Snapshot> {
    performance.mark("candef:load-start");
    const http = (what: string, status: number) =>
      new DataLoadError("http", `The ${what} is unavailable right now (HTTP ${status}).`);
    const manifestRes = await fetch(`${this.baseUrl}/manifest.json`, {
      cache: "no-store",
      signal,
    });
    if (!manifestRes.ok) throw http("dataset index", manifestRes.status);
    let manifest: SnapshotManifest;
    try {
      manifest = (await manifestRes.json()) as SnapshotManifest;
    } catch {
      throw new DataLoadError("damaged", "The dataset index is damaged. Please try again later.");
    }
    const [major, minor] = String(manifest?.schemaVersion ?? "").split(".");
    const [wantMajor, wantMinor] = SNAPSHOT_SCHEMA_VERSION.split(".");
    if (typeof manifest?.current !== "string" || major === undefined)
      throw new DataLoadError("damaged", "The dataset index is damaged. Please try again later.");
    if (major !== wantMajor || minor !== wantMinor)
      throw new SnapshotIncompatibleError(manifest.schemaVersion);
    const res = await fetch(`${this.baseUrl}/${manifest.current}`, { signal });
    if (!res.ok) throw http("data file", res.status);
    // Download and parse are timed separately (performance marks; read by the stress harness).
    const text = await res.text();
    performance.mark("candef:snapshot-downloaded");
    let snap: unknown;
    try {
      snap = JSON.parse(text);
    } catch {
      // Truncated transfers, and hosts that answer a missing file with their HTML fallback page.
      throw new DataLoadError(
        "damaged",
        "The data file arrived incomplete or damaged. Please try again.",
      );
    }
    assertSnapshotShape(snap);
    performance.mark("candef:snapshot-parsed");
    return snap;
  }
}

/**
 * Which dataset this build reads (set at build time): `--mode research` → research, `--mode stress`
 * → the synthetic stress dataset (fictional, scale tests only), otherwise the demo.
 */
export type Dataset = "demo" | "research" | "stress";
export function datasetFromEnv(value: string | undefined): Dataset {
  return value === "research" ? "research" : value === "stress" ? "stress" : "demo";
}
export const DATASET: Dataset = datasetFromEnv(import.meta.env.VITE_DATASET);

export const defaultDataSource: DataSource = new StaticSnapshotSource(
  `${import.meta.env.BASE_URL}data/${DATASET}`,
);
