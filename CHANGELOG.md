# Changelog

This file records completed repository changes. Each entry uses `Date`, `Added`, `Changed`, `Fixed`, `Removed` and `Docs`. Task status and future work belong only in `TASKS.md`.

## 2026-08-01 - P0-M5-005 Financial Reconciliation Closeout Slice C (`0.1.0`)

### Added

- Store-isolated, immutable maker-checker review records for accepting or escalating exceptional reconciliation batches without mutating payment, refund, order, inventory, shipment or cash facts.
- An audited closeout API with direct-store permission, recent MFA, importer/reviewer separation, idempotent replay, conflicting-key rejection and concurrent single-winner behavior.
- Three-language review filters, exception summaries, closeout form/results and responsive administrator layouts.

### Changed

- Batch list, detail and import responses now expose review status, immutable exception summaries and an optional closeout result.
- Completed the repository/local-test P0-M5-005 Description across payment settlements, fees, refund differences, COD receivables, normalized GHN remittance and independent variance review.

### Fixed

- Applied `review_status` to both cursor validation and the actual batch query so `OPEN`, `CLOSED_ACCEPTED` and `CLOSED_ESCALATED` pages cannot contain rows from another review state.
- Revalidated direct-store authorization after the batch review lock wait and kept database maker-checker, RLS, append-only and rollback guards authoritative under races or direct writes.
- Corrected the README control summary and Task Tree main-sync evidence after Slice C integration so current documentation no longer reports the historical Slice A-only state.

### Removed

- None.

### Docs

- Added the P0-M5-005 completion report and synchronized M5 OpenAPI, architecture, data dictionary, permission matrix, implementation plan and README.
- Verified full format/lint/typecheck/build/schema gates, 633/633 unit tests, 351/351 integration tests, 26/26 Chromium/WebKit E2E tests and the 55-migration M2 upgrade/down/forward exercise. Production dependency audit remains 3 moderate and 0 high/critical advisories; OpenAPI 3.1.0 strict YAML and 302 local references passed with no external or missing references.
- P0-M5-005 is repository/local-test complete only. Real ZaloPay/GHN sandbox channels, funds, Zalo host validation, deployment and production rollout remain `BLOCKED/NOT_RUN`; the project is not Production Ready.

## 2026-08-01 - P0-M5-005 COD Reconciliation Slice B (`0.1.0`)

### Added

- Store-isolated COD receivable projections and normalized GHN remittance imports with integer-VND gross, fee, net and difference facts.
- Shipping-channel reconciliation batches and shipment-linked lines covering matched, amount/fee mismatch, missing reference/fee, non-final, non-receivable and duplicate-reference outcomes.
- Three-language administrator COD receivable, source filtering and GHN import workflows with responsive loading, empty, error and success states.

### Changed

- Generalized append-only reconciliation batches to bind exactly one payment or shipping channel while preserving the Slice A payment/refund contract.
- Extended filtered COD pagination to scan before slicing and require every cursor to remain inside the target store's delivered GHN COD scope.

### Fixed

- Prevented a GHN shipment reference repeated in the same or a later batch from being counted or linked as a second remittance.
- Made quote and prior-line selection deterministic, aligned string digesting with Slice A and cleared stale batch detail immediately when an administrator changes stores.
- Removed two lint failures found by the final repository gate without weakening runtime response validation.

### Removed

- None.

### Docs

- Synchronized M5 OpenAPI, data dictionary, permission matrix, architecture, implementation plan and README with the COD/GHN repository boundary.
- Verified full format/lint/typecheck/build/schema gates, 631/631 unit tests, 348/348 integration tests, 26/26 Chromium/WebKit E2E tests and the 54-migration M2 upgrade/down/forward exercise. Production dependency audit remains 3 moderate and 0 high/critical advisories; OpenAPI strict YAML and 285 local references passed with no external or missing references.
- Slice B is repository/local-test validated only. Real GHN formats, sandbox/production channels, funds, deployment and rollout remain `BLOCKED/NOT_RUN`; maker-checker Slice C remains incomplete and `P0-M5-005` stays `In Progress`.

## 2026-08-01 - P0-M5-005 Payment And Refund Reconciliation Slice A (`0.1.0`)

### Added

- Store-isolated, append-only payment/refund reconciliation batches and lines with integer-VND summaries, redacted references, deferred aggregate/channel guards and FORCE RLS.
- Audited administrator import plus filtered cursor list/detail APIs protected by direct-store RBAC, recent MFA, confirmation and idempotency.
- Vietnamese, Chinese and English financial reconciliation workbench with responsive list, detail, filters, normalized import and loading/empty/error/success states.

### Changed

- Registered `store.finance.read` and `store.finance.reconcile` without granting production roles; local/test seed grants remain explicit.
- Extended the M2-to-current migration exercise to cover the 53-migration tail, empty-fact rollback, forward restoration, RLS, triggers and runtime grants.

