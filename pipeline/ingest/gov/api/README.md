# Government API discovery

API results are **leads only**, never evidence. This helper never imports records,
registers sources, creates proposals, or modifies research. Cite only a downloaded,
dated, fingerprinted file after independently inspecting its rows.

Run from the repository root (Node fetch, no credentials, no dependencies added):

```powershell
npx.cmd tsx pipeline/ingest/gov/api-cli.ts gov-api new-rows --since 2026-2027-Q1 --terms-reviewed
npx.cmd tsx pipeline/ingest/gov/api-cli.ts gov-api lookup --names companies.json --terms-reviewed
```

Use `--help` for CSV paths, dataset selection, package/resource overrides and paging.
In a worktree, point `--contracts` and `--grants` at the existing dated CSVs; do not
copy or re-download them just to use the helper. Output is exclusively JSON under
the current checkout's gitignored `research-cache/gov-api/`. No raw API response is
persisted. Exit 0 means complete discovery under the stated matching rules; exit 2
means partial/unsupported discovery; exit 1 means failure/refusal. Reports retain
the exact query's zero-based index rather than copying company names or BNs.

`companies.json` is a list of strings, or explicit `{ "name": "Fictional Aster" }`
and `{ "businessNumber": "123456789RC0001" }` objects. Numeric JSON values are
rejected because a numeric parser can lose leading zeroes. Use an explicit name
object for numbered company names. BN input and grant cells must be a valid
nine-digit root or root plus two letters and four digits. Invalid/ten-digit cells
are counted and excluded from all lookup matches. Contracts have no BN in the
importer projection and explicitly report BN lookup as unsupported.

The existing `pipeline/research/names.ts` exports the shared exact normalization
(`nameKey`, `nameKeys`, `businessNumberRoot`). `gov/identity.ts` handles agreement
identity and has no name normalizer. This helper reads those utilities without
modifying them. Normalized matches are candidates for a company, never proof of
entity identity. There is no fuzzy/substring matching. Individual/sole-proprietor
grant rows (`recipient_type=P`) are counted as skipped and never named or emitted.

## First live run (2026-10-16): what it established

- **Terms:** `https://open.canada.ca/en/terms` now returns 404; the site's footer links its terms
  to `https://www.canada.ca/en/transparency/terms.html`. Because the client only talks to
  open.canada.ca, its terms check reads the dataset licence page there
  (`/en/open-government-licence-canada`, Open Government Licence - Canada).
- **Confirmed IDs** (package_show, then a zero-row `datastore_search`): contracts package
  `d8f85d91-7dec-4fd1-8055-483b77225d8b` ("Proactive Publication - Contracts"), resource
  `fac950c0-00d5-4ec1-a4d3-9cbebf98a305` ("Contracts over $10,000", 1,313,313 rows, has
  `reporting_period`); grants package `432527ab-7aac-45b5-81d6-7597107a7013` ("Proactive Disclosure -
  Grants and Contributions"), resource `1d15a62f-5656-49ad-8c88-f40ce689d831` (1,327,356 rows, no
  `reporting_period`). Every importer fingerprint field is present in both. Pass the IDs explicitly
  (`--contracts-package … --contracts-resource … --grants-package … --grants-resource …`).
- **Paging is blocked by robots.txt:** it disallows `/*?sort*` and `/*&sort*`, and `new-rows` and
  `lookup` page with `sort`. The client stops ("Request blocked by robots policy") and must not be
  made to page without a stable order or to hide the parameter. To find rows newer than a local
  file, re-download the dated CSVs and compare row fingerprints instead.

## Resource confirmation and polite access

On each run, the client reads robots.txt, applies the most specific matching agent
group and longest allow/disallow path rule, and checks the terms URL. The operator
must have read the site's current terms before using `--terms-reviewed`. This flag
does not override robots, access controls, challenges or licence restrictions.
No terms or access permission could be confirmed in this implementation session:
the initial robots.txt request returned 403 and all subsequent site requests stopped.

Package discovery uses a bounded `package_search` by dataset title (or the supplied
package ID/slug), followed by `package_show`. Active datastore resources must belong
to that package, whose title must match the requested publication. A zero-row
`datastore_search` confirms actual field names, `_id`, total, and every importer
fingerprint field. Multiple eligible resources require an explicit resource ID;
missing fields fail closed. The owner-supplied contracts resource UUID is **not**
hardcoded or treated as confirmed. Metadata in successful reports records the
confirmed IDs and fields and how they were checked.

