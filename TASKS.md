# Project Task Tree

> Baseline date: 2026-08-01
>
> Project version: `0.1.0` (repository package version)
>
> Project progress: **approximately 64%** of the full `REQUIREMENTS.md` scope
>
> Production readiness: **Not Ready**

## 1. Authority And Maintenance

`TASKS.md` is the single source of truth for project work selection, ordering, dependency and status. `REQUIREMENTS.md` remains the authority for product scope and business rules; `CHANGELOG.md` records completed changes. Plans and completion reports are supporting evidence and must not override task status in this file.

This tree was recovered from `REQUIREMENTS.md` V2.1, the repository at `978446d`, all current tracked and untracked code, migrations, tests, plans, reports and 39 available Git commits. It must be maintained incrementally and must not be regenerated unless `REQUIREMENTS.md` receives an approved scope change.

Allowed status values are `Todo`, `In Progress`, `Done` and `Blocked`. `Done` means the task's explicitly described scope meets its Definition of Done; a default-disabled repository slice may be `Done` while a separate production validation task remains `Blocked`.

## 2. Current Control State

| Field             | Value                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current Sprint    | `S03 - Dependency recovery; execution resumed`                                                                                                                                                                                                                                                         |
| Sprint Goal       | Restore independently executable vertical slices without changing product scope or business rules.                                                                                                                                                                                                     |
| Current Task      | `P0-M5-005` - implement repository/local-test financial reconciliation on the existing provider-neutral facts.                                                                                                                                                                                         |
| Next Task         | `P0-M6-007` - implement COD refund settlement after `P0-M5-005` completes; its implementation prerequisites are already satisfied.                                                                                                                                                                     |
| Production Status | Not Ready; P0 product, external acceptance, compliance and operations gates remain open.                                                                                                                                                                                                               |
| Main Sync         | Not performed: this recovery only updates task management; existing dirty worktree changes remain preserved.                                                                                                                                                                                           |
| Last Verification | 2026-08-01: dependency recovery scan found independent P0/P1/P2 implementation slices; no business code changed. Existing P0-M6-009 hardening evidence remains 337/337 integration, 627/627 unit, 25/25 browser E2E, full verify and security gates; 3 moderate and 0 high/critical advisories remain. |
| Task Counts       | `53` total: `16` Done, `25` Todo, `12` Blocked. Project progress remains approximately `64%`; dependency recovery changes scheduling only, not delivered capability.                                                                                                                                   |
| Eligible Queue    | `17` tasks are currently eligible: `P0-M5-005`, `P0-M6-007`, `P0-M6-008`, `P0-M7-001`, `P0-M7-002`, `P0-M7-003`, `P0-M7-005`, seven P1 implementation slices and three P2 implementation slices.                                                                                                       |

## 3. Progress Baseline

Progress is a recovered engineering estimate, not a release claim. It is weighted by vertical requirement slices rather than task count, commits, files or test volume.

| Workstream                                           |   Weight |  Earned | Evidence Summary                                                                                                              |
| ---------------------------------------------------- | -------: | ------: | ----------------------------------------------------------------------------------------------------------------------------- |
| M0-M4 foundation, security, catalog and COD commerce |      42% |     42% | Repository implementation and automated closeout reports exist.                                                               |
| M5 online payment, refund and GHN integration        |      13% |      9% | Core, adapters and buyer launch/recovery exist; real provider acceptance and financial closure remain open.                   |
| M6 after-sales, member and sharing                   |      23% |     11% | Data/policy/evidence, B3-B6 and member runtime/UI slices exist; B7, fulfillment, sharing and full after-sales UI remain open. |
| M7 reports, compliance and operations                |      15% |      1% | Evidence templates and readiness tools exist; operational product and release gates remain open.                              |
| External production acceptance                       |       7% |      1% | One partial iPhone beauty-store Zalo path exists; full provider/device/legal evidence is blocked.                             |
| **Total**                                            | **100%** | **64%** | **Approximate current completion: 64%; this is not a production-readiness claim.**                                            |

## 4. P0 Task Tree

### 4.1 Governance And Foundation

