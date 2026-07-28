# M6 售后、会员与分享权限矩阵

> 状态：M6.1 契约已冻结；M6.2 权限目录/数据库 scope 已迁移；M6.3-A settings 运行时 RBAC、M6.3-B0 契约/前向修复与 B1 只读门禁已完成并验证；B2-B7、UI 与生产启用未授权
>
> 日期：2026-07-29

M6.2 已登记下列 12 项 STORE 权限且不自动给生产角色扩权；local/test seed 仅为明确的测试
`store-admin` 授权。第五段前向迁移把 member actor 限制到本人售后/凭证和隐私请求的有界命令；
初始第六段 `20260727115000_m62_integrity_closeout` 进一步收口 legacy 决定、聚合状态/副作用并发、
返件/结算/库存/换货/凭证事实和 definer ACL；后续五段前向修复保持 member scope，补齐容量占用、
共享退款锁序及 definer NULL actor fail-closed。收藏、历史继续使用 owner scope。M6.3-A 仅实现
`GET/PUT /v1/admin/after-sale-settings` 的运行时 RBAC、审计和幂等边界；M6.3-B1 随后只实现会员/
管理员售后列表与详情。其他售后写入、凭证文件访问、政策管理、会员、分享 controller/service/worker/
UI 仍未交付。本矩阵中除明确标为 M6.3-A 或 B1 已实现的动作外，其余动作行是 B0 已冻结、等待 B2-B7
或后续里程碑另行授权实施的契约，不代表按钮、API、worker 或生产角色授权已经交付。
B0 不新增 STORE 权限 code；其 SYSTEM principal 是独立的内部 transaction actor，不是可授予管理员
角色的权限，也不能复用固定管理员 UUID。

## 1. 新增权限目录

| 权限 code                               | 用途                             | 风险 |
| --------------------------------------- | -------------------------------- | ---- |
| `store.after-sales.read`                | 查看售后列表、详情和非敏感时间线 | 高   |
| `store.after-sales.review`              | 审批、拒绝和发起退款协调         | 极高 |
| `store.after-sales.inspect`             | 返件验收和处置结论               | 极高 |
| `store.after-sales.exchange`            | 创建/取消换货领域履约            | 极高 |
| `store.after-sales.evidence.read`       | 读取私密图片/视频凭证            | 极高 |
| `store.after-sales.policy.read`         | 查看当前和历史售后政策           | 中   |
| `store.after-sales.policy.manage`       | 创建政策草稿和类目/商品关联      | 极高 |
| `store.after-sales.policy.publish`      | 发布不可变政策版本               | 极高 |
| `store.after-sales.policy.disable`      | 停用新订单政策解析               | 极高 |
| `store.after-sales.policy.enforce`      | 切换商城政策快照强制门禁         | 极高 |
| `store.after-sales.cod-refunds.request` | 申请 COD 线下退款                | 极高 |
| `store.after-sales.cod-refunds.confirm` | 独立复核到账并确认 COD 退款      | 极高 |

权限迁移只登记 code，不自动给生产角色扩权。`read`、`review`、`inspect`、`exchange`、政策和 COD
结算权限互不隐含。管理员商城令牌、`X-Store-Code`、`store_id` 查询参数和 RLS 必须共同一致。

## 2. 售后动作矩阵