### Fixed

- Made batch and line creation compatible with Prisma composite relations while preserving one Serializable atomic transaction.
- Revalidated direct-store authorization before replay/write after the advisory-lock wait and prevented deferred or later line inserts from invalidating immutable batch summaries or channel ownership.
- Removed phantom final-page cursors by reading one extra ordered row; added duplicate-free filtered pagination coverage.

### Removed

- None.

### Docs

- Added the P0-M5-005 implementation plan and synchronized M5 OpenAPI, data dictionary, permission matrix, architecture and README boundaries.
- Verified full format/lint/typecheck/build/schema gates, 630/630 unit tests, 346/346 integration tests, 26/26 browser E2E tests and the 53-migration M2 upgrade/down/forward exercise. Production dependency audit remains 3 moderate and 0 high/critical advisories.
- Slice A is repository/local-test validated only. COD/GHN remittance, maker-checker closeout, real provider/sandbox/funds, deployment and production rollout remain incomplete or `BLOCKED/NOT_RUN`; `P0-M5-005` stays `In Progress`.

## 2026-08-01 - Commit-Level Merge Gate Clarification (`0.1.0`)

### Added

- Explicit commit-level Merge Gate criteria and feature-branch synchronization rules.

### Changed

- Independently verified commits may synchronize to `main` while their Task remains `In Progress`.
- Unrelated blocked tasks no longer prevent a verified commit from synchronizing to `main`.

### Fixed

- Removed the workflow contradiction that required all project blockers to close before any independent commit could reach the integration branch.

### Removed

- None.

### Docs

- Clarified task status transitions, phase-commit evidence, rollback scope and post-merge branch synchronization in `AGENTS.md`.
- No business code, requirements or Task Tree changes were made.

## 2026-08-01 - Task Tree Recovery (`0.1.0`)

### Added

- An explicit eligible queue that separates immediately executable implementation slices from external acceptance gates.

### Changed

- Rebased P0, P1 and P2 task dependencies on the completed domain foundations each slice actually consumes.
- Selected `P0-M5-005` as Current Task and `P0-M6-007` as Next Task while preserving every existing task ID and the approximately 64% weighted progress estimate.
- Classified Zalo OA/share attribution and Vietnam accounting integration as genuinely externally blocked instead of leaving them as misleading Todo nodes.

### Fixed

- Removed the dependency pattern that made all P1/P2 work wait for `P0-M7-006` and made unrelated P0 implementation wait for provider, legal or production acceptance.
- Restored a non-empty, priority-ordered development path without changing product scope, business rules or delivered capability.

### Removed

- None.

### Docs

- Updated `TASKS.md` control state, dependencies, blocked-task list, eligible queue and unchanged project-progress evidence.
- No business code, `AGENTS.md` or `REQUIREMENTS.md` changes were made.

## 2026-08-01 - End Of Development Gate (`0.1.0`)

### Added

- P0-WF-002 governance gate for task completion, affected-module verification, task-branch commits and conditional `main` synchronization.

### Changed

- `main` is now the integration branch; feature/fix branches are required for task work.
- A tested completed task must update `TASKS.md` and `CHANGELOG.md`, create a task-scoped commit, and synchronize to `main` only when no `Blocked` item remains.

### Fixed

- Closed the workflow gap where completed tasks could be marked Done without a documented commit or explicit main-branch gate.

### Removed

- None.

### Docs

- Added the End of Development Gate and branch synchronization rules to `AGENTS.md` and `TASKS.md`.

## 2026-08-01 - Member Engagement And Privacy Runtime (`0.1.0`)

### Added

- Store/member-scoped favorites, per-product favorite status, recent product history, commerce summary, latest consent projection and encrypted privacy request runtime.
- Three-language Mini App member center, favorites, product history, consent withdrawal and privacy intake/list/cancel pages with mobile loading, empty, error, success and confirmation states.
- HMAC opaque cursors, member read/write rate limits and real PostgreSQL/RLS/Redis plus Android Chromium/iPhone WebKit regression coverage.

### Changed

- Product details now read exact favorite status and record authenticated product history after successful rendering.
- Favorite, history and privacy pages consume server cursors; unavailable products remain removable but no longer expose a false navigation link.

### Fixed

- Prevented internal privacy-request UUID disclosure in cancellation responses.
- Prevented client-provided privacy cancellation text from being stored in the plaintext transition reason field; member cancellations now persist a canonical non-sensitive reason while retaining request-hash idempotency.
- Replaced a runtime-role-inaccessible privacy row lock with a store/member/request advisory lock while preserving replay and conflict guarantees.
- Closed the false-negative favorite state for members whose target product falls after the first 100 favorites.

### Removed