| ID        | Description                                                                                                                                            | Priority | Dependencies            | Status  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------- | ------- |
| P0-WF-001 | Audit the entire repository, recover the real baseline, create the authoritative Task Tree and baseline changelog, and upgrade the AI workflow rules.  | P0       | None                    | Done    |
| P0-WF-002 | Enforce the End of Development Gate: task/changelog updates, affected-module verification, task-branch commit and conditional synchronization to main. | P0       | P0-WF-001               | Done    |
| P0-M0-001 | Establish the Node/pnpm monorepo, four applications, shared packages, local infrastructure, CI and standard quality commands.                          | P0       | None                    | Done    |
| P0-M1-001 | Implement store isolation, identity, member/admin sessions, RBAC/MFA, consent, audit, i18n and Vietnamese localization foundations.                    | P0       | P0-M0-001               | Done    |
| P0-M1-002 | Complete the full Zalo host identity matrix for both stores, Android/iPhone, three languages, denial, replay, network and recovery cases.              | P0       | P0-M1-001, EXT-ZALO-001 | Blocked |

### 4.2 Catalog, Commerce And Orders

| ID        | Description                                                                                                                                                             | Priority | Dependencies             | Status  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------ | ------- |
| P0-M2-001 | Deliver store-scoped brands, categories, attributes, SPU/SKU, media, compliance, content decoration, buyer catalog and restricted import/export workbenches.            | P0       | P0-M1-001                | Done    |
| P0-M2-002 | Validate production S3/CDN/IAM/KMS, media lifecycle, failure behavior and two-store rollout.                                                                            | P0       | P0-M2-001, EXT-CLOUD-001 | Blocked |
| P0-M3-001 | Deliver inventory/reservations, multilingual search/facets, promotions/coupons, trusted integer-VND pricing and member cart with concurrency/security closeout.         | P0       | P0-M2-001                | Done    |
| P0-M4-001 | Deliver encrypted Vietnamese addresses, server-owned checkout, idempotent COD orders, immutable snapshots, inventory consume/release/restore and order/admin workflows. | P0       | P0-M3-001                | Done    |
| P0-M4-002 | Replace provisional administrative geography with an approved authoritative Vietnam province/district/ward dataset and validate update operations.                      | P0       | P0-M4-001, EXT-DATA-001  | Blocked |

### 4.3 Payment, Refund And Logistics

| ID        | Description                                                                                                                                                                                                                                             | Priority | Dependencies                                   | Status  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------- | ------- |
| P0-M5-001 | Deliver provider-neutral payment/refund/shipping contracts, RLS data model, outbox/inbox, online payment core, Zalo Checkout/ZaloPay and GHN adapters, reconciliation workers and refund workbench. Scope is repository/local-test implementation only. | P0       | P0-M4-001                                      | Done    |
| P0-M5-002 | Add the buyer Mini App online-payment checkout/launch/retry/recovery experience while keeping SDK and client results non-authoritative.                                                                                                                 | P0       | P0-M5-001                                      | Done    |
| P0-M5-003 | Validate isolated Zalo Checkout/ZaloPay sandbox channels for both stores, including callbacks, query compensation, refund and reconciliation evidence.                                                                                                  | P0       | P0-M5-001, P0-M5-002, EXT-PAY-001, EXT-NET-001 | Blocked |
| P0-M5-004 | Validate both-store GHN sandbox quote/create/cancel/track/label/COD flows and manual exception recovery.                                                                                                                                                | P0       | P0-M5-001, EXT-GHN-001, EXT-NET-001            | Blocked |
| P0-M5-005 | Close financial reconciliation for payment settlements, fees, refund differences, COD receivables and GHN remittance.                                                                                                                                   | P0       | P0-M5-001                                      | Todo    |

### 4.4 After-Sales, Member And Sharing