Every HTTP request, including robots, terms and retries, is serialized and spaced
at least 20 seconds apart. A longer robots crawl-delay/request-rate takes precedence.
Transient network/500/502/503/504 errors get at most three attempts with exponential
backoff and Retry-After support. 401/403/429, a challenge, redirects, malformed
JSON/JSONP, or inaccessible policy pages stop the client. No challenge bypass,
browser impersonation, login, API key, paid service, SQL or write action is used.
The descriptive User-Agent is `CANDEF-GovDiscovery/1.0` with its research purpose.

Each CLI dataset gets at most 50 pages by default (configurable downward), 1,000
rows per page; a client run has an absolute 100-page cap, including repeat calls.
Metadata probes return zero rows and are limited to eight resource candidates per
package. Pages sort by `_id`, with a period prefix for new-rows, and use offsets
and the API `total`. Changed totals, repeated IDs, missing selected cells and empty
premature pages fail. Offset scans are not transactional snapshots: a constant
total cannot rule out concurrent replacement/deletion. Rerun against a stable API
and reconcile with a later dated file. The client also exposes exact scalar/list
field filters; filters do not normalize a remote text column.

## Period discovery and lookup limits

`new-rows` streams the local CSV without loading it whole and computes the newest
recognized fiscal period (`YYYY-YYYY-Qn`, consecutive years). The cutoff is the
later of that period and `--since`; a lower `--since` cannot move it behind the
local maximum. Blank and unparseable local periods are counted, never repaired.
They make `localPeriodsComplete` and overall `complete` false, even if
`apiScanComplete` is true. A CSV without a period column or any valid periods is
unsupported. The cached grants CSV has no reporting_period, so its period mode
is explicitly unsupported; agreement/amendment dates are never substituted.

The API is read in descending period order and stops at the first page reaching
the cutoff. Counts group by department and period; leads contain only those keys
and the existing versioned row locator. Invalid API periods fail closed. This
mode cannot detect corrections, delayed publications in older periods, or rows
added to the local newest period. It is period discovery, not a change feed.

Lookup must scan API pages before applying the shared normalizer: CKAN exact raw
field filters cannot guarantee all normalized-name variants or BN account suffix
variants. A bounded full scan avoids falsely reporting an exact raw spelling as a
complete normalized lookup. When capped, **every match count is a lower bound**
and `complete=false`; do not interpret zero as no matches. This can take over half
an hour at the absolute cap. A future server-supported normalization index could
improve this; this helper makes no unsupported filtering promises.

Only candidate locators are retained; the local CSV is then streamed once, keeping
only a set of candidate fingerprints seen locally. `alreadyInLocal` counts API
row occurrences whose full versioned locator is present locally, including all
source cells in its fingerprint. `notInLocal` contains unmatched API locators;
duplicate API rows remain separate occurrences, not new agreements. An invalid BN
is diagnostic, never repaired into a match. No domain records are created.

## Fingerprint and privacy boundaries

CSV and API paths reuse `toContractRow`, `toGrantRow`, `rowLocator`, and the importer's
own `sourceCells` allowlist. Contact and other unknown columns are never selected,
hashed or emitted. Lookups do not emit raw rows, query names/BNs, descriptions,
postal codes or API response bodies; existing locators include the allowlisted
vendor/recipient legal name and identifiers by design. Output stays ignored.

`row_sha256` hashes the importer's raw allowlisted cells, not the API `_id` or CSV
column order. CSV whitespace, decimal spelling and date formatting matter. JSON
nulls become empty cells and scalar values become strings; unsafe integer cells
and object cells fail. API numeric/date coercion can destroy source-cell spelling.
Reports list non-text API fingerprint fields. Hash equality is useful for discovery
reconciliation; a mismatch is only a lead, not proof a row is newly published.
Never treat an API hash as a fingerprint of a downloaded evidence file.

## Verification

Unit tests use only fictional fixtures and injected HTTP/search clients, with no
network. The owner-only smoke script fetches metadata and zero rows:

```powershell
$env:CANDEF_LIVE_API = '1'
npx.cmd tsx pipeline/ingest/gov/api/live-smoke.ts --terms-reviewed
Remove-Item Env:CANDEF_LIVE_API
```

Without the flag the smoke script skips; with `CI` set it refuses live access.
The implementation agent did not run it live. Stop on refusal and resolve access
with the data publisher; do not try another route around the refusal.
