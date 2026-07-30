# M6 售后、会员、内容与主动分享专项实施计划

> 状态：已批准；M6.1、M6.2、M6.3-A、M6.3-B0、B1、B2a、B2b-D0、B2b-D1 repository +
> local/test storage validation、B2b-D2 repository implementation + local/test scanner worker
> validation、B2b-D3 repository implementation + local/test member evidence HTTP validation 与
> B2b-D4 repository implementation + local/test deletion worker validation 已完成且适用仓库门禁通过；B2/B2b、B3-B7、
> M6.3、UI 与生产启用未完成或未授权并保持失败关闭；M6 整体未完成
>
> 版本：1.0
>
> 日期：2026-07-30
>
> 依赖：`REQUIREMENTS.md`、`AGENTS.md`、`docs/plans/p0-development-plan.md`、
> `docs/architecture/system-architecture.md`、`docs/plans/m5-implementation-plan.md`、
> `docs/reports/m5.7-progress-report.md`

## 1. 批准与顺序变更记录

用户于 2026-07-27 批准采用双轨方案：M5 的真实 ZaloPay/GHN、HTTPS 回调、结算、COD 回款
和 Zalo 宿主证据继续作为上线硬门禁，M5/M5.7 不标记完成；同时允许推进仓库内 M6，并先形成
本专项计划、完成 M6.1 契约冻结。

本批准只改变“外部 M5 证据阻塞全部后续仓库开发”的实施顺序，不改变支付金额、退款容量、
库存、商城隔离、权限、合规或供应商信任边界。它不授权真实供应商调用、生产凭据、部署、
Zalo Testing 上传、审核或发布。M5 外部契约若与当前实现不一致，仍需先做差异审查和向前修复。

M6.1 审查更正（2026-07-27）：初稿曾假设仓库已有真实注销/隐私申请流程，并把结构化受理整体
留到 M7；代码核查确认现有运行时只有 logout 和 consent 事件，不能承接 `REQUIREMENTS.md` 第
15.3、16.1、21 节的数据访问、更正、删除、匿名化和注销申请。为避免 M6 交付虚假入口，M6.1
据既有需求冻结最小 `privacy_requests` 受理/本人查询契约；M7 仍负责后台履约、导出和实际执行。

M6.1 完成记录（2026-07-27）：数据字典、权限矩阵、37 路径/44 操作 OpenAPI、严格 DTO 与售后、
隐私、分享纯领域规则已冻结；定向 34 项测试与仓库级 `verify`（51 个文件/352 项单元测试）通过。
该阶段完成时 M6.2 尚未获授权，历史证据和当时的 `NOT_RUN` 边界见
`docs/reports/m6.1-completion-report.md`。

M6.2 批准与完成记录（2026-07-27）：用户随后明确授权按本计划继续数据层实施。已新增 30 个
商城数据模型/表、11 段前向迁移和 12 项 STORE 权限目录，完成复合租户关系、30 表 FORCE RLS、
会员 owner scope、只追加与列级最小授权、政策快照、数量/金额、COD、M5 Refund、库存/换货、凭证、
隐私和运单 purpose guard。初始第六段 `20260727115000_m62_integrity_closeout` 收口 legacy 初态/决定、
settlement 聚合锁、返件/凭证/COD、库存、换货、共享 shipment 并发及 definer ACL；后续五段前向修复
补齐请求/批准容量、immutable order allocation、M5/M6 退款锁序、definer fail-closed scope 与批准占用。
定向数据库 38/38、完整 integration 26 个文件/202 项与 35 段 M2-to-current、重复部署、M6/M5 down/重新前滚及 `55000`
门禁演练已通过；仓库级 `verify` 保持 51 个文件/352 项单元测试通过。M6.2 完成当时 M6.3 运行时
API/worker/UI 尚未开始；所有商城政策快照 enforcement 保持 OFF，没有生产政策、checkout 快照
writer/readiness 命令、生产角色自动扩权或真实外部调用。

M6.3 授权与拆分记录（2026-07-28）：用户要求按仓库严谨工作流继续下一阶段，明确授权进入路线图中
唯一未开始的 M6.3。为使 checkout、物流和售后资金域分别取得可回滚证据，M6.3 先实施 M6.3-A
前置安全收口，再实施 M6.3-B 售后申请/审核/返件/结算协调；详细目标、非目标、涉及文件、兼容、
回滚、风险和验收见 `docs/plans/m6.3-implementation-plan.md`。该拆分不扩大授权，也不放宽 M5/P0
外部上线门禁。

M6.3-A 实现与门禁进度（2026-07-28）：checkout 已在订单事务内按商品覆盖、最近主类目祖先和
商城默认解析不可变政策，并仅在逐商城 enforcement 启用时写入完整订单行快照；readiness hash
绑定权威活动投影与版本化 runtime capability。`GET/PUT /v1/admin/after-sale-settings` 已实现
商城/Header/查询一致性、独立读/强制权限、近期 MFA、确认词、
AccessReason（平台跨商城时强制）、expected version、24 小时商城幂等、精确 before/after 审计与
串行化重试。既有订单物流查询、命令、callback、worker
和供应商事实已按本地可信 purpose 分流，只有 `ORDER_OUTBOUND` 可推进原订单。四段前向迁移补齐
最近祖先数据库 guard、既有商城稳定 OFF 行、受限 settings 行锁和新增商城自动 OFF provisioning。
最终物流复核还关闭了创建/取消竞态：provider reference 待写回保持可重试，并以真实数据库证明
两类非订单 purpose 更新自身事实时不改变原订单 status/version/transitions。
定向 unit 55/55、M6.2 数据库 39/39、M4 15/15、M5.6 13/13、完整 integration 26 个文件/206 项，
以及 39 段 M2→当前、重复部署、fresh、down/重新前滚和 `55000` 演练已通过。`verify`（54 个文件/
381 项单元测试）、21/21 E2E、交付候选 Gitleaks、`git diff --check` 与生产依赖 high 门禁均通过；
审计另有 3 项 React Router moderate 公告并已明确结转。M6.3-A 完成当时 M6.3-B1-B7 运行时均未
开始；详见 `docs/reports/m6.3-a-completion-report.md`。