| ID        | Description                                                                                                                                                                                          | Priority | Dependencies                            | Status  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------- | ------- |
| P0-M6-001 | Deliver M6 contracts/data/RLS for after-sales policies, cases, evidence, settlements, favorites, views, privacy requests and share links.                                                            | P0       | P0-M5-001                               | Done    |
| P0-M6-002 | Deliver M6.3 policy resolution/control, read APIs and evidence lifecycle D0-D5 as default-disabled repository/local-test capabilities.                                                               | P0       | P0-M6-001                               | Done    |
| P0-M6-003 | Deliver M6.3-B3 member application/cancel and merchant-initiated refund request commands as default-disabled repository/local-test capabilities.                                                     | P0       | P0-M6-002                               | Done    |
| P0-M6-004 | Deliver M6.3-B4 review, manual-review resolution and return-expiry worker as default-disabled repository/local-test capabilities.                                                                    | P0       | P0-M6-003                               | Done    |
| P0-M6-005 | Deliver M6.3-B5 member return registration, trusted admin shipping facts and inspection-pending reads as default-disabled repository/local-test capabilities.                                        | P0       | P0-M6-004                               | Done    |
| P0-M6-006 | Close M6.3-B6 authoritative ONLINE after-sale refund coordination: finish completion evidence, final gates and status synchronization for the already implemented default-disabled repository slice. | P0       | P0-M6-005                               | Done    |
| P0-M6-007 | Implement M6.3-B7 COD refund settlement with trusted receipt facts, maker-checker controls, reconciliation and audit.                                                                                | P0       | P0-M4-001, P0-M6-006                    | Todo    |
| P0-M6-008 | Implement M6.4 return inspection, exactly-once inventory restoration, refund eligibility and exchange fulfillment.                                                                                   | P0       | P0-M3-001, P0-M6-005, P0-M6-006         | Todo    |
| P0-M6-009 | Implement M6.5 member favorites, product-view history, consent/privacy request runtime and three-language Mini App pages.                                                                            | P0       | P0-M6-001                               | Done    |
| P0-M6-010 | Implement M6.6 store/language/object Deep Links, official user-triggered share, three-language share cards and fallback pages.                                                                       | P0       | P0-M6-001, EXT-ZALO-002                 | Blocked |
| P0-M6-011 | Deliver M6.7 complete buyer/admin after-sales and member UI, mobile states, accessibility, browser E2E and Zalo-host acceptance.                                                                     | P0       | P0-M6-008, P0-M6-009                    | Todo    |
| P0-M6-012 | Validate and approve production policy/enforcement, evidence TTL/quota, storage/scanner/IAM/KMS/versioning/Object Lock/lifecycle, alerting and rollout.                                              | P0       | P0-M6-002, EXT-CLOUD-001, EXT-LEGAL-001 | Blocked |

### 4.5 Reports, Compliance And Production Release

| ID        | Description                                                                                                                                                                        | Priority | Dependencies                                                     | Status  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------- | ------- |
| P0-M7-001 | Implement store-isolated sales, brand, category, product, payment, COD, logistics and conversion reports with secure CSV/XLSX export.                                              | P0       | P0-M3-001, P0-M4-001, P0-M5-001                                  | Todo    |
| P0-M7-002 | Implement three-language public compliance pages plus privacy-request fulfillment, legal-hold conflict handling, data-subject actions and the audited administrator SLA workbench. | P0       | P0-M6-002, P0-M6-009                                             | Todo    |
| P0-M7-003 | Implement production observability, alerts, runbooks, deployment/rollback, backup/restore, queue backlog and provider outage recovery.                                             | P0       | P0-M0-001                                                        | Todo    |
| P0-M7-004 | Execute performance/capacity/security/privacy/accessibility checks, Android/iPhone three-language regression and Vietnam 4G first-screen acceptance.                               | P0       | P0-M7-003, EXT-PERF-001, EXT-ZALO-001                            | Blocked |
| P0-M7-005 | Resolve or formally mitigate the 3 moderate React Router production dependency advisories without breaking the ZMP host.                                                           | P0       | P0-M0-001                                                        | Todo    |
| P0-M7-006 | Complete Zalo review materials, official policy checks, provider evidence index and `REQUIREMENTS.md` section 23 release gate.                                                     | P0       | P0-M1-002, P0-M5-003, P0-M5-004, P0-M6-011, P0-M7-002, P0-M7-004 | Blocked |

## 5. P1 Task Tree