| 动作                 | 必要权限                                                | 额外控制                                                                                           |
| -------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 管理售后列表/详情    | `store.after-sales.read`                                | B1 已实现；中央商城授权 + 显式 store scope + FORCE RLS、签名游标/locale/限流、严格 select/no-store |
| 查看凭证             | `store.after-sales.evidence.read`                       | B2 契约；扫描与 claim 能力 fail-closed、每次读取审计、短期 no-store URL                            |
| 审批/拒绝            | `store.after-sales.review`                              | B4 契约；近期 MFA、确认词、reason、expected version、幂等键、逐行 approved_quantity                |
| 旧订单一次性例外决定 | `store.after-sales.review`                              | 当前管理员、未污染初态、policy basis、无副作用且只能一次                                           |
| 创建商家主动退款售后 | `store.after-sales.review`                              | B3 契约；同政策/version/hash、权威交付事实、服务端金额、近期 MFA、幂等和审计                       |
| 解决人工复核         | 原动作权限 + `store.after-sales.review`                 | 恢复同类型记录状态；仅无任何副作用的早期状态可拒绝                                                 |
| 发起 ONLINE 退款     | `store.after-sales.review` + `store.refunds.create`     | 仅 B6 设计；复用 M5 transaction/capacity/outbox，B0 不开放运行时                                   |
| 查询 ONLINE 退款     | `store.after-sales.read` + `store.refunds.read`         | 仅 B6 设计；不返回完整供应商引用或原始响应                                                         |
| 返件验收             | `store.after-sales.inspect`                             | 整体延至 M6.4；须与 exactly-once 库存恢复一并授权，B 不开放写路由                                  |
| 恢复可售库存         | `store.after-sales.inspect` + `store.inventory.adjust`  | M6.4；仅验收可售数量、稳定 operation key、同事务审计                                               |
| 创建换货             | `store.after-sales.exchange`                            | 同 SPU 等量 SKU、库存预留、近期 MFA、幂等                                                          |
| 换货运单             | `store.after-sales.exchange` + `store.shipments.create` | purpose=EXCHANGE_OUTBOUND，不推进原订单                                                            |
| COD 退款申请         | `store.after-sales.cod-refunds.request`                 | 仅 B7 设计；近期 MFA、服务端金额、真实转账证明入口缺失时保持 PENDING/REVIEW_REQUIRED               |
| COD 退款确认         | `store.after-sales.cod-refunds.confirm`                 | 仅 B7 设计；公开号、异人复核、近期 MFA；真实证明适配入口前不开放成功按钮                           |
| 政策/历史查看        | `store.after-sales.policy.read`                         | B2 契约；API 未实现，当前商城、只读不可变版本                                                      |
| 设置/readiness 查看  | `store.after-sales.policy.read`                         | M6.3-A 已实现；令牌/Header/查询一致；平台跨商城需 AccessReason                                     |
| 政策草稿             | `store.after-sales.policy.manage`                       | B2 契约；三语校验、商城目标约束、乐观锁                                                            |
| 政策发布             | `store.after-sales.policy.publish`                      | B2 契约；近期 MFA、确认词、payload hash、发布后不可变                                              |
| 政策停用             | `store.after-sales.policy.disable`                      | B2 契约；近期 MFA、确认词、历史版本/快照保持可读                                                   |
| 快照强制开关         | `store.after-sales.policy.enforce`                      | M6.3-A；MFA/确认/reason/expected version；跨店 AccessReason；24h 商城幂等；精确 before/after 审计  |

任何退款、库存恢复或换货命令都不能仅凭前端隐藏按钮保护。权限不足、令牌/Header 商城不一致或
跨商城对象统一失败，不能泄漏对象是否存在于其他商城。

M6.2 已完成 shipment purpose 的数据库归属/type/允许状态 guard，并通过聚合锁关闭 raw shipment 与
拒绝、到期、换货转退款的并发旁路。M6.3-A 已把本地可信 shipment `purpose` 贯穿既有 M5 查询、命令、
callback hint、worker 和供应商权威事实应用；purpose 只从当前商城本地运单事实解析，不能由客户端、
callback body 或供应商响应选择。只有 `ORDER_OUTBOUND` 可以推进原订单，
`AFTER_SALE_RETURN`/`EXCHANGE_OUTBOUND` 不得复用 `SHIP/DELIVER` 路径。M6.3-A 不创建售后运单，
售后协调与相应权限仍属于 M6.3-B。

共用 `/refund` 命令必须从可信订单支付方式动态判权：ONLINE 同时要求
`store.after-sales.review + store.refunds.create`；COD 只走
`store.after-sales.cod-refunds.request` 和受审线下 settlement。控制器不能用 review 权限替代 COD
财务权限，也不能接受客户端 payment method 选择分支。

## 3. 买家能力

| 能力              | 身份与范围               | 控制                                                                                      |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| 查看售后列表/详情 | 当前商城认证会员本人     | B1 已实现；显式 store/member scope + FORCE RLS、签名游标、严格 select、no-store           |
| 创建/取消售后     | 当前商城认证会员本人     | B3 契约；同 policy/version/hash、权威交付、服务端金额；当前未授权、未注册写路由           |
| 上传/读取凭证     | 当前会员、当前售后单     | B2；校验/扫描/claim/保护读取/删除补偿任一不可用时要求证据的申请失败关闭                   |
| 提交返件信息      | 当前会员、已批准返件     | B5 契约；只写 SUBMITTED 并追加 START_RETURN 到 RETURN_PENDING；当前未授权、不能标记运输中 |
| 收藏              | 当前会员、当前商城商品   | PUT/DELETE 幂等；下架商品只返回受限摘要                                                   |
| 浏览历史          | 当前会员、当前商城商品   | 最多 100；可单删/清空；匿名不写入                                                         |
| 会员中心          | 当前会员                 | 复用本人资料、地址、券和订单事实，不返回管理字段                                          |
| 隐私请求受理/查询 | 当前会员、当前商城       | 真实 SUBMITTED 事实；不声称导出/删除/注销已完成                                           |
| 创建/解析分享     | 当前商城；创建可选会员   | 只接受公共 code/locale/受限来源；服务端解析已发布目标                                     |
| 记录分享结果      | interaction token 持有人 | token 绑定 shortCode/交互/有效期；仅完成/取消统计                                         |

