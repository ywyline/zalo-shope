# M6 售后、会员与分享数据字典

> 状态：M6.1 契约已冻结；M6.2 schema/RLS、M6.3-A、M6.3-B0、B1、B2a、B2b-D0 与
> B2b-D1 repository + local/test storage validation、B2b-D2 repository implementation +
> local/test scanner worker validation、B2b-D3 repository implementation + local/test member
> evidence HTTP validation 与 B2b-D4 repository implementation + local/test deletion worker validation
> 以及 B2b-D5 default-disabled repository implementation + local/test protected-read validation 已完成；
> B3 default-disabled repository implementation + local/test validation 也已 `COMPLETE`。B2/B2b、
> B4-B7、M6.3 与 UI 未完成；生产策略、TTL、对象存储、真实供应商、部署和 rollout 为
> `NOT_AUTHORIZED / NOT_RUN` 并保持失败关闭
>
> 日期：2026-07-31

M6.2 实施使用 `20260727110000_m62_after_sales_member_share_foundation`、
`20260727111000_m62_permission_catalog`、`20260727112000_m62_integrity_and_snapshot_guards`、
`20260727113000_m62_integrity_forward_fix`、`20260727114000_m62_runtime_member_scope` 与
`20260727115000_m62_integrity_closeout` 六段基础迁移，以及
`20260727116000_m62_capacity_allocation_closeout`、
`20260727117000_m62_capacity_allocation_runtime_fix`、
`20260727118000_m62_capacity_allocation_expression_fix`、
`20260727119000_m62_order_lock_order_closeout` 与
`20260727120000_m62_capacity_scope_and_approval_occupancy_fix` 五段前向修复。十一段迁移建立 30 个
商城模型/表及 Prisma 复合关系，并收口请求/批准容量、不可变订单级分配、M5/M6 共享锁序、
definer fail-closed scope 与批准占用；当时定向数据库 38/38 和 35 段 M2-to-current、重复部署、
down/重新前滚及回滚门禁演练已通过。该 M6.2 证据只证明数据事实边界，不代表 M6.3-B API、worker
或 UI 已交付。

M6.3-A 追加四段前向迁移：`20260728100000_m63_policy_snapshot_category_resolution` 把快照数据库
guard 对齐到“商品覆盖 → 最近主类目祖先 → 商城默认”，
`20260728101000_m63_policy_settings_rows` 为既有商城建立稳定 OFF 设置行，
`20260728102000_m63_policy_settings_lock` 提供仅锁定当前商城设置行的窄 definer 函数，
`20260728103000_m63_policy_settings_provisioning` 通过 `stores_after_sale_setting_provisioner` 为以后新增
商城自动建立同样的 OFF 行。定向 M6.2 数据库测试 39/39，以及共 39 段迁移的 M2→当前、重复部署、
fresh、down/重新前滚与 SQLSTATE `55000` 门禁演练已通过；`verify`（54 个文件/381 项单元测试）、
21/21 E2E、交付候选 Gitleaks、`git diff --check` 与生产依赖 high 门禁均通过；审计另有 3 项
React Router moderate 公告并已明确结转。M6.3-A 完成仍不构成生产启用依据。

M6.3-B0 追加 `20260728104000_m63_b0_after_sale_contract_guards`：为非 legacy 售后 header
增加精确 `policy_id/policy_version_id`，约束每一条售后行与同一不可变政策/version/payload/hash
匹配；统一申请与逐行审批的整数 VND 余数 guard；把会员返件提交收口为仅 `START_RETURN`；并为
售后 transition 增加独立、窄权限 SYSTEM scope/RLS/事件 allowlist。对应 `down.sql` 仅允许无售后
运行时事实的 local/test，存在事实时以 SQLSTATE `55000` 拒绝。领域/契约、数据库、完整 integration、
迁移演练、`verify`、依赖审计、Gitleaks、差异检查与最终高风险复审等适用门禁已验证，证据见
`docs/reports/m6.3-b0-completion-report.md`。B0 未新增运行时或 UI，未执行或声称专属 E2E；B0 完成
当时 B1-B7 运行时均未开始、未授权，该历史证据保持不变。

M6.3-B1 随后只实现会员/管理员售后列表与详情四个 GET。它复用既有售后事实而不增加业务列，以
严格字段投影、两阶段 `limit + 1` keyset 分页、PostgreSQL 六位微秒 tuple seek、可轮换 HMAC key ring、
RBAC/owner scope + FORCE RLS、Redis 商城+主体读限流及 `private, no-store` 响应收口读取边界。B1
新增管理员无 status 查询索引，并把数据库已有的售后退款链接唯一约束同步回 Prisma；不开放任何
写路径、UI、worker、生产政策/启用、供应商调用、部署或发布。

M6.3-B2a 在现有政策表上实现 policy heads 列表/详情、草稿 `PUT`、不可变 versions 列表/详情、发布和停用
七个管理员接口。新迁移 `20260729100000_m63_b2a_policy_control_plane` 只增加 heads/versions 的两个 keyset 分页索引，
不增加业务列、不改写 RLS、不变更任何政策、settings、活动投影、快照或售后事实。保留既有 tenant RLS 是为了让 B1 会员
继续读取售后已绑定的停用/被替换历史版本；不采用会破坏历史读且仍不能提供列级草稿隔离的 ACTIVE-only RLS 改写。仓库已增加
只读 B2a 兼容性预检，在本地测试库通过且证明 `policies=0, versions=0`；适用仓库门禁均已完成，B2a 仓库实施标记 `COMPLETE`。
任何目标库 rollout 前仍要逐库重新执行并留证；B2a 收口时 B2/B2b、B3-B7、M6.3、UI、生产政策与
启用/部署仍未完成或未授权，后续 B3 局部完成不改写该历史范围。

M6.3-B2b-D0 追加 `20260729120000_m63_b2b_d0_evidence_lifecycle`。该迁移补齐 evidence
上传/确认/扫描/普通访问/删除耗尽字段，新建规范对象 ledger `after_sale_evidence_objects`，为 evidence
transition 增加 correlation ID，并用独立 `after-sale-evidence-lifecycle` SYSTEM scope、FORCE RLS、
列级授权、生命周期/ledger 触发器和 deferred outbox commit guard 收口数据库写入。D0 的初始化、
确认、SYSTEM 重扫请求、scan 结果、transaction-scoped claim、到期、逐对象删除、失败退避与 dead-letter reconciliation
原语均已加入仓库，但没有 HTTP、worker、对象存储、真实 scanner、保护 URL 或生产配置。目标库必须
先以只读 preflight 证明 evidence/transition/outbox/idempotency 四类事实均为零；非空时迁移以
SQLSTATE `55000` 停止并要求受审前向修复。D0 仓库完成不等于 B2b/B2 或 M6.3 完成。

M6.3-B2b-D1 不增加 schema、RLS、数据库函数或迁移；M2→current 仍为 43 段且迁移演练已通过。
D1 在 integrations/config/infra 层增加独立 evidence S3-compatible adapter、失败关闭配置和 local/test
MinIO 最小 IAM/真实 bytes 校验，但没有把 provider 接入 D0 confirm/delete 原语、HTTP 或 worker。
因此数据库中仍不存在由 D1 自动形成的上传验证、扫描、保护读取或 provider 物理删除事实。

M6.3-B2b-D2 已接入 D1 同流读取、真实 ClamAV adapter、scan outbox handler、租约绑定结果投影和
持久 scan dead-letter 收敛，并完成适用测试、全仓门禁、文档与独立复审。D2 不增加 schema、迁移、
RLS、grant、trigger、enum 或 OpenAPI runtime status，迁移总数继续是 43。该局部只标记为 repository
implementation + local/test scanner worker validation `COMPLETE`；完整 B2b/B2、B3 claim、HTTP、
保护读取/审计、expire/delete worker 与生产 rollout 不在该结论内。

M6.3-B2b-D3 随后开放默认关闭的会员初始化、确认和 owner 状态 HTTP，把 D0 生命周期/配额/scan
outbox、D1 create-only 上传与确认前真实 bytes 校验、D2 scanner 接成 local/test 链路。D3 不增加
schema、迁移、RLS、grant、trigger、enum 或 STORE 权限，迁移仍为 43 段。该局部只标记 repository
implementation + local/test member evidence HTTP validation `COMPLETE`；B3 claim、凭证正文保护读取/
管理员审计、expire/delete worker、生产参数批准与 rollout 不在该结论内。

M6.3-B2b-D4 不修改数据库形状，而是把 D0 已冻结的 expire/delete、ledger、删除失败退避与 dead-letter
原语接入 worker。新增 lease-bound 原语在 provider 网络调用前后复核当前商城、outbox owner/version/
未过期 lease、evidence version/status/legal hold 与完整活动 ledger；成功和失败投影都不能绕过这些
条件。M2→current 仍为 43 段。该局部只标记 repository implementation + local/test deletion worker
validation `COMPLETE`；生产 versioned storage、legal hold 管理、保护读取/审计与外部告警不在结论内。

M6.3-B2b-D5 以第 44-48 段迁移建立默认关闭的 member/admin 保护读取、锁后授权/到期重验和管理员逐次
审计边界；其 repository implementation + local/test validation 已完成，生产 provider/IAM/KMS/lifecycle/
retention 与 rollout 不在该结论内。该历史完成边界见第 16 节。

M6.3-B3 追加第 49 段 `20260731110000_m63_b3_after_sale_commands`，为
`after_sale_transitions` 增加可空 `operation_id`，以复合 FK 绑定同商城、同售后单 operation，并增加每个
case 唯一 `SUBMIT`、创建/取消原子性、提交完整性、授权重验和窄 definer 边界。该段在任何 DDL 前只读
校验四类历史 policy payload 的 reason allowlist 合约，不兼容时以 `55000` 停止且不猜测回填；审批准备
写还通过共享 per-order advisory lock 与 B3 创建串行化。仓库已注册会员创建、
会员取消与管理员商家主动退款三条默认关闭路由；完整 repository/local-test 门禁已通过，状态为
`COMPLETE`，证据见 `docs/reports/m6.3-b3-after-sale-commands-completion-report.md`。
生产策略、TTL、对象存储、真实供应商、部署与 rollout 为 `NOT_AUTHORIZED / NOT_RUN`。

## 1. 统一约定

- 所有商城业务表包含 `store_id uuid NOT NULL` 和 `UNIQUE (store_id, id)`；领域引用优先使用
  `(store_id, id)` 复合外键，全部启用并强制 RLS。
- 金额使用非负 `bigint` VND，API 限制为 JavaScript 安全整数。数量使用正整数并由数据库 guard
  保护跨售后单累计容量。
- 面向用户的售后号、分享短码与内部 UUID 分离。客户端不提交 `store_id/member_id`、退款金额、
  状态、库存动作、供应商引用或任意跳转 URL。
- 售后公开号使用至少 128-bit 服务端随机熵并满足 `^ASC-[A-Z0-9]{16,32}$`；结算公开号继续使用
  `AST-` 前缀。响应 `reason_detail` 仅允许 legacy 已存事实为 null，新申请仍要求 10-2000 字符详情。
- 售后、政策版本、转换、证据检查、结算、库存动作和分享交互属于业务事实；需要修正时追加受审
  事实，不覆盖历史。密钥、完整手机号/地址、收款账户和原始证据内容不进入普通日志或审计 JSON。
- 时间使用 UTC `timestamptz`；售后期限按 `Asia/Ho_Chi_Minh` 自然日和冻结政策计算。

## 2. 领域枚举

### 2.1 售后类型和状态

