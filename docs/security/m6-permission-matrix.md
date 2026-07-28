# M6 售后、会员与分享权限矩阵

> 状态：M6.1 契约已冻结；M6.2 权限目录与数据库 scope 已迁移；运行时 RBAC 未开始
>
> 日期：2026-07-27

M6.2 已登记下列 12 项 STORE 权限且不自动给生产角色扩权；local/test seed 仅为明确的测试
`store-admin` 授权。第五段前向迁移把 member actor 限制到本人售后/凭证和隐私请求的有界命令；
初始第六段 `20260727115000_m62_integrity_closeout` 进一步收口 legacy 决定、聚合状态/副作用并发、
返件/结算/库存/换货/凭证事实和 definer ACL；后续五段前向修复保持 member scope，补齐容量占用、
共享退款锁序及 definer NULL actor fail-closed。收藏、历史继续使用 owner scope。当前没有售后/会员/
分享 controller、service、worker 或 UI；本矩阵中的动作行是 M6.3 及后续运行时必须实现的授权契约，
不代表按钮、API 或生产角色授权已经交付。

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

| 动作                 | 必要权限                                                | 额外控制                                                    |
| -------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| 管理售后列表/详情    | `store.after-sales.read`                                | 当前商城、游标上限、敏感字段脱敏                            |
| 查看凭证             | `store.after-sales.evidence.read`                       | 每次读取审计、短期 no-store URL、扫描通过                   |
| 审批/拒绝            | `store.after-sales.review`                              | 近期 MFA、确认词、reason、expected version、幂等键          |
| 旧订单一次性例外决定 | `store.after-sales.review`                              | 当前管理员、未污染初态、policy basis、无副作用且只能一次    |
| 创建商家主动退款售后 | `store.after-sales.review`                              | 当前商城订单、服务端金额、近期 MFA、幂等和审计              |
| 解决人工复核         | 原动作权限 + `store.after-sales.review`                 | 恢复同类型记录状态；仅无任何副作用的早期状态可拒绝          |
| 发起 ONLINE 退款     | `store.after-sales.review` + `store.refunds.create`     | 复用 M5 容量/锁/outbox；金额服务端计算                      |
| 查询 ONLINE 退款     | `store.after-sales.read` + `store.refunds.read`         | 不返回完整供应商引用或原始响应                              |
| 返件验收             | `store.after-sales.inspect`                             | 近期 MFA、完整行集、处置数量守恒、版本、审计                |
| 恢复可售库存         | `store.after-sales.inspect` + `store.inventory.adjust`  | 仅验收可售数量、稳定 operation key、同事务审计              |
| 创建换货             | `store.after-sales.exchange`                            | 同 SPU 等量 SKU、库存预留、近期 MFA、幂等                   |
| 换货运单             | `store.after-sales.exchange` + `store.shipments.create` | purpose=EXCHANGE_OUTBOUND，不推进原订单                     |
| COD 退款申请         | `store.after-sales.cod-refunds.request`                 | 近期 MFA、确认词、金额服务端计算、证据加密                  |
| COD 退款确认         | `store.after-sales.cod-refunds.confirm`                 | case ID + settlement 公开号、异人复核、近期 MFA、版本、审计 |
| 政策/历史/设置查看   | `store.after-sales.policy.read`                         | 当前商城、只读不可变版本、敏感审计字段不返回                |
| 政策草稿             | `store.after-sales.policy.manage`                       | 三语校验、商城目标约束、乐观锁                              |
| 政策发布             | `store.after-sales.policy.publish`                      | 近期 MFA、确认词、payload hash、发布后不可变                |
| 政策停用             | `store.after-sales.policy.disable`                      | 近期 MFA、确认词、历史版本/快照保持可读                     |
| 快照强制开关         | `store.after-sales.policy.enforce`                      | 近期 MFA、确认词、逐商城 readiness 预检、审计               |

任何退款、库存恢复或换货命令都不能仅凭前端隐藏按钮保护。权限不足、令牌/Header 商城不一致或
跨商城对象统一失败，不能泄漏对象是否存在于其他商城。

M6.2 已完成 shipment purpose 的数据库归属/type/允许状态 guard，并通过聚合锁关闭 raw shipment 与
拒绝、到期、换货转退款的并发旁路。M6.3 创建售后运单前仍必须让既有 M5 订单物流查询、命令、
callback 与 worker 显式按 purpose 判权和分流；`store.shipments.*` 不能让
`AFTER_SALE_RETURN`/`EXCHANGE_OUTBOUND` 复用 `ORDER_OUTBOUND` 的原订单推进路径。

共用 `/refund` 命令必须从可信订单支付方式动态判权：ONLINE 同时要求
`store.after-sales.review + store.refunds.create`；COD 只走
`store.after-sales.cod-refunds.request` 和受审线下 settlement。控制器不能用 review 权限替代 COD
财务权限，也不能接受客户端 payment method 选择分支。

