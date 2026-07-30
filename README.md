# Zalo Shop

面向越南市场的 Zalo 多品牌自营商城底座。项目使用一套代码支持美妆商城和服装商城，所有商城业务数据与配置必须按 `store_id` 隔离。

当前状态：M1 商城安全上下文、身份、RBAC、三语、本地化与审计基础已实现；M2 商品目录、媒体、合规、装修、三语管理端、买家目录和受限导入导出已实现；M3.1-M3.7 已完成库存/预留、三语搜索/筛选、促销/优惠券/可信计价、会员购物车、并发与安全回归。M4 已按批准计划实现商城隔离的三级行政区、加密地址、服务端最终报价、COD 幂等下单、订单/快照/状态机、库存消费/释放/恢复、配送策略、买家端交易页面和管理工作台。M5.1-M5.4 已完成支付契约、数据/RLS、可靠消息、受限在线支付核心与 test-only provider；M5.5 已加入按商城解析的 Zalo Checkout 适配器、官方 MAC/查单契约、provider-order 绑定和原始 body webhook 接缝；M5.6 已加入 GHN 适配器、可信仓库/订单物理事实、可靠运单命令、面单代理及三语轨迹工作台；M5.7 已加入退款创建/查询、支付状态投影、逐笔权威查单、本地异常任务和双端三语退款状态。M6.1 已冻结售后、会员收藏/历史和主动分享的数据、权限、API、严格 DTO 与纯领域契约；M6.2 已完成 30 个商城模型/表、11 段迁移、RLS、复合关系、权限目录和数据库完整性 guard。M6.3-A 已完成 checkout 政策解析/同事务快照 writer、readiness/enforcement 管理 API、新商城自动 OFF provisioning 和既有物流 purpose 分流；`verify`、21/21 E2E、生产依赖 high 门禁、交付候选 Gitleaks 与差异检查已通过。审计另有 3 项 React Router moderate 公告，已明确结转且不得写成零漏洞。M6.3-B0 已完成领域、契约、OpenAPI、schema 与前向修复，并通过独立完成报告所列适用门禁；M6.3-B1 已完成会员与管理员售后列表/详情四个只读接口及适用门禁。M6.3-B2a 政策列表/详情、草稿、版本列表/详情、发布和停用七个管理员接口及 settings 契约收口已完成仓库实施与适用门禁，状态为 `COMPLETE`。M6.3-B2b-D0 已完成凭证数据库生命周期、专用 SYSTEM scope、规范对象 ledger、并发配额锁、严格 outbox 与 dead-letter reconciliation 仓库底座。D0 没有 HTTP、worker 注册、对象存储、真实 scanner、短期 URL、外部告警或生产配置；数据库 fixture 不能冒充真实文件校验。每个 staging/production 数据库仍必须逐库执行只读 preflight 并留证。B2/B2b、B3-B7、M6.3、UI、生产政策/enforcement 启用、供应商调用、部署和发布仍未完成或未授权并保持失败关闭。所有商城政策 enforcement 继续默认 OFF，没有售后申请、审核、返件、退款或结算运行时，也没有 M6 UI。真实商户/物流凭据、HTTPS 回调、Zalo/GHN sandbox、商户结算文件、GHN COD 回款和真机证据仍未验收，不能标记 M5.5-M5.7、整个 M5、M6.3、M6 或 P0 完成。

M6.3-B2b-D1 已完成专用 `AfterSaleEvidenceObjectStorageProvider`、默认失败关闭配置、本地/测试
MinIO 独立 bucket 与 upload/read/delete 最小 IAM，以及真实对象长度、SHA-256、Content-Type 和
JPEG/PNG/WebP/MP4 magic bytes 流式校验。当前只将 D1 repository implementation + local/test storage
validation 标记 `COMPLETE`；`verify`、Gitleaks、差异复审、生产依赖 high 审计与 OpenAPI 回归均有
精确通过证据。D1 没有 HTTP、worker、scanner、B3 claim 调用方、管理员读取审计或生产 storage
rollout，不能据此标记 B2b/B2、M6.3、M6 或 P0 完成。

M6.3-B2b-D2 已完成真实 ClamAV 单会话 scanner、D1 同流 HEAD/`If-Match` GET 内容复验、严格 scan
outbox handler、租约绑定数据库投影、版本漂移重排队、scan dead-letter 收敛和优雅停机 drain。真实
PostgreSQL + MinIO + ClamAV D2 集成 20/20、完整 integration 32 个文件/270 项、43 段迁移演练、
生产依赖 high、OpenAPI、Gitleaks 与独立复审均已通过。该结论只标记 repository implementation +
local/test scanner worker validation `COMPLETE`；没有 HTTP、B3 claim、保护读取/审计、expire/delete
worker、外部告警或 production storage/scanner/rollout，完整 B2b/B2、M6.3、M6 与 P0 继续未完成。

M6.3-B2b-D3 已完成默认关闭的会员凭证初始化、确认和 owner 状态三条 HTTP 路由。初始化复用 D0
配额/幂等并返回 D1 create-only URL 与必需 header；确认前验证真实对象 bytes 后原子排队 D2 scan；
状态只公开 `PENDING/READY/UNAVAILABLE`。真实 PostgreSQL + Redis + MinIO + ClamAV D3 集成 4/4、
完整 integration 33 个文件/274 项和 43 段迁移演练通过。该结论只标记 repository implementation +
local/test member evidence HTTP validation `COMPLETE`；B3 claim、保护读取/管理员审计、expire/delete
worker、生产参数批准与 rollout 仍未完成。

M6.3-B2b-D4 已完成默认关闭、与 scanner 解耦的凭证 expire/delete worker。expire/delete 结果提交均
绑定当前 outbox 租约、商城、evidence version/status/legal hold 与完整活动对象 ledger；ORIGINAL、
DERIVATIVE、SCAN_TEMPORARY 由 delete-only 身份并行幂等删除，provider 已删除、部分失败、租约换 owner、
重试状态推进后崩溃与 lifecycle dead letter 均可安全收敛。D4 定向单元 114/114、真实 PostgreSQL +
MinIO 6/6、完整 integration 34 文件/280 项、完整 `verify` 69 文件/545 项和 43 段迁移演练通过。该结论
只标记 repository implementation + local/test deletion worker validation `COMPLETE`；B3 claim、保护读取/
管理员审计、legal hold 管理、外部告警、production IAM/KMS/versioning/Object Lock/lifecycle 与 rollout
仍未完成。

B2a 仓库内只读预检的本地测试库结果为 `policies=0, versions=0`。D0 owner preflight 的本地结果为
`files=0, transitions=0, outbox=0, idempotency=0`；runtime RLS 连接按预期以 SQLSTATE `42501`
失败关闭。两者都不能替代未获授权的 staging/production 精确目标库 rollout 前重跑与留证。

