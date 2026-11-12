# Research protocol: researching one company for the pilot

**Who this is for:** any researcher, whether the owner, a Claude session or a supervised subagent, adding a real company to `research/`. Follow it step by step. The tooling (`npm run candef -- …`, see `research/README.md`) enforces much of it. The rest is judgement, and the owner's review is the final check.

**Status:** M3 tooling exists. **Pilot research starts only after the owner reviews the M0.5 records** (`docs/DECISION_QUEUE.md` Q1) and approves a taxonomy (Q2).

## Non-negotiables (CLAUDE.md)

- **No invented data.** Missing means "not found", "undisclosed" or "not researched", never a guess.
- **Cite only what you actually read.** Search results, snippets and AI summaries (including the external research reports) are discovery, not evidence. Open the page; cite the page.
- **Everything you write is `proposed`.** Never write `verification: verified` or a `review` block. Never run `candef review`.
- **No excerpts in Git.** Locators point to where the fact is ("para 3", "row ref_number=…"); the text stays in the source or in `research-cache/`.
- **People:** professional role facts only (name, title, organization, dates), from first-party or filing sources. No contact details: the `no-contact-data` gate fails the build on any email, phone or fax.
- **Weapons programs:** in scope since 2026-10-16 (P-15 dropped). Describe what a product does only from publicly documented, cited sources; never write build or use instructions.

## Order of work (F-33)

**identity → headquarters → eligibility → everything else.** If the company turns out to be ineligible, record the decision and the ledger entry, then **stop**: excluded companies are not researched further.

### 1. Identity

- `candef new company "<operating name>"` refuses near-duplicates. If it reports a clash, check whether it really is the same entity.
- **Facts to record:**
  - `legal_name`: from a registry (T1) or the company itself (T2);
  - `registry_id`:
    - `{ system: corporations-canada, value }` for the federal corporation number;
    - `{ system: cra-bn, value }` for the business number, **only if it is shown in a public source you read**;
  - `founded_year`, `website`.
- **Renames:** add a new `legal_name` with `supersedes: <old id>`. Never edit an approved value in place.

### 2. Headquarters

- **Rule:** city-level HQ needs first-party or filing evidence; a registry's registered office alone only supports the province.
- **When sources disagree:** record each value with its source. The compiler will show "Sources disagree".
- **Postal code:** if the company publishes it, add `postalCode` inside `hq_location`. The government importer uses it as a second identifier.

### 3. Eligibility (analyst interpretation)

Record an `eligibility` fact with `epistemic: analyst_interpretation`:

```yaml
- predicate: eligibility
  epistemic: analyst_interpretation
  value:
    decision: included # included | excluded | pending | ambiguous
    rationale: "<dual-use rationale citing the evidence: a documented defence/security customer, program or product>"
    segments: [tax:…] # once the taxonomy is approved
    exclusion_check: { weapons_primary: false, notes: "" }
    entity_boundary: "assessed on its own; parent not inherited"
    reassess_by: "2027-10"
  src: ["<source>#<locator>"]
```

- **Classification (`classified_as`) must name a node in the approved `research/taxonomy.yaml`.** The taxonomy was approved for the pilot on 2026-10-13 (P-24); IDs never change once published. The `dangling-taxonomy` gate fails the build on unknown IDs. A justified secondary classification is a second `classified_as` with `primary: false`; mark the main one `primary: true`.
- **An `included` decision needs a real rationale** (at least a sentence citing the evidence). The `eligibility-rationale` gate fails the build otherwise.
- **Segment fit alone is not enough.** "Could be used by the military" is speculative, so the company is excluded (P-12).
- **Environmental monitoring** qualifies only with documented security, defence or sovereignty use.
- **Foreign-owned Canadian HQ:** include it, labelled (P-13). **Foreign HQ:** contextual only (P-17).

### 4. Financing

- **One round = one record.** Successive closes and extensions are `disclosures` of that round, never new rounds. The quality check flags likely duplicates.
- **Disclosures:**
  - `amountBasis`: `cumulative_round_total` or `incremental`, as the source states it; otherwise `unknown`;
  - **currency as stated;** if the source says "$" with no currency, record `currency: unknown`. Currency alternates from a second source (F-02) are not implemented yet, so note the other source's currency in the ledger entry instead;
  - an undisclosed amount is `{ amount: null, disclosure: undisclosed }`, never 0.
- **Participants:**
  - `investorId` is the **firm** (the economic investor); `vehicleId` is the named fund;
  - record "and others" as `participantsCompleteness: partial_named`, never as an invented investor.
- **Exclusions:**
  - anonymous-source amounts or valuations are never publishable (P-18);
  - valuations are not estimated.
- **Company-stated cumulative totals** ("raised $40M to date") use the `total_raised_as_stated` predicate, with a value like `{ money: {…}, qualifier: "more than", since: "2016" }`. They are never summed with rounds, and the compiler ignores them in totals.

### 5. Government relationships

- **Prefer the bulk-disclosure route** (`research/README.md` → Government disclosures):
  - first register identifiers;
  - then `gov-index`, the importer, read the match report, and `gov-accept`.
- **Ambiguous rows are never imported automatically.** Resolve them by hand: open the row, check the vendor name **and** the address or BN.
- **Grants are not purchases.** A grant or contribution is never recorded as procurement (P-16).
- **Consortium awards:** the member's share is undisclosed unless an allocation is published.
- **Announcement-only relationships** (a press release naming a department) are `named_in_description` unless the source is a party of record; they draw no relationship line.

### 6. Ledger: every topic, every time

After each topic, record what you searched, even when you found nothing:

```
candef ledger <slug> financing none_found --searched "company site; BetaKit; The Logic" --next 2027-04
```

- **Without a ledger entry,** a topic shows as "Not yet researched".
- **With `none_found`,** it shows as "Not found in reviewed sources, as of <date>".
- **Use `partial`** when you stopped early.

### 7. Hand over

1. Run `candef validate`. Fix every load error and gate; read each quality flag.
2. Run `candef report` and give the owner the HTML path.
3. Note the **time spent per company** in the handoff. The pilot size and the D-03 triggers depend on measured time.

## Source tiers (quick reference)

| Tier | Examples                                                                  | Alone sufficient for                                          |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| T1   | Government datasets and registries, filings (SEDAR+, Corporations Canada) | identity, government relationships                            |
| T2   | The company's or investor's own release or page                           | its own rounds, HQ city, products                             |
| T3   | Independent reporting (BetaKit, The Logic, Globe and Mail)                | gaps a T2 source leaves (e.g. currency), at medium confidence |
| T4   | Other (blogs, aggregators)                                                | never alone                                                   |

**Corroboration counts distinct origin groups.** Three articles rewriting one press release are one origin.