| ID          | Description                                                                                                                | Priority | Dependencies            | Status  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------- | ------- |
| P1-LOG-001  | Add multiple logistics providers through the stable adapter boundary and unified internal status mapping.                  | P1       | P0-M5-001               | Todo    |
| P1-INV-001  | Extend the current warehouse foundation to production multi-warehouse allocation and transfer operations.                  | P1       | P0-M3-001               | Todo    |
| P1-OA-001   | Add consent-aware Zalo OA order notifications, retry, unsubscribe and audit using official OA APIs.                        | P1       | P0-M1-001, EXT-ZALO-003 | Blocked |
| P1-MEM-001  | Implement store-scoped points, member levels, earning/redemption rules and financial reconciliation.                       | P1       | P0-M1-001, P0-M4-001    | Todo    |
| P1-MKT-001  | Implement advanced promotion composition beyond the current P0 promotion/coupon rules.                                     | P1       | P0-M3-001               | Todo    |
| P1-AFF-001  | Implement KOL/KOC promotion entities, attribution, settlement and abuse controls.                                          | P1       | P0-M1-001, P0-M3-001    | Todo    |
| P1-COD-001  | Implement enhanced COD risk scoring, limits and operations review beyond current static policy controls.                   | P1       | P0-M4-001               | Todo    |
| P1-FIN-001  | Implement automatic provider settlement ingestion and reconciliation.                                                      | P1       | P0-M5-005               | Todo    |
| P1-SHR-001  | Implement consent-safe share attribution after official sharing and Deep Links are production accepted.                    | P1       | P0-M6-010, EXT-ZALO-002 | Blocked |
| P1-I18N-001 | Implement AI-assisted translation as a reviewed draft workflow; AI output must never bypass Vietnamese publication review. | P1       | P0-M1-001               | Todo    |

## 6. P2 Task Tree

| ID          | Description                                                                                       | Priority | Dependencies              | Status  |
| ----------- | ------------------------------------------------------------------------------------------------- | -------- | ------------------------- | ------- |
| P2-TEN-001  | Generalize the proven two-store platform to additional stores without weakening tenant isolation. | P2       | P0-M1-001, P0-M2-001      | Todo    |
| P2-ERP-001  | Add ERP integration through versioned, idempotent and store-scoped adapters.                      | P2       | P2-TEN-001                | Todo    |
| P2-WMS-001  | Add external WMS integration and authoritative stock synchronization/reconciliation.              | P2       | P1-INV-001, P2-ERP-001    | Todo    |
| P2-ACC-001  | Add accounting and Vietnam electronic-invoice integrations after approved tax design.             | P2       | P1-FIN-001, EXT-LEGAL-001 | Blocked |
| P2-REC-001  | Implement privacy-safe intelligent recommendations with measurable fallback behavior.             | P2       | P0-M3-001, P0-M6-009      | Todo    |
| P2-AICS-001 | Implement AI customer service with human escalation, data boundaries and reviewed answers.        | P2       | P0-M1-001                 | Todo    |
| P2-FCT-001  | Implement sales forecasting with explainable inputs and monitored accuracy.                       | P2       | P0-M7-001                 | Todo    |
| P2-REP-001  | Implement intelligent replenishment recommendations without autonomous inventory mutation.        | P2       | P2-FCT-001, P1-INV-001    | Todo    |
| P2-CRM-001  | Implement automated member marketing with consent, frequency caps and unsubscribe enforcement.    | P2       | P1-MEM-001                | Todo    |
| P2-POS-001  | Add offline-store inventory and reconciliation after the multi-warehouse model is proven.         | P2       | P1-INV-001, P2-WMS-001    | Todo    |

## 7. Dependency Recovery And Eligible Work

The previous tree treated production acceptance as an implementation prerequisite. That made `P0-M7-006` a global gate and left `Current Task`/`Next Task` empty even though the repository already contains independent local/test foundations. This recovery keeps implementation dependencies only where the code contract requires them; provider, legal, host and production evidence remain separate completion gates.

### Recovery Rules Applied

- `P0-M5-005` now depends on the completed provider-neutral M5 facts, not real ZaloPay/GHN sandbox acceptance.
- `P0-M6-007` (COD settlement) and `P0-M6-008` (return inspection/inventory/exchange) are independent vertical slices; COD settlement no longer blocks return inspection.
- `P0-M7-001`, `P0-M7-002`, `P0-M7-003` and `P0-M7-005` can be implemented against completed local contracts and foundations; production evidence remains a later gate.
- P1/P2 implementation work now depends on the domain foundations it consumes. No P1/P2 task depends on `P0-M7-006` merely to start coding.
- `P0-M6-011` can implement buyer/admin UI after internal after-sales and member foundations are ready. Zalo-host acceptance remains part of its final evidence and is not used to block coding.
- Tasks that genuinely require external provider, legal, host, cloud or production evidence remain `Blocked` below.