- 类型：`REFUND_ONLY`、`RETURN_REFUND`、`EXCHANGE`、`MERCHANT_REFUND`。
- 状态：`PENDING_REVIEW`、`APPROVED`、`REJECTED`、`CANCELLED`、`RETURN_PENDING`、
  `RETURN_IN_TRANSIT`、`INSPECTION_PENDING`、`REFUND_PENDING`、`REFUND_PROCESSING`、
  `REFUNDED`、`EXCHANGE_PENDING`、`EXCHANGE_IN_TRANSIT`、`REVIEW_REQUIRED`、`COMPLETED`。
- 买家 UI 可把细粒度退货/退款/换货状态映射为需求附录的统一文案，但 API 和数据库保留精确状态。

命令/权威事实到转换的顺序固定如下；每一行在单个商城范围事务内锁定聚合、校验 expected version、
追加全部转换并只递增一次聚合版本。同幂等键同请求复放返回原结果，不重复追加部分事件：

| 命令或事实          | 起点                                   | 按序追加事件与终点                                                                                                                                    |
| ------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 管理员批准/拒绝     | `PENDING_REVIEW`                       | `APPROVE -> APPROVED` 或 `REJECT -> REJECTED`                                                                                                         |
| legacy 一次性决定   | `REVIEW_REQUIRED`                      | 仅 `legacy_policy_review=true` 且无副作用时，`LEGACY_APPROVE -> APPROVED` 或 `LEGACY_REJECT -> REJECTED`                                              |
| 买家取消            | `PENDING_REVIEW`                       | `CANCEL -> CANCELLED`                                                                                                                                 |
| 买家首次提交返件    | `APPROVED`                             | 只追加 `START_RETURN -> RETURN_PENDING`；同事务保存 `SUBMITTED` 返件事实，会员不能追加权威运输事件                                                    |
| 可信返件运输事实    | `RETURN_PENDING`                       | 经可信物流查询或受审管理员核验后才可 `RETURN_SHIPPED -> RETURN_IN_TRANSIT`                                                                            |
| 寄回窗口到期        | `APPROVED`                             | 仅退货退款/换货且尚未提交返件时，`RETURN_EXPIRED -> REJECTED`                                                                                         |
| 管理员完整验收      | `RETURN_IN_TRANSIT`                    | `RETURN_RECEIVED -> INSPECTION_PENDING`，再按处置派生 `ACCEPT_INSPECTION -> REFUND_PENDING/EXCHANGE_PENDING` 或全拒绝 `REJECT_INSPECTION -> REJECTED` |
| 发起 ONLINE 退款    | `APPROVED` 或 `REFUND_PENDING`         | 前者先 `QUEUE_REFUND -> REFUND_PENDING`；M5 refund/outbox 创建后 `REFUND_REQUESTED -> REFUND_PROCESSING`                                              |
| 发起 COD 退款       | `APPROVED` 或 `REFUND_PENDING`         | 前者 `QUEUE_REFUND -> REFUND_PENDING`；只创建待复核 settlement，不伪造处理中                                                                          |
| 独立确认 COD 到账   | `REFUND_PENDING`                       | `REFUND_REQUESTED -> REFUND_PROCESSING`，`REFUND_SUCCEEDED -> REFUNDED`                                                                               |
| M5 ONLINE 退款成功  | `REFUND_PROCESSING`                    | `REFUND_SUCCEEDED -> REFUNDED`                                                                                                                        |
| M5 退款失败/取消    | `REFUND_PROCESSING`                    | `REFUND_FAILED/REFUND_CANCELLED -> REFUND_PENDING`；保留失败退款事实并释放其 M5 活动容量，允许新幂等键重试                                            |
| 换货改为退款        | `EXCHANGE_PENDING`                     | 无替换预留或出库副作用时 `CONVERT_EXCHANGE_TO_REFUND -> REFUND_PENDING`；保留返件、验收和库存事实                                                     |
| 换货出库/签收       | `EXCHANGE_PENDING/EXCHANGE_IN_TRANSIT` | `EXCHANGE_SHIPPED -> EXCHANGE_IN_TRANSIT`，`EXCHANGE_DELIVERED -> COMPLETED`                                                                          |
| 不确定事实          | 各类型显式允许的非终态                 | `REQUIRE_REVIEW -> REVIEW_REQUIRED`，冻结原状态                                                                                                       |
| 解决人工复核        | `REVIEW_REQUIRED`                      | `RESUME_REVIEW` 回冻结状态；仅无副作用早期状态可 `REJECT_REVIEW -> REJECTED`                                                                          |
| SYSTEM 退款售后收口 | `REFUNDED`                             | `COMPLETE -> COMPLETED`；仅作无新增资金副作用的确定性收口                                                                                             |

### 2.2 其他枚举

- 售后来源：`MEMBER`、`ADMIN`。
- 退货承担方：`BUYER`、`MERCHANT`、`CONDITIONAL`。
- 验收处置：`PENDING`、`RESTOCK_SELLABLE`、`QUARANTINE`、`SCRAP`、`RETURN_TO_MEMBER`。
- 结算方式：`ONLINE_ORIGINAL`、`COD_OFFLINE`、`NO_PAYOUT`。
- 结算状态：`PENDING`、`PROCESSING`、`SUCCEEDED`、`FAILED`、`REVIEW_REQUIRED`、`CANCELLED`。
- 运单目的：`ORDER_OUTBOUND`、`AFTER_SALE_RETURN`、`EXCHANGE_OUTBOUND`。
- 分享目标：`STORE`、`BRAND`、`CATEGORY`、`PRODUCT`、`PROMOTION`、`COUPON`。

## 3. 售后政策和历史快照

### 3.1 `store_after_sale_settings`

每商城必须有且只有一行，包含 `enforce_policy_snapshots boolean DEFAULT false`、
`default_policy_id/current_version_id`、readiness 时间/hash/检查 actor、版本和更新 actor。M6.3-A
迁移为既有商城补齐稳定 OFF 行，并由 `stores_after_sale_setting_provisioner` 在新增商城事务后自动建立
`enforce_policy_snapshots=false, version=1` 的同样行；不会自动创建政策或启用 enforcement。checkout
与受审开关都锁定该稳定行，防止下单过程中开关提交造成半快照订单。

readiness 只从当前商城活动 assignment、不可变政策版本及可执行 checkout writer 计算。hash 显式
绑定版本化运行时能力 `m63-a:product-nearest-category-default:canonical-payload-v1`，因此应用升级不能
沿用与当前 writer 不兼容的旧 ready 事实。`false` 时 checkout 保持兼容并且所有订单行都不写政策
快照；`true` 时必须在同一订单事务内为所有订单行写入快照，任何默认政策、解析、payload/hash 或
写入失败都使整个下单失败关闭，禁止部分写入、静默降级或读取当前政策替代历史。

M6.3-A 只开放 `GET/PUT /v1/admin/after-sale-settings`。GET 使用独立
`store.after-sales.policy.read` 权限并返回服务端计算的 readiness；PUT 使用独立
`store.after-sales.policy.enforce` 权限、近期 MFA、与动作匹配的确认词、reason、expected version、
商城/Header/查询三方一致性，并把 `X-Access-Reason` 传入授权上下文（平台跨商城时强制）。PUT
重新计算 readiness，不接受客户端 ready；幂等键
按商城与 `after-sale.policy.enforce` operation 隔离、只保存 hash 并保留 24 小时，同键异参返回冲突。
成功命令在同一事务记录精确设置 before/after、reason、actor 与 correlation ID 审计。

B2a 收口修正了 settings 既有实现与公共 HTTP 契约的偏差：GET/PUT 现在严格校验 Store-Code、Access-Reason 和 query，
成功响应统一 `Cache-Control: private, no-store` 与 `X-Correlation-Id`，并分别接入管理员 READ 120/WRITE 30 次每
60 秒档位。Redis 不可用时在读取设置或变更 enforcement 之前失败关闭为 `503`；这是 B2a 收口的既有契约修复，
不改变 M6.3-A 的 readiness/enforcement 事务语义。

所有商城仍默认 OFF。M6.3-A 不创建、发布或启用任何生产政策；真实政策审批和最终门禁通过前，不得
直接修改设置表或把 local/test fixture 表述为生产 ready。

### 3.2 `after_sale_policies`

| 字段                 | 类型             | 约束与说明                                            |
| -------------------- | ---------------- | ----------------------------------------------------- |
| `id` / `store_id`    | uuid             | 商城复合唯一，强制 RLS                                |
| `code`               | varchar(64)      | `UNIQUE(store_id, code)`；规范小写业务 code           |
| `category_id`        | uuid nullable    | 同商城类目；空值为商城默认政策，每商城恰一条活动默认  |
| `status`             | enum             | `DRAFT/ACTIVE/DISABLED`；停用不破坏历史版本           |
| `current_version_id` | uuid nullable    | 同商城、同政策版本；发布事务内更新                    |
| `draft_payload/hash` | jsonb/char(64)   | 受 JSON Schema allowlist 的可变草稿；不参与当前解析   |
| `draft_product_ids`  | API 投影         | 实际存独立同商城 draft 关联表；仅发布事务切换活动绑定 |
| `version`            | integer          | 管理配置乐观锁，`>=1`                                 |
| 审计字段             | uuid/timestamptz | 创建/更新管理员和时间                                 |

商品级覆盖已在 M6.2 通过同商城目标关联实施；没有采用 M2 字典中曾规划的
`products.after_sale_policy_code`。M6.3-A checkout 与数据库快照 guard 的解析顺序均固定为商品覆盖、
最近主类目祖先规则、商城默认；同一优先级不能以最后写入隐式决胜。

### 3.3 `after_sale_policy_versions`

只追加，`UNIQUE(store_id, policy_id, version_number)`。字段包括：

- `effective_at`、`request_window_days`、`return_window_days`。
- 四种售后类型开关、`return_shipping_payer`、`unopened_required`、`hygiene_restricted`。
- `damaged_exception`、`wrong_item_exception`、`defect_exception`、
  `exchange_same_product_only=true`、可换属性 code（服装通常为 size）。
- `condition_rules jsonb`，只接受版本化 JSON Schema allowlist；禁止可执行表达式。
- 越南语、中文、英文的政策名称、摘要和买家说明；越南语必填。
- `payload_hash char(64)`、发布管理员和发布时间；发布后拒绝 UPDATE/DELETE。

草稿 `PUT /{policyCode}` 的 path code 是唯一标识，body 不重复提交 code。`product_ids` 是 draft
replace-set，不得在发布前改变 ACTIVE 解析。发布事务原子创建版本、不可变商品/类目 assignment、
更新 `current_version_id/status/version` 并写审计；`DISABLED` 只阻止新订单解析，不破坏历史快照。
`after_sale_policy_draft_products` 以 `(store_id, policy_id, product_id)` 复合 FK 持久化可变草稿集合；
`after_sale_policy_version_assignments` 只追加保存发布版本的 PRODUCT/CATEGORY/STORE_DEFAULT 目标，
CHECK 保证目标列恰好匹配类型。另用 `after_sale_active_policy_assignments` 保存当前解析投影并对
`(store_id, target_type, target_id)` 建唯一约束；STORE_DEFAULT 使用商城级唯一键。发布事务按规范目标
键排序加锁，只能替换同一 policy 的旧投影；目标已由另一 ACTIVE policy 占用时返回 `409`，不能以
最后写入或发布时间隐式取胜。停用原子移除该 policy 的活动投影，但 enforcement 启用时若因此失去
默认或使目标不完整则拒绝。解析只读活动投影指向的不可变 version assignment，绝不直接读取 draft
表。并发发布相同商品/类目必须恰有一个成功，另一个稳定冲突。
政策详情返回独立草稿与当前不可变版本；历史版本通过只读分页/详情接口查询。停用使用独立受审命令
和 `store.after-sales.policy.disable`，不得通过草稿 PUT 篡改状态或删除历史版本。