Post-M3 仓库内就绪收口证据继续有效。Zalo Testing 版本 6 已完成 iPhone 美妆商城登录和中国手机号保存成功路径；Android、服装商城及完整异常矩阵仍为 `PARTIAL`。M4 浏览器验收使用真实本地 API、PostgreSQL 和 Zalo 测试桥，不能替代 Zalo 宿主真机。真实 staging S3/CDN、越南权威行政区主数据、近生产规模性能、两个商城的 Zalo Checkout/ZaloPay 与 GHN sandbox 配置/密钥/回调条件、生产凭据/权限、远程 CI 和越南/中国个人信息专业合规签字仍待外部输入。阶段证据见 `docs/reports/m4-completion-report.md`、`docs/reports/m5.1-completion-report.md`、`docs/reports/m5.2-completion-report.md`、`docs/reports/m5.3-completion-report.md`、`docs/reports/m5.4-completion-report.md`、`docs/reports/m5.5-progress-report.md`、`docs/reports/m5.6-progress-report.md`、`docs/reports/m5.7-progress-report.md`、`docs/reports/m6.1-completion-report.md`、`docs/reports/m6.2-completion-report.md`、`docs/reports/m6.3-a-completion-report.md`、`docs/reports/m6.3-b0-completion-report.md`、`docs/reports/m6.3-b1-completion-report.md`、`docs/reports/m6.3-b2a-completion-report.md` 与 `docs/reports/m6.3-b2b-d0-completion-report.md`。B0 已按其独立报告完成适用门禁；B0 未新增运行时或 UI，因此没有执行或声称 B0 专属 E2E，也不把 M6.3-A 的 E2E 冒充为 B0 证据。B2a 与 D0 报告只证明各自仓库实施 `COMPLETE`，不证明目标库 preflight、生产 rollout、完整 B2/B2b 或 M6.3 完成。

D1 当前证据与未完成门禁见
`docs/reports/m6.3-b2b-d1-evidence-storage-completion-report.md`；D2 证据见
`docs/reports/m6.3-b2b-d2-scanner-worker-completion-report.md`；D3 证据见
`docs/reports/m6.3-b2b-d3-member-evidence-http-completion-report.md`；D4 证据见
`docs/reports/m6.3-b2b-d4-evidence-deletion-worker-completion-report.md`。四份报告只证明各自明确标注的
repository/local-test 边界，不证明 production S3/KMS/lifecycle/versioning/Object Lock、scanner、
保护读取、legal hold 管理、外部告警或完整 B2b 可用。

## 应用与包

```text
apps/api         NestJS API 与健康检查
apps/worker      独立 worker 进程及健康检查
apps/admin-web   PC 管理端 React 应用
apps/mini-app    Zalo Mini App React 应用
packages/config  运行时环境变量校验
packages/logger  结构化日志与 correlation ID
packages/platform PostgreSQL、Redis、对象存储就绪检查
packages/database Prisma schema 与迁移入口
packages/domain  StoreContext 与 deny-by-default 权限规则
packages/contracts API 输入与错误契约
packages/security JWT、scrypt、TOTP 与 PII 加密
packages/integrations Zalo 身份、支付与物流端口及供应商契约
packages/i18n    vi/zh/en 回退与越南本地格式器
packages/design-tokens Mini App/管理端共享设计 token
```

M2.4 的媒体适配器使用 S3 兼容对象存储。`infra:up` 会通过一次性 `minio-init` 服务创建本地 bucket；生产 bucket 仍必须由批准的基础设施流程预先创建。

架构与范围以 `REQUIREMENTS.md`、`AGENTS.md` 和 `docs/` 下已批准文档为准。

## 前置环境

- Node.js 24 LTS
- Corepack（Node.js 官方安装包已包含）
- Docker Desktop 或兼容的 Docker Compose 环境
- Git

仓库通过 `packageManager` 固定 pnpm 版本，不需要全局安装 pnpm：

```powershell
corepack pnpm --version
```

如果 Windows PowerShell 策略阻止 `.ps1`，可在首次启用前使用：

```powershell
corepack.cmd pnpm --version
```

## 本地启动

```powershell
Copy-Item .env.example .env
corepack pnpm install --frozen-lockfile
corepack pnpm infra:up
corepack pnpm dev
```

默认地址：

- API 存活检查：<http://localhost:3000/health/live>
- API 就绪检查：<http://localhost:3000/health/ready>
- Worker 存活检查：<http://localhost:3001/health/live>
- 管理端：<http://localhost:5173>
- Mini App Web 预览：由 ZMP CLI 输出地址；也可运行 `corepack pnpm --filter @zalo-shop/mini-app dev:web` 后打开其输出地址（旧版 Vite 本地预览必要时追加 `/index.html`）
- MinIO Console：<http://localhost:9001>

Mini App 身份启动和手机号授权直接调用官方 ZMP SDK，服务端生产适配器尚未配置。真机模式需要有效的 Zalo Mini App ID、父 App 配置、开发者登录和官方 ZMP CLI 流程；本仓库不保存这些凭据。

库存预留过期由 worker 按数据库事实逐商城轮询，默认每 5 秒处理最多 100 条；可通过 `INVENTORY_EXPIRATION_INTERVAL_MS`（1000–300000）和 `INVENTORY_EXPIRATION_BATCH_SIZE`（1–500）调整。动作键和数据库终态保证重复执行幂等；M4 会在预留进入终态后关闭仍待确认的订单或推进已消费订单，失败保留计数供下轮重试。当前无需 BullMQ。

M5 outbox worker 同样通过可信商城注册表逐商城轮询，并在事务级 `store_id` RLS 上下文中使用 `FOR UPDATE SKIP LOCKED` 领取。默认每秒最多领取 25 条、租约 30 秒，重试从 1 秒指数退避并在 5 分钟封顶；分别由 `OUTBOX_WORKER_INTERVAL_MS`、`OUTBOX_WORKER_BATCH_SIZE`、`OUTBOX_WORKER_LEASE_MS`、`OUTBOX_WORKER_RETRY_BASE_DELAY_MS` 和 `OUTBOX_WORKER_RETRY_MAX_DELAY_MS` 调整。消息不会因失败删除；租约到期可恢复，达到上限进入死信。支付创建 handler 已按配置注册，但 `PAYMENT_PROVIDER=disabled` 时不会调用任何供应商；test provider 仍仅限测试环境。启用 `PAYMENT_RECONCILIATION_ENABLED` 后，已绑定供应商单号的尝试会在接受后最多 2 分钟、且尽量早于支付到期 30 秒进入主动查单；此时 `OUTBOX_WORKER_INTERVAL_MS` 不得超过 30000。

公共搜索默认按来源地址每 60 秒最多 120 次请求；可通过 `SEARCH_RATE_LIMIT_WINDOW_SECONDS`（10–3600）和 `SEARCH_RATE_LIMIT_MAX_REQUESTS`（10–10000）调整。Redis 仅保存短期限流计数，不作为搜索或商城数据事实来源。

## 质量检查

```powershell
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm build
corepack pnpm db:validate
corepack pnpm verify
```

基础设施集成测试：

```powershell
corepack pnpm infra:up
corepack pnpm test:integration
corepack pnpm infra:down
```

浏览器 E2E 首次运行需安装 Chromium 与 WebKit。测试使用真实 API、PostgreSQL、Redis 和 MinIO，自动启动管理端以及美妆/服装两个 Mini App Web 预览进程；生成的报告位于 `playwright-report/`：

```powershell
corepack pnpm test:e2e:install
corepack pnpm infra:up
corepack pnpm test:e2e
corepack pnpm infra:down
```