### Eligible Queue

The queue is ordered by priority and task-tree order. `Current Task` is the first item; `Next Task` is the next P0 slice after it.

`P0-M5-005`, `P0-M6-007`, `P0-M6-008`, `P0-M7-001`, `P0-M7-002`, `P0-M7-003`, `P0-M7-005`, `P1-LOG-001`, `P1-INV-001`, `P1-MEM-001`, `P1-MKT-001`, `P1-AFF-001`, `P1-COD-001`, `P1-I18N-001`, `P2-TEN-001`, `P2-REC-001` and `P2-AICS-001` can start without any new external input.

## 8. External Dependencies And Blocked Tasks

External dependency IDs are gates, not implementation tasks. No secret may be committed to satisfy them.

| ID            | Required Input Or Evidence                                                                                                               | Blocks                                                           | Status  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------- |
| EXT-ZALO-001  | Both Mini Apps/Testing versions, approved accounts and Android/iPhone devices for the complete three-language host matrix.               | P0-M1-002, P0-M7-004; P0-M6-011 final host evidence              | Blocked |
| EXT-ZALO-002  | Current official Zalo Mini App Deep Link/share/review rules and an approved test application surface.                                    | P0-M6-010                                                        | Blocked |
| EXT-ZALO-003  | Approved Zalo OA, official API access, templates and consent/notification policy.                                                        | P1-OA-001                                                        | Blocked |
| EXT-PAY-001   | Independent beauty/fashion Zalo Checkout/ZaloPay sandbox merchant configuration, refundable transactions and secret references.          | P0-M5-003                                                        | Blocked |
| EXT-GHN-001   | Independent beauty/fashion GHN sandbox ShopId/Token, test warehouse/orders, service/COD and remittance material.                         | P0-M5-004                                                        | Blocked |
| EXT-NET-001   | Approved HTTPS callback domain, TLS certificate, trusted-proxy model, replay/IP policy and reachable staging.                            | P0-M5-003, P0-M5-004                                             | Blocked |
| EXT-CLOUD-001 | Production-like S3/CDN/IAM/KMS/versioning/Object Lock/lifecycle design, account and approved evidence location.                          | P0-M2-002, P0-M6-012                                             | Blocked |
| EXT-DATA-001  | Licensed/authoritative Vietnamese province, district and ward master data plus update policy.                                            | P0-M4-002                                                        | Blocked |
| EXT-LEGAL-001 | Vietnam legal, tax, privacy, translation and applicable cosmetics/contact-lens/oral/intimate-care professional decisions and signatures. | P0-M6-012, P0-M7-006, P2-ACC-001; P0-M7-002 publication sign-off | Blocked |
| EXT-OPS-001   | Approved production topology, cloud resources, secret manager, monitoring/alert receivers and deployment ownership.                      | P0-M7-003 production rollout evidence                            | Blocked |
| EXT-PERF-001  | Approved staging scale, traffic model, SLOs, stop conditions and evidence/sign-off owners.                                               | P0-M7-004                                                        | Blocked |

### Blocked Tasks

`P0-M1-002`, `P0-M2-002`, `P0-M4-002`, `P0-M5-003`, `P0-M5-004`, `P0-M6-010`, `P0-M6-012`, `P0-M7-004`, `P0-M7-006`, `P1-OA-001`, `P1-SHR-001` and `P2-ACC-001` are blocked by external inputs. These blocks affect final provider/host/legal/production acceptance or integrations that cannot be implemented against an unverified official contract; they do not block unrelated local/test implementation slices. No fake credentials, test-only adapters or undocumented assumptions may replace blocked evidence.

## 9. P0 Launch Risks