M6.3-B 写路径前置差异审查已完成。用户于 2026-07-28 接受返件 member transition、SYSTEM actor、
ONLINE Refund 原子协调设计、验收/库存切片边界及多政策/金额/证据等推荐默认值，并只授权实施
`docs/plans/m6.3-b0-decision-plan.md` 的 B0 契约与前向修复。B0 已完成，适用门禁和残余风险见
`docs/reports/m6.3-b0-completion-report.md`；B0 完成当时 B1-B7 仍未开始、未授权。

M6.3-B1 授权与实现记录（授权 2026-07-28，实施收口 2026-07-29）：用户在了解风险后明确
“按照建议执行”，只授权
`GET /v1/after-sales`、`GET /v1/after-sales/{afterSaleId}`、`GET /v1/admin/after-sales` 与
`GET /v1/admin/after-sales/{afterSaleId}`。四个只读接口现已实现：会员显式绑定商城+本人，管理员要求
`store.after-sales.read` 并绑定目标商城，两者叠加 FORCE RLS；响应采用严格 Prisma `select` 和 schema
allowlist。列表在 `REPEATABLE READ` 中先取 `limit + 1` 个 page key，再按白名单 ID 投影，使用数据库
六位微秒 `(timestamp,id)` tuple seek；`c1_` 游标由 1–3 把 HMAC key ring 签发/轮换。Redis 读限流、
`Retry-After`、correlation ID 与 `Cache-Control: private, no-store` 同步落地。B1 只提供读取；B1 收口时不授权
B2-B7、UI、生产政策/启用、供应商调用、部署或发布，该历史边界随后仅由下述 B2a 授权扩展。

M6.3-B2a 授权与仓库实施完成记录（2026-07-29）：用户再次要求按仓库严谨工作流程继续下一阶段，本轮授权并实施
`docs/plans/m6.3-b2-implementation-plan.md` 中的 B2a 政策控制面。政策 head 列表/详情、草稿 `PUT`、不可变 version 列表/
详情、发布和停用七个管理员接口已落地。它们实施独立 policy RBAC、发布/停用近期 MFA、严格三语和规范 hash、
商城范围 24 小时幂等、商城锁+head 行锁、不可变发布、活动投影、enforcement readiness 同事务回滚、微秒签名游标、严格响应
复验和完整审计。B2a 收口还修复已有 settings GET/PUT 的严格 Store-Code/Access-Reason/query、成功 correlation/no-store、
管理员 READ/WRITE 分级限流及 Redis `503`。只读兼容性预检已实现，并在本地测试库通过（`policies=0, versions=0`）。

B2a 迁移只增加 policy heads 和 versions 的两个分页索引，没有 RLS 改写。这保留 B1 会员对已绑定历史政策版本的读取；
ACTIVE-only RLS 方案会破坏该历史读又不能提供列级草稿隔离，因此被否决。目标库 rollout 前仍必须重新执行兼容性预检并留证；
仓库内 `verify`（60 个文件/427 项单元测试、格式/lint/typecheck、生产构建、Prisma validate）、完整 integration 29 个文件/234 项、
M2→current 42 段迁移演练、生产依赖 high、OpenAPI 结构检查、tracked+13 个 untracked 候选 Gitleaks、`git diff --check` 与独立高风险复审均通过，
所以 B2a 仓库实施标记 `COMPLETE`。这不代表任何 staging/production 目标库已 preflight 或可 rollout，也不完成 B2/B2b、M6.3、M6 或 P0。

M6.3-B2b-D0 授权与仓库实施完成记录（2026-07-29）：B2a 后用户再次要求按严谨工作流继续下一
阶段。完整 B2b 依赖专用对象存储、真实 scanner、保护读取、生产保留政策与 worker 外部证据，不能
一次安全交付，因此本轮只实施
`docs/plans/m6.3-b2b-d0-implementation-plan.md` 的数据库生命周期与可靠排队底座。D0 增加
evidence upload/confirm/scan/access/exhaustion 元数据、规范对象 ledger、独立
`after-sale-evidence-lifecycle` SYSTEM scope、会员配额并发锁、SYSTEM 重扫请求、严格 scan/expire/delete outbox 与
dead-letter reconciliation 原语，并修正 B1 已 claim READY 投影以 ordinary access deadline 控制读取。

D0 迁移要求 evidence/transition/outbox/idempotency 四类既有 runtime 事实全空，非空以 `55000`
停止；本地 owner preflight 为四类事实均 0，runtime RLS 连接按预期以 `42501` 失败关闭。迁移已进入
M2→current 第 43 段的 fresh/redeploy/down-forward/fingerprint/五类事实门禁演练；数据库、商城隔离、
配额并发、消息原子性、generation、hold、ledger 删除、第五次告警/第八次耗尽和三类 dead letter
已有自动化证据。最终仓库门禁与精确计数见
`docs/reports/m6.3-b2b-d0-completion-report.md`，D0 repository implementation 单独标记
`COMPLETE`。

该结论明确不包含 HTTP、worker 注册、对象存储、真实 MIME/magic/checksum/provider 校验、scanner、
保护 URL、外部告警、生产参数审批/配置、目标库 rollout 或真实用户文件。上述外部能力保持
`NOT_RUN/BLOCKED`；B2b/B2、B3-B7、M6.3、M6 和 P0 均未完成，也未因 D0 自动获得下一切片授权。

M6.3-B2b-D1 授权与当前收口记录（2026-07-29）：用户在 D0 后再次要求继续下一阶段，本轮只实施
`docs/plans/m6.3-b2b-d1-evidence-storage-plan.md` 的专用对象存储与内容校验切片。仓库新增独立
`AfterSaleEvidenceObjectStorageProvider`、默认 disabled 且失败关闭的 `EVIDENCE_STORAGE_*` 配置、
local/test MinIO content/evidence bucket 和 upload/read/delete 最小 IAM，以及实际 bytes 长度、SHA-256、
Content-Type 和四类 magic 的有界流式校验。D1 不修改数据库；M2→current 仍为 43 段且演练通过。