`test:e2e` 会从 `.env.test.example` 使用测试 API 端口；如需覆盖端口，可在 PowerShell 先设置
`$env:E2E_API_PORT='3100'`。Windows 某些环境会将 2984–3083 列为排除端口，遇到
`listen EACCES` 时应使用 3100 或其他未被排除的端口。该 E2E 覆盖桌面 Chromium、Android
Chromium 与 iPhone WebKit 的 Web 预览。认证后购物车用例只在 Playwright 启动的 localhost
Mini App 且显式设置 `VITE_ZALO_TEST_BRIDGE=true` 时安装测试桥，之后仍调用 test provider、
真实 API 与数据库；它不进入正常生产配置，也不替代 Zalo Mini App 宿主真机测试。M4 用例覆盖地址创建、服务端报价、COD 快速双击防重、订单详情/取消、三语标题和移动端横向溢出。

## 数据库迁移与本地种子

M6.3-B2a 前向迁移 `20260729100000_m63_b2a_policy_control_plane` 只增加 policy heads 的
`(store_id, updated_at DESC, id DESC)` 和 versions 的
`(store_id, policy_id, published_at DESC, id DESC)` 两个 keyset 索引。它不修改 RLS、政策事实或活动投影，
保留 B1 会员售后历史政策读取语义。仓库还提供只读
`corepack pnpm --filter @zalo-shop/database preflight:m63-b2a`，用于分批校验既有 policy code、规范草稿/hash/
products/head、全部不可变版本/三语/assignment/标量和发布时间一致性。预检事务设置
`row_security=off`；该设置不会绕过 RLS，而会让可能被 RLS 过滤的连接以 `42501` 失败，防止误用
`DATABASE_RUNTIME_URL` 得到虚假的零行通过。必须使用受控的 migration/maintenance `DATABASE_URL`。本地测试库预检已通过，
结果为 `policies=0, versions=0`；任何 staging/production 路由 rollout 前仍必须针对精确目标库重新执行并保留证据，
发现不兼容旧政策时先停止 rollout 并实施受审前向修复。

M6.3-B2b-D0 前向迁移 `20260729120000_m63_b2b_d0_evidence_lifecycle` 增加 evidence 上传、
确认、扫描、普通访问和删除耗尽元数据，新建 FORCE RLS 的规范对象 ledger，并收窄 member/admin/
SYSTEM policy、transition、生命周期与严格 outbox 原子约束。它要求 evidence files/transitions、
evidence outbox 与 evidence idempotency 四类既有 runtime 事实全空；非空以 SQLSTATE `55000` 停止，
不猜测真实对象状态。目标库部署前使用受控 migration/maintenance `DATABASE_URL` 运行：

```powershell
corepack pnpm --filter @zalo-shop/database preflight:m63-b2b-d0
```

预检在 `REPEATABLE READ` 只读事务中设置 `row_security=off`；误用 runtime RLS 连接会以 `42501`
失败关闭，而不是把隐藏行当成零事实。本地 owner 结果为
`files=0, transitions=0, outbox=0, idempotency=0`；该结果不能替代任何 staging/production 精确
目标库的重跑与归档。D0 `down.sql` 还检查对象 ledger，只允许五类事实均为空的 local/test 人工执行；
生产或已有凭证事实环境只允许受审前向修复。

M1 包含商城、身份、RBAC、会话、同意和审计表，并强制 runtime role RLS。M4 迁移新增三级行政区、地址、配送策略、订单、订单行、快照、转换、幂等与会员券核销门禁；权限迁移只登记 M4 权限 code，不给生产角色自动扩权。M6.2 的十一段前向迁移新增售后政策/快照、售后事实、会员收藏/历史、最小隐私请求与分享数据基础，并扩展运单 purpose、容量占用和 M5/M6 退款锁序保护；12 项 M6 STORE 权限同样只登记、不自动赋予生产角色。M6.3-A 的四段前向迁移让快照 guard 支持最近主类目祖先解析，为既有商城补稳定 OFF settings 行，增加当前商城受限行锁，并为后续新增商城自动 provision 同样的 OFF 行；迁移不创建政策、不启用 enforcement，也不扩生产角色权限。B0 前向迁移 `20260728104000_m63_b0_after_sale_contract_guards` 增加售后 header 精确 policy/version 身份、跨行同 policy/hash、逐行整数 VND 余数与窄 SYSTEM transition guard；它不开放任何售后运行时，事实环境只允许向前修复。B1 前向迁移 `20260728110000_m63_b1_after_sale_admin_read_index` 只增加管理员无状态筛选时使用的 `(store_id, updated_at DESC, id DESC)` 读取索引；Prisma 同时补记数据库原有的 `after_sale_refunds(store_id, settlement_id)` 唯一约束以消除 schema drift，不重复创建该索引。D0 迁移增加凭证 ledger/生命周期/可靠排队数据库底座，不新增 STORE 权限、不注册路由或 worker，也不创建生产/真实对象事实。种子仅创建可识别的 local/test 商城、行政区测试夹具、三语配置、配送策略、权限目录和系统商城角色，不创建默认管理员、会员、订单、售后政策、售后/分享事实或真实 Zalo ID。staging/production 必须先为每个商城导入并复核带 `source_version` 的越南权威省/区/坊数据；没有有效父链时地址写入和未知偏远省份配置会被服务端拒绝。

D1 不修改 Prisma、RLS 或数据库迁移；M2→current 仍为 43 段，不能把 storage adapter 记作第 44
段迁移。D1 回滚通过保持 evidence provider disabled 完成，不能通过删除 bucket 或数据库事实清理未来
真实对象。

D2 同样不增加 schema、RLS 或迁移，迁移总数保持 43。应用回滚必须先停止 scanner consumer；已有
evidence/outbox/transition 事实保留并由兼容 worker/reconciler 向安全终态收敛，不得清空数据库或
删除 bucket 作为回滚。

D3 与 D4 也不增加 schema、RLS 或迁移，迁移总数保持 43。D4 应用回滚必须先关闭新上传，再停止
expire/delete consumer 并等待在途 provider 删除与数据库提交；已有 `DELETION_PENDING/DELETE_FAILED`、
ledger、transition 和 outbox 事实必须保留，由兼容 worker/reconciler 前向收敛。

```powershell
corepack pnpm db:generate
corepack pnpm db:validate
corepack pnpm --filter @zalo-shop/database migrate:dev
corepack pnpm --filter @zalo-shop/database migrate:deploy
$env:NODE_ENV='test'
corepack pnpm --filter @zalo-shop/database seed
```

搜索文档属于可重建派生数据。需修复单个商城投影时，使用 runtime RLS 连接并显式记录执行人；该管理员必须在目标商城处于活动状态并具备 `store.catalog.publish`。命令按稳定商品 ID 每批处理 100 个商品，但删除、全部批次和审计位于单个 `REPEATABLE READ` 商城事务；任一失败整体回滚，重试从头执行，不是断点续跑：

```powershell
$env:SEARCH_REBUILD_STORE_CODE='beauty-local'
$env:SEARCH_REBUILD_ACTOR_ID='<authorized-admin-uuid>'
corepack pnpm --filter @zalo-shop/database search:rebuild
```

迁移目录提供人工审查的 `down.sql`，仅允许用于无真实身份、审计、M3-M6 业务事实的 local/test 环境；检测到地址、订单、`USED` 会员券、支付/物流/退款或 M6 售后、政策快照、会员、隐私和分享事实会以 SQLSTATE `55000` 拒绝，已有事实后只采用向前修复。仓库提供严格限制为 `NODE_ENV=test`、loopback PostgreSQL 和随机 `zalo_shop_m2_upgrade_*` scratch 数据库的 M2-to-current 回归；它部署真实 M2 迁移前缀和代表性双商城数据，验证完整升级、重复部署、fingerprint、搜索回填、RLS/权限与零虚构交易事实，并在成功或失败后清理：