| Risk                                                             | Impact                                                                                                 | Required Closure                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Buyer online payment exists only at repository/local-test scope. | Host, merchant, callback and funds defects may surface only in real Zalo/sandbox environments.         | Complete P0-M5-003 and financial closure.                    |
| Real payment/refund and GHN/COD flows are unvalidated.           | Amount, callback, settlement, shipping and cash-reconciliation defects may surface only in production. | Complete P0-M5-003 through P0-M5-005.                        |
| Basic after-sales is incomplete end to end.                      | Return inspection, COD refund, stock restore, exchange and customer/admin UX are unavailable.          | Complete P0-M6-007 through P0-M6-011.                        |
| Reports and public compliance pages are absent.                  | Operations and Vietnam launch obligations cannot be met.                                               | Complete P0-M7-001 and P0-M7-002 plus professional sign-off. |
| Deployment, observability, backup and recovery are unproven.     | Incidents, data loss or provider outages cannot be operated safely.                                    | Complete P0-M7-003 and P0-M7-004.                            |
| Zalo real-device/review matrix is incomplete.                    | Host-specific failures or review rejection remain likely.                                              | Complete P0-M1-002 and P0-M7-006.                            |
| Three moderate React Router advisories remain.                   | Known redirect/XSS/constructor-injection advisory exposure remains pending compatibility review.       | Complete P0-M7-005.                                          |

## 10. Execution Protocol

Every development cycle uses:

`Scan -> Plan -> Execute -> Verify -> Update -> Repeat`

1. Scan the current task, its dependencies, relevant requirements, code, tests, official provider documentation and dirty worktree.
2. Plan the smallest complete vertical slice and record any required approved plan.
3. Execute only the `Current Task`; preserve unrelated changes and fail closed at external boundaries.
4. Verify applicable unit, integration, API, E2E, migration, security, static, build and dependency gates.
5. Update `TASKS.md`, `CHANGELOG.md`, contracts, plans and completion evidence in the same change.
6. Repeat with `Next Task`; do not start a dependency-blocked task.

## 11. Task Definition Of Done

A task may move to `Done` only when its described scope is implemented, tests and applicable repository gates pass, multi-store/RBAC/amount/inventory/state risks are reviewed, documentation/contracts/config/migrations are synchronized, no secret/debug/fake-success path exists, `CHANGELOG.md` is updated and the next eligible task is selected. External acceptance tasks additionally require named target evidence and sign-off; local adapters or empty templates do not satisfy them.

## 12. Git Recovery Commit Ledger

This ledger reconciles already-completed task snapshots with task-scoped commits. It does not replan the product tree or change `Current Task` / `Next Task`; those fields remain governed by the recovered execution queue above.

| Task ID   | Commit message                                             | Verification evidence                                                                                                 | Recovery scope                                                         |
| --------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P0-WF-001 | `docs(P0-WF-001): recover project baseline report`         | Format, Markdown structure, staged diff check and current full static/unit/integration/build recovery gates           | Missing historical audit artifact only; no current task-state changes  |
| P0-M5-002 | `feat(P0-M5-002): buyer online payment runtime`            | Typecheck, lint, unit, affected M5.4 integration, build, format check, staged diff check, and Chromium/WebKit E2E 2/2 | Historical snapshot isolated from M6.3-B5/B6 and P0-M6-009 changes     |
| P0-M6-002 | `fix(P0-M6-002): stabilize evidence rescan polling`        | Format, lint, typecheck, 627 unit, D2 20/20 and full 337 integration, build, schema validation and staged diff check  | Historical D2 test stabilization isolated from M6.3-B5/B6 and M6.5     |
| P0-M6-005 | `feat(P0-M6-005): return trust commands`                   | Typecheck, lint, unit, affected B5 integration, M2 upgrade migration, build, format check and staged diff check       | Historical B5 snapshot isolated from B6, D2 and P0-M6-009 changes      |
| P0-M6-006 | `feat(P0-M6-006): authoritative online after-sale refunds` | Typecheck, lint, unit, affected B6 integration, build, format check and staged diff check                             | Historical B6 snapshot isolated from D2 and P0-M6-009 changes          |
| P0-M6-009 | `feat(P0-M6-009): member privacy and engagement runtime`   | Format, lint, typecheck, 627 unit, 337 integration, build, schema validation, 25 browser E2E and staged diff check    | Historical M6.5 snapshot isolated from D2 and project baseline changes |