D1 定向 config/integrations 单元 65/65、真实 MinIO 7/7、完整 integration 31 文件/250 项通过；MinIO
初始化连续两次成功并强制固定 evidence bucket 版本控制从未启用。生产依赖 high 审计退出码 0，且仍
披露 3 项 moderate；OpenAPI 文件 diff=0，结构引用为 556/112/0/0。最终 `verify`（62 个单元文件/482
项）、46 个交付候选文件逐文件与 committed history Gitleaks、`git diff --check` 和独立高风险复审均
通过，详见 `docs/reports/m6.3-b2b-d1-evidence-storage-completion-report.md`。

因此只将 D1 repository implementation + local/test storage validation 标记 `COMPLETE`。D1 没有
HTTP、worker、scanner、D0 outbox 消费、B3 claim 调用方、管理员读取审计或生产 KMS/lifecycle/
versioning/Object Lock/rollout；五项 runtime capability 与 OpenAPI status 不变。B2b/B2、B3-B7、M6.3、
M6 和 P0 继续未完成。

M6.3-B2b-D2 授权与仓库/local-test 完成记录（2026-07-30）：用户在 D1 后再次要求按严谨工作流
继续，本轮只实施真实 ClamAV scanner 与 scan worker。D2 以 D1 HEAD/`If-Match` GET 同流重算实际
长度/SHA-256/magic 并扫描，通过固定 evidence SYSTEM scope 在网络调用前后复核权威 outbox/evidence/
ORIGINAL、商城、严格 payload、version/generation 与数据库时钟租约；legal-hold 同状态版本漂移会
原子生成下一 generation/outbox。独立 scan dead-letter reconciler 将仍权威的 `PENDING` 收敛为
`FAILED`，旧消息只 `SUPERSEDED`。

D2 真实 PostgreSQL + MinIO + ClamAV 20/20、完整 integration 32 文件/270 项、43 段迁移演练、
生产依赖 high、OpenAPI 556/112/0/0、Gitleaks、差异检查与独立复审通过。两个租约事务各限 2 秒，
默认超时组合的租约下限为 29 秒；worker 关闭时先 drain 再释放 Prisma/S3。只将 repository
implementation + local/test scanner worker validation 标记 `COMPLETE`；HTTP、B3 claim、保护读取/
审计、expire/delete worker、外部告警和生产 rollout 未完成，B2b/B2、B3-B7、M6.3、M6 与 P0 均
不因此完成。完整证据见 `docs/reports/m6.3-b2b-d2-scanner-worker-completion-report.md`。

M6.3-B2b-D3 授权与仓库/local-test 完成记录（2026-07-30）：用户在 D2 后再次要求按严谨工作流
继续，本轮只实施会员凭证初始化、确认和 owner 状态 HTTP。独立 capability 默认关闭，启用要求 D1
S3、D2 ClamAV、显式上传 TTL 与未 claim 数量/字节配额。初始化复用 D0 配额/幂等并由 D1 签发
create-only 目标；确认前以 D1 HEAD + `If-Match` GET 验证真实 bytes，随后 D0 原子排队 scan；状态只
投影 `PENDING/READY/UNAVAILABLE`。

D3 真实 PostgreSQL + Redis + MinIO + ClamAV 4/4、完整 integration 33 文件/274 项和 43 段迁移演练
通过。三条路由绑定会员 token、商城、owner RLS、Redis 读写限流、correlation/no-store/no-referrer
header 与严格响应 allowlist。只将 repository implementation + local/test member evidence HTTP
validation 标记 `COMPLETE`；B3 claim、保护读取/管理员审计、expire/delete worker、外部告警、生产
参数批准和 rollout 未完成，完整 B2b/B2、B3-B7、M6.3、M6 与 P0 均不因此完成。完整证据见
`docs/reports/m6.3-b2b-d3-member-evidence-http-completion-report.md`。

M6.3-B2b-D4 授权与仓库/local-test 完成记录（2026-07-30）：用户在 D3 后再次要求按严谨工作流
继续，本轮只实施 expire/delete outbox worker 与 provider 删除补偿。独立 capability 默认关闭且与
ClamAV 解耦；loader/result 绑定当前 lease、商城、父 version/status/hold 与完整 ledger，三类对象只用
role-bound delete-only 身份删除。提前截止按数据库 `nextAttemptAt` 有界重试，领域失败固定第 5 次
warning、第 8 次耗尽，lifecycle dead letter 只按权威事实重排或安全失败。

D4 定向单元 6 文件/114 项、真实 PostgreSQL + MinIO 6/6、完整 integration 34 文件/280 项、完整
`verify` 69 文件/545 项与 43 段迁移演练通过；生产依赖 high 退出码 0 并保留 3 moderate，OpenAPI
570/114/0/0、Gitleaks 与差异检查通过。只将 repository implementation + local/test deletion worker
validation 标记 `COMPLETE`；B3 claim、保护读取/管理员审计、legal hold 管理、外部告警、production
versioning/Object Lock/lifecycle 与 rollout 未完成。完整证据见
`docs/reports/m6.3-b2b-d4-evidence-deletion-worker-completion-report.md`。

## 2. 目标与非目标

### 2.1 目标

- 建立独立于订单、支付和物流状态的售后聚合，覆盖仅退款、退货退款、等价换货和商家主动退款。
- 以版本化政策和下单快照表达期限、美妆卫生限制、服装换码、证据要求和退货运费承担。
- 将售后资格、退款资金事实、退货验收、库存恢复和换货履约拆成可审计的独立事实。
- 提供会员中心所需的收藏、商品浏览历史和已有资料/地址/券/订单能力聚合入口。
- 为商城、品牌、类目、商品、促销和优惠券生成同商城、三语、可回退的 Deep Link 与浏览器兜底。
- 只在用户主动点击后调用 Zalo 官方分享界面，不自动、不强迫、不以奖励诱导分享。
- 继续使用同一套代码，通过商城政策、主题和行业规则表达美妆与服装差异。