```powershell
corepack pnpm infra:up
corepack pnpm test:migration:m2-upgrade
```

该自动化不会改变已有开发数据库，也不替代真实生产数据的受控升级演练。首个管理员使用 `admin:create` CLI 和一次性环境变量创建，不得把密码或 TOTP secret 写入文件。

## Post-M3 readiness 工具

HTTP smoke/baseline 和 staging S3/CDN 预检不新增第三方依赖，也不默认连接远程环境：

```powershell
corepack pnpm test:readiness:http
corepack pnpm test:readiness:storage
```

HTTP 默认只允许 loopback；staging 必须同时提供显式开关、HEAD 中无差异的受审 origin 策略和目标同源、24 小时内有效的 guard，production 始终拒绝。对象存储预检只允许 staging，先读取可写前缀之外的 guard，再在 `staging/{store_id}/readiness/` 下执行 create-only checksum upload/head/read/可选 CDN 读取，并只删除能够证明属于本次探针的对象。完整环境变量、guard 格式、最小权限和证据边界见 `docs/testing/readiness-runbook.md`，近生产拓扑、数据量、SLO 和签字见 `docs/testing/performance-acceptance-matrix.md`。没有真实 staging、批准 SLO、Zalo 设备或专业签字时，工具/模板只能保持 `NOT_RUN`、`BLOCKED` 或 baseline，不能写成生产验收通过。

## M1 API 与安全边界

- API 从 `/v1` 开始，契约见 `docs/api/openapi.m1.yaml`。
- 买家令牌绑定 `store_id`，后续请求的 `X-Store-Code` 必须与令牌一致。
- 普通管理员只能访问明确授权商城；平台跨店访问必须携带 `X-Access-Reason` 并逐店审计。
- 手机号使用 AES-256-GCM 加密和 HMAC 查重，API 只返回掩码；刷新令牌只保存 hash。
- 管理端访问令牌只保存在内存，不写入 LocalStorage 或 SessionStorage。

## M4 交易边界

- 增量契约见 `docs/api/openapi.m4.yaml`，字段/约束见 `docs/database/m4-data-dictionary.md`，管理员授权见 `docs/security/m4-permission-matrix.md`。
- `POST /v1/checkout/quote` 和 `POST /v1/checkout/orders` 只信任商城绑定会员、地址 ID、SKU/数量、券 code 和报价 hash；金额、优惠、库存、运费、商城和订单状态均由服务端重新加载。
- M4 交付时只允许 COD；该基线现由下述 M5.4 受限在线支付核心向后兼容扩展。
- 地址和订单地址快照中的敏感字段加密；API 只返回掩码手机号。正式 staging/production 前必须导入并复核越南权威三级行政区主数据。
- COD 确认消费库存预留；确认前取消释放预留；确认后发货前取消追加 RESTORE 反向流水。重复命令不会重复扣减或恢复。

## M5.4 受限在线支付核心

- 增量契约见 `docs/api/openapi.m5.yaml`，支付/可靠消息数据边界见 `docs/database/m5-data-dictionary.md`。
- `PAYMENT_PROVIDER=test` 只允许与 `NODE_ENV=test` 同时使用，并要求独立的 `PAYMENT_TEST_PROVIDER_SECRET`；适配器不发网络请求，非测试环境构造会硬失败。
- 测试中显式启用的商城独立 sandbox 渠道可创建 ONLINE 订单。订单、库存预留、首个支付尝试和 `payment.create.requested.v1` outbox 在同一事务提交，订单响应不伪造供应商成功。
- worker 在数据库事务外生成确定性测试 launch，再保存哈希和供应商幂等引用。主动查单与未来回调共用支付事实命令；匹配成功只消费一次库存并推进两段订单状态。
- 单次失败不关闭订单；窗口内可创建幂等新尝试。取消和到期会终止活动尝试并释放预留，迟到成功进入人工复核，不复活订单。
- 当前没有真实 ZaloPay/Checkout 凭据、SDK、回调或 sandbox 验收。开发环境默认 `PAYMENT_PROVIDER=disabled`，不得把 test provider 或测试 launch 作为生产集成。

## M5.5 Zalo Checkout 适配器与回调接缝

- `PAYMENT_PROVIDER=zalo-checkout` 只选择真实适配器；每个商城的 `store_payment_channels` 独立解析 App ID、method、environment、secret reference 和 key version。默认仍为 `disabled`，不会从 production 回退 test provider。
- createOrder MAC、callback `mac/overallMac`、原始字节验签、HTTPS allowlist、响应大小/超时/429 分类、查单和 provider-order 绑定均由 `packages/integrations` 提供；Mini App SDK 返回值不能直接确认支付成功。
- `POST /v1/webhooks/payments/zalo-checkout` 只接受官方回调 IP（附加门禁），通过 callback/inbox 唯一键去重后调用统一支付事实命令。密钥只通过 `env:ZALO_CHECKOUT_*` secret reference resolver 读取，不进入数据库、日志或前端。
- `PAYMENT_RECONCILIATION_ENABLED=true` 会为已绑定尝试创建商城隔离的有限重试查单任务；成功、回调竞态、持续 pending、上游超时、迟到成功和死信均复用可靠 outbox 与统一支付事实命令，不由 worker 直接写订单或库存。
- 本阶段没有真实密钥、回调域名、sandbox 或 Zalo Testing 真机证据；这些项目在 `docs/plans/m5.5-implementation-plan.md` 和后续报告中必须标记 `BLOCKED/NOT_RUN`。

## M5.6 GHN 物流适配器与履约事实

- `SHIPPING_PROVIDER=ghn` 只选择按商城 `store_shipping_channels` 解析的 GHN 适配器；development
  和 production 默认 `disabled`，非测试环境没有固定成功或 test fallback。
- 新订单必须从服务端 SKU 保存重量及长宽高快照；缺项时结算明确失败。建单继续重载订单地址、
  全量订单行、默认仓库履约资料、服务、COD 与渠道，客户端不能提交金额、地址、重量或供应商状态。
- 仓库履约资料中的联系人、电话和详细地址加密，管理端不回显原文；更新要求近期 MFA、版本、
  输入式确认和审计。管理端可报价、创建/取消运单、同步轨迹并获取 60 秒内部面单代理。
- GHN 未签名 webhook 只创建主动查单提示；只有核对商城/ShopId/运单后的权威 Order Info 可以推进
  运单和订单。买家与管理端均使用内部状态和三语 message key，不直接展示供应商状态文案。
- 本阶段没有真实 GHN ShopId/Token、测试仓库/订单、面单/webhook/COD 或 Zalo 宿主证据；这些
  项目保持 `BLOCKED/NOT_RUN`，仓库自动化不能替代供应商 sandbox 验收。

## M5.7 退款、逐笔查单与异常工作台

- 具备当前商城权限、近期 MFA 和输入式二次确认的管理员，可针对成功的 ONLINE 支付创建整数
  VND 的部分或全额退款；服务端锁定支付及退款事实并重算可退款余额，不信任前端金额。