- None.

### Docs

- Added the P0-M6-009 plan and completion report; synchronized M6 OpenAPI, README, Task Tree and three-language messages.
- Git Recovery reconciled this completed task to the task-scoped commit `feat(P0-M6-009): member privacy and engagement runtime`; format, lint, typecheck, 627 unit tests, 337 integration tests, build, schema validation, 25 browser E2E tests and staged-diff verification passed.
- Recorded the approximately 64% engineering estimate and activated the Stop Protocol because no remaining P0 task has all dependencies satisfied.

## 2026-08-01 - Buyer Online Payment Experience (`0.1.0`)

### Added

- Mini App ONLINE checkout selection, explicit Zalo Checkout launch, server-authoritative status recovery, failed-attempt retry and order-detail resume entry.
- Three-language mobile payment states and a localhost-only injected Checkout bridge for deterministic Chromium/WebKit testing.
- Payment runtime, API isolation and browser regression coverage for provider-order binding, uncertain outcomes and recovery.

### Changed

- Buyer order details now expose the latest optional `payment_attempt_id`; payment details expose `provider_order_bound` so the client can fail closed after binding.
- ONLINE pending orders can use the existing atomic member cancellation path while COD behavior remains unchanged.

### Fixed

- Closed the buyer-facing gap between the existing M5 online-payment core and Mini App checkout without trusting SDK, `PaymentDone`, `checkTransaction` or client amounts as payment success.
- Invalidated stale checkout quotes whenever address, coupon, cart items or payment method changes.

### Removed

- None.

### Docs

- Added the approved P0-M5-002 plan and completion report; synchronized M4/M5 OpenAPI, README, Task Tree and three-language contracts.
- Kept real Zalo Testing, sandbox, callback, funds and production rollout explicitly blocked or not run.
- Git Recovery reconciled this completed task to the task-scoped commit `feat(P0-M5-002): buyer online payment runtime`; TypeScript, lint, unit, affected integration, build, format and two-device targeted E2E verification passed.

## 2026-08-01 - M6.3-B5 Return Trust Git Recovery (`0.1.0`)

### Added

- Default-disabled member return registration and audited administrator `IN_TRANSIT`/`DELIVERED` fact commands.
- The guarded M6.3-B5 forward migration, return command primitives, API coverage and completion evidence.

### Changed

- Return tracking is persisted only as a keyed HMAC and display mask; current aggregate and inspection-pending state remain read through the existing B1 projection.
- Runtime return-table writes now pass through store/member or direct target-store review authorization, expected versions, idempotency and deferred atomicity guards.

### Fixed

- Recovered the completed B5 snapshot into the task-scoped commit `feat(P0-M6-005): return trust commands` without mixing B6, D2 or P0-M6-009 changes.

### Removed

- None.

### Docs

- Added the approved B5 plan and completion report and synchronized the B5-era README, OpenAPI, architecture, data dictionary, permission matrix and milestone plans.
- Recorded typecheck, lint, unit, affected integration, migration, build, format and staged-diff verification in the Git Recovery ledger.

## 2026-08-01 - M6.3-B6 ONLINE After-Sale Refund Closeout (`0.1.0`)

### Added

- Concurrency regression coverage for shared M5 order-refund lock ordering and permission revocation while a B6 command waits.
- B6 completion evidence for the default-disabled repository/local-test slice.

### Changed

- B6 now acquires the shared M5 order-refund scope before order, successful-payment and after-sale aggregate locks.
- Final authorization is revalidated inside the Serializable write transaction with locked store, administrator, session/MFA, role-assignment and four direct-permission facts.

### Fixed

- Removed the B6 order/after-sale lock inversion window and closed the post-wait RBAC/session authorization race.
- Stabilized an M6.2 evidence lifecycle regression fixture against PostgreSQL sub-millisecond timestamps without weakening database guards.

### Removed

- None.

### Docs

- Added `docs/reports/m6.3-b6-online-refund-completion-report.md` and synchronized architecture, data, permission, plan and Task Tree evidence.
- Recorded that B7 remains dependency-blocked and selected the buyer online-payment experience as the next eligible internal slice.
- Git Recovery reconciled B6 to `feat(P0-M6-006): authoritative online after-sale refunds` after typecheck, lint, unit, affected integration, build, format and staged-diff verification, without mixing D2 or P0-M6-009 changes.

## 2026-08-01 - Recovered Project Baseline (`0.1.0`)

### Added

- Enterprise Task Tree and recovered project audit baseline.
- Uncommitted M6.3-B5 return-trust repository slice and forward migration.
- Uncommitted M6.3-B6 default-disabled ONLINE after-sale refund coordination, including settlement/refund linking and provider-result sync worker.

### Changed

