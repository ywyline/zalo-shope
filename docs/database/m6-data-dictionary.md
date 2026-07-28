# M6 售后、会员与分享数据字典

> 状态：M6.1 契约已冻结；M6.2 schema/RLS、M6.3-A、M6.3-B0 与 B1 已完成并验证；B2-B7、UI 与生产 rollout 未开始、未授权
>
> 日期：2026-07-29

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

只追加保存 `from_status/to_status/event/actor_type/actor_id/reason/correlation_id/created_at`，复合
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

### 4.4 `after_sale_operations`

保存商城、售后单、operation、幂等键 hash、请求 hash、状态、版本、结果摘要和时间。
`UNIQUE(store_id, operation, idempotency_key_hash)`；不保存原始幂等键、证据正文或敏感账户。

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
  key 固定包含环境/商城/临时上传命名空间，不要求尚不存在的售后 ID。确认并扫描通过后状态为
  `READY_UNCLAIMED`，带短 `claim_deadline_at`；认领后切为 `READY` 并冻结 `retention_deadline_at`。
- 创建售后事务按 evidence IDs 锁行，验证同商城/同会员、认领窗口未过期、扫描通过且从未 claim，
  再一次性写入 `(store_id, after_sale_id, member_id)`；同一凭证不能复用到第二个售后。claim 后对象
  访问始终通过数据库授权，不依赖可猜对象路径。
- 保存 MIME、byte size、SHA-256、原文件名、扫描结果和
  `PENDING/READY_UNCLAIMED/READY/FAILED/QUARANTINED/DELETION_PENDING/DELETED/DELETE_FAILED`。
  `EXPIRE` 只允许在对应 claim/retention 截止点到达且无活动 legal hold 时进入
  `DELETION_PENDING`；`DELETE_SUCCEEDED -> DELETED`，失败记录稳定错误类别并走
  `DELETE_FAILED -> RETRY_DELETE -> DELETION_PENDING`，使用幂等对象删除和有界退避告警。
  `EXPIRE`、`RETRY_DELETE` 和 `DELETE_SUCCEEDED` 不能走无上下文的通用状态转换；每次尝试都必须重新
  锁行并检查截止点和 legal hold，hold 在首次排队或失败后激活时同样阻止重试/成功提交。
- staged 凭证只能从无扫描结果的安全初态进入扫描流程；可认领状态要求非空且精确的 `CLEAN`
  scan result，NULL 不能绕过。每次状态变化自动追加不可变 transition；删除失败重试必须达到
  `next_delete_attempt_at`，成功后对象、衍生和扫描临时 key 均清空。
- `legal_hold_active/held_at/held_by/reason` 是正交受审事实，不新增可读取状态。M6 普通售后 API 不提供
  设置/解除 legal hold 的入口；M6.2 只为受治理的合规流程保留最小字段。活动 hold 阻止删除，但不延长
  买家或普通管理员的访问窗口；解除后若截止点已过，worker 立即重新排队删除。
- 到达访问截止点后，即使对象因 legal hold 尚在，普通访问也统一拒绝。只有 `READY` 且未过期对象可
  签发短期 URL；`PENDING/READY_UNCLAIMED/FAILED/QUARANTINED/DELETION_PENDING/DELETED/DELETE_FAILED`
  均不可读取，响应不能泄露扫描或删除细节。会员和普通管理员 API 不直接投影内部状态：
  `PENDING -> PENDING`，`READY_UNCLAIMED/READY` 在各自有效窗口内投影为 `READY`，其他内部状态或
  已过期对象统一投影为 `UNAVAILABLE` 且 `access_expires_at=null`；访问端点继续使用无差别 `404`。
- 删除范围包含原对象、缩略图/转码衍生物和扫描临时对象。`DELETED` 后清除对象 key、衍生 key、签名
  token 和原始错误，只保留商城/售后归属、checksum、byte size、状态转换、截止时间、删除时间、
  尝试次数与审计元数据；该最小元数据继续受 RLS 与审计保留策略保护。
- 只允许 JPEG/PNG/WebP 与 MP4，拒绝 SVG、脚本和可执行内容。
- 每单最多 6 个文件；图片单个最多 10 MiB、视频最多 50 MiB。确认时校验 magic bytes、声明类型、
  长度和 checksum；未扫描或隔离对象不能读取。
- 买家只能读取本人售后凭证，管理员需要专门权限；短期 no-store URL，每次管理员读取写审计。

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
- evidence 只公开 `PENDING/READY/UNAVAILABLE`：未过期 `READY_UNCLAIMED/READY` 映射为 `READY`，
  其余内部状态或过期对象统一为 `UNAVAILABLE` 且 `access_expires_at=null`。四个成功响应统一
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
  不存在 `404` 和限流 `429`。B1 不注册写路由；B0 冻结的会员写 10、管理员写 30 次每 60 秒只在
  B2-B7 获批实现相应命令时生效，当前不能据此声称申请、取消、审核、证据访问、返件、退款或 COD
  结算可用。