- Zalo Checkout 退款创建与查询使用官方固定 HTTPS 端点和 MAC。由于官方创建接口没有供应商
  幂等键，创建命令最多外呼一次；网络结果不确定时进入人工复核，不自动重试并产生重复退款。
- 人工复核中的不确定退款继续占用可退款容量；应用和数据库 guard 双重阻止新退款导致超额。
- 退款成功只投影订单支付状态为部分或全部退款，不改变履约、运单或库存。买家订单详情只显示
  退款公开编号、金额、标准状态和时间，不暴露管理员原因、供应商编号或上游响应。
- 管理端提供商城隔离的支付、退款、主动查询、延迟重试和 dead-letter 任务视图；危险重试要求
  对应领域权限、近期 MFA、原因、版本、幂等键和固定确认码，并保留审计记录。
- 当前对账只覆盖逐笔权威查询、本地异常与死信视图，不代表商户日结完成。真实两商城退款、
  商户结算文件/手续费、GHN COD 回款和 Zalo 宿主验收保持 `BLOCKED/NOT_RUN`；M5/M5.7/P0 不标记
  完成，但 2026-07-27 的受限双轨批准允许继续仓库内 M6，外部上线门禁不变。

## M6.2 售后、会员与分享数据基础

- 十一段前向迁移建立 30 个商城模型/表、Prisma 复合关系、30 表 FORCE RLS、会员 owner scope、
  只追加事实和列级最小授权；政策快照、累计结算、COD 双人事实、M5 Refund 链接、库存/换货、
  凭证、隐私和运单 purpose 由数据库 guard 保护。初始第六段
  `20260727115000_m62_integrity_closeout` 进一步关闭 legacy 初态/决定、settlement 聚合锁、返件与
  凭证/COD、库存恢复、换货状态及共享 shipment 并发旁路；后续五段前向修复收口请求/批准容量、
  immutable order allocation、M5/M6 共享 advisory lock、固定行锁顺序、definer fail-closed scope 与
  仅批准/已有副作用案例占用订单级额度。定向数据库 38/38、完整 integration 26 个文件/202 项、
  35 段迁移演练、`verify` 51 个文件/352 项
  单元测试及既有 E2E 21/21 均通过。
- M6.2 交付时所有商城售后政策快照 enforcement 保持 OFF，本地种子不创建生产或默认政策；当时
  checkout 政策解析/快照 writer、readiness API 和受审启用命令尚未实现。该历史边界由下述
  M6.3-A 向后兼容扩展，不能把 M6.2 的无快照新单解释为已按当前政策下单。
- M6.2 交付时没有售后、收藏、历史、隐私或分享的买家/管理员运行时，也没有 worker、UI、对象存储
  扫描或真实 COD/GHN/Zalo 调用；这是 M6.2 的历史阶段边界，后续增量只以以下各节为准。

## M6.3-A checkout 政策与物流 purpose 安全收口

- checkout 只在逐商城 enforcement ON 时，按“商品覆盖 → 最近主类目祖先 → 商城默认”解析当前
  活动不可变版本，并在创建订单的同一商城事务中为全部订单行写入规范 payload、SHA-256 和精确
  版本快照。OFF 时明确写零快照并保持旧流程兼容；ON 时默认、assignment、runtime capability、
  解析或快照任一不一致都以稳定 `409` 失败并整体回滚。
- readiness hash 绑定权威活动 assignment、不可变 payload hash 与版本化 checkout runtime capability，
  不接受客户端 ready。`GET /v1/admin/after-sale-settings` 需要独立 policy read 权限；`PUT` 需要独立
  enforce 权限、近期 MFA、匹配确认词、AccessReason（平台跨商城时强制）、expected version 与
  Idempotency-Key，并记录
  精确 settings/policy ID、版本、readiness hash 的 before/after 审计。响应通过
  `Idempotency-Replayed` 标记重放。
- 四段前向迁移分别对齐最近类目祖先数据库 guard、既有商城稳定 OFF 行、当前商城受限行锁和新增
  商城自动 OFF provisioning。已有事实环境只允许向前修复；回滚没有 snapshot writer 的应用前，
  必须先通过受审命令关闭 enforcement。
- 既有订单物流查询、建单、取消、主动查单、callback hint、worker 和供应商事实均读取本地可信
  `ShipmentPurpose`。订单 API 固定为 `ORDER_OUTBOUND`，旧建单 worker 永久拒绝非订单 purpose；
  `AFTER_SALE_RETURN`/`EXCHANGE_OUTBOUND` 的状态事实不产生原订单 `SHIP/DELIVER` 事件。
- 创建/取消竞态使用可重试的“供应商引用待写回”状态补偿；真实数据库回归还验证两类非订单 purpose
  更新运单、轨迹和 operation 时，原订单状态、版本与转换数量均保持不变。
- 当前定向 unit 55/55、M6.2 数据库 39/39、M4 15/15、M5.6 13/13、完整 integration 26 个文件/
  206 项和 39 段迁移演练已通过。`verify`（54 个文件/381 项单元测试）、21/21 E2E、交付候选
  Gitleaks、`git diff --check` 与生产依赖 high 门禁也已通过；审计另有 3 项 React Router moderate
  公告，完整依赖链与缓解边界见 M6.3-A 报告。M6.3-A 已完成；随后首次获批的 B0 当时仅允许下述
  契约与前向修复，不授权 B1-B7 运行时。B1 后来另行取得只读授权，见下节。所有商城默认 OFF，
  不创建生产政策、售后运单或真实外部调用；
  M5.5-M5.7、整个 M5 与 P0 的外部门禁保持不变。

## M6.3-B0 已完成的售后契约与前向修复

- 非 legacy 售后单的全部订单行必须解析为完全相同的 policy、不可变 version 和 canonical payload
  hash；不同政策拆单。每行 `delivered_at` 只从 `shipment_items` 关联的 `ORDER_OUTBOUND` 运单证明，
  并要求完整数量已签收；冲突或无法证明的旧事实进入 `legacy_policy_review`，不使用订单时间或当前
  时间猜测。
- 申请和审核都锁定订单行并使用同一安全整数 VND 余数算法。审核只接收每个申请行的
  `approved_quantity`，不接受批准金额；全部剩余数量取得全部剩余 VND。reason code 来自冻结政策
  allowlist；政策要求证据时，上传校验、恶意文件扫描、READY claim、保护读取和删除补偿任一能力
  不可用都失败关闭且不创建售后。
- 会员返件提交只保存 `SUBMITTED` 返件记录并追加 `START_RETURN -> RETURN_PENDING`，不能自行追加
  `RETURN_SHIPPED` 或宣称运输/签收。完整 `inspect-return` 与 exactly-once 库存恢复整体延至 M6.4。
- SYSTEM 使用专用 `after-sale-transition` scope，只允许寄回到期、退款权威结果、必要人工复核和
  `COMPLETE`；审核、legacy 决定、COD 确认等人工动作禁止。`COMPLETE` 只能无新增资金副作用地把
  `REFUNDED -> COMPLETED` 确定性收口。
- B0 冻结但不实现 B1 读取契约：会员 locale `preferredLocale -> vi`，管理员显式 locale、商城默认、
  `vi`；`c1_` HMAC 游标绑定商城/主体/过滤/排序/过期；售后公开号为至少 128-bit 随机
  `ASC-[A-Z0-9]{16,32}`；会员读/写 60/10、管理员读/写 120/30 次每 60 秒；correlation ID 贯穿响应、
  事务、转换、审计、日志和错误，冲突只暴露公开 allowlist。