## 3. 买家能力

| 能力               | 身份与范围               | 控制                                                  |
| ------------------ | ------------------------ | ----------------------------------------------------- |
| 创建/查看/取消售后 | 当前商城认证会员本人     | 订单和行从服务端解析；不接受金额、状态、store/member  |
| 上传/读取凭证      | 当前会员、当前售后单     | 类型/大小/checksum/扫描；短期签名；禁止访问他人凭证   |
| 提交返件信息       | 当前会员、已批准返件     | 锁 case、允许状态/截止点；不当作权威签收              |
| 收藏               | 当前会员、当前商城商品   | PUT/DELETE 幂等；下架商品只返回受限摘要               |
| 浏览历史           | 当前会员、当前商城商品   | 最多 100；可单删/清空；匿名不写入                     |
| 会员中心           | 当前会员                 | 复用本人资料、地址、券和订单事实，不返回管理字段      |
| 隐私请求受理/查询  | 当前会员、当前商城       | 真实 SUBMITTED 事实；不声称导出/删除/注销已完成       |
| 创建/解析分享      | 当前商城；创建可选会员   | 只接受公共 code/locale/受限来源；服务端解析已发布目标 |
| 记录分享结果       | interaction token 持有人 | token 绑定 shortCode/交互/有效期；仅完成/取消统计     |

会员不能通过订单 UUID、订单行 UUID、售后号、商品 code、分享短码、游标或 Header 访问其他会员
或商城数据。RLS 只作纵深防御，服务查询仍显式包含 `store_id/member_id`。

## 4. 分享和公开兜底边界

- 公共 resolver 不接受内部 UUID、`store_id`、任意 URL/title/image 或重定向目标。
- target type 只允许 STORE/BRAND/CATEGORY/PRODUCT/PROMOTION/COUPON；服务端验证同商城和发布状态。
- browser fallback 只按全局不可猜 `shortCode` 查询服务端绑定的单一商城/目标事实，不从请求 Header、
  query 或 path 中接受 `storeCode/locale/type/code` 组合。
- 卡片文本 HTML 转义并设置 CSP；图片只允许同商城已发布产物或受控代理，不抓取任意远程 URL。
- attribution 参数只接受服务端签发、绑定商城/活动/有效期的 opaque token；匿名请求不能提交 raw
  campaign/promotion code。完成/取消只接受创建响应签发且绑定 shortCode/交互/有效期的 token；服务端
  只存 token digest。交互限流并有限保留，URL/日志不含会员 ID、Zalo subject、手机号。
- Zalo `openShareSheet` 只允许由用户点击触发；取消不是成功，任何结果都不能兑换奖励或资金。

## 5. 数据库与对象存储最小权限

- M6 商城表全部 FORCE RLS；运行角色没有 bypass。复合 FK 阻止跨商城及同商城错订单/行/会员/SKU/
  payment/refund 拼接。favorites/history/privacy 在 member actor 下的 `USING/WITH CHECK` 还必须要求
  `member_id=app_security.current_actor_id()` 与 `app.actor_type='member'`，不能仅做 store-only RLS。
- 政策版本、售后转换、结算历史、库存动作和分享交互撤销 UPDATE/DELETE；状态头只允许领域命令
  通过只追加 transition 和 definer trigger 原子投影，运行角色没有 header 状态列直改权限。
- 售后行/legacy 决定、settlement、返件、库存和换货 guard 在必要时以受控 definer owner 跨 RLS
  锁定聚合；函数固定 `search_path=pg_catalog, public, pg_temp`，PUBLIC/runtime 直接 EXECUTE 均撤销。
  M6.6 运行时交付前，runtime 也不能直接 INSERT 分享三张事实表。
- evidence bucket/prefix 按环境和商城隔离。普通 catalog/content 权限不能读取售后凭证；管理员
  下载 URL 短期、一次用途并带 no-store，日志只记录内部对象 ID 和审计结果。
- 凭证清理 worker 使用独立最小对象删除权限，只按数据库中已持久化的精确商城对象 key 删除原件和
  衍生物；进入删除事务前重新锁行并检查截止点与 legal hold。legal hold 不赋予普通读取权限，删除失败
  只记录稳定错误类别并有界重试，日志不得包含签名 URL、对象正文或供应商原始错误。
- 会员与普通管理员只看到 `PENDING/READY/UNAVAILABLE` 安全投影；隔离、删除中、删除失败和已删除
  只保留在受限内部事实中，不能通过售后详情、上传响应、错误码或时序差异泄露。
- COD 收款信息与转账证据按敏感数据加密；常规 API、审计快照和日志仅返回掩码或存在性。

## 6. 稳定拒绝与必测安全场景

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