B2a 现已按上述模型实现读/草稿/发布/停用。规范化顺序固定为冻结售后类型顺序、小写 UUID、字典序 reason code、
`vi/zh/en` 和稳定目标序；三语均必填。发布/停用在商城级 `m62-policy:{store_id}` advisory lock 下再锁 head，发布和生效时间来自
同一事务 `CURRENT_TIMESTAMP`。已启用 enforcement 的商城必须在同事务重新同步 settings readiness，否则整个发布/停用回滚。
读取端会对草稿 payload/hash/product replace-set 和每个版本的 payload/hash/标量/三语/assignment 做一致性复验，不用损坏事实构造响应。
发布/停用审计同时保存 policy 和 settings 的完整 before/after、reason、actor 与 correlation ID。稳定冲突在 HTTP 层只以
`details.reason_code` 公开白名单原因。

### 3.4 `order_item_after_sale_policy_snapshots`

主键/唯一 `(store_id, order_item_id)`；复合引用订单、订单行和政策版本。保存 `policy_code`、
`policy_version_number`、规范 `payload`、`payload_hash` 和 `captured_at`。只有商城 enforcement 为 ON
时，它才在创建订单的同一事务中为全部订单行创建；OFF 时一个快照也不写，ON 时缺少任一行快照则
整笔下单失败。快照不可更新/删除。旧订单不回填；售后单以 `legacy_policy_review=true` 和一次性
受审决定处理。
legacy 决定不写成历史政策版本：`LEGACY_APPROVE/LEGACY_REJECT` 只追加保存管理员、理由、
`policy_basis`、决定时刻和规范 payload/hash。`policy_basis` 只保存经审查的历史规则引用/摘要并加密，
不得写入原始凭证、账户或支付数据。退货退款/换货批准 payload 必须包含 1-60 天的
`return_window_days` 与运费承担方；仅退款/商家退款两项必须为 null。该决定只能写一次，不能被当前
活动政策替换或事后改写。无政策快照的 legacy 售后只能以 `legacy_policy_review=true` 和
`REVIEW_REQUIRED` 初态创建；决定写入会锁定售后聚合，必须绑定当前管理员、尚未产生普通/返件/
换货 shipment、结算、验收、库存或换货履约副作用的未触碰初态，并由匹配的
`LEGACY_APPROVE/LEGACY_REJECT` 一次性转换消费。普通 `APPROVE/REJECT`、冒用其他管理员或事后补写
决定均拒绝。

## 4. 售后聚合

### 4.1 `after_sales`

| 字段组   | 关键字段                                            | 约束与说明                                         |
| -------- | --------------------------------------------------- | -------------------------------------------------- |
| 归属     | `id/store_id/order_id/member_id`                    | `(store,order,member)` 复合 FK 证明订单所有者；RLS |
| 标识     | `public_case_number`                                | 至少 128-bit 随机、`ASC-` 规范且全局唯一           |
| 业务     | `type/status/source/reason_code/reason_detail`      | 状态只由领域命令更新                               |
| 人工复核 | `review_resume_status/review_reason`                | 冻结可恢复状态；解决命令不得任选跳转               |
| 政策     | `policy_id/policy_version_id/snapshot/hash/legacy`  | 非 legacy 精确绑定同一不可变版本；不读取当前政策   |
| 寄回     | `return_deadline_at/return_expired_at`              | 冻结排他截止时刻；逾期转换只追加且幂等             |
| 金额     | 商品/运费/其他申请与批准 VND 分项、`currency='VND'` | 服务端从订单事实计算                               |
| 并发     | `version/idempotency_key_hash/request_hash`         | 同键同请求复放；异请求冲突                         |
| 审计     | 发起/审核/完成 actor 与时间                         | 管理动作含原因、MFA 和 correlation ID              |

普通售后只能以 `PENDING_REVIEW` 创建，legacy 售后只能使用上述 `REVIEW_REQUIRED` 初态；初态不得预填
审批金额、审核人、完成时间或履约事实。运行角色没有 header 状态列直改权限，状态、复核恢复状态、版本和
完成时间仅由校验后的只追加 `after_sale_transitions` 通过固定 definer trigger 原子投影。

非 legacy 售后 header 必须保存一个精确的 `policy_id/policy_version_id/policy_snapshot/policy_hash`，且
每条 `after_sale_items` 对应的订单行快照都必须匹配同一 policy、不可变 version、canonical payload 和
hash；任一行缺失、混用政策或只与 header 部分匹配均失败关闭。无快照旧订单或无法证明权威交付事实的
旧订单进入 `legacy_policy_review`；若 legacy 订单行已有快照，则必须每行都存在且身份完全一致，不能把
有/无快照或不同政策事实混成一个售后单，也不能任取第一行政策。

B1 列表不新增业务字段。会员读取复用 `(store_id, member_id, created_at DESC, id DESC)`；管理员带
status 时复用 `(store_id, status, updated_at, id)`，无 status 时使用
`20260728110000_m63_b1_after_sale_admin_read_index` 新增的
`(store_id, updated_at DESC, id DESC)`。page key 的时间值来自数据库 `timestamptz(6)` 六位微秒文本，
不得先降精度为 JavaScript 毫秒 `Date`。

申请窗口的权威 `delivered_at` 按订单行解析：只读取 `shipment_items` 关联的
`purpose=ORDER_OUTBOUND` 运单，要求关联数量精确覆盖原订单行、相关运单均为 `DELIVERED` 且交付时间
可证明；多运单使用可证明事实中的最晚交付时刻。重复/冲突 shipment、数量不守恒、把非订单 purpose
当成交付依据、未签收或缺少时间都不能以订单更新时间或当前时间补猜，旧事实进入受审
`legacy_policy_review`。

活动数量占用状态包括待审核、已批准、退货、验收、退款、换货和人工复核。拒绝/取消只释放尚无
资金、返件在途、验收、库存或换货副作用的未履约数量；已退款、已换货、已完成以及任何不可逆/
结果不确定事实继续占用历史容量，防止同一订单行重复获赔。人工复核拒绝只允许记录恢复状态为
`APPROVED/RETURN_PENDING` 且事务内证明无 settlement、返件、验收、库存、换货及共享售后 shipment
副作用；其他阶段必须恢复并协调权威事实。

退货退款/换货批准事务以越南时区日历计算并持久化 `return_deadline_at`，后续不再读取当前政策。
普通订单使用订单行快照的 `return_window_days`；legacy 订单使用该次不可变例外决定的天数。批准日
不消耗完整寄回日，N 天窗口的排他截止点是批准日之后第 N 个完整越南自然日结束后的下一日
`00:00:00 Asia/Ho_Chi_Minh`。返件提交必须在同一锁内满足 `now < return_deadline_at`；到点后 worker
幂等追加 `RETURN_EXPIRED`，而提交与到期并发只能有一个成功。仅退款/商家退款的截止字段为 null。

### 4.2 `after_sale_items`

`UNIQUE(store_id, after_sale_id, order_item_id)`；冗余不可变 `order_id`，并同时用
`(store_id, after_sale_id, order_id)` 与 `(store_id, order_id, order_item_id)` 复合 FK 证明售后行属于
售后单的原订单。字段包括：

- `requested_quantity`、`approved_quantity`、`received_quantity`、`accepted_quantity`、
  `rejected_quantity`、`restockable_quantity`、`restored_quantity`，逐级守恒且不得超过购买量。
- 申请/批准商品退款 VND、原 SKU/商品/品牌/类目不可变摘要。
- `condition`、`disposition`、验收版本和管理员。
- 换货时的 `replacement_sku_id`、数量；必须同商城、同商品 SPU、等量且不同 SKU。

售后行 INSERT 会锁定当前售后聚合并只允许安全审核初态，防止与 `APPROVE/REJECT` 并发后向终态
追加行。创建时的 `requested_item_vnd` 与审核时的 `approved_item_vnd` 都由服务端在锁定订单行后按同一
整数 VND 余数算法计算，并由数据库逐行复算；客户端创建只提交申请数量，审核只为每个申请行提交
`approved_quantity`，不能提交任何金额。审批必须由当前管理员在待审状态原子写入：零批准数量必须
对应零商品金额，至少一行批准数量为正；换货必须有正数等量 replacement 且不能使用原 SKU。聚合
批准转换再次核对每一行和 header 金额，不能只填运费/其他金额而留下未决定的行。数据库 guard 另在
锁定订单行后汇总所有占用售后行，防止并发超出 `order_items.quantity`。

申请与批准的商品退款权益都锁定订单行，并只汇总其他仍占用容量的售后行：
`available_quantity = ordered_quantity - occupied_quantity`，
`available_vnd = order_item.payable_vnd - occupied_allocated_vnd`，本次分配为
`floor(available_vnd * quantity / available_quantity)`；若本次申请/批准覆盖全部剩余数量则直接分配
全部 `available_vnd`。无副作用早期拒绝从活动汇总释放其数量和金额，但不可变历史分配仍
保留审计；带副作用拒绝、人工复核和终态继续占用。这样释放后可重新使用权益，分次批准的折扣余数
不丢失、不重复，全部活动数量最终仍精确等于行 `payable_vnd`。运费/偏远费权益使用独立订单级分配
事实，按政策决定且每订单最多成功分配一次。数据库同时限制售后批准额、订单累计额、同 payment
的 M5 `REQUESTED/PROCESSING/SUCCEEDED/REVIEW_REQUIRED` 与 COD settlement 占用。

### 4.3 `after_sale_transitions`

只追加保存 `operation_id/from_status/to_status/event/actor_type/actor_id/reason/correlation_id/created_at`，复合
引用售后单。人工复核恢复/早期拒绝分别记录 `RESUME_REVIEW/REJECT_REVIEW`，legacy 一次性决定记录
`LEGACY_APPROVE/LEGACY_REJECT`，不能复用初次审核事件掩盖状态修正。状态修正只能追加受审转换；
终态不得更新或删除。转换写入锁定售后聚合、校验当前 actor、from/to/event、类型图和所需权威事实，
再由 trigger 原子投影 header；运行角色不能直接执行 definer 函数或跳过 transition 改状态。

B0 增加独立 `SYSTEM` 分支，但不把普通 StoreContext 或固定伪管理员 UUID 当成系统身份。事务必须同时
设置 `app.actor_type=system`、`app.system_scope=after-sale-transition`、当前商城、真实系统 actor 与
`app.correlation_id`，写入行必须逐项匹配。allowlist 仅包含 `RETURN_EXPIRED`、
`REFUND_SUCCEEDED/REFUND_FAILED/REFUND_CANCELLED`、`REQUIRE_REVIEW` 与 `COMPLETE`，并继续校验类型图和
返件/settlement 等权威前置事实；审批、拒绝、legacy 决定、COD 确认、`REFUND_REQUESTED`、人工复核
解决及其他人工动作均禁止。`COMPLETE` 只允许 `REFUNDED -> COMPLETED`，不创建 settlement、退款、
库存或其他资金副作用，用于退款事实已确定后的确定性收口。