- B6 ONLINE Refund 与 B7 COD 双人结算当前仅为设计，不代表 M5 transaction-scoped refund 原语、
  coordinator、真实转账证明或成功按钮已交付。B0 没有 controller/service/worker/UI；领域/契约、
  数据库、完整 integration、迁移演练、`verify`、生产依赖审计、Gitleaks、差异检查和高风险复审等
  适用门禁已经验证，结果见 `docs/reports/m6.3-b0-completion-report.md`。B0 未执行或声称专属 E2E；
  B0 完成当时 B1-B7 运行时均未开始、未授权；此历史证据不因随后单独实施 B1 而改变。

## M6.3-B1 售后只读运行时

- 只开放 `GET /v1/after-sales`、`GET /v1/after-sales/{afterSaleId}`、
  `GET /v1/admin/after-sales` 与 `GET /v1/admin/after-sales/{afterSaleId}`。会员查询显式绑定当前
  商城和本人；管理员查询要求当前商城 `store.after-sales.read`，应用层 RBAC/owner 条件与数据库
  FORCE RLS 同时生效。
- 详情投影使用严格 Prisma `select` 和响应 schema allowlist，不使用宽关系 `include`。政策按会员
  `preferredLocale -> vi` 或管理员“显式 locale → 商城默认 → vi”读取冻结版本；凭证只投影
  `PENDING/READY/UNAVAILABLE`，原因密文、管理员字段、对象 key、供应商原始载荷和内部资金引用不
  进入响应。
- 列表在单个 `REPEATABLE READ` 事务中先用原生 SQL 读取 `limit + 1` 个 page key，再仅按白名单 ID
  批量加载严格投影并按 page key 重排。会员固定 `created_at DESC, id DESC`，管理员固定
  `updated_at DESC, id DESC`；数据库以六位微秒 UTC 文本返回排序键，下一页直接使用 PostgreSQL
  `(timestamptz, uuid)` tuple seek，避免 JavaScript 毫秒精度造成重复或漏项。
- `c1_` 游标使用 `AFTER_SALE_CURSOR_HMAC_KEYS` 的 1–3 把 base64url HMAC-SHA-256 key ring：第一把
  签发、全部验证，并绑定版本、商城、主体、资源、规范筛选、微秒排序键、ID 和过期时间。读限流固定
  60 秒窗口，会员 60 次、管理员 120 次，均绑定商城+主体；超限返回 `Retry-After`，Redis 不可用时
  在读取目标前失败关闭为 `503 UPSTREAM_UNAVAILABLE`。四个成功响应统一
  `Cache-Control: private, no-store` 并携带安全 `X-Correlation-Id`。
- B1 本身不注册任何写 handler，不创建 UI、worker、政策或外部调用。随后增加并完成下节 B2a 政策控制面的仓库实施；B2b/B3-B7、完整返件验收/M6.4、
  生产 rollout、部署和发布仍需单独授权。B1 可读不表示售后申请、审核、退款或结算可用。
- B1 的最终自动化数字、独立复审修复和残余风险见
  `docs/reports/m6.3-b1-completion-report.md`；B1 完成不代表 M6.3、M6 或 P0 完成。

## M6.3-B2a 政策控制面仓库实施

- 已接入政策列表/详情、草稿 `PUT`、不可变版本列表/详情、发布和停用七个管理员接口。政策读、
  草稿、发布和停用使用互不隐含的 `policy.read/manage/publish/disable`；发布/停用还要求近期 MFA、
  匹配确认词、reason、expected version 和商城范围 24 小时幂等。
- 草稿经严格三语/枚举/目标校验后规范化并保存 SHA-256；ACTIVE head 的下一版草稿不会提前改变 checkout 活动投影。
  发布在商城 advisory lock 和 policy `FOR UPDATE` 下原子创建版本、三语、冻结 assignment 和活动投影；发布/
  停用如在 enforcement ON 时破坏 readiness，整个事务失败关闭。时间来自同一数据库
  `CURRENT_TIMESTAMP`。
- policy heads 与 versions 使用保留 PostgreSQL 六位微秒的签名 keyset 游标，并绑定商城、管理员、资源、筛选和
  policy code。B2a 读/写分别复用管理员 120/30 次每 60 秒档位；成功响应使用
  `Cache-Control: private, no-store` 和 correlation ID。B2a 收口同时修复既有 settings GET/PUT 的严格输入、同类响应头、
  管理员 READ/WRITE 限流和 Redis 不可用时的 `503`。
- 稳定 `409` 冲突通过 `details.reason_code` 公开；读取会复验草稿 hash/product replace-set、不可变 payload/标量/
  三语/assignment，写命令在同事务记录完整 before/after、reason、actor 与 correlation ID。
- B2a 只增加两个分页索引，不改写 RLS。这是有意的安全/兼容决策：保留 B1 会员历史售后对已绑定政策版本的读取，
  不用“只读 ACTIVE assignment”的 RLS 让停用/替换后的历史不可读。
- 仓库内只读兼容性预检已在本地测试库通过（`policies=0, versions=0`），但每个目标库 rollout 前必须重新执行并留证。
  仓库门禁已通过：`verify` 为 60 个文件/427 项单元测试，完整 integration 为 29 个文件/234 项，M2→current 42 段
  fresh/redeploy/down-forward/fingerprint/guard 迁移演练、生产依赖 high、Gitleaks、OpenAPI 结构检查、`git diff --check` 与独立高风险复审均完成。
  生产依赖审计退出码为 0，但仍保留 3 项 moderate 公告；B2a 无 UI，专项 E2E 为 `NOT_APPLICABLE`。
- 首轮全仓 ESLint 在本机约 2 GiB 默认堆下 OOM；仅为复验进程临时设置 `NODE_OPTIONS=--max-old-space-size=4096` 后完整 `verify` 通过，未修改仓库或运行时配置。
- OpenAPI 检查未发现 YAML 重复键或外部引用，解析 556 个本地引用、112 个唯一目标；仓库没有专用 OpenAPI 3.1 语义 linter，因此该限制保留在完成报告中。
- Gitleaks v8.24.3 的 tracked diff 与 13 个 untracked 候选均通过；pathless stdin 仅对固定非密钥 `M63_IDEMPOTENCY_KEY_SECRET` 使用精确 allowlist，未放宽规则。
- 后续先授权并完成下节 D0 数据库底座，随后完成 D1 专用 storage adapter 与 local/test MinIO 校验；
  完整 B2b 的 HTTP、真实扫描、B3 claim 调用、保护读取授权/审计和删除 worker，以及 B3-B7、UI、
  生产政策/enforcement、部署和发布仍未授权；相关运行时能力保持 contract-only 或失败关闭。

## M6.3-B2b-D0 凭证数据库生命周期底座

- D0 在 `after_sale_evidence_files` 增加 upload/confirm/scan generation、scanner 身份、独立 ordinary
  access deadline 和删除耗尽事实；B1 对已 claim `READY` 的公开投影现使用 ordinary access deadline，
  不再把 retention 或 legal hold 当成普通读取授权。