### 2.2 非目标

- 不把售后状态加入 `orders.status`，不让供应商、物流或退款状态直接改写售后终态。
- 不建立与 M5 `refunds/refund_transitions` 平行的线上退款账，不放宽线上退款容量或幂等约束。
- 不实现多物流退货网络、跨商品换货、自动价差补收/退款、维修、积分补偿或第三方争议仲裁。
- 不提前实现 P1 的 KOL/KOC、佣金、奖励分享和完整归因结算。
- M6 只实现结构化、只追加且可查询状态的隐私请求受理事实，不能把提交表述为访问/删除/注销已
  完成；数据导出、后台履约、匿名化执行和合规 SLA 工作台仍在 M7 实现。
- M6.1 不创建 Prisma 模型、SQL 迁移、controller/service/worker、UI 或外部适配器。

## 3. 必须保持的领域边界

### 3.1 售后、订单与物流

- 售后是独立聚合。原订单状态继续表达主履约；售后时间线通过关联读取并入订单详情。
- 售后只接受当前认证会员本人、当前商城的订单；普通取消继续走 M4 订单取消，发货后的争议
  才进入售后。商家主动退款是受审管理员例外。
- 返件和换货出库必须带 `AFTER_SALE_RETURN`/`EXCHANGE_OUTBOUND` 目的，不能触发原订单的
  `SHIP/DELIVER`。
- P0 换货限定同一商品 SPU、相同数量、仅替换 SKU 选项，不自动处理价差。无库存时进入人工选择
  等待或改为退款，不能创建负库存或假运单。拒绝只允许在返件/验收等副作用发生前；已经验收进入
  `EXCHANGE_PENDING` 后只能保留等待，或在无替换预留/运单事实时追加
  `CONVERT_EXCHANGE_TO_REFUND`，不能借拒绝释放历史容量。

### 3.2 退款与 COD 结算

- ONLINE 售后退款必须复用 M5 退款命令、容量 guard、outbox 和供应商结果。只有 M5 Refund
  `SUCCEEDED` 事实才能把售后结算投影为成功；`REVIEW_REQUIRED` 继续占用容量。
- M5 ONLINE Refund 明确进入 `FAILED/CANCELLED` 时，售后追加对应失败/取消事实并回到可重试的
  `REFUND_PENDING`；失败 Refund 本身保留审计并按 M5 规则释放活动容量。结果不确定仍进入
  `REVIEW_REQUIRED`，不能把失败伪装成成功或无事实重试。
- COD 没有 `payment_attempt`，不得硬塞入现有线上 `refunds`。M6 使用独立、受审的 COD 线下
  结算事实：一名管理员申请，另一名具备结算权限且近期 MFA 的管理员根据脱敏转账证据确认。
  未确认到账前只能是 `PENDING/REVIEW_REQUIRED`，不能标记已退款。
- 所有金额来自不可变订单行和政策的服务端计算，使用安全整数 VND。客户端不提交退款金额、
  供应商引用、手续费、库存动作或结算终态。
- 部分数量的商品退款权益在锁定订单行后，汇总仍占用容量的批准数量/已分配金额，再从剩余权益池
  分配：`floor(available_vnd * requested_quantity / available_quantity)`；申请覆盖全部剩余数量时取得
  全部 `available_vnd`。无副作用早期拒绝同时释放数量和金额容量，历史分配事实不删除；新批准按
  当前占用重新分配，确保折扣余数不丢失、不重复。运费权益单独按冻结政策且每订单最多分配一次。
  售后、订单、支付和 M5 活动/成功退款四层 guard 同时生效；ONLINE 最终仍以 M5 payment
  lock/capacity guard 为准。
- 每个 COD 确认命令必须同时标识售后单和不可猜 `public_settlement_number`；退款命令响应必须返回该
  公开号，使管理工作台无需内部 UUID 即可执行双人确认。同售后/方式最多一个活动 settlement；
  关联 M5 refund 时订单、支付、settlement 和金额必须一致，不能只校验同商城。

### 3.3 库存

- 退款成功、物流退回、退货验收和可重新销售是四个不同事实；前三者都不自动增加可售库存。
- 只有已消费的原订单行、已实际收货、验收为 `RESTOCK_SELLABLE` 的数量可以按商城/仓库/SKU
  恢复。卫生限制、损坏、隔离或报废商品即使退款也不恢复可售库存。
- 恢复使用售后行和验收版本组成的稳定 operation key，锁定原订单行和库存余额；事务还必须汇总
  该售后行所有验收版本的已完成恢复量并与累计可售验收量、原消费量核对。新增验收版本不能绕过
  总量 guard；重复、并发或 worker 重试不能产生第二笔库存动作。换货新品另走 M3 预留、消费、
  释放原语。

### 3.4 政策和历史订单

- M6 新订单按订单行保存发布时的售后政策版本、规范 JSON 和 SHA-256；当前政策变化不影响历史。
- 当前 Prisma 与 M4 快照都没有可证明的售后政策版本。旧订单不得按当前政策伪造回填，统一使用
  `status=REVIEW_REQUIRED` 与 `legacy_policy_review=true`，由授权管理员依据可证明材料形成一次性
  `LEGACY_APPROVE/LEGACY_REJECT` 例外决定和审计；`LEGACY_REVIEW_REQUIRED` 不是另一个状态枚举。
  决定命令只能执行一次并保存规范 policy basis/hash；退货退款/换货批准还必须显式冻结 1-60 天寄回
  窗口与运费承担方，仅退款/商家退款不得携带这两项。legacy 决定不是历史政策快照。
- 生产没有默认硬编码窗口。请求期限使用政策配置的越南本地自然日，从权威 `delivered_at` 起算；
  寄回期限、证据要求、运费承担和卫生例外也必须来自已发布政策版本，legacy 仅使用上述一次性决定。
  退货类批准事务冻结排他的 `return_deadline_at`：批准日不消耗完整寄回日，政策 N 天结束后的下一
  越南本地自然日 `00:00` 到期；买家提交与到期 worker 使用同一聚合锁竞争，恰有一方成功。