B3 的创建事件固定为 `SUBMIT`，形状只能是 `NULL -> PENDING_REVIEW` 或 legacy 的
`NULL -> REVIEW_REQUIRED`，不会把 header 自投影一次；每个 case 最多一条且必须通过
`operation_id` 关联其 `MEMBER_CREATE` 或 `MERCHANT_REFUND_CREATE`。会员取消仍为
`PENDING_REVIEW -> CANCELLED/CANCEL`，但同样必须关联 `MEMBER_CANCEL` operation；普通 runtime 不能
直接插入对应 operation 或借 transition 伪造命令完成。

### 4.4 `after_sale_operations`

保存商城、售后单、operation、幂等键 hash、请求 hash、状态、版本、结果摘要和时间。
`UNIQUE(store_id, operation, idempotency_key_hash)`；不保存原始幂等键、证据正文或敏感账户。
B3 另增加 `UNIQUE(store_id,id,after_sale_id)` 供 transition 复合引用。三项 operation 固定为
`MEMBER_CREATE`、`MERCHANT_REFUND_CREATE` 和 `MEMBER_CANCEL`；`result_summary` 保存命令提交时的
case 公开号、状态和版本，幂等重放读取该不可变结果而不是后续 header 状态。三条写 API 由该摘要构造
`id/public_number/status/version` acknowledgement；当前可变聚合只通过 GET 查询。

### 4.5 `after_sale_inspections` 与 `after_sale_inspection_allocations`

- 两张表及既有数据库完整性 guard 继续保留，供后续 M6.4 使用；B0 已从 M6.3-B 公共契约移除
  `inspect-return` 写路由，B1-B5 不得据表存在自行开放验收或库存恢复。
- inspection header 只追加保存售后单、版本、管理员、原因和时间；P0 一次命令必须精确覆盖所有
  等待验收的 approved 行，管理员必须等于当前 actor，禁止只提交部分行或全零数量推进整个聚合。
- allocation 逐售后行保存 `RESTOCK_SELLABLE/QUARANTINE/SCRAP/RETURN_TO_MEMBER` 和正整数数量；
  同 inspection/行/处置唯一，各处置之和必须等于实际 `received_quantity`。
- `accepted_quantity` 是前三种处置之和，`rejected_quantity` 是 `RETURN_TO_MEMBER`，
  `restockable_quantity` 仅等于 `RESTOCK_SELLABLE`；全部拒绝走 `REJECT_INSPECTION`，不能进入退款/
  换货。更正通过新 inspection 版本追加，不能覆盖旧验收事实。
- 完整验收命令必须与 exactly-once 库存恢复原语、累计可售容量 guard 和迁移证据一并在 M6.4 获得
  明确授权；M6.3-B 只提供返件、待验收状态和可信物流事实的读取边界。

## 5. 凭证、结算、库存和换货履约

### 5.1 `after_sale_evidence_files`

- reason code 必须来自冻结政策 allowlist，服务端根据政策的 `evidence_required` 和
  `evidence_required_reason_codes` 决定是否需要凭证。需要凭证时，真实上传类型/大小/magic bytes 校验、
  恶意文件扫描、READY/未占用 claim、受保护短期读取与删除补偿能力必须全部可用；任一能力不可用以
  稳定不可用错误失败关闭且不创建售后单，不能把未扫描、静态成功或手工数据库对象当作凭证。
- 预上传先以 `store_id/member_id/upload_session_id` 和 nullable `after_sale_id` 建立 staged 事实；对象
  key 固定为 `{environment}/{store_id}/staged/{evidence_id}/original`，由服务端生成且不依赖尚不存在
  的售后 ID。初态必须为无扫描/claim/hold/删除事实的 `PENDING`，`scan_generation=0`、
  `version=1`，并带排他的 `upload_deadline_at`。
- D0 新增 `confirmed_at/scan_requested_at/scan_completed_at/scan_generation`、
  `scanner_engine/scanner_engine_version/scanner_signature_version`、
  `ordinary_access_deadline_at` 与 `delete_exhausted_at`。确认只在上传截止前递增 generation 并与 scan
  outbox 同事务提交。D0 当时没有对象存储适配器；D1 收口时虽已提供独立 adapter 和 local/test 真实
  bytes 校验，但尚无 HTTP/worker 调用方把它接入该原语，因此当时的 confirm 事务不读取 provider 对象，
  D1 本身不能表述为已实现的真实上传确认能力。后续 D3 已在默认关闭的会员确认路径中先于数据库事务
  验证真实 provider 对象 bytes，再由事务在锁后复验并与 D2 scan 排队原子提交；数据库 confirm primitive
  本身不跨网络读取 provider。
- 受信 scanner 的规范结果只有精确 `CLEAN` 可把当前 generation 的 `PENDING` 推进为
  `READY_UNCLAIMED`；恶意进入 `QUARANTINED`，超时、不可用或不确定进入 `FAILED`。D0 测试直接调用
  scan 结果投影原语，只证明 generation/version 竞争和状态约束。D2 当前实现用同一 ClamAV
  `zIDSESSION\0` 连接依次执行 request 1 `zVERSION\0`、request 2 `zINSTREAM\0` 和 `zEND\0`；只把
  严格 NUL 帧中的精确 `2: stream: OK` 解释为 `CLEAN`，并验证响应 ID、签名 freshness 与稳定
  engine `clamav`。恶意签名正文会被丢弃。各结果仍必须获得显式清理截止并与 expire outbox 同事务提交。
- 创建售后事务按 evidence IDs 锁行，验证同商城/同会员、认领窗口未过期、扫描通过且从未 claim，
  再一次性写入 `(store_id, after_sale_id, member_id)`；同一凭证不能复用到第二个售后。D0 已提供
  transaction-scoped claim 原语并同时冻结 `claimed_at/ordinary_access_deadline_at/
retention_deadline_at`；后续 B3 已在默认关闭的会员创建事务内调用该原语，但没有独立 claim HTTP
  路由。claim 后对象访问始终通过数据库授权，不依赖可猜对象路径。
- 保存 MIME、byte size、SHA-256、原文件名、扫描结果和
  `PENDING/READY_UNCLAIMED/READY/FAILED/QUARANTINED/DELETION_PENDING/DELETED/DELETE_FAILED`。
  `PENDING` 使用 upload 截止，未 claim 的 scan 结果使用 claim/显式失败保留截止，已 claim `READY`
  使用 retention 截止。已 claim 后再次进入 `QUARANTINED` 仍使用原 retention 截止，不能回退到旧
  claim 截止。`EXPIRE` 只允许相应截止点到达且无活动 legal hold 时进入
  `DELETION_PENDING`；`DELETE_SUCCEEDED -> DELETED`，失败记录稳定错误类别并走
  `DELETE_FAILED -> RETRY_DELETE -> DELETION_PENDING`，使用幂等对象删除和有界退避告警。
  `EXPIRE`、`RETRY_DELETE` 和 `DELETE_SUCCEEDED` 不能走无上下文的通用状态转换；每次尝试都必须重新
  锁行并检查截止点和 legal hold，hold 在首次排队或失败后激活时同样阻止重试/成功提交。
- staged 凭证只能从无扫描结果的安全初态进入扫描流程；可认领状态要求非空且精确的 `CLEAN`
  scan result，NULL 不能绕过。每次状态变化自动追加不可变 transition；删除失败重试必须达到
  `next_delete_attempt_at`。删除策略固定第 5 次形成持久告警条件、第 8 次写
  `delete_exhausted_at` 并停止自动重排；非耗尽重试至少 60 秒、最多 6 小时。删除成功后所有 ledger
  对象 key 以及父行兼容 key 均清空。
- `legal_hold_active/held_at/held_by/reason` 是正交受审事实，不新增可读取状态。M6 普通售后 API 不提供
  设置/解除 legal hold 的入口；M6.2 只为受治理的合规流程保留最小字段。活动 hold 阻止删除，但不延长
  买家或普通管理员的访问窗口；解除后若截止点已过，worker 立即重新排队删除。
- `ordinary_access_deadline_at` 与 `retention_deadline_at` 明确分离。到达普通访问截止点后，即使对象
  因 retention 或 legal hold 尚在，普通访问也统一拒绝。只有 `READY` 且未过期对象可
  签发短期 URL；`PENDING/READY_UNCLAIMED/FAILED/QUARANTINED/DELETION_PENDING/DELETED/DELETE_FAILED`
  均不可读取，响应不能泄露扫描或删除细节。会员和普通管理员 API 不直接投影内部状态：
  `PENDING -> PENDING`，`READY_UNCLAIMED/READY` 在各自有效窗口内投影为 `READY`，其他内部状态或
  已过期对象统一投影为 `UNAVAILABLE` 且 `access_expires_at=null`；访问端点继续使用无差别 `404`。
- `DELETED` 后清除父行对象 key、衍生/扫描临时兼容投影、原文件名、scanner 身份、scan/delete
  错误，只保留商城/售后归属、checksum、byte size、generation、状态转换、原始截止时间、删除时间、
  尝试次数与审计元数据；该最小元数据继续受 RLS 与审计保留策略保护。
- 只允许 JPEG/PNG/WebP 与 MP4，拒绝 SVG、脚本和可执行内容。
- 每单最多 6 个文件；图片单个最多 10 MiB、视频最多 50 MiB。确认时校验 magic bytes、声明类型、
  长度和 checksum。D2 storage consumer 先 HEAD 并要求非空 ETag，再以 `If-Match` GET 锁定同一对象；
  实际长度、SHA-256、magic 和 scanner 输入使用同一条不超过 50 MiB 的有界流。只有 storage 校验和
  scanner 都完整成功才可投影结果。这里仍没有 confirm HTTP/service 调用方；D0 数据库只保存/约束
  声明元数据，magic 通过也不等于 scanner `CLEAN`。
- 买家只能读取本人售后凭证，管理员需要专门权限；短期 no-store URL，每次管理员读取写审计。

### 5.1.1 `after_sale_evidence_objects`

- D0 起该表是新写路径的规范对象清单。字段为 `id/store_id/evidence_file_id/object_role/object_key/
object_key_hash/deleted_at/version/created_at/updated_at`；角色只允许 `ORIGINAL/DERIVATIVE/
SCAN_TEMPORARY`。父表使用 `(store_id,evidence_file_id)` 复合外键，表启用 FORCE RLS。
- 每个 evidence 只允许一个 ORIGINAL；未删除的 SCAN_TEMPORARY 只允许一个；DERIVATIVE 可逐行追加。
  ORIGINAL 固定在 `staged` 路径，衍生/扫描临时对象分别固定在 `derived`/`scan` 路径，且路径中的商城
  与 evidence ID 必须匹配权威行。`object_key_hash` 必须是 key 的小写 SHA-256，并全局唯一。
- ORIGINAL 只能由同商城 owner member 与 `PENDING` evidence 同事务初始化；DERIVATIVE 和
  SCAN_TEMPORARY 只允许专用 evidence SYSTEM principal 写入。运行角色只能读取/插入以及更新
  `object_key/deleted_at/version/updated_at`，trigger 进一步要求该更新是无 hold、
  `DELETION_PENDING` 下的逐对象删除事实。
- 未删除行必须 `object_key IS NOT NULL AND deleted_at IS NULL`；已删除行必须清空 key 并保留 hash、
  role、version 与删除时间。父 evidence 进入 `DELETED` 前，deferred binding guard 要求所有对象均已
  无活动 key；非 `DELETED` 父行则精确存在一个与父兼容 key 相同的活动 ORIGINAL。