- 新表 `after_sale_evidence_objects` 逐行记录 ORIGINAL/DERIVATIVE/SCAN_TEMPORARY 及 key hash/删除
  版本。D0 新原语以 ledger 为删除权威清单；父 evidence 只有在全部活动 key 清空后才能 `DELETED`。
- lifecycle SYSTEM 固定使用独立 `after-sale-evidence-lifecycle` scope 和稳定 actor，与管理员、会员及
  `after-sale-transition` scope 互不替代。FORCE RLS、列级 grant、trigger 和 append-only transition
  阻止跨商城、宽更新和越 allowlist 动作。
- 初始化按商城+会员配额锁串行；确认、SYSTEM 重扫请求、scan 结果、claim、expire、delete/retry 与 dead-letter
  reconciliation 均绑定 expected version/generation。scan/expire/delete outbox payload 精确只有
  `store_id/evidence_id/expected_version`，数据库 deferred guard 要求关键生命周期变化与对应消息
  原子提交。
- 删除退避至少 60 秒、最多 6 小时，第 5 次形成告警条件、第 8 次写耗尽事实并停止自动重试。
  legal hold 只阻止物理删除，不延长普通读取；已 claim 对象晚到恶意结果仍按 retention 截止清理。
- D0 没有注册凭证 HTTP 或 worker，不接 S3/MinIO evidence bucket、真实 scanner、保护 URL 或外部
  告警，也没有生产 TTL/配额/retention 审批和配置。初始化/确认数据库原语保存的是声明元数据，未读取
  provider 对象或验证 magic/checksum；自动化 fixture 不是外部文件能力证据。
- 因此 D0 只将 database repository implementation 标记 `COMPLETE`；其历史完成时对象存储、scanner、
  保护读取、worker、告警与生产 rollout 均为 `NOT_RUN/BLOCKED`。D1 的后续局部进度见下一节，但
  完整 B2b/B2、B3-B7、M6.3、M6 和 P0 仍未完成。D0 完整证据与限制见
  `docs/reports/m6.3-b2b-d0-completion-report.md`。

## M6.3-B2b-D1 专用对象存储与本地/测试内容校验

- D1 新增独立于 catalog/content 的 `AfterSaleEvidenceObjectStorageProvider`。上传使用 create-only
  `If-None-Match: *`，并签名绑定 Content-Type 与 SHA-256；读取身份执行 HEAD + 有界流式 GET，重新
  计算长度/checksum 并检测 JPEG/PNG/WebP/MP4 magic；删除身份只执行幂等删除。
- `EVIDENCE_STORAGE_PROVIDER` 默认 `disabled`。S3 mode 要求独立 evidence bucket、互不复用的
  upload/read/delete access key/secret、请求超时和短 TTL；production 还要求 HTTPS、`aws:kms` 和 KMS
  key ID。配置门禁通过不代表 provider 侧 KMS、IAM 或 lifecycle 已验收。
- 本地 MinIO root 只做 bootstrap。固定 content/evidence bucket、content 身份和三种 evidence 身份
  互相隔离；真实 MinIO D1 7/7 覆盖四种对象、防篡改、create-only、metadata/content 欺骗、反向 IAM、
  幂等删除与最终无残留。初始化连续两次成功，并要求固定 evidence bucket 版本控制从未启用。
- 版本化 bucket 的物理删除尚未解决：当前 adapter 不接收 version ID，普通 DELETE 在启用版本化时
  可能只创建 delete marker。AWS 最小 read IAM 对不存在对象也可能返回 `403` 而非 `404`。两项都须
  在目标 provider/staging 收口，生产 rollout 继续阻塞。
- D1 定向 config/adapter 单元 65/65、完整 integration 31 个文件/250 项和 M2→current 43 段迁移演练
  通过；生产依赖 high 审计退出码为 0，并保留 3 项 moderate，OpenAPI 文件 diff 为 0，结构引用检查为
  556/112/0/0。最终 `verify`（62 个单元文件/482 项）、46 个交付候选文件逐文件与 committed history
  Gitleaks、`git diff --check` 和独立高风险复审均通过。D1 无 UI/HTTP，专项 E2E 为 `NOT_APPLICABLE`。
- adapter 尚无 HTTP/worker 调用方，不消费 D0 outbox，也不调用 scanner。内部签名 GET 和 delete
  方法不能使 `protectedReadAvailable` 或 `deletionCompensationAvailable` 为 true；magic 校验也不是
  malware scanning。完整边界见
  `docs/reports/m6.3-b2b-d1-evidence-storage-completion-report.md`。

## M6.3-B2b-D2 真实扫描与租约安全 worker

- `EVIDENCE_SCANNER_PROVIDER` 默认 `disabled`；启用 `clamav` 必须同时启用 D1 S3 storage、提供
  server-only host/signature freshness/retention 配置，并满足租约预算。production 只接受显式
  loopback sidecar 地址，因为 Clamd TCP 本身没有认证或 TLS。
- scanner 在单一 `zIDSESSION\0` 连接严格执行 VERSION/INSTREAM/END，最大正文 50 MiB。只有精确
  `stream: OK` 可成为 `CLEAN`；EICAR/`FOUND` 只投影稳定 `MALWARE_DETECTED`，不记录恶意签名、
  provider 正文、对象 key 或 checksum。
- worker 从 D0 权威 evidence/ORIGINAL ledger 加载对象身份，使用 D1 read 身份执行 HEAD 和带
  `If-Match` 的 GET；实际长度、SHA-256、magic 与 scanner 消费同一有界流。网络调用前后都在专用
  SYSTEM scope 复核商城、严格 payload、version/generation 与未过期租约。
- loader/result 两个租约绑定事务各限制为 2 秒，并在 evidence 行锁等待后重新读取数据库时钟。默认
  10 秒 storage/scanner 超时组合要求 `OUTBOX_WORKER_LEASE_MS >= 29000`；D2 不实现 heartbeat。
- outbox、scan dead-letter 与库存轮询关闭时先停止领取并等待在途工作，随后才断开共享 Prisma 和
  销毁 S3 client。通用 outbox 在 scanner disabled 时仍可能把已存在的 scan 消息按 unsupported handler
  写入死信，因此关闭 scanner 不等于暂停既有 scan 队列；D3 producer 启用后，关闭顺序必须先停止
  新初始化/确认并收敛既有 scan 消息。
- local/test ClamAV 只证明协议和仓库协调，不证明生产网络隔离、签名更新、HA、吞吐、容量、监控或
  SLA。完整证据和剩余阻断见
  `docs/reports/m6.3-b2b-d2-scanner-worker-completion-report.md`。

## M6.3-B2b-D3 会员凭证 HTTP 生命周期

- `POST /v1/after-sales/evidence-uploads`、confirm 与 owner 状态 GET 已注册。三条路由要求当前商城
  member token、匹配 `X-Store-Code`、owner RLS、Redis MEMBER READ/WRITE 限流，并统一返回
  correlation/no-store/no-referrer header；跨会员/商城的已知 UUID 不可探测。
- `AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED` 默认 `false`。启用必须同时配置 D1 S3、D2 ClamAV、
  `AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS`、`AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_FILES` 与
  `AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_BYTES`；签名 URL TTL 不得超过数据库上传 TTL。
- 初始化响应只包含 evidence ID/version、上传到期、create-only URL 和严格 header allowlist，不包含
  object key、bucket 或凭据。确认前使用 D1 read 身份执行 HEAD + `If-Match` GET，按真实 bytes 复算
  长度/checksum/magic；通过后 D0 才原子确认并排队 scan，D2 仍独立重读 ledger 并扫描。
