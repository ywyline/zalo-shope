# Project Audit And Recovered Baseline

> Audit date: 2026-08-01
>
> Repository baseline: `main` / `origin/main` at `978446d`, plus preserved uncommitted M6.3-B5/B6 work
>
> Package version: `0.1.0`
>
> Estimated completion: approximately 60%
>
> Production readiness: Not Ready

## 1. Audit Scope And Method

The audit used `REQUIREMENTS.md` V2.1, `AGENTS.md`, the complete repository file tree, application/package manifests, API controllers and services, Prisma schema and 52 migration stages, worker/provider registration, frontend routes and views, 37 integration suites, 18 browser E2E cases, architecture/API/database/security/testing documents, the dirty worktree and all 39 available Git commits.

The repository contains 581 files, including 291 TypeScript files, 17 TSX files, 107 SQL files and 97 Markdown files. Prisma currently defines 121 models and 80 enums. No skipped/only tests and no `TODO`, `FIXME`, `HACK` or `XXX` source markers were found.

Status was recovered from executable behavior and test coverage first. Plans and reports were used as supporting evidence only. A repository/local-test capability is not treated as production acceptance.

## 2. Requirements Consistency

| Requirement Area                                   | Actual Code State                                                                                                   | Consistency                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| One codebase, two independently configured stores  | Store context, compound keys, FORCE RLS, RBAC, store-scoped caches/messages/tests exist across implemented domains. | Implemented and consistent for delivered modules.                                                       |
| Vietnamese default plus Chinese/English; VND       | Shared i18n/localization packages, three-language catalog/commerce UI and integer VND domain rules exist.           | Implemented in delivered screens; missing future screens remain a P0 gap.                               |
| Brands/categories/SPU/SKU/media/compliance/content | Database, APIs, admin workbenches, buyer catalog and import/export exist.                                           | Implemented. Production object storage/compliance acceptance remains blocked.                           |
| Search/filter/cart/pricing/inventory               | Real services, concurrency controls, trusted server pricing and UI exist.                                           | Implemented.                                                                                            |
| Address/checkout/COD/order                         | Encrypted address, server quote, reservation/order transactions, snapshots, transitions and buyer/admin UI exist.   | Implemented; authoritative geography data remains blocked.                                              |
| Online payment/refund/GHN                          | Core, adapters, callbacks, outbox/inbox, workers and admin recovery exist.                                          | Partially implemented. Buyer checkout still disables ONLINE and real sandbox evidence is absent.        |
| Basic after-sales                                  | Policies, cases, evidence, reads and B3-B6 repository commands exist.                                               | Partially implemented. COD settlement, inspection, inventory restore, exchange and full UI are missing. |
| Member favorites/history/privacy                   | M6.2 data foundation exists; search-query history predates it.                                                      | Data foundation only; product runtime and UI are missing.                                               |
| Deep Link/official share/OA                        | Share-link data foundation exists.                                                                                  | Runtime/UI and official host acceptance are missing; OA is P1.                                          |
| PC admin                                           | Catalog, content, inventory, promotions, orders/shipping, RBAC and audit workbenches exist.                         | Partially implemented; after-sales, member, finance/report/compliance operations remain incomplete.     |
| Reports/compliance pages/operations                | Readiness and sign-off templates exist.                                                                             | Product/report/deployment capabilities and actual evidence are missing.                                 |
| Zalo official device/review acceptance             | iPhone beauty-store login/phone success path has partial evidence.                                                  | Incomplete and externally blocked.                                                                      |

No implemented code was found that changes the required self-operated multi-brand retail model into a third-party marketplace. No duplicated beauty/fashion business codebase was found.

## 3. Recovered Delivery State

### Done

- M0 repository and infrastructure foundation.
- M1 store/RLS identity, RBAC/MFA, consent, audit, i18n and localization foundation.
- M2 catalog, media/compliance, content decoration, buyer catalog and restricted operations tooling.
- M3 inventory/reservations, search/facets, promotions/coupons, trusted pricing and member cart.
- M4 addresses, COD checkout/orders, snapshots, inventory coordination and transaction UI/workbench.
- M5.1-M5.4 contracts, database, reliable messaging and restricted online payment core.
- M5.5-M5.7 ZaloPay/GHN/refund repository adapters, workers and admin recovery within local/test boundaries.
- M6.1/M6.2 contracts and data foundation.
- M6.3-A/B0/B1/B2a and evidence D0-D5 repository/local-test scopes.
- M6.3-B3/B4/B5 repository/local-test command slices.

### In Progress

- Enterprise workflow migration (`TASKS.md`, `CHANGELOG.md`, upgraded `AGENTS.md` and this baseline).
- M6.3-B6 ONLINE after-sale refund coordination: code and focused/full integration validation are complete; independent completion evidence and final repository gates are being closed.
- Overall M5 production acceptance remains partially implemented but externally gated.
- Overall M6.3/M6 remains open because B7, fulfillment, member/share runtime, UI and production enablement are not complete.

### Todo

- Buyer ONLINE payment launch/retry/recovery UI.
- B7 COD refund settlement and reconciliation.
- Return inspection, exactly-once inventory restore and exchange fulfillment.
- Favorites, browsing history, privacy request runtime/UI.
- Deep Links, official share, share cards/fallback pages.
- Full buyer/admin after-sales and member UX.
- Reports, finance/COD reconciliation, public compliance pages.
- Observability, deployment, rollback, backup/restore and incident/provider outage drills.
- P1 and P2 requirement scopes.