- M6.2 父行 `object_key/derivative_object_keys/scan_temporary_object_key` 暂保留兼容投影。D0 删除
  原语只按 ledger 的稳定集合与 expected object versions 完成数据库删除事实，不能把任意 JSON 数组
  或队列完成当作已删除证明。D1 已提供幂等 `removeObject` adapter 并在 local/test 验证 provider
  success/not-found 语义，但没有 worker 调用它；未来 worker 仍必须先取得 provider 权威结果，再重锁
  ledger 并提交数据库删除事实。

### 5.2 `after_sale_settlements` 与 `after_sale_refunds`

- 本节在 B0 仅冻结 B6/B7 的数据与协调设计。B0 不提取 M5 transaction-scoped refund 原语、不注册
  售后退款 coordinator，也不开放 ONLINE Refund 或 COD 到账确认运行时；表和 guard 存在不等于资金
  流程可用。
- `after_sale_settlements` 保存全局唯一且不可猜的 `public_settlement_number`、售后单、方式、批准金额、
  状态、版本、幂等 hash、申请/确认 actor 和时间；内部主键不作为管理工作台命令标识。
- settlement 冗余不可变 `order_id`；部分唯一索引保证 `(store_id, after_sale_id, method)` 最多一个
  `PENDING/PROCESSING/REVIEW_REQUIRED` 活动事实。退款命令响应必须投影 settlement 公开号；COD 确认
  路由同时携带 case ID 与该公开号，并在商城/售后范围内解析后锁行，不能接受客户端金额或内部 ID。
- ONLINE 结算通过 `after_sale_refunds(store_id, settlement_id, refund_id, amount_vnd)` 关联现有 M5
  `refunds`；链接冗余 order/payment ID，并以复合 FK/约束证明 case、settlement、payment、refund 是
  同一订单。`amount_vnd` 必须等于 M5 refund amount 与 settlement amount，refund 只能被一个售后
  结算占用。它不是第二套退款账。数据库从 M6.2 起已有 `UNIQUE (store_id, settlement_id)`；B1 只在
  Prisma 补记 `@@unique([storeId, settlementId])` 修复 schema drift，不重复创建该唯一索引。
- COD 结算保存脱敏转账引用 digest、加密凭证引用和双人确认；申请人与确认人必须不同。
- COD 结算的转账 digest 与加密凭证引用必须非空，NULL 不能绕过格式/存在性校验；确认 actor 必须与
  申请 actor 不同。
- settlement 写入先锁定售后聚合，并只允许匹配退款阶段或受审恢复阶段的状态；全部活动/成功结算及
  M5 人工复核退款合计不得超过售后批准额、订单可退额和已捕获金额。

### 5.3 `after_sale_inventory_actions`

只追加保存售后行、验收版本、warehouse/SKU、处置、数量和 `inventory_operation_id`。
`UNIQUE(store_id, after_sale_item_id, inspection_version, action_type)`。只有
`RESTOCK_SELLABLE` 可关联 M3 `RESTORE` 操作；退款或运单终态不能创建库存动作。
每次创建动作必须锁售后聚合、售后行、原订单行和库存余额，绑定原订单实际消费的 reservation、
最新完整 inspection、唯一且 tuple/数量精确的 `RESTORE` movement，并按 UUID 无序假设安全地汇总该行
全部 inspection version 的已完成恢复量；汇总不得超过累计 accepted/restockable 和原已消费量，
`after_sale_items.restored_quantity` 必须与只追加 actions 之和一致。新增 inspection version 不能重置
总量或获得第二份容量。

### 5.4 返件和换货

- `after_sale_return_shipments` 保存返件承运商、脱敏运单号、状态、提交人和时间；P0 可记录买家
  自寄事实，不把未验证文本当作供应商权威运输/签收。首次会员提交在一个聚合锁事务内校验本人、
  类型、`APPROVED` 和 `now < return_deadline_at`，写入并占用 `SUBMITTED` 记录且只追加
  `START_RETURN -> RETURN_PENDING`；与 `RETURN_EXPIRED` 并发只能一个成功，幂等复放不得新增记录或
  transition。会员不能追加 `RETURN_SHIPPED` 或把记录直接写成 `IN_TRANSIT/DELIVERED`；只有后续可信
  物流查询或受审管理员核验事实可以追加 `RETURN_SHIPPED/RETURN_RECEIVED`。
- `exchange_fulfillments` 保存售后行、replacement SKU、warehouse、预留、出库运单、状态和版本。
  替换库存使用 `source_type='AFTER_SALE_EXCHANGE'` 的 M3 预留；出库消费，取消/超时释放。INSERT 和
  每次 UPDATE 都锁定售后聚合并核对 `EXCHANGE_PENDING/EXCHANGE_IN_TRANSIT` 或相应复核恢复状态；
  转退款后即使只更新时间戳/版本也不能重新推进预留、出库或交付。
- M6.2 已选择扩展共享 M5 `shipments`：新增非空 `purpose`、nullable `after_sale_id`，旧数据和未显式
  传值的新订单运单默认为 `ORDER_OUTBOUND`；复合 FK、shape/type guard 和活动 purpose 唯一索引约束
  售后归属。非订单 shipment 写入会锁定售后聚合并限制到对应允许状态；`RETURN_EXPIRED`、
  `REJECT_REVIEW`、普通拒绝或 `CONVERT_EXCHANGE_TO_REFUND` 与 raw shipment 并发串行后不能留下非法
  售后物流事实。M6.3-A 已把本地可信 shipment `purpose` 显式贯穿查询、命令、callback hint、worker
  和供应商权威事实应用；purpose 必须从当前商城本地运单事实解析，不能由 callback body、客户端或
  供应商响应选择。只有 `ORDER_OUTBOUND` 可推进原订单 `SHIP/DELIVER`；
  `AFTER_SALE_RETURN`/`EXCHANGE_OUTBOUND` 事实不得复用原订单推进路径。M6.3-A 本身不创建这两类
  售后运单，它们仍由后续获批的售后协调切片负责。
- `shipping_operations` 在取消与建单并发时继续以 `PENDING` 表达“供应商单号尚未写回”，worker 将
  `SHIPMENT_PROVIDER_REFERENCE_PENDING` 交回可靠 outbox 重试；只有 operation/关联 shipment 真缺失
  才进入永久失败。该暂态不会把 provider reference 缺口误记为不可恢复业务失败。

## 6. 会员能力

### 6.1 `member_favorites`

主键/唯一 `(store_id, member_id, product_id)`；复合 FK 阻止跨商城。`PUT` 幂等创建，`DELETE`
真实删除当前会员收藏。索引 `(store_id, member_id, created_at DESC, product_id)`。

### 6.2 `member_product_views`

唯一 `(store_id, member_id, product_id)`，保存 `first_viewed_at/last_viewed_at`。商品详情成功展示后
由认证会员幂等 upsert；不保存匿名身份或每次事件计数。每会员/商城最多 100 条，事务内稳定裁剪；
支持单条删除和全部清空。

favorites/history 的 member policy 在 `USING` 与 `WITH CHECK` 同时要求商城上下文、
`current_setting('app.actor_type')='member'` 和 `member_id=app_security.current_actor_id()`；普通管理员
不获得 store-wide 直读。列表 cursor 是 `c1_` 前缀的签名 opaque token，绑定商城、会员、时间排序键
和 product tie-breaker；解码后仍显式查询当前 store/member，不回显内部 UUID。

### 6.3 `privacy_requests` 与 `privacy_request_transitions`

- 状态固定为 `SUBMITTED`、`UNDER_REVIEW`、`ACTION_REQUIRED`、`IN_PROGRESS`、`COMPLETED`、
  `REJECTED`、`CANCELLED`。转换固定为：`SUBMITTED --START_REVIEW--> UNDER_REVIEW`、
  `SUBMITTED/UNDER_REVIEW --REQUEST_ACTION--> ACTION_REQUIRED`、
  `ACTION_REQUIRED --PROVIDE_ACTION--> SUBMITTED`、`UNDER_REVIEW --START_FULFILLMENT--> IN_PROGRESS`、
  `UNDER_REVIEW/IN_PROGRESS --REJECT--> REJECTED`、`IN_PROGRESS --COMPLETE--> COMPLETED`，以及
  `SUBMITTED/ACTION_REQUIRED --CANCEL--> CANCELLED`。履约开始后不能经 ACTION_REQUIRED 绕回可取消状态；
  所有终态关闭。
- M6 只持久化真实受理：`store_id/member_id/public_number/type/status/version`、加密 description、
  幂等/request hash、创建/更新时间；类型为访问、更正、删除、匿名化、注销，初始状态只能
  `SUBMITTED`。提交响应不得声称已导出、删除、匿名化或注销。
- transitions 只追加，记录状态、actor、原因、correlation ID 和审计；契约计划让买家查询本人状态并在
  `SUBMITTED/ACTION_REQUIRED` 阶段取消。M6.2 仅实现 member owner-RLS 和数据库转换投影，尚未开放
  提交、本人查询或取消运行时；其余管理履约转换先冻结但到 M7 才实现。M7 实施管理员履约、数据导出/删除执行、法定保留
  冲突处理和 SLA 工作台。
- 与收藏/历史相同使用 member-owner RLS；描述视为敏感数据，日志/普通审计只记录请求号、类型和
  状态。会员中心继续复用现有 `members`、地址、订单和 `member_coupons`，不复制这些事实。

## 7. 分享

### 7.1 `share_links`

- `id/store_id/short_code/target_type/locale/source_code/verified_campaign_id/verified_promotion_id/created_by_member_id`
  和时间；short code 全局随机唯一，URL 不含会员或 Zalo subject。
- BRAND/CATEGORY/PRODUCT/PROMOTION/COUPON 使用各自 nullable FK 列和 CHECK 保证恰好一个目标，
  STORE 目标全部为空；所有目标使用同商城复合 FK，不采用无约束 polymorphic UUID。
- `mini_app_path` 与浏览器 URL 由固定路由模板生成，不保存客户端任意 URL。失效目标安全回商城首页。
- 创建请求只接受服务端签发、绑定商城/活动/有效期的 opaque attribution token；原始 campaign 或
  promotion code 不入请求。无效/跨商城 token 拒绝，不作为奖励或资金事实。

### 7.2 `share_link_localizations`

主键 `(store_id, share_link_id, locale)`；保存标题、摘要、图片发布产物/源媒体引用、目标版本和
payload hash。越南语必有，中英缺失显式回退越南语。长期图片通过固定 HTTPS 公共代理或 CDN
发布产物提供，对象 key 至少包含规范商城 code 与不可变 payload hash，不保存会过期的签名 URL。

### 7.3 `share_interactions`

可选会员、分享 link、`INITIATED/COMPLETED/CANCELLED/OPENED/FALLBACK_OPENED`、来源、粗粒度
设备类别和时间，只追加且有限保留。SDK 返回只用于体验/基础统计，不作为奖励、佣金或资金事实；
不收集收件人列表。创建响应签发仅绑定 short code、初始 interaction 和有效期的 outcome token，库中
只存 digest；重复完成/取消幂等，跨 link、过期或篡改 token 拒绝。P1 才实现推广归因与佣金。

## 8. RLS、授权与迁移要求

- 会员表策略同时使用当前 `store_id` 和应用层 `member_id` 条件；管理员售后表仍需服务层逐商城判权。
- 运行角色不获得政策版本、转换、证据检查、结算确认、库存动作和分享交互的 UPDATE/DELETE。
- 跨 FORCE RLS 投影或校验所需函数使用受控 definer owner 和固定
  `search_path=pg_catalog, public, pg_temp`；PUBLIC 与 `zalo_shop_runtime` 的直接 EXECUTE 均撤销，运行
  角色只能通过受 RLS 和 trigger guard 的表命令触发。M6.6 分享运行时交付前，runtime 对
  `share_links/share_link_localizations/share_interactions` 的 INSERT 同样撤销。