### 3.5 会员与分享

- 收藏和商品浏览历史绑定认证会员与商城；匿名访问不写会员历史。浏览历史保留最近 100 个商品，
  只更新最后查看时间，不用重复渲染制造虚假次数。
- 收藏、历史和隐私请求的 member actor RLS 同时校验当前商城、`app.actor_type='member'` 与
  `member_id=app_security.current_actor_id()`；所有列表使用绑定商城/主体/排序键的签名 opaque cursor。
- 分享目标只接受类型、公共 code、locale 和受限来源参数；不接受任意 URL、标题、图片、内部 UUID、
  `store_id` 或会员标识。服务端只解析当前商城已发布/启用对象。
- 活动来源只接受服务端签发的 opaque attribution token，不接受匿名调用者提交原始 campaign 或
  promotion code；图片发布路径显式包含规范商城 code，浏览器/图片 origin 只能来自启动期固定 HTTPS
  配置。
- 三语缺失按统一规则回退越南语。长期分享图片通过受控公开代理或发布产物提供，不持久化短期
  S3 签名 URL。兜底页固定 allowlist origin、转义文本、设置 CSP，禁止 open redirect。
- Mini App 固定使用当前锁定的 `zmp-sdk@2.51.8` 能力：先取得服务端权威卡片并调用
  `getShareableLink`，再只在用户点击事件中调用 `openShareSheet`；取消单独记录，不算成功。
- 创建分享时另签发绑定 short code、初始交互和有效期的 outcome token；完成/取消接口只接受该
  token 并保持幂等，不能让任意访问者污染交互事实，也不能把 SDK 结果当奖励或资金依据。

## 4. 分阶段实施顺序

### M6.1：契约、状态机和专项设计冻结

- 新增 M6 数据字典、权限矩阵、增量 OpenAPI、严格 DTO 和纯领域状态机。
- 冻结售后类型/状态/事件、数量和金额容量、库存恢复、等价换货、分享目标及路径规则。
- 冻结政策草稿/发布/历史/停用和逐商城快照 readiness 控制面；发布、停用与 enforcement 权限互不
  隐含。冻结证据 staged/scan/claim 生命周期、验收结论派生转换和人工复核副作用守卫。
- 只运行单元/契约与仓库静态门禁；不创建数据库表或开放运行时路由。

### M6.2：数据、RLS、迁移与政策快照

> 实施状态：数据模型、RLS、迁移和数据库完整性 guard 已完成；运行时与生产 rollout 不在本阶段。

- 实施版本化售后政策、订单行政策快照、售后/行/转换/证据/结算/库存动作、收藏、历史、最小隐私
  请求受理和分享表。
- 新增复合外键、强制 RLS、只追加保护、数量/金额 guard、最小列级授权和权限目录登记。
- 建立订单行售后政策快照及精确 policy/version/payload/hash 约束，并在 enforcement 启用时以 deferred
  commit guard 要求同事务快照。实际 checkout 政策解析/writer、readiness 和受审启用命令留到 M6.3；
  旧订单只允许显式 legacy review，不回填假历史。
- 售后表保存冻结 `return_deadline_at` 和只追加 legacy decision payload/hash；结算表生成并唯一约束
  `public_settlement_number`。证据表保存 claim/retention 截止点、正交 legal hold、删除状态与重试审计。
- 初始第六段完整性收口要求普通/legacy 售后使用各自安全初态，legacy 决定只能由当前管理员在无副作用的
  初始复核状态写入；售后 header 仅由只追加 transition 原子投影。settlement、返件、共享 shipment、
  inventory restore 和 exchange fulfillment 在写入时锁定聚合并校验允许状态，凭证/COD 使用 NULL-safe
  必填事实，所有跨 RLS definer trigger 固定 owner/search path 并撤销 runtime 直接 EXECUTE。后续五段
  前向修复保留该边界并统一容量占用、不可变分配、M5/M6 锁序和 NULL actor 的 fail-closed 行为。
- rollout 固定为 expand -> 各商城配置/发布默认政策 -> readiness 预检 -> 逐商城启用快照强制。
  M6.2 后所有商城仍为 OFF，不创建生产政策；旧 checkout 保持可用且不产生伪快照，后续售后只能
  显式走 legacy review。M6.3 完成 writer/readiness 后，启用商城若缺少有效默认版本、绑定或同事务
  快照，下单事务必须失败并告警。回滚可关闭新申请入口，但不能删除快照或已受理事实。

### M6.3：售后申请、审核、退货与结算协调

实施顺序细分为 M6.3-A 前置安全收口和 M6.3-B 售后运行时；当前 M6.3-A 与
M6.3-B0/B1/B2a/B2b-D0 仓库实施、B2b-D1 repository + local/test storage validation、B2b-D2
repository implementation + local/test scanner worker validation、B2b-D3 repository
implementation + local/test member evidence HTTP validation，以及 B2b-D4 repository implementation +
local/test deletion worker validation 已完成。B2/B2b、B3-B7 仍未完成或未授权并失败关闭。
A/B0/B1/B2a/D0-D4 的局部交付也不代表 M6.3 完成，详见
`docs/plans/m6.3-implementation-plan.md`。

- B1 只读列表/详情使用严格响应投影和三语历史政策回退；不得因 RLS 没有列级保护而使用宽
  `include`。会员排序固定 `created_at DESC, id DESC`，管理员固定
  `updated_at DESC, id DESC`，两阶段 `limit + 1` 分页保留 PostgreSQL `timestamptz(6)` 微秒精度。
- B1 游标绑定商城、主体、资源、规范筛选、微秒排序键、ID 与过期时间；独立 HMAC key ring 的第一把
  签发、全部验证。会员/管理员读限流分别 60/120 次每 60 秒且绑定商城+主体，成功响应 no-store。
- B2a 七个管理员政策接口使用互不隐含的 read/manage/publish/disable，发布/停用要求近期 MFA、确认词和 reason。
  草稿与当前投影隔离；发布/停用在商城锁下原子同步不可变版本、活动投影与 enforcement readiness，破坏 ready 则整事务回滚。