会员不能通过订单 UUID、订单行 UUID、售后号、商品 code、分享短码、游标或 Header 访问其他会员
或商城数据。RLS 只作纵深防御，服务查询仍显式包含 `store_id/member_id`。

会员返件权限不包含 `RETURN_SHIPPED/RETURN_RECEIVED`。这两个事件必须来自后续可信物流查询或受审
管理员核验事实；会员提交与 SYSTEM `RETURN_EXPIRED` 在同一聚合锁和排他截止点竞争，恰有一方成功。

## 4. SYSTEM 售后 principal

- SYSTEM 不是 RBAC 角色，也不接受管理员 access token。内部事务必须使用明确的 system actor，设置
  `actor_type=system`、`system_scope=after-sale-transition`、当前 `store_id` 与 correlation ID；写入的
  actor/store/correlation 必须与 transaction-local 上下文逐项一致。
- 事件 allowlist 仅为 `RETURN_EXPIRED`、`REFUND_SUCCEEDED`、`REFUND_FAILED`、
  `REFUND_CANCELLED`、`REQUIRE_REVIEW` 和 `COMPLETE`。每个事件仍校验售后类型图、当前锁定状态及
  返件/settlement 等权威事实，不能只因 event 名称在 allowlist 就通过。
- SYSTEM 永久禁止 `APPROVE/REJECT`、`LEGACY_APPROVE/LEGACY_REJECT`、`RESUME_REVIEW`、COD
  确认、`REFUND_REQUESTED` 和其他人工动作；不能冒用申请/审核管理员，也不能直接执行 definer
  validator 绕过表 RLS/trigger。
- `COMPLETE` 仅允许从 `REFUNDED -> COMPLETED`，用于所有批准资金事实已经确定后的无副作用、
  确定性收口；它不能创建/更新 M5 refund、settlement、库存动作、运单或换货事实。

## 5. 分享和公开兜底边界

- 公共 resolver 不接受内部 UUID、`store_id`、任意 URL/title/image 或重定向目标。
- target type 只允许 STORE/BRAND/CATEGORY/PRODUCT/PROMOTION/COUPON；服务端验证同商城和发布状态。
- browser fallback 只按全局不可猜 `shortCode` 查询服务端绑定的单一商城/目标事实，不从请求 Header、
  query 或 path 中接受 `storeCode/locale/type/code` 组合。
- 卡片文本 HTML 转义并设置 CSP；图片只允许同商城已发布产物或受控代理，不抓取任意远程 URL。
- attribution 参数只接受服务端签发、绑定商城/活动/有效期的 opaque token；匿名请求不能提交 raw
  campaign/promotion code。完成/取消只接受创建响应签发且绑定 shortCode/交互/有效期的 token；服务端
  只存 token digest。交互限流并有限保留，URL/日志不含会员 ID、Zalo subject、手机号。
- Zalo `openShareSheet` 只允许由用户点击触发；取消不是成功，任何结果都不能兑换奖励或资金。

## 6. 数据库与对象存储最小权限

- M6 商城表全部 FORCE RLS；运行角色没有 bypass。复合 FK 阻止跨商城及同商城错订单/行/会员/SKU/
  payment/refund 拼接。favorites/history/privacy 在 member actor 下的 `USING/WITH CHECK` 还必须要求
  `member_id=app_security.current_actor_id()` 与 `app.actor_type='member'`，不能仅做 store-only RLS。
- 政策版本、售后转换、结算历史、库存动作和分享交互撤销 UPDATE/DELETE；状态头只允许领域命令
  通过只追加 transition 和 definer trigger 原子投影，运行角色没有 header 状态列直改权限。
- 售后行/legacy 决定、settlement、返件、库存和换货 guard 在必要时以受控 definer owner 跨 RLS
  锁定聚合；函数固定 `search_path=pg_catalog, public, pg_temp`，PUBLIC/runtime 直接 EXECUTE 均撤销。
  M6.6 运行时交付前，runtime 也不能直接 INSERT 分享三张事实表。
- B0 的 SYSTEM transition 使用与 member/admin 分离的 INSERT RLS policy 与 trigger guard；只有专用
  system scope、当前商城/actor/correlation 和窄事件 allowlist 同时匹配才可写入，普通 StoreContext
  不获得该路径。
