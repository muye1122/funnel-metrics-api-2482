# Funnel Metrics API

A runnable reference implementation of the lead funnel statistics endpoint: cohort-based
stage reach, adjacent-stage conversion, overall conversion, stage dwell time, churn
distribution and source-channel split.

## Honest scope note

The requested delivery stack for this ticket is **Node.js 22 + Express + an in-memory data
layer + Playwright (Microsoft Edge) + a React 18 / Vite 6 demo**. That is exactly what this
repository contains. The wider project convention describes Python, FastAPI, PostgreSQL and
Redis; that SQL stack is **not** used here, and no PostgreSQL, Redis, external service or
cloud account is required to run or test this delivery.

The requested SQL object `mv_sales_lead_stage_reach` (first-reach timestamp per lead per
stage) is represented by an **in-memory columnar first-reach index** built in
`buildReachView()` and rebuilt by `refreshMaterializedView()`. `mock-server/index.js` runs a
hourly refresh ticker, configurable with `VIEW_REFRESH_INTERVAL_MS`, which is the in-memory
counterpart of a scheduled `REFRESH MATERIALIZED VIEW CONCURRENTLY` task. Reachability is
derived from log rows, so a lead that moves `new -> contacted -> new -> contacted` still
contributes one reach to `contacted`.

All records are deterministic **synthetic / fictional examples** produced by a seeded PRNG.
No real personal data, real company data, client name or secret is present. Configuration is
read from environment variables (`PORT`, `HOST`, `VIEW_REFRESH_INTERVAL_MS`); no third-party
SDK is used, and nothing is sent to an external server.

## Layout

| Path | Purpose |
| --- | --- |
| `server.js` | Express app, endpoint, permission enforcement, static demo hosting |
| `mock-server/metrics.js` | View builder, metric aggregation, fictional data generator, hand-calculated examples |
| `mock-server/index.js` | In-memory dataset, viewer registry, refresh ticker |
| `src/` | React 18 demo console |
| `tests/metrics.test.js` | Node test runner: acceptance criteria, permissions, P95 benchmark |
| `tests/flow.spec.js` | Playwright browser and HTTP flow tests |
| `验证记录.md` | Real command output captured during verification |

## Run

Requires Node.js 22 and a local Microsoft Edge installation. Playwright is pinned to the
`msedge` channel, so no Chromium browser download is needed.

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
npm run build
npm start
```

The API and the built demo are served together at `http://127.0.0.1:3001`.
For the Vite development server with an API proxy:

```bash
npm run dev     # http://127.0.0.1:5173
```

Docker is also available:

```bash
docker compose up --build
```

## Test

```bash
npm test
```

`npm test` runs `npm run test:unit` (7 Node tests) and `npm run test:e2e` (5 Playwright
tests). Use `npm run perf` to run only the P95 benchmark.

## API

```text
GET /api/sales/stats/funnel?site_id=&from=&to=&owner_id=&source_channel=
Header: x-user-id: <viewer id>
```

`from` and `to` accept `YYYY-MM-DD` or an ISO datetime. Date-only bounds are inclusive of
the whole start and end day. `site_id`, `owner_id` and `source_channel` are optional.
`GET /api/health` reports the dataset size and last view refresh time.
`GET /api/sales/stats/funnel/examples` returns the three hand-calculated examples through
the same aggregation code path, which makes them reproducible over HTTP.

Response fields:

- `meta` — resolved bounds, filters, effective owner, cohort size, viewer, refresh time.
- `stages[]` — `stage`, `reached` (distinct leads that ever reached it), `dwellDays.mean`,
  `dwellDays.median` in days rounded to one decimal; `null` when there are no completed
  dwell samples.
- `stageConversionRates[]` — adjacent `from`/`to` pairs with `rate = reached(next) /
  reached(current)`, `null` when the denominator is zero.
- `overallConversionRate` — `reached(signed) / cohortSize`, `null` for an empty cohort.
- `churn` — `lostReasonDistribution` and `lostStageDistribution` for lost leads in the cohort.
- `bySourceChannel[]` — lead count and overall conversion rate per channel.

### Permissions

| Role | Behaviour |
| --- | --- |
| `consultant` | `owner_id` is forced to the viewer; query values are ignored |
| `team_lead` | restricted to the viewer's team |
| `venue_manager` | may query any owner in the venue |

Unknown viewer ids return HTTP 403. Invalid date ranges return HTTP 400.

## Metric definition and three hand-calculated examples

Stages, in order: `new`, `contacted`, `qualified`, `proposal`, `negotiation`, `signed`.
A lead belongs to the cohort when its registration timestamp lies inside `[from, to]` after
all filters and permission scopes are applied. "Ever reached" counts distinct cohort leads
with at least one stage log row for that stage; repeat visits never add to the count. Dwell
samples come only from stage logs with a `leftAt` value, divided by 86,400 and rounded to
one decimal for mean and median.

### Example 1 — regression and a zero denominator

Window 2026-01-01 to 2026-01-31, two leads, both channel `referral`:

- Lead A: new (1d), contacted (2d), new (1d), contacted (1d), qualified (3d), signed (no exit).
- Lead B: new (2d), contacted (1d), then lost with reason `timing`.

| Stage | Ever reached | From previous | Mean dwell | Median dwell |
| --- | --- | --- | --- | --- |
| new | 2 | n/a | 1.3 | 1.0 |
| contacted | 2 | 100% | 1.3 | 1.0 |
| qualified | 1 | 50% | 3.0 | 3.0 |
| proposal | 0 | 0% | n/a | n/a |
| negotiation | 0 | null | n/a | n/a |
| signed | 1 | null | n/a | n/a |

Overall conversion 1/2 = 50%. Churn: `{timing: 1}` and lost at `{contacted: 1}`.
Channel split: `referral` 2 leads, 50%.

### Example 2 — empty later stages

Window 2026-02-01 to 2026-02-28, one lead with a single `new` log and no exit. Cohort 1;
reached `new` 1 and every other stage 0; rates `0%, null, null, null, null`; overall 0%;
all dwell values `null`; churn distributions empty; channel split `referral` 1 lead, 0%.

### Example 3 — channel split and even-sample median

Window 2026-03-01 to 2026-03-31, leads D and E on `referral` both reach `signed`, lead F on
`event` is lost at `qualified`. Reached counts are `3, 3, 3, 2, 2, 2`; adjacent rates are
`100%, 100%, 66.7%, 100%, 100%`; overall 2/3 = 66.7%. New-stage dwell samples are 1, 2 and
3 days, so mean and median are both 2.0. Churn: `{budget: 1}` at `{qualified: 1}`.
Channel split: `event` 1 lead 0%, `referral` 2 leads 100%.

All three examples are encoded in `HAND_CALC_EXAMPLES` in `mock-server/metrics.js` and
asserted with `deepStrictEqual` in `tests/metrics.test.js`.

## Integration points (stubs)

- `sales_lead_stage_logs` is represented by synthetic log objects in
  `generateSyntheticDataset()`. To connect the production table, supply a query adapter that
  returns `{ leads, logs }` with the same field names; `computeFunnel()` needs no change.
- The viewer registry in `mock-server/index.js` is a stub for the platform identity service;
  replace `resolveViewer()` with the real token lookup when integrating.
- Money is not part of this ticket's response; if amounts are added later, store them as
  integer cents as the project convention requires.