- B2a 政策/settings 读写使用管理员 120/30 次每 60 秒限流、correlation/no-store 和严格输入；稳定冲突只公开
  `details.reason_code`。两个索引迁移不改写 RLS，保留会员历史政策读取。
- B2b-D0 仅提供凭证数据库生命周期：规范对象 ledger、独立 SYSTEM scope、配额锁、严格
  scan/expire/delete outbox、版本/generation/hold 竞争和 dead-letter reconciliation。D0 不注册凭证
  HTTP/worker、不接对象存储或 scanner、不提供保护 URL，也不启用生产 capability。
- B2b-D1 仅提供独立 storage adapter、失败关闭配置和 local/test MinIO bucket/IAM/真实 bytes 校验。
  adapter 没有 API/worker 调用方，不消费 D0 outbox；签名 GET、幂等 DELETE 和 magic 校验不能据此
  变成保护读取、删除补偿或 malware scanning 运行时。
- B2b-D2 仅提供内部真实 ClamAV scanner、D1 同流内容复验、scan worker、租约安全投影和持久 scan
  dead-letter 收敛。D2 不注册凭证 HTTP，不实现 B3 claim、保护读取/审计、expire/delete worker、
  外部告警或 production rollout。
- B2b-D3 仅开放默认关闭的会员初始化/确认/owner 状态 HTTP，并连接 D0 配额/scan outbox、D1
  create-only 上传与确认前真实 bytes 校验。它不实现 B3 claim、凭证正文 URL、管理员读取审计、
  expire/delete worker、legal hold 管理、外部告警或 production rollout。
- 买家提交/取消、管理员审核、返件登记与可信物流事实、待验收读取和售后时间线；完整返件验收写路径
  及 exactly-once 库存恢复属于 M6.4。
- ONLINE 通过内部原语关联 M5 Refund，并消费成功/失败/取消/不确定权威结果；COD 使用可从退款响应
  取得公开号的双人确认线下结算事实。
- 所有命令使用商城范围幂等键、expected version、固定锁序和有界串行化重试。
- 在创建任何 `AFTER_SALE_RETURN`/`EXCHANGE_OUTBOUND` 运单前，先把既有 M5 物流读取、命令、
  callback 和 worker 改为显式 purpose-aware；只有 `ORDER_OUTBOUND` 可推进原订单 `SHIP/DELIVER`。
- 实现 checkout 政策解析/快照 writer、逐商城 readiness 预检和受审 enforcement 命令后，才可申请
  启用任何商城；无越南业务/合规批准时仍保持 OFF。

### M6.4：库存恢复与等价换货履约

- 按验收行数量幂等恢复可售库存；隔离/报废不恢复。
- 等价换货预留替换 SKU，失败释放；换货出库与原订单履约事件隔离。
- 不确定、越界、价差或供应商异常进入人工复核。
- 进入人工复核时冻结原阶段的可恢复状态；受审解决命令只能回到同类型记录状态，或在原状态仍为
  `APPROVED/RETURN_PENDING` 且不存在资金、返件在途、验收、库存或换货副作用时拒绝。退款已排队/
  处理中、返件在途、换货预留/出库后只能恢复并协调权威事实，不能借拒绝释放容量。

### M6.5：会员中心、收藏和商品浏览历史

- 复用现有资料、地址、优惠券和订单 API；新增收藏、浏览历史与轻量汇总读模型。
- 提供真实同意撤回和结构化隐私请求受理/查询入口；提交只返回 `SUBMITTED`，不伪装访问、删除、
  匿名化或注销履约已完成。

### M6.6：Deep Link、三语分享卡和浏览器兜底

- 六类目标的权威解析、稳定卡片、短码、兜底页、入站 allowlist 路由和粗粒度交互记录。
- Mini App 主动分享、SDK 不可用降级和双商城/三语真机矩阵。

### M6.7：工作台、并发、安全与阶段收口

- 买家端/管理端三语售后工作台，加载、空、错误、等待、冲突和重试状态。
- 完成跨商城/会员、RBAC/MFA、证据授权、并发退款/恢复/换货、XSS/open redirect 和 E2E 回归。
- 真实支付/物流/Zalo 证据仍保持独立 M5/M6 外部门禁，不以 Web E2E 替代。

## 5. 涉及模块与文件

- `packages/domain/src/after-sales.ts`：售后/证据状态、数量/金额容量、验收、库存恢复和等价换货纯规则。
- `packages/domain/src/share.ts`：分享目标、locale 回退和固定 Mini App 路径规则。
- `packages/domain/src/privacy.ts`：隐私请求受理、人工补充和履约终态的纯状态机。
- `packages/contracts/src/after-sales.ts`、`member.ts`、`share.ts`：严格 Zod DTO。
- `packages/config/src/index.ts`、`packages/integrations/src/after-sale-evidence-storage.ts`：D1
  server-only 配置与专用 storage adapter；不与 catalog/content provider 复用。
- `.env.example`、`.env.test.example`、`docker-compose.yml`、`infra/minio/`：D1 local/test bucket、
  最小身份、幂等 bootstrap 与版本控制从未启用门禁。
- `packages/database/prisma/`：从 M6.2 起新增 schema、前向迁移、回滚门禁和种子权限目录。
- `apps/api/src/after-sales*`：从 M6.3 起实现售后运行时 API。
- `apps/api/src/member*`：从 M6.5 起实现会员运行时 API。
- `apps/api/src/share*`：从 M6.6 起实现分享运行时 API。
- `apps/worker/src/after-sales*`：退款事实、换货履约和补偿协调；外部 HTTP 不持数据库锁。
- `apps/mini-app`、`apps/admin-web`：从 M6.5 起交付三语、移动优先和可访问 UI。
- `docs/api/openapi.m6.yaml`、`docs/database/m6-data-dictionary.md`、
  `docs/security/m6-permission-matrix.md`：M6.1 冻结契约。

## 6. 迁移、兼容和回滚