- Project work selection and status now use `TASKS.md` as the single source of truth.
- B6 synchronizes after-sale state from authoritative M5 refund facts while preserving provider-neutral adapters and failure-closed production defaults.

### Fixed

- Stabilized the D2 evidence scanner rescan integration test by bounded polling for its intentionally delayed outbox message; full integration passed 330/330 afterward.
- Git Recovery reconciled the stabilization to `fix(P0-M6-002): stabilize evidence rescan polling`; the D2 suite passed 20/20 and the current full integration suite passed 337/337.

### Removed

- None.

### Docs

- Added `TASKS.md`, this changelog and `docs/reports/project-baseline-2026-08-01.md`.
- Recovered current completion, blockers, P0 risks and external dependencies from code, tests and Git history.
- Upgraded `AGENTS.md` with the continuous AI development workflow.
- Git Recovery reconciled the previously untracked audit artifact to `docs(P0-WF-001): recover project baseline report` without changing its historical snapshot.

## 2026-07-31 - M6.3 After-Sale Commands (`3f64086..978446d`)

### Added

- B3 member application/cancellation and merchant-initiated refund request commands.
- B4 administrator review, manual-review resolution and return-expiration worker.
- Protected evidence read completion at B2b-D5.

### Changed

- Tightened after-sale command idempotency, authorization revalidation, maker-checker and state-transition boundaries.

### Fixed

- No standalone fix commit; fixes were included in the B3/B4 feature closeouts.

### Removed

- None.

### Docs

- Added B3/B4 plans and completion reports and synchronized M6 architecture, API, database and permission documents.

## 2026-07-28 to 2026-07-30 - M6 Foundation And Evidence Lifecycle (`42c3b13..e9eec8f`)

### Added

- M6 after-sales/member/share data and contract foundation.
- M6.3 policy/read runtime, policy control plane and evidence lifecycle D0-D4.
- Dedicated evidence storage, scanner, member HTTP lifecycle and deletion worker with local/test validation.

### Changed

- Extended RLS, permissions, migrations and worker boundaries for store-isolated after-sales evidence.

### Fixed

- No standalone fix commit.

### Removed

- None.

### Docs

- Added M6/M6.3 plans, API contracts, data dictionary, permission matrix and per-slice completion evidence.

## 2026-07-25 to 2026-07-27 - M5 Payment, Shipping And Refund (`7bd7ac5..c55e12e`)

### Added

- Payment/refund/shipping contracts and RLS database foundation.
- Transactional outbox/inbox and reliable workers.
- Restricted ONLINE payment core, Zalo Checkout/ZaloPay adapter and recovery.
- GHN adapter, shipment synchronization, refund automation and admin workbench.

### Changed

- Separated provider facts from order/payment/refund/shipping domain state and enforced independent store channel configuration.

### Fixed

- No standalone fix commit.

### Removed

- None.

### Docs

- Added M5 architecture, contracts, data dictionary, permissions, plans and repository/local-test reports; real sandbox evidence remained explicitly blocked.

## 2026-07-24 - M4 Checkout And COD Orders (`c4ec66f`, `b23663a`)

### Added

- Encrypted Vietnamese addresses, server-owned final quotes and idempotent COD checkout.
- Orders, immutable snapshots, transitions, inventory coordination and buyer/admin transaction views.

### Changed

- Connected trusted pricing, coupons, cart and reservations in the order transaction.

### Fixed

- No standalone fix commit.

### Removed

- None.

### Docs

- Added the M4 implementation plan, API/data/security updates and completion report.

## 2026-07-20 to 2026-07-23 - M3 Commerce And Readiness (`eb1e4c8..ecbf695`)

### Added

- Inventory, warehouse and reservation foundation.
- Multilingual search/facets/history, promotions/coupons, trusted pricing and member cart.
- Concurrency, cross-store security and browser closeout coverage.
- Readiness tools and partial Zalo real-device validation evidence.

### Changed

- CI initializes the test database before integration suites (`31be975`).

### Fixed

- Preserved recoverable Zalo sign-in feedback (`ecbf695`).

### Removed

- None.

### Docs

- Added M3 plans/completion reports and post-M3 readiness evidence matrices.

## 2026-07-17 to 2026-07-20 - M0-M2 Foundation And Catalog (`82e3a64..e790dab`)

### Added

- Requirements baseline and Node/pnpm monorepo foundation.
- Store isolation, identity, RBAC, audit, i18n and Mini App/admin shells.
- Catalog database/APIs, product/content administration, buyer catalog and operations workbench.
- Zalo Open API identity integration, restricted XLSX operations and Chromium/WebKit browser automation.

### Changed

- Established one-codebase/two-store configuration and shared package boundaries.

### Fixed

- No standalone fix commit.

### Removed

- None.

### Docs

- Added architecture, data dictionaries, API contracts, permission matrices, plans and M1/M2 completion reports.