- `app_security.lock_m63_after_sale_setting()` 是唯一有意保留给 runtime 直接 EXECUTE 的窄 definer
  例外：它只使用 `app_security.current_store_id()`，只返回并 `FOR UPDATE` 锁定当前商城的
  `enforce_policy_snapshots` 布尔值，设置行缺失时失败关闭，不能更新设置或访问其他商城。
- B0 的 SYSTEM transition 使用与 member/admin 分离的 INSERT RLS policy 和 trigger guard；仅在
  `actor_type=system`、专用 scope、当前商城/actor/correlation 全部匹配且 event 位于窄 allowlist 时
  才能写入。所有 B0 definer 校验函数继续撤销 PUBLIC 与 runtime 的直接 EXECUTE，SYSTEM 也不能绕过
  表 RLS/trigger 直接调用函数。
- 权限迁移只登记 M6 code，不自动授予生产角色；local/test seed 可以显式授权系统测试角色。
- 政策 publish、disable 与逐商城 enforcement 是三个独立极高风险权限，互不隐含。
- M6.2 十一段 `down.sql` 检测任一售后、政策快照、结算、凭证、库存动作、收藏/历史、隐私请求或分享
  事实时以 `55000` 拒绝。生产和已有事实环境只允许向前修复。
- M6.3-A 四段 `down.sql` 仅供空事实 local/test：类目解析回滚在存在政策快照或活动 CATEGORY
  assignment 时以 `55000` 拒绝；稳定设置行、锁函数与自动 provisioning 回滚在存在政策/快照或任一
  非默认设置事实时同样拒绝。生产及已有事实环境只允许向前修复；回滚到不具备快照 writer 的应用前，
  已启用商城必须先通过受审命令关闭 enforcement，禁止直接改表。
- B0 的 `20260728104000_m63_b0_after_sale_contract_guards` 只允许在无 `after_sales`、凭证、settlement、
  售后退款链接、库存动作、返件或换货履约事实的 local/test 执行 `down.sql`；任一事实存在即以 `55000`
  拒绝。生产和已有售后事实环境只允许向前修复。该迁移的 M2-to-current、fresh、重复 deploy、
  down-forward、fingerprint 和事实门禁演练已独立验证并记录在 B0 完成报告中，没有沿用 M6.3-A 的
  39 段结果冒充 B0 证据。
- B1 的 `20260728110000_m63_b1_after_sale_admin_read_index` 只新增
  `after_sales(store_id, updated_at DESC, id DESC)` 普通读取索引，不改写售后事实。应用回滚后索引可
  安全保留；如需回滚，只在确认没有 B1 查询依赖后受审执行 `down.sql` 删除该精确索引。生产迁移仍
  遵循向前部署，不因 Prisma schema drift 修复重复创建既有唯一索引。
- B2a 的 `20260729100000_m63_b2a_policy_control_plane` 只增加
  `after_sale_policies(store_id, updated_at DESC, id DESC)` 和
  `after_sale_policy_versions(store_id, policy_id, published_at DESC, id DESC)` 两个普通索引。`down.sql` 只删除这两个精确索引，
  不修改 RLS 或数据事实；应用回滚后索引可保留。试图以 ACTIVE assignment 限制政策/version SELECT 的 RLS 改写被明确否决，
  因为它会破坏 B1 已绑定历史政策的会员读取，且无法隐藏 ACTIVE head 行内的 draft payload。
- B2a 的只读兼容性预检通过受控 migration/maintenance `DATABASE_URL` 在 `REPEATABLE READ` 中分批校验 code、严格且规范的 draft/hash/products/head，
  以及所有不可变版本/三语/assignment/标量和 `effective_at=published_at`。事务设置 `row_security=off`；它不绕过 RLS，
  而会让可能被策略过滤的 runtime 连接以 `42501` 失败，防止零行假通过。本地 owner 连接已通过且 runtime RLS 连接已验证失败关闭；
  本地测试库结果为 `policies=0, versions=0`；
  staging/production 在注册路由前必须对精确目标库再执行并留证，预检失败时禁止 rollout 并只允许受审前向修复。
- D0 的 evidence SYSTEM principal 与 B0 的售后 transition SYSTEM principal 完全分离。只有
  `actor_type=system`、`system_scope=after-sale-evidence-lifecycle`、当前商城、稳定 actor
  `00000000-0000-4000-8000-000000000006` 和非空 correlation ID 同时匹配，才可写 lifecycle/ledger
  SYSTEM 事实。普通 StoreContext、管理员 UUID 或 `after-sale-transition` scope 均不能提升为该身份。
- D0 的 outbox trigger 只接受 `after-sale.evidence.scan.requested`、
  `after-sale.evidence.expire.requested` 与 `after-sale.evidence.delete.requested`；aggregate 固定
  `AFTER_SALE_EVIDENCE`、event version 固定 1，payload 必须精确为
  `store_id/evidence_id/expected_version`。deferred commit guard 要求初始化、确认、重扫请求、scan 结果、claim、
  首次到期和可重试删除失败与对应消息原子提交。对象 key/hash、MIME、checksum、scanner 结果、
  deadline、hold 和供应商错误不得进入 payload。
- D0 前向迁移在 evidence files/transitions、`after-sale.evidence.*`/`AFTER_SALE_EVIDENCE` outbox 或
  `after-sale-evidence-*` idempotency 任一事实存在时以 `55000` 拒绝。`down.sql` 额外检查 ledger，只有
  五类事实全空的 local/test 才恢复精确 M6.2 列、索引、policy、trigger、FK update action 与 grant。
  迁移 preflight 使用 `REPEATABLE READ + READ ONLY + row_security=off`；owner 本地测试库四类事实均
  为 0，runtime RLS 连接按预期以 `42501` 失败关闭。任何 staging/production 目标都必须重新运行并
  归档，生产或已有凭证事实环境只允许受审前向修复。

## 9. M6.3-B1 读取与公共 HTTP 运行时

- B0 冻结的读取契约现由 B1 的 `GET /v1/after-sales`、
  `GET /v1/after-sales/{afterSaleId}`、`GET /v1/admin/after-sales` 和
  `GET /v1/admin/after-sales/{afterSaleId}` 实现。会员查询显式包含当前 `store_id/member_id`，政策
  文案按认证会员 `preferredLocale -> vi`；管理员必须具备 `store.after-sales.read`，显式包含
  `store_id`，locale 按请求值、商城默认、`vi` 回退。两者都叠加 FORCE RLS。
- 列表在单个 `REPEATABLE READ` 事务中先用原生 SQL 取 `limit + 1` 个 page key，再仅对白名单 ID
  使用严格 Prisma `select` 加载响应字段并按 page key 重排。会员固定
  `created_at DESC, id DESC`，管理员固定 `updated_at DESC, id DESC`；下一页在 PostgreSQL 内直接以
  `(timestamptz, uuid)` tuple seek。数据库返回并由 cursor 原样保存六位微秒 UTC 排序键，不经
  JavaScript 毫秒 `Date` 往返。
- 数据库读取和响应投影均使用显式 allowlist，不使用宽关系 `include`。非 legacy 记录必须存在绑定的
  不可变 policy/version 和越南语本地化事实，否则失败关闭；legacy 才允许政策字段为 null。响应使用
  `ASC-[A-Z0-9]{16,32}` 公开号，settlement/退款同样只投影公开号；reason ciphertext、管理员字段、
  evidence 对象 key/扫描与删除细节、transition actor/reason、内部资金引用和供应商原始 payload 不
  进入进程宽查询或 HTTP 响应。
- evidence 只公开 `PENDING/READY/UNAVAILABLE`：未过期 `READY_UNCLAIMED` 使用
  `claim_deadline_at`，已 claim `READY` 使用 `ordinary_access_deadline_at`，两者映射为 `READY`；
  retention 或 legal hold 不能延长普通读取。其余内部状态或过期对象统一为 `UNAVAILABLE` 且
  `access_expires_at=null`。四个成功响应统一
  `Cache-Control: private, no-store`，避免含原因和历史政策的私有数据被缓存。
- 列表游标固定 `c1_` 前缀。`AFTER_SALE_CURSOR_HMAC_KEYS` 是 1–3 把唯一、解码后至少 32 字节的
  base64url HMAC-SHA-256 key ring，第一把签发、全部验证；payload 绑定版本、商城、主体类型/ID、
  resource、规范过滤 hash、六位微秒排序键、tie-breaker UUID 和过期时间。篡改、错商城、错主体、
  错资源/过滤或过期统一返回 `400 INPUT_INVALID`。轮换按“新密钥置首 → 保留旧验证密钥至最长 TTL →
  移除退役密钥”执行。
- B1 读限流固定 60 秒并绑定商城+主体：会员 60、管理员 120；Redis 不可用时失败关闭，超限在查询
  目标前返回不泄露资源存在性的 `429` 与 `Retry-After`。所有响应携带同一个安全
  `X-Correlation-Id`，错误体 correlation 与事务、授权、审计（如发生）和日志保持一致。
- B1 读取的稳定语义为严格输入/游标 `400`、认证失败 `401`、目标商城/权限 `403`、当前主体范围内
  不存在 `404` 和限流 `429`。B1 本身不注册写路由；B2a 只为政策草稿/发布/停用和 settings PUT 启用管理员写
  30 次每 60 秒档位。后续 B3 已把会员写 10 次与管理员写 30 次档位接入三条默认关闭命令；这不改变
  B1 当时的只读结论，也不能据此声称生产申请/取消、审核、返件、退款或 COD 结算可用。

## 10. M6.3-B2a 政策控制面运行时

- 实现的路由仅为 `GET /v1/admin/after-sale-policies`、
  `GET/PUT /v1/admin/after-sale-policies/{policyCode}`、
  `GET /v1/admin/after-sale-policies/{policyCode}/versions`、
  `GET /v1/admin/after-sale-policies/{policyCode}/versions/{versionNumber}`、`POST .../publish` 和 `POST .../disable`。
  B2b 其余能力和 B4-B7 路由仍为 contract-only 或失败关闭；B3 三条路由已在 repository/local-test
  默认关闭条件下实现，当前边界见第 17 节。
- head 列表固定 `(updated_at DESC,id DESC)`，version 列表固定 `(published_at DESC,id DESC)`。两者先读 `limit + 1` 个微秒 page key，
  再对白名单 ID 投影；游标绑定管理员、商城、资源、筛选及 policy code，不能跨资源/跨 policy 重放。
- 草稿创建仅允许 `expected_version=0`；更新、发布和停用要求精确正版本。写命令的幂等 key 只保存 SHA-256，范围为
  商城+操作且保留 24 小时；请求 hash 绑定 policy code 与规范 payload，同键异参稳定冲突。
- 政策读/写分别复用管理员 120/30 次每 60 秒限流，scope 为商城+主体；Redis 故障在读取政策之前失败关闭为 `503`。
  成功响应使用 `private, no-store` 和安全 correlation ID，幂等写额外返回 `Idempotency-Replayed`。
- B2a 仓库实施已完成：`verify`、完整 integration 29 个文件/234 项、M2→current 42 段迁移演练、生产依赖 high、OpenAPI 结构检查、
  Gitleaks、差异检查与独立高风险复审均通过。目标库逐库 preflight 仍是 rollout 前置条件；详见 `docs/reports/m6.3-b2a-completion-report.md`。

## 11. M6.3-B2b-D0 数据库原语与当前边界