- M6 使用新增表和 nullable/default 安全的向前迁移；不改写 M4/M5 历史订单、退款、运单或库存流水。
- 新运单目的默认 `ORDER_OUTBOUND`，确保旧数据不被改写。M6.3-A 已让既有 M5 订单物流查询、
  命令、callback、worker 和供应商事实显式传递本地可信 purpose；订单 API 固定只处理
  `ORDER_OUTBOUND`，非订单 purpose 不生成原订单 `SHIP/DELIVER` 事件且不能复用旧建单 worker。
- M6.2 已通过明确本地数据库 drop/recreate 后的 fresh deploy、M2-to-current、重复 deploy、
  down/重新前滚、RLS、列级权限和 PostgreSQL catalog 约束。`prisma migrate reset` 遇到
  `app_security` 残留对象的尝试不计成功证据；Prisma 无法表达的跨行容量 guard 使用审查过的原生 SQL。
- `down.sql` 只允许无 M6 售后、结算、证据、库存、收藏/历史、隐私请求或分享事实的 local/test scratch。
  有事实时以 SQLSTATE `55000` 拒绝；生产只允许向前修复。
- B1 的 `20260728110000_m63_b1_after_sale_admin_read_index` 只新增管理员无 status 列表所需的
  `(store_id, updated_at DESC, id DESC)` 索引；应用回滚后可保留，删除时只执行其精确 `down.sql`。
  Prisma 同时补记数据库从 M6.2 起已有的 `after_sale_refunds(store_id, settlement_id)` 唯一约束，
  只修复 schema drift，不重复建迁移或改写业务事实。
- B2a 的 `20260729100000_m63_b2a_policy_control_plane` 只新增 policy heads 和 versions 的两个 keyset 索引；
  `down.sql` 只删除这两个索引，不修改 RLS 或事实。ACTIVE-only RLS 会破坏 B1 会员历史政策读且不能隐藏 head 草稿列，因此不采用。
- B2a 只读兼容性预检以 `REPEATABLE READ` 分批复验既有 code、草稿/hash/products/head、不可变版本/三语/assignment/标量与时间。
  本地测试库已通过（`policies=0, versions=0`）；路由 rollout 前必须针对每个精确目标库重新执行并留证，失败时只允许受审前向修复。
- B2b-D0 的 `20260729120000_m63_b2b_d0_evidence_lifecycle` 只允许在 evidence files/transitions、
  evidence outbox/idempotency 事实全空时前滚；非空以 `55000` 失败，不能猜测对象状态。`down.sql`
  额外检查 ledger，只允许五类事实全空的 local/test 恢复精确 M6.2 约束；生产或已有凭证事实环境只
  允许向前修复。应用回滚必须保留该底座，直到未来兼容 worker 把对象与消息收敛至安全终态。
- B2b-D1 不增加 schema、RLS 或迁移；M2→current 保持 43 段。应用回滚将 evidence provider 保持
  disabled 即可；MinIO bootstrap 可幂等重跑，但不得递归删除 bucket 作为回滚。未来已有真实对象时，
  只能沿 D0 ledger 与兼容 worker 收敛。
- 应用回滚可关闭新建售后/分享入口，但必须保留兼容 worker 处理已有退款、结算、库存预留和运单至终态。

## 7. 风险、外部依赖和停止条件

- 美妆卫生、开封例外、售后期限、证据、运费承担和服装换码规则需越南业务/合规人员确认后才可
  发布生产政策；local/test 规则不是法律意见。
- COD 真实退款渠道、收款信息保存、财务复核和到账凭证尚无生产方案；实现必须默认禁用并保持
  `REVIEW_REQUIRED`，不能使用永远成功的手工按钮。
- M5 外部支付、退款、GHN、结算和 Zalo 宿主仍未验收。若真实契约改变 M6 假设，先更新本计划、
  数据字典、OpenAPI、迁移和安全测试。
- M6.2 只交付数据事实边界；其历史范围保持不变。当前后续运行时已新增 B1 会员/管理员售后列表与详情，并完成 B2a 七个
  政策管理接口；D0-D2 分别完成数据库生命周期、storage 和 scanner 底座，D3 开放默认关闭的会员
  初始化/确认/owner 状态 HTTP，D4 接通 local/test 到期与物理删除补偿。收藏、历史、隐私、分享以及售后申请/取消/审核/凭证正文保护读取/
  返件/退款/结算仍未交付；表、原语、权限目录、只读响应或政策控制面存在不等于真实凭证能力、售后写路径或完整产品可用。
- 证据对象视为敏感且不可信；必须限制类型、magic bytes、大小、数量、扫描状态、保留期和下载授权。
  到期立即停止普通访问；无 legal hold 时幂等删除原件、衍生物与扫描临时对象，失败有界重试并告警；
  legal hold 只延迟删除，不延长普通访问，删除后仅保留受 RLS 保护的最小审计元数据。会员和普通
  管理员响应只投影 `PENDING/READY/UNAVAILABLE`，不得区分隔离、删除中、删除失败或已删除。
- D0 已实现上述规则的数据库形状、配额/版本/消息/删除 guard；D1-D4 已在 local/test 接通真实 bytes
  校验、扫描、会员 confirmation 和删除补偿，但仍没有保护读取审计、legal hold 管理或外部告警。
  不得把 D4 MinIO 测试列为保护读取、production versioned-object 物理删除、生产 IAM/KMS/lifecycle 或 retention 的
  验收证据。版本化 bucket 物理删除和 AWS 最小 read IAM 不存在对象 `403` 语义仍阻塞生产。
- M6.3-A 已按重新授权关闭 checkout enforcement 与既有 shipment purpose 前置风险；最终静态、
  浏览器、交付候选敏感信息和生产依赖 high 门禁已通过，3 项 moderate 已明确结转。A 已完成，
  但不自动进入 M6.3-B。

## 8. 测试与验收

- 单元：所有合法/非法状态转换，类型守卫，终态不可重开，安全整数、数量/金额容量、库存恢复、
  寄回截止点和证据 legal hold/删除门禁，以及同 SPU 等价换货；分享类型、code、locale 回退与路径注入。