- owner GET 只投影 `PENDING/READY/UNAVAILABLE`，使用数据库时钟执行排他截止。恶意、失败、隔离、
  删除和内部错误均折叠为 UNAVAILABLE，不返回 scanner/provider/cleanup 细节。
- D3 无 schema/RLS/grant/迁移变化，迁移仍为 43 段。D3 不提供 B3 claim、凭证正文 URL、管理员读取
  审计、expire/delete worker、legal hold 管理、外部告警或生产 rollout；完整边界见
  `docs/reports/m6.3-b2b-d3-member-evidence-http-completion-report.md`。

## M6.3-B2b-D4 到期与物理删除补偿 worker

- `AFTER_SALE_EVIDENCE_DELETION_WORKER_ENABLED` 默认 `false`，可在 ClamAV scanner 关闭时独立运行。
  启用必须配置 D1 S3/delete-only 身份、固定 8 次领域重试、60 秒至 6 小时退避参数和足够 outbox
  lease；会员上传与 scanner producer 只有在删除 consumer 同时可用时才允许启用。
- expire handler 只在当前 PROCESSING lease、权威 evidence version/status、无 legal hold 且数据库截止
  已到时进入 `DELETION_PENDING` 并同事务排队 delete。提前消息按数据库 `nextAttemptAt` 有界重试；
  lifecycle dead-letter reconciler 可按当前权威事实重排，不把死信冒充成功。
- delete loader/result 在 provider 调用前后分别重锁消息、evidence 与完整活动 ledger。三类对象使用
  role-bound delete identity 并行删除；全部成功或 provider 明确已不存在后，才原子清空 ledger key 并
  把父 evidence 置为 `DELETED`。失败提交同样绑定原始 `(object id, version)` 集合。
- 第 5 次失败形成稳定本地 warning condition，第 8 次耗尽且停止自动排队；当前没有外部告警接收方。
  D4 的 MinIO 证据不证明 production versioned bucket 的历史版本物理删除，完整边界见
  `docs/reports/m6.3-b2b-d4-evidence-deletion-worker-completion-report.md`。

## 环境与密钥

- `.env.example` 和 `.env.test.example` 只包含本地开发占位凭据。
- `NODE_ENV=production` 会在启动配置解析阶段拒绝上述示例中的 JWT、PII 和 S3 占位值；生产值必须由部署密钥系统独立注入。
- `.env`、生产凭据、Zalo Token、支付密钥和物流密钥禁止提交。
- API/worker 启动时会验证数据库、Redis 和对象存储配置。
- 对象存储就绪检查只对配置的 `S3_BUCKET` 执行 `HeadBucket`，不要求账户级 `ListBuckets`；临时 STS 凭据可通过可选的 `S3_SESSION_TOKEN` 注入。
- evidence storage 使用单独的 `EVIDENCE_STORAGE_*` 配置和可选 session token，不得复用 `S3_BUCKET`、
  `S3_ACCESS_KEY`、`S3_SECRET_KEY` 或三种 evidence 身份中的任一凭据。示例值只适用于 local/test。
- 固定本地 evidence bucket 必须从未启用版本控制；production 的 KMS/lifecycle/versioning/Object Lock、
  历史版本清理和恢复策略均需另行审批与目标环境证据。
- 日志默认遮盖认证、Cookie 和 Zalo Token 请求头。
- `ZALO_IDENTITY_PROVIDER=test` 只允许 `NODE_ENV=test`；生产环境会拒绝启动该 provider。
- `PAYMENT_PROVIDER=test` 同样只允许 `NODE_ENV=test` 且需要专用测试密钥；development/production 默认并应保持 `disabled`。真实适配器从商城 `private_key_secret_ref` 解析部署密钥，`env:ZALO_CHECKOUT_*` 只是受限的本地/部署 resolver 示例，不是把密钥写入仓库。
- `SHIPPING_PROVIDER=ghn` 需要数据库中的商城独立 ShopId、固定环境、origin allowlist key 和
  `env:GHN_*` secret reference；Token 不写数据库值、日志、审计或前端。默认 `disabled`。
- `GHN_REQUEST_TIMEOUT_MS`、`GHN_RESPONSE_LIMIT_BYTES` 和
  `GHN_CALLBACK_RATE_LIMIT_PER_MINUTE` 控制 GHN 网络与未签名提示门禁；非生产固定 sandbox，
  production 固定 production，不接受自由 origin。
- `ZALO_CHECKOUT_REQUEST_TIMEOUT_MS`、`ZALO_CHECKOUT_RESPONSE_LIMIT_BYTES`、`ZALO_CHECKOUT_CALLBACK_IP_ALLOWLIST` 和 `ZALO_CHECKOUT_CALLBACK_RATE_LIMIT_PER_MINUTE` 控制查单/回调安全门禁；生产 IP 列表需按官方回调 IP 与受信代理实际配置复核。
- 真实 Zalo 登录使用 `ZALO_IDENTITY_PROVIDER=open-api`，并要求服务端配置 `ZALO_APP_ID`、`ZALO_MINI_APP_ID` 和 `ZALO_APP_SECRET`。App Secret 只能写入被 Git 忽略的本地环境或部署密钥，禁止写入 `VITE_*`、前端代码、终端输出和版本库。
- `ZALO_OPEN_API_TIMEOUT_MS` 控制 Graph API 短超时；`ZALO_TOKEN_METADATA_TTL_SECONDS` 只是官方响应未给出过期时间时的保守元数据，不替代每次敏感操作的上游实时校验。
- `AFTER_SALE_CURSOR_HMAC_KEYS` 是逗号分隔的 1–3 把唯一 base64url 密钥，每把解码后至少 32 字节；
  第一把签发、全部验证。轮换时先置入新主密钥，至少保留旧验证密钥至
  `AFTER_SALE_CURSOR_TTL_SECONDS`（默认 900 秒）覆盖的游标全部过期；production 会拒绝仓库占位值。
- `CONTENT_EXTERNAL_TARGET_HOSTS` 是逗号分隔的页面外跳 HTTPS 主机白名单；默认空值表示禁止全部外跳，配置不含协议或路径。

## Zalo Mini App 真机与 Testing

`apps/mini-app` 是现有 Vite Web App 的 ZMP deploy-only 项目。首次联调在该包目录登录对应 Mini App，CLI 凭据会进入被忽略的 `.env`：

```powershell
corepack pnpm --filter @zalo-shop/mini-app exec zmp login
corepack pnpm --filter @zalo-shop/mini-app zmp:device
```

Device 模式通过 Zalo 官方隧道连接本地 Vite 与 `/api` 代理，适合验证 `getAccessToken`、手机号允许/拒绝和手工降级。上传 Testing 前先构建，并确保 `VITE_API_BASE_URL` 是手机可访问的受控 HTTPS API；不能把本地 `localhost` 或 Vite 代理用于托管版本：

```powershell
corepack pnpm --filter @zalo-shop/mini-app build
corepack pnpm --filter @zalo-shop/mini-app zmp:deploy:testing -- --desc "real-device identity validation"
```

Testing 上传不等于审核或发布。正式提交前仍需完成 Mini App 主体/行业资质、生产 API 域名、隐私政策和完整真机回归。
