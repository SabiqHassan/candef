# CANDEF

A research and market-mapping tool for **Canadian-headquartered companies in defence, security, space and dual-use technology**, built for investors and analysts.

**Live site:** https://sabiqhassan.github.io/candef/

## What it does

- **Explorer.** An interactive map of companies with Capital, Government and Industry lenses, a 2D and 3D view, a list view, and company dossiers. Every published fact links to a source.
- **Leads search.** A search over about 271,000 companies in Canadian federal grants and contracts data, narrowed to the ~8,500 with a defence, security or space link. Results are labelled as **unverified leads from public government data**.
- **Ask in plain language.** A question box on the Leads page ("Show me first-time grant recipients for drone companies in 2026"). A model turns the question into filters and answers from the search results only. On the live site you paste **your own Anthropic API key**. It is sent only to api.anthropic.com from your browser, kept in memory and cleared on reload.

## How the data is made

Nothing is published until a person has approved it.

1. Research is drafted as proposed records, each with a source and a locator for every claim.
2. Independent researchers check each company blind, without seeing the drafted record.
3. A clearance policy compares the checks and sends only exceptions to the owner. The owner approves or rejects in a review queue, and a rejection needs a written reason.
4. The build publishes approved records only. A company with no approved identity does not appear.

The research records and review history are kept in a private repository. This repository holds the application, the data pipeline and the tests. The live site includes the approved data.

## Stack

React 19, Vite and TypeScript (strict), Three.js for the 3D view, Zod schemas as the source of truth for data shape, Vitest for unit tests and Playwright for end-to-end and accessibility tests.

## Run it locally

```
npm ci
npm run dev        # the app on the fictional demo dataset
npm test           # unit tests
npm run build      # demo build
```

The demo dataset is fictional. No company in it is real.

## Layout

```
src/        the app; src/graph/engine is the Three.js engine (no React); src/domain/schema holds the schemas
pipeline/   data compiler and publishing gates, research tooling, government-data importers, lead search
tests/      Playwright end-to-end, performance and scale tests
bench/      renderer benchmark and synthetic stress tools
scripts/    research and build scripts
```

**Corrections and takedowns:** sabiqhassan1234@gmail.com