- B1 不把 RLS 当作唯一授权。会员 service 的列表/详情条件始终显式包含 `store_id/member_id`；管理员先
  通过中央授权校验当前商城 `store.after-sales.read`，查询再显式包含 `store_id`。所有读取使用严格
  Prisma `select` allowlist，不以宽关系 `include` 把 RLS 无法提供的列级敏感字段保护交给响应过滤。
- `app_security.lock_m63_after_sale_setting()` 是唯一有意允许 runtime 直接 EXECUTE 的 definer 例外。
  它固定安全 `search_path`，只读取 `app_security.current_store_id()`，只返回并锁定当前商城 enforcement
  布尔值；设置行缺失时失败关闭，不能更新设置、枚举商城或扩大任何 policy 权限。
- evidence bucket/prefix 按环境和商城隔离。普通 catalog/content 权限不能读取售后凭证；管理员
  下载 URL 短期、一次用途并带 no-store，日志只记录内部对象 ID 和审计结果。
- 凭证清理 worker 使用独立最小对象删除权限，只按数据库中已持久化的精确商城对象 key 删除原件和
  衍生物；进入删除事务前重新锁行并检查截止点与 legal hold。legal hold 不赋予普通读取权限，删除失败
  只记录稳定错误类别并有界重试，日志不得包含签名 URL、对象正文或供应商原始错误。
- 会员与普通管理员只看到 `PENDING/READY/UNAVAILABLE` 安全投影；隔离、删除中、删除失败和已删除
  只保留在受限内部事实中，不能通过售后详情、上传响应、错误码或时序差异泄露。
- COD 收款信息与转账证据按敏感数据加密；常规 API、审计快照和日志仅返回掩码或存在性。

## 7. 稳定拒绝与必测安全场景

- 未认证 `401`；无目标商城/权限 `403`；当前主体范围内不存在 `404`；严格 DTO `400`；状态、
  版本、数量、金额、幂等、政策或库存冲突 `409`；限流 `429`。
- 必测跨商城已知 UUID、跨会员订单/售后/凭证、只读管理员写入、验收员发起退款、财务人员恢复库存。
- 必测同订单行并发多售后不超量、售后行 INSERT 与批准/拒绝串行、零数量/正金额和同 SKU 换货拒绝、
  同幂等键异参、重复审批、重复退款、M5 人工复核容量和重复恢复。
- 必测 legacy 安全初态、决定绑定当前管理员且只能一次、无副作用、退货条款与类型匹配；返件提交和
  `RETURN_EXPIRED` 在截止点并发恰有一个成功，已有 raw return shipment 时不得到期拒绝；COD 公开号
  不能跨商城/售后确认，digest/加密凭证不能为空且响应不暴露内部 settlement ID。
- 必测返件/换货 raw shipment 与拒绝/转退款并发后无非法事实、非订单运单不推进原订单、卫生品退款
  但不恢复可售库存、换货预留超时只释放一次、转退款后任意 fulfillment UPDATE 均拒绝。
- 必测凭证 MIME 欺骗、超限、未扫描、路径穿越、签名过期、管理员读取审计和日志/错误无敏感正文。
- 必测 `READY/FAILED/QUARANTINED` 到期、legal hold 阻止删除但不延长普通访问、解除后重排、对象与
  衍生物幂等删除、`DELETE_FAILED` 重试、`DELETED` 仅保留最小受保护审计元数据，以及公共投影不
  区分隔离/删除中/删除失败/已删除。
- 必测分享 code 注入、XSS、open redirect、跨商城目标、草稿/停用/过期对象、token 篡改和三语回退。
- B0 必测同售后单跨行 policy/version/hash 混用、legacy/非 legacy 混合、只取第一行政策、
  `ORDER_OUTBOUND + shipment_items` 数量/状态/交付时间冲突，以及使用订单时间或当前时间伪造交付。
- B0 必测逐行 `approved_quantity` 缺行/重复/全零/超申请量、客户端金额篡改、申请与批准余数算法不一致、
  覆盖全部剩余数量未取得全部 VND，以及并发申请/批准超过订单或 M5 退款容量。
- B0 必测要求证据时上传校验/扫描/claim/保护读取/删除补偿任一能力不可用均不创建售后；会员提交返件
  只能 `START_RETURN -> RETURN_PENDING`，不得直接 `RETURN_SHIPPED`；B 公共 API 不出现
  `inspect-return` 写路由。