## 4. Known Bugs And Defects

### Open

- No currently reproducible code defect was found by the available automated suites. This does not imply absence of defects in unimplemented or externally untested flows.
- Buyer checkout presents ONLINE as unavailable even though the server core exists. This is tracked as the explicit product gap `P0-M5-002`, not represented as a completed payment flow.
- Three moderate production dependency advisories affect React Router 6.30.4: `GHSA-wrjc-x8rr-h8h6`, `GHSA-jjmj-jmhj-qwj2` and `GHSA-337j-9hxr-rhxg`. There are zero high/critical audit findings.

### Fixed During Audit

- `tests/integration/m63b2b-d2-evidence-scanner-worker.test.ts` could claim a deliberately delayed rescan outbox only once, returning no message and leaking it into the next case. Empty-message claiming now polls for at most one second while actual errors still fail immediately. The repaired suite passed 20/20 and the full integration suite passed 330/330.
- M6.3 documentation referenced a missing B6 completion report. The current closeout task owns creation and final evidence synchronization.

## 5. Technical Debt

- The root package version remains `0.1.0` despite many milestones; release/version policy has not yet been defined.
- Historical status is duplicated across a large README, plans and reports. From this baseline onward `TASKS.md` is authoritative; old documents remain evidence and must not be independently treated as current task state.
- M5.5-M5.7 are named progress reports even though repository automation is closed; external acceptance must stay separate to avoid ambiguous completion claims.
- OpenAPI documents are structurally exercised but the repository has no dedicated OpenAPI 3.1 semantic linter.
- Full ESLint has previously required a temporary 4 GiB Node heap on this workstation; the command/runtime budget is not codified.
- Production media/evidence storage semantics for versioning/Object Lock/lifecycle and stable missing-object errors are unvalidated.
- Production policy/TTL/quota values and legal retention decisions are intentionally absent.
- The UI surface substantially trails backend capability for online payment, after-sales, member privacy and reporting.

## 6. External Dependencies And Blockers

| Dependency                  | Current State   | Needed Evidence                                                                                                |
| --------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| Zalo host and review        | Partial/Blocked | Both stores, Android/iPhone, three languages, denial/replay/network matrix, Testing/review evidence.           |
| Zalo Checkout/ZaloPay       | Blocked/Not Run | Independent store sandbox merchants, secret references, callback/query/refund and settlement evidence.         |
| GHN                         | Blocked/Not Run | Independent store ShopId/Token, warehouse/orders, quote/create/cancel/track/label/COD and remittance evidence. |
| Network ingress             | Blocked         | HTTPS callback domain, TLS, trusted proxies and replay/IP policy.                                              |
| Cloud storage/CDN           | Not Run         | Production-like S3/CDN/IAM/KMS/versioning/Object Lock/lifecycle and evidence retention.                        |
| Vietnam address master data | Blocked         | Authoritative licensed province/district/ward source and update policy.                                        |
| Legal/tax/privacy/industry  | Blocked         | Vietnam professional review and signatures for both stores and regulated categories.                           |
| Production operations       | Not Run         | Topology, secret manager, deployment ownership, monitoring/alerts, backup/restore and rollback.                |
| Performance                 | Not Run         | Approved staging scale, SLO/traffic/stop conditions, Vietnam 4G and sign-off owners.                           |

## 7. P0 Production Risks

1. The buyer cannot complete the required online-payment journey from checkout.
2. Real payment, refund, logistics, callback, settlement and COD remittance behavior has not been accepted.
3. Basic after-sales is not end to end: COD refunds, inspection, stock restore, exchanges and UI are missing.
4. Reports, public compliance pages and professional approvals are incomplete.
5. Production deployment, observability, backup/restore and incident recovery are unproven.
6. Zalo Android/fashion-store/full error-path acceptance and official review are incomplete.
7. Moderate React Router advisories remain unresolved pending ZMP compatibility work.

Any one of these prevents a Production Ready declaration.

## 8. Verification Evidence

| Check                              | Result                                      |
| ---------------------------------- | ------------------------------------------- |
| Repository typecheck               | Passed before baseline migration.           |
| B6 focused unit tests              | 6 files, 136/136 passed.                    |
| B6 database/API integration        | 2 files, 35/35 passed.                      |
| D2 repaired integration suite      | 20/20 passed.                               |
| Full infrastructure integration    | 37 files, 330/330 passed in 232.02 seconds. |
| Skipped/only tests                 | None found.                                 |
| Source TODO/FIXME/HACK/XXX markers | None found.                                 |
| Production dependency audit        | 3 moderate, 0 high, 0 critical.             |

Final static/build/migration/security gates for the uncommitted B6 slice are owned by `P0-M6-006` and must be recorded before it moves to `Done`.

## 9. Baseline Decision

The recovered project baseline is accepted at approximately 60% requirement completion and not production ready. Existing completed code must not be reimplemented. Future work selection and status changes occur only through incremental edits to `TASKS.md`; each completed task must update `CHANGELOG.md` and its evidence in the same development cycle.
