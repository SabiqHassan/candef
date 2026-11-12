/**
 * Web lookup slot for the leads search. Interface only: nothing here touches the network.
 *
 * - Claude mode: the Claude session does the web step itself (its own search and fetch tools, on
 *   official or company sources) and records each page it read as a `web` source. This slot then
 *   answers `not_researched`.
 * - API mode: a search provider can be plugged in later. A key in CANDEF_WEBSEARCH_API_KEY marks the
 *   slot as configured but no provider is implemented yet, so the answer is `not_configured`.
 *
 * The key is never read into a result, logged or put in an error.
 */
export type WebResult =
  | { state: "not_researched"; note: string }
  | { state: "not_configured"; note: string }
  | { state: "not_found"; note: string }
  | {
      state: "found";
      pages: { url: string; title: string; accessed: string; excerpt?: string }[];
    };

export interface WebProvider {
  id: string;
  lookup(name: string, question: string): Promise<WebResult>;
}

export const noneProvider: WebProvider = {
  id: "none",
  async lookup() {
    return {
      state: "not_researched",
      note: "No web search provider is configured. In Claude mode the session searches the web itself and cites the pages it read.",
    };
  },
};

/** Placeholder for a future search API; reports that it is not implemented. */
export const unimplementedProvider: WebProvider = {
  id: "slot",
  async lookup() {
    return {
      state: "not_configured",
      note: "A web search key is set (CANDEF_WEBSEARCH_API_KEY) but no search provider is implemented yet.",
    };
  },
};

export const WEB_KEY_ENV = "CANDEF_WEBSEARCH_API_KEY";

export function defaultWebProvider(
  env: Record<string, string | undefined> = process.env,
): WebProvider {
  return env[WEB_KEY_ENV] ? unimplementedProvider : noneProvider;
}

export function webLookup(
  name: string,
  question: string,
  provider: WebProvider = defaultWebProvider(),
): Promise<WebResult> {
  return provider.lookup(name, question);
}