- 集成：RLS/复合 FK、同订单行多售后并发容量、退款/结算幂等、库存只恢复一次、换货预留释放、
  返件不推进原订单、证据授权和旧订单 legacy review。
- API 安全：商城/会员 IDOR、严格 DTO、金额/状态/退款/库存字段篡改、幂等键冲突、RBAC/MFA、
  凭证越权、凭证内部状态投影脱敏、分享目标投毒、XSS、open redirect、限流和错误脱敏。
- B1 读取：四个 GET 的严格 select、双层 store/owner/RBAC + FORCE RLS、两阶段 `limit + 1`、六位
  微秒 tuple seek、HMAC key ring 轮换/scope、三语回退、敏感字段不可达、60/120 限流、no-store 与
  correlation。B1 无 UI，不能用既有浏览器 E2E 冒充售后 UI 或 Zalo 真机证据。
- B2a 政策：规范 payload/hash、权限互不隐含、近期 MFA、strict DTO、双商城目标、幂等复放/异参、ACTIVE 草稿不污染 checkout、
  并发目标冲突、不可变历史、enforcement 下发布/停用安全回滚、游标跨资源/跨 policy 重放、30/60 写限流与完整审计。
  仓库只读兼容性预检已在本地测试库通过；目标库 rollout 前仍必须再执行并留证。B2a 无 UI，专项浏览器 E2E 为 `NOT_APPLICABLE`。
- B2b-D0：专用 SYSTEM actor/scope 与越权拒绝、owner/cross-store FORCE RLS、对象 ledger/path/hash、
  数量/字节并发配额、确认+scan outbox 原子性、generation/version 乱序、claim/普通访问/retention、
  hold 与删除竞争、第五次告警/第八次耗尽、scan/expire/delete dead-letter 安全收敛和消息敏感字段
  不泄漏。D0 无 UI/HTTP/真实对象/scanner，专项 E2E 为 `NOT_APPLICABLE`，外部验收为
  `NOT_RUN/BLOCKED`。
- B2b-D1：config/integrations 65/65、真实 MinIO 7/7、完整 integration 31 文件/250 项和 43 段迁移
  回归通过；覆盖四种真实对象、create-only 签名、metadata/content 欺骗、content/evidence 与三身份
  反向 IAM、幂等删除和最终无残留。初始化连续两次通过且 evidence bucket 版本控制必须从未启用。
  D1 无 UI/HTTP，专项 E2E 为 `NOT_APPLICABLE`；production provider/versioning/Object Lock、scanner、
  worker 与 rollout 为 `NOT_RUN/BLOCKED`。
- E2E：双商城三语仅退款、退货退款、换货、收藏、历史、隐私入口、六类分享目标和异常恢复。
- 真机：Android/iPhone 中由用户主动分享并打开正确商城、语言和对象；Web 预览不替代宿主证据。
- 阶段门禁：定向测试、`corepack pnpm verify`、相关集成/E2E、迁移演练、生产依赖审计、Gitleaks、
  `git diff --check` 和最终高风险差异审查。未运行项必须说明原因。

B2a 仓库最终证据：`verify` 完整通过（60 个文件/427 项单元测试、格式/lint/typecheck、生产构建、Prisma validate），完整 integration
29 个文件/234 项，M2→current 42 段 fresh/redeploy/down-forward/fingerprint/guard 演练通过；生产依赖 high 门禁退出码为 0，保留 3 项 moderate 公告；
OpenAPI YAML 重复键为 0，本地引用 556 个、唯一目标 112 个、外部引用 0，但仓库无专用 OpenAPI 3.1 语义 linter；Gitleaks v8.24.3 的 tracked diff 与
13 个 untracked 候选通过，pathless stdin 只对固定非密钥 `M63_IDEMPOTENCY_KEY_SECRET` 使用精确 allowlist，未放宽规则；`git diff --check` 和独立高风险复审通过。
首轮全仓 ESLint 在本机约 2 GiB 默认堆下 OOM，临时以 `NODE_OPTIONS=--max-old-space-size=4096` 重跑后通过，未修改运行配置。B2a 无 UI，专项 E2E 为
`NOT_APPLICABLE`。上述证据完成 B2a 仓库实施，不替代目标库逐库 preflight，也不完成 B2/B2b 或 M6.3。
D0 的独立最终证据、`NOT_RUN/BLOCKED` 项和限制见
`docs/reports/m6.3-b2b-d0-completion-report.md`；D0 repository implementation 的局部完成同样不
完成 B2b/B2、M6.3 或 M6。
D1 当前证据见 `docs/reports/m6.3-b2b-d1-evidence-storage-completion-report.md`。生产依赖 high 与
OpenAPI 回归、最终 `verify`、Gitleaks 和差异复审均已有通过证据。该局部完成同样不完成
B2b/B2、M6.3、M6 或 P0。
D2 当前证据见 `docs/reports/m6.3-b2b-d2-scanner-worker-completion-report.md`。真实 scanner worker、
租约竞争与死信收敛只在 repository/local-test 边界完成；生产 scanner/storage、claim、保护
读取/审计、expire/delete worker、外部告警与 rollout 继续未完成。该局部同样不完成 B2b/B2、
M6.3、M6 或 P0。
D3 当前证据见 `docs/reports/m6.3-b2b-d3-member-evidence-http-completion-report.md`。会员预上传、确认
与 owner 状态只在默认关闭的 repository/local-test 边界完成；B3 claim、保护读取/审计、删除补偿、
生产参数与 rollout 继续未完成。该局部同样不完成 B2b/B2、M6.3、M6 或 P0。
D4 当前证据见 `docs/reports/m6.3-b2b-d4-evidence-deletion-worker-completion-report.md`。到期、三类
对象 provider 删除、租约/账本补偿与 dead-letter 只在 repository/local-test 边界完成；B3 claim、保护
读取/审计、legal hold 管理、外部告警与 production versioned storage/rollout 继续未完成。该局部同样
不完成 B2b/B2、M6.3、M6 或 P0。