- `initializeAfterSaleEvidenceUpload` 只接受 owner member StoreContext、allowlist MIME、服务端范围内的
  byte size/checksum/filename、显式 upload TTL 和未 claim 配额。它先取得商城+会员 advisory quota
  lock，再以数据库权威行汇总数量和字节，原子创建 `PENDING` 父行、ORIGINAL ledger、上传到期
  outbox 和 24 小时幂等事实。返回的 object key 只是未来专用 storage adapter 的内部输入；D0 没有
  签发上传 URL 或写对象。
- `confirmAfterSaleEvidenceUpload` 锁配额与 evidence，校验 owner、expected version、上传排他截止和
  24 小时幂等，然后原子写 `confirmed_at/scan_requested_at`、递增 generation/version 并排队 scan。
  规范 ORIGINAL binding 由 deferred 数据库 guard 保护；但没有 provider HEAD/body/magic 读取，故
  不能证明声明 MIME、长度或 checksum 与真实对象一致。
- `requestAfterSaleEvidenceRescan` 只允许专用 SYSTEM 对已确认且仍为未归属 `PENDING` 的当前版本
  发起同状态重扫；它递增 generation/version、追加带 correlation ID 的 `SCAN_REQUESTED` transition，
  并与新 scan outbox 原子提交。stale 请求只返回未请求，不覆盖当前身份。
- `applyAfterSaleEvidenceScanResult` 只在专用 SYSTEM 事务接受 current generation/version。精确 CLEAN
  必须携带 scanner engine/version/signature identity；恶意或不确定使用稳定 allowlist code 并失败关闭。
  stale/乱序结果返回 no-op，当前状态不被覆盖。该入口是未来 scanner worker 的数据库投影边界，不是
  scanner adapter。
- `claimAfterSaleEvidenceInTransaction` 只供售后创建在其现有商城会员事务中调用：锁 quota、售后聚合和
  排序后的 1–6 个 evidence，要求全部为 owner 的未过期 `READY_UNCLAIMED`，一次性写售后归属、普通
  访问与 retention 截止并排队 retention expire。D0 本身未注册路由；后续 B3 只在默认关闭的
  `POST /v1/after-sales` 事务内调用，因此仍不存在独立可调用的 claim API。
- `begin/list/complete/record...Deletion` 原语只在专用 SYSTEM scope 操作权威行和 ledger；每次都复核
  expected version、截止点、hold 和精确活动对象集合。`complete` 只记录未来 provider 已成功删除或
  已确认不存在后的数据库事实；D0 本身不会调用 provider。失败固定第 5 次告警、第 8 次耗尽，退避
  60 秒起、最多 6 小时。
- `reconcileAfterSaleEvidenceDeadLetter` 只接受同商城、严格消息形状和真实 `DEAD_LETTER`。scan 死信
  把仍待扫描对象收敛为不可 READY 的 `FAILED` 并安排清理；expire 死信按当前权威 deadline/hold
  重排或进入删除；delete 死信进入有界 retry/exhausted。旧版本已有当前身份消息时安全
  `SUPERSEDED`，不得绕过版本/generation/hold 或把死信直接写成成功。
- D0 没有对 OpenAPI 增加 implemented 标记，也没有 API/controller、worker handler、evidence bucket、
  IAM/KMS/lifecycle、真实 scanner、保护 URL、管理员读取审计、外部告警或生产政策/配置。该历史完成
  报告只证明仓库数据层；D1 的后续 local/test storage 进展见下一节。
  B2b、B2、M6.3 和 M6 继续未完成。

## 12. M6.3-B2b-D1 对象存储校验与数据边界

- D1 不新增数据库列、状态、枚举、RLS、grant、trigger、函数或迁移。D0 的 `after_sale_evidence_files`
  与 `after_sale_evidence_objects` 继续是唯一数据库权威事实，M2→current 迁移总数保持 43。
- `AfterSaleEvidenceObjectStorageProvider` 只接受 D0 冻结的 ORIGINAL key
  `{environment}/{store_id}/staged/{evidence_id}/original`，并校验 environment、store/evidence UUID 与
  key 逐段一致；adapter 不从客户端输入生成新 key，也不写数据库。
- create-only 上传把 Content-Length、Content-Type、SHA-256 和 `If-None-Match: *` 全部绑定签名。验证使用独立 read
  身份执行 HEAD + 有界流式 GET，以实际 bytes 复算长度/checksum，并检测 JPEG/PNG/WebP/MP4 magic；
  成功只返回规范 MIME、长度与 checksum，不返回对象 key、URL 或供应商正文。
- D1 local/test MinIO 使用与 content 分离的 bucket 和 upload/read/delete 身份。真实 MinIO D1 7/7、
  定向 config/integrations 65/65、完整 integration 31 文件/250 项及 43 段迁移回归通过；初始化连续
  两次通过并要求固定 evidence bucket 版本控制从未启用。
- 当前 delete adapter 不接收 version ID；版本化 bucket 的普通 DELETE 可能只生成 delete marker，不能
  证明旧版本正文物理删除。production versioning/Object Lock/lifecycle/历史版本清理保持
  `BLOCKED/NOT_RUN`。AWS 最小 read IAM 对不存在 key 也可能返回 `403`，稳定错误语义须在目标 provider/
  staging 验证。
- D1 没有把 adapter 接入 confirm、scan、claim、protected-read 或 delete worker。OpenAPI runtime status
  与五项 capability 不变；production storage、scanner、HTTP、worker、管理员读取审计和 rollout 继续
  未完成。最终 `verify`（62 个单元文件/482 项）、Gitleaks、`git diff --check` 与独立高风险复审均通过。

## 13. M6.3-B2b-D2 scanner worker 与数据库提交边界

- D2 不新增数据库列、索引、约束、状态、枚举、RLS、grant、trigger、函数或迁移；D0 evidence/ledger
  与 outbox 仍是权威事实，M2→current 迁移总数保持 43。OpenAPI operation runtime status 也不变。
- `loadAfterSaleEvidenceScanWorkForLease` 只为严格 scan v1 消息加载当前 evidence 与规范 ORIGINAL。
  它复核消息为 `PROCESSING`、lease owner、数据库时钟下仍有效的 lease、消息 version、商城与精确
  payload，以及 evidence 的 `PENDING`、version 和 generation；不匹配返回 `SUPERSEDED` 或失败关闭，
  返回 work 也不授权稍后的提交。取得 evidence 行锁并读取 work 后还会重新读取数据库时钟复核租约；
  事务最长 2 秒。
- `applyAfterSaleEvidenceScanResultForLease` 在独立 SERIALIZABLE 事务中再次使用数据库
  `clock_timestamp()`，逐项复核 `PROCESSING`、owner、严格未到期 lease（相等也拒绝）、outbox message
  version、store/payload 身份和 evidence version/generation/status。只有复核成功才调用结果投影并与
  expire outbox 原子提交；等待 evidence 行锁后也会重新读取数据库时钟，事务最长 2 秒。旧租约、
  重领、重复或乱序结果不能覆盖当前事实。
- 若 legal hold 等操作只推进 `PENDING` evidence version，旧 scan identity 会在同一 SYSTEM 事务推进
  generation/version 并排队新的权威 scan outbox；若已有当前 version 的可收敛消息则保持幂等。旧
  worker/dead letter 不能覆盖或吞掉新 generation。
- `listAfterSaleEvidenceScanDeadLetterCandidates` 按商城返回有界、持久的 scan v1 `DEAD_LETTER` 候选；
  `reconcileAfterSaleEvidenceScanDeadLetter` 再锁消息与 evidence。仍处于当前待扫描身份的对象收敛为
  `FAILED`、稳定 code `SCAN_OUTBOX_DEAD_LETTER` 并排队 expire；已有新 version/generation 的旧消息
  返回 `SUPERSEDED`，不得倒退或直接产生成功结果。
- worker 仅通过 `createAfterSaleEvidenceSystemContext` 使用固定 actor 和
  `system_scope=after-sale-evidence-lifecycle`，不冒用管理员、会员或普通 StoreContext。网络调用前后的
  数据库检查与 provider/scanner 调用分离，消息 payload 从不成为授权或内容元数据来源。
- ClamAV adapter 在单一 `zIDSESSION\0` TCP 会话执行 `zVERSION\0`、`zINSTREAM\0`、`zEND\0`，帧最大
  64 KiB、总正文最大 50 MiB；严格校验 request/response ID、顺序、NUL framing、响应上限、engine
  VERSION 和签名时间。只有 `2: stream: OK` 成为 `CLEAN`；`FOUND` 的 signature 文本不记录、不持久化。
- D2 的定向与真实 MinIO/ClamAV integration、完整 integration、`verify`、依赖审计、OpenAPI 回归、
  Gitleaks、差异检查和独立复审均已通过，因此局部标记 repository implementation + local/test
  scanner worker validation `COMPLETE`。
  该局部结论不包含 HTTP upload/confirm/status、B3 claim、保护读取/管理员读取审计、expire/delete
  worker、外部告警、生产参数审批、production storage/scanner 或 rollout；B2b/B2/M6.3/M6/P0 继续未完成。

## 14. M6.3-B2b-D3 会员凭证 HTTP 与数据库读取边界

- D3 不新增数据库列、索引、约束、枚举、RLS、grant、trigger、函数或迁移；D0 evidence、ORIGINAL
  ledger、配额锁、幂等事实与 outbox 继续是权威数据，M2→current 保持 43 段。
- `prepareAfterSaleEvidenceUploadConfirmation` 只接受 member StoreContext、严格 UUID/正版本/幂等键，
  在 owner RLS 下读取未确认、未过上传排他截止且 expected version 匹配的声明。会员 HTTP 不获得
  SYSTEM-only ledger SELECT；对象 key 只作为内部 D1 输入，D2 扫描仍从权威 ledger 独立重读。
- 预确认读取不持有数据库锁跨越对象网络调用。D1 验证结束后，既有
  `confirmAfterSaleEvidenceUpload` 重新取得商城+会员配额锁和 evidence 行锁，复核 owner、version、
  `PENDING`、未确认与数据库时钟截止，再原子递增 generation/version、写确认事实和 scan outbox。
  TOCTOU 期间的版本或截止变化稳定冲突，不接受客户端 key、provider metadata 或 HTTP URL 作为事实。
- `readMemberAfterSaleEvidenceUpload` 在 member FORCE RLS 事务中同时绑定 `store_id/member_id/id`，并用
  数据库 `clock_timestamp()` 返回 observed time。应用只从白名单父行字段投影
  `PENDING/READY/UNAVAILABLE`；不返回 object key、checksum、扫描身份/错误、hold、删除状态或供应商
  正文。
- 初始化复用 D0 SERIALIZABLE 配额与 24 小时幂等；确认 replay 复用已提交事实，不重复读取对象或排队
  scan。Redis 读写限流在任何 evidence 读取或写入前完成，故限流失败不创建或修改凭证事实。
- D3 真实基础设施集成 4/4 和完整 integration 33 文件/274 项通过；43 段迁移演练通过。该局部结论不
  包含 B3 claim、保护读取/管理员审计、expire/delete worker、legal hold 管理、生产 retention/配额批准
  或 rollout；完整 B2b/B2/M6.3/M6/P0 继续未完成。

## 15. M6.3-B2b-D4 删除协调与数据库提交边界

- D4 不新增列、表、索引、约束、枚举、RLS、grant、trigger、函数或迁移；D0 evidence、ledger、
  transition、outbox 和删除 attempt/exhaustion 字段继续是唯一权威事实，迁移总数保持 43。