- B0 必测 SYSTEM 缺 scope、错商城/actor/correlation、越 allowlist 事件、冒用管理员、缺权威退款事实
  均拒绝；`COMPLETE` 只允许 `REFUNDED -> COMPLETED` 且不产生新的资金、库存或物流副作用。
- B1 必测四个 GET 的跨商城、跨会员已知 UUID、无 `store.after-sales.read`、Header/query 不一致、严格
  输入、locale 回退、敏感 marker 不出响应、`Cache-Control: private, no-store` 和 correlation；分页还
  必须覆盖两阶段 `limit + 1`、六位微秒 `(timestamp,id)` tuple seek、游标篡改/过期/跨主体/跨筛选，
  以及 Redis 商城+主体 60/120 读限流和 `Retry-After`。

M6.3-A 已补充 settings GET/PUT 的跨商城、Header/查询不一致、read/enforce 权限互不隐含、近期 MFA、
确认词、expected version、同键复放/异参冲突、24 小时商城 scope、精确 before/after 审计、
并发开关与 checkout 串行、创建/取消 provider reference 待写回重试等测试，并以真实数据库覆盖两类
非订单 shipment 更新自身事实但不能推进原订单。当前证据为定向 unit 55/55、
M6.2 数据库 39/39、M4 integration 15/15、M5.6 integration 13/13、完整 integration 26 文件/206 项，
以及 39 段迁移 M2→当前/重复部署/fresh/down-forward/`55000` 演练通过。`corepack pnpm verify`
（54 个文件/381 项单元测试）、21/21 E2E、交付候选 Gitleaks、`git diff --check` 与生产依赖 high
门禁均通过；审计另有 3 项 React Router moderate 公告并在完成报告中明确结转。M6.3-A 已完成，
但这不授权启用生产 enforcement 或进入 B 写路径。

settings controller/service 将 `X-Access-Reason` 原样交给既有 `AdminService`；平台管理员跨商城时的
至少 10 字符 reason 校验和受审切换继续由 M1 中央授权分支保证。本切片未重复构造平台角色专项用例，
因此不把 store/header 跨店拒绝用例表述为平台跨店专项证据。

## 8. B1 读取授权与当前边界

- B1 只实现四个列表/详情 GET。会员只读当前商城本人数据，locale 按 `preferredLocale -> vi`；管理员
  需要目标商城 `store.after-sales.read`，locale 按显式值、商城默认、`vi`。详情中的 evidence 仅为
  `PENDING/READY/UNAVAILABLE` 安全投影；读取对象正文仍需未实现的独立
  `store.after-sales.evidence.read` 路径。
- `c1_` 游标使用独立的 1–3 把 HMAC-SHA-256 key ring，第一把签发、全部验证，并绑定版本、商城、
  主体、资源、规范过滤、六位微秒排序键/tie-breaker 和过期时间；篡改、过期或换 scope 返回统一
  `400`，不能泄露其他会员/商城存在性。轮换需保留旧验证密钥至最长 TTL。
- 列表在 `REPEATABLE READ` 中先取 `limit + 1` 个 page key，再仅对白名单 ID 做严格 Prisma `select`；
  下一页以 PostgreSQL `(timestamptz,uuid)` tuple seek，禁止用毫秒精度 `Date` 降级。成功响应统一
  `Cache-Control: private, no-store`，不返回 ciphertext、对象 key、管理员原因/身份或供应商原始数据。
- B1 会员/管理员读限流分别为 60/120 次每 60 秒，scope 固定商城+主体；超限先于资源查询返回 `429`
  和 `Retry-After`。每个响应的 `X-Correlation-Id` 与错误体、事务、授权审计（如发生）和日志一致。
- 售后公开号固定至少 128-bit 随机的 `ASC-[A-Z0-9]{16,32}`；legacy 响应的 `reason_detail` 可为 null，
  新申请仍要求非空。B0 冻结的会员/管理员写限流 10/30 只供未来写路径使用，当前没有写 handler。
- B6 ONLINE Refund 和 B7 COD 双人结算在 B0 只冻结权限、事务与失败关闭设计；未实现 M5
  transaction-scoped refund 原语、售后 coordinator、真实转账证明适配入口或成功确认按钮。
- B0 领域/契约、数据库、完整 integration、迁移演练、`verify`、生产依赖审计、Gitleaks、
  `git diff --check` 和最终高风险复审等适用门禁已验证，实际结果统一记录在
  `docs/reports/m6.3-b0-completion-report.md`。B0 未新增运行时或 UI，未执行或声称专属 E2E；随后
  单独实施 B1 不改变 B0 历史证据。B2-B7、UI、生产政策/启用、供应商调用、部署与发布仍未授权。