- `applyAfterSaleEvidenceExpirationForLease` 先锁当前 outbox，再锁 evidence，并在锁等待后重读数据库
  时钟。只有 payload expected version 与父行一致、状态具有权威截止、无 hold 且到期时，才复用 D0
  transaction-local 原语进入 `DELETION_PENDING` 并同事务追加当前 version 的 delete outbox。
- `loadAfterSaleEvidenceDeletionWorkForLease` 返回父 version 与所有 `object_key IS NOT NULL` 的 ledger
  `(id,version,role,key)`。`applyAfterSaleEvidenceDeletionResultForLease` 再锁同一消息、父行和完整 ledger；
  对象新增、移除、version 变化、父 version/status/hold 变化或 lease 换 owner/到期均拒绝 success/failure。
- success 原子把全部活动 ledger key 置空、保留行/hash 审计元数据，并清理父行兼容 key 与敏感 scanner
  字段后进入 `DELETED`。failure 复用 D0 指数退避，第 5 次形成 warning condition，第 8 次写
  `delete_exhausted_at` 且不再自动排队。
- `DELETE_FAILED` 到期重试会先推进父 version；同一消息仅允许在已有失败计数、仍为
  `DELETION_PENDING` 且父 version 精确为 payload expected version + 1 时恢复，以覆盖该推进后崩溃。
  其他旧消息返回 `SUPERSEDED`；ledger 漂移抛状态冲突交给通用 outbox 重试。
- D4 真实 PostgreSQL + MinIO 6/6、完整 integration 34 文件/280 项与 43 段迁移演练通过。该数据边界
  不证明 production versioned bucket 历史版本删除、B3 claim、保护读取/管理员审计、legal hold 管理、
  外部告警或 rollout；完整 B2b/B2/M6.3/M6/P0 继续未完成。

## 16. M6.3-B2b-D5 保护读取与审计数据边界

- D5 不新增业务列、表、索引、约束、枚举或 STORE 权限代码；第 44-48 段迁移只建立受限的数据库授权
  revalidation 边界。第 44 段 `20260730100000_m63_b2b_d5_protected_read_lock` 提供 evidence locking read；
  第 45 段 `20260730103000_m63_b2b_d5_authorization_revalidation` 新增授权感知 definer 函数及其最小
  auth-table grants/RLS；第 46 段 `20260730104000_m63_b2b_d5_member_authorization_grant_fix` 仅授予 guard
  `members.store_id` 的列级 `SELECT`；第 47 段 `20260730105000_m63_b2b_d5_expiry_revalidation` 在 evidence
  锁已取得后再复验到期事实；第 48 段 `20260731100000_m63_b2b_d5_commit_deadline_revalidation` 进一步绑定
  Bearer/session 截止并保留提交余量。D0 的 `after_sale_evidence_files`、header `object_key`、
  claim/status/ordinary deadline/version 与 deferred ORIGINAL-binding guard 继续是 member/admin 读取的唯一
  业务授权事实。
- `zalo_shop_evidence_read_guard` 是集群级而非 runtime login role：必须 `NOLOGIN`、`NOINHERIT`、
  `NOSUPERUSER`、`NOCREATEDB`、`NOCREATEROLE`、`NOREPLICATION`、`NOBYPASSRLS` 且无任何角色成员关系。
  迁移在角色不存在时创建它；已存在时严格校验这些属性和关系后复用，任何不安全状态均以 `55000` 停止。
  `zalo_shop_runtime` 不获得该角色成员资格。第 44、45、47、48 段必须由真正的 PostgreSQL `rolsuper` 通过受控
  maintenance `DATABASE_URL` 部署，才能将 definer ownership 转给该无关系角色；runtime 角色不能承担该权限。
- member/admin 事务不读取 `after_sale_evidence_objects`：该 ledger 维持 SYSTEM-only。非 `DELETED` 父行
  的 header key 由 D0 guard 绑定唯一活动 ORIGINAL，因此 D5 可把其作为签名身份，同时不扩大 ledger
  SELECT 权限或泄漏 DERIVATIVE/SCAN_TEMPORARY。
- prepare 使用商城范围事务读取 eligible snapshot；签名完成后 revalidate 在 `READ COMMITTED` 的
  restricted security-definer 函数中以 `SELECT ... FOR SHARE` 执行。函数使用固定 `search_path` 和
  `row_security=on`，先锁定并校验 ACTIVE store、当前 member/admin、未撤销未到期 session、Bearer 到期与
  direct store 或 cross-store platform permission，再锁定 evidence。它只返回最小重验 snapshot，并以数据库
  `clock_timestamp()` 在取得 evidence 锁后再次校验 signed URL、Bearer/session 和 ordinary-access deadline；
  同时校验 store/case/member（member）、claim、`READY`、header key 与排他 deadline。状态、key、case、
  owner、授权或到期漂移拒绝；仅 legal-hold 状态造成的 version 漂移不撤销一个仍在普通读取窗口内的读取。
  这个锁继续与生命周期写入冲突，但不赋予 member 常规 `UPDATE` 权限。
- admin 成功读取把 `after-sale.evidence.protected_read.issued` 审计与最终 revalidate 放在同一事务。
  审计只保存 allowlisted admin/store/case/evidence/version/correlation/access-reason 事实，不能保存 signed
  URL、object key、checksum、scanner/provider 数据或文件内容；写审计失败则回滚且不返回 URL。
- 回滚必须先关闭 protected-read capability 并等待在途请求和 URL TTL。仅 local/test 且不存在任何
  `after-sale.evidence.protected_read.issued` 审计事实时，才允许按 `48 -> 47 -> 46 -> 45 -> 44` 执行
  `down.sql`；第 48、47 段的逆向脚本只做审计事实 guard，不恢复较弱函数，任一 issued-read audit 均以
  `55000` fail-fast。逆序回滚仅移除当前数据库的 D5 函数、policies 和 grants，并保留共享 guard role；生产
  或已有受保护读取审计事实环境只能以审查过的前向修复纠正。D5 repository
  implementation + local/test validation 已完成；该状态不包含 production 部署或 rollout，完整证据见
  `docs/reports/m6.3-b2b-d5-protected-evidence-read-completion-report.md`。

## 17. M6.3-B3 售后申请与取消数据边界

- B3 不新建平行售后聚合，也不增加政策业务列。严格政策 payload 现要求
  `condition_rules.allowed_reason_codes`，并要求 `evidence_required_reason_codes` 与
  `opened_package_exception_reason_codes` 均为其子集；旧 payload 无法证明兼容时写入失败关闭。申请窗口按
  `Asia/Ho_Chi_Minh` 自然日和权威 `ORDER_OUTBOUND` 交付事实计算，排他截止点到达即拒绝。
- `POST /v1/after-sales` 只允许会员创建 `REFUND_ONLY/RETURN_REFUND/EXCHANGE`；
  `POST /v1/after-sales/{afterSaleId}/cancel` 只取消本人非 legacy、仍为 `PENDING_REVIEW` 且没有审核/
  返件/settlement/库存/换货副作用的 case；`POST /v1/admin/orders/{orderId}/after-sales` 只创建
  `MERCHANT_REFUND + PENDING_REVIEW`。三条路由受 `AFTER_SALE_COMMANDS_ENABLED` 默认关闭，production
  配置和服务层均拒绝启用。
- 创建原语在单个 `Serializable` 商城事务中读取并锁定订单、逐行商品/政策/交付/支付/容量事实。仅
  VND、已交付或已完成、具有唯一可证明 ONLINE 成功收款事实的订单可进入当前写路径；merchant refund
  不接受 legacy。当前没有可锁定并复验的 COD 已确认收款事实，因此 COD 失败关闭。服务端按剩余数量和
  剩余 VND 计算逐行申请额，覆盖全部剩余数量时取得全部余数；
  merchant-paid `RETURN_REFUND/EXCHANGE` 的实际已付运费每订单最多占用一次，其他类型/承担方为 0。
- exchange replacement 必须为当前商城 ACTIVE、同商品 SPU、不同 SKU、等价价格；订单快照的
  attribute definition UUID 先映射到稳定业务 code，仅政策指定 `exchange_attribute_code` 可以变化，
  其他 option 必须完全一致。非 exchange 行携带 replacement SKU 一律拒绝。
- 证据要求或请求携带非空 evidence id 时，上传校验、恶意扫描、claim、protected read、删除补偿和显式
  `ordinary < retention` TTL 必须全部可用。D0 `claimAfterSaleEvidenceInTransaction` 与 header/items/
  operation/transition/audit 在同一事务提交；取消保留 claim 和原 ordinary/retention deadline。
- 第 49 段 migration 通过 `after_sale_transitions.operation_id`、复合 FK、唯一 `SUBMIT`、operation 完成
  guard、deferred runtime case commit guard 和两项 runtime 可执行窄函数，把 header/items、
  `MEMBER_CREATE/MERCHANT_REFUND_CREATE/MEMBER_CANCEL`、transition 与 allowlist audit 绑定。创建使用
  `SUBMIT`，取消使用 `CANCEL`；普通 runtime 的 operation INSERT 与 member cancel transition policy 已
  撤销，内部 validator 对 PUBLIC/runtime 均不可执行。
- 第 49 段的第一条语句对 `after_sale_policies.draft_payload`、`after_sale_policy_versions.payload`、
  `order_item_after_sale_policy_snapshots.payload` 和非空 `after_sales.policy_snapshot` 做只读 preflight。
  `allowed_reason_codes` 必须是 1–64 个合法且不重复的 code；evidence/opened-package 两个 reason 数组也
  必须有界、合法、不重复并为 allowlist 子集。任一事实不能证明兼容即以 `55000` 停止，迁移目录状态和
  数据不变；不得猜测、删除或回填历史 policy。
- 审批 item/header/allocation 与 legacy approve 的首个准备写使用同一
  `m62-refund:{store_id}:{order_id}` advisory lock。由于 PostgreSQL 在进入 row trigger 前已持目标行锁，
  与并发 B3 创建冲突时 early guard 以可重试 `40001` 原子回滚，避免 row↔advisory 反向等待；transition
  lock trigger 名称排在 B0 contract guard 前，transition-only 审批则先取得 order lock。后续 B4 调用方
  仍须把 `40001` 当作整笔审批事务重试，不能局部续写。
- 命令 finalizer 在持锁事务内复验 ACTIVE 商城、当前 actor、Bearer/session 截止、会员归属；管理员还
  复验近期 MFA 和目标商城直接 `store.after-sales.review`；仅有 platform cross-access 固定失败，
  `X-Access-Reason` 不能替代目标商城权限。规范 request hash 绑定商城、actor、operation、path、
  order/case、规范 body 与幂等键 hash；同键同请求从原 `result_summary` 重建创建/取消时的不可变
  acknowledgement，同键异参稳定冲突；当前聚合必须通过 GET 查询。
- create/cancel 只对 Prisma `P2034` 或 PostgreSQL `40001` 执行最多三次 Serializable 事务尝试；
  `expected_version` 冲突不重试并稳定映射版本冲突。随机公开号碰撞使用独立三次上限。
- B3 `down.sql` 仅限 local/test；存在 `SUBMIT`、三项 B3 operation、三类 B3 audit 或预留的 B3 outbox
  事实时以 SQLSTATE `55000` fail-fast。生产或已有命令事实的数据库只能向前修复。B3 default-disabled
  repository implementation + local/test validation 已 `COMPLETE`；production policy/TTL/storage/provider/
  deployment/rollout 均为 `NOT_AUTHORIZED / NOT_RUN`。
