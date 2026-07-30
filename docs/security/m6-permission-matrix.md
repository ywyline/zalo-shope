# M6 售后、会员与分享权限矩阵

> 状态：M6.1 契约已冻结；M6.2 权限目录/数据库 scope 已迁移；M6.3-A settings、
> M6.3-B0、B1、B2a、B2b-D0、B2b-D1 repository + local/test storage validation、B2b-D2
> repository implementation + local/test scanner worker validation、B2b-D3 repository
> implementation + local/test member evidence HTTP validation 与 B2b-D4 repository implementation +
> local/test deletion worker validation、B2b-D5 default-disabled repository implementation +
> local/test protected-read validation `COMPLETE`，适用 repository/local-test 门禁 `PASS`；
> B2/B2b、B3-B7、M6.3、UI 与生产启用未完成或未授权并保持失败关闭
>
> 日期：2026-07-31

M6.2 已登记下列 12 项 STORE 权限且不自动给生产角色扩权；local/test seed 仅为明确的测试
`store-admin` 授权。第五段前向迁移把 member actor 限制到本人售后/凭证和隐私请求的有界命令；
初始第六段 `20260727115000_m62_integrity_closeout` 进一步收口 legacy 决定、聚合状态/副作用并发、
返件/结算/库存/换货/凭证事实和 definer ACL；后续五段前向修复保持 member scope，补齐容量占用、
共享退款锁序及 definer NULL actor fail-closed。收藏、历史继续使用 owner scope。M6.3-A 仅实现
`GET/PUT /v1/admin/after-sale-settings` 的运行时 RBAC、审计和幂等边界；M6.3-B1 随后只实现会员/
管理员售后列表与详情。B2a 随后实现政策读取、草稿、发布和停用的独立运行时 RBAC，并在收口时为已有 settings GET/PUT
补齐严格输入、成功 correlation/no-store 和共享的管理员 READ/WRITE 限流。D0 随后只建立凭证
数据库生命周期、专用 SYSTEM scope、对象 ledger、配额锁、严格 outbox 与 reconciliation 原语；它
没有启用任何凭证 HTTP、worker、对象存储、scanner 或生产角色。D1 后续只新增内部 storage adapter、
失败关闭配置和 local/test MinIO bucket/IAM/真实 bytes 校验，不增加 STORE 权限，也没有 HTTP/worker
调用方。D2 只接入内部 scan worker、ClamAV、租约绑定投影与 scan dead-letter 收敛，同样不增加
STORE 权限或角色授权。D3 随后只开放会员初始化、确认和 owner 安全状态三条 HTTP 路由，复用
member owner RLS，不新增 STORE 权限或生产角色授权；它不开放凭证正文或管理员读取。D5 随后默认关闭地
接入 member/admin 已 claim READY ORIGINAL 保护读取与管理员逐次审计，不新增 STORE 权限 code、角色 seed
或生产授权。其他售后写入、会员、分享
controller/service/worker/UI 仍未交付。本矩阵中除明确标为 M6.3-A、B1、B2a、D0 数据层、D1 local/test storage
、D2 local/test 内部扫描、D3 local/test 会员 HTTP、D4 local/test 内部删除 worker 或 D5 local/test
保护读取切片的动作外，其余动作行是 B0 已冻结、等待完整 B2b/B3-B7
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

| 动作                 | 必要权限                                                | 额外控制                                                                                                                           |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 管理售后列表/详情    | `store.after-sales.read`                                | B1 已实现；中央商城授权 + 显式 store scope + FORCE RLS、签名游标/locale/限流、严格 select/no-store                                 |
| 查看凭证             | `store.after-sales.evidence.read`                       | D5 default-disabled repository/local-test `COMPLETE`；admin 当前商城 scope、跨商城 AccessReason、READ 限流、提交截止重验和逐次审计 |
| 审批/拒绝            | `store.after-sales.review`                              | B4 契约；近期 MFA、确认词、reason、expected version、幂等键、逐行 approved_quantity                                                |
| 旧订单一次性例外决定 | `store.after-sales.review`                              | 当前管理员、未污染初态、policy basis、无副作用且只能一次                                                                           |
| 创建商家主动退款售后 | `store.after-sales.review`                              | B3 契约；同政策/version/hash、权威交付事实、服务端金额、近期 MFA、幂等和审计                                                       |
| 解决人工复核         | 原动作权限 + `store.after-sales.review`                 | 恢复同类型记录状态；仅无任何副作用的早期状态可拒绝                                                                                 |
| 发起 ONLINE 退款     | `store.after-sales.review` + `store.refunds.create`     | 仅 B6 设计；复用 M5 transaction/capacity/outbox，B0 不开放运行时                                                                   |
| 查询 ONLINE 退款     | `store.after-sales.read` + `store.refunds.read`         | 仅 B6 设计；不返回完整供应商引用或原始响应                                                                                         |
| 返件验收             | `store.after-sales.inspect`                             | 整体延至 M6.4；须与 exactly-once 库存恢复一并授权，B 不开放写路由                                                                  |
| 恢复可售库存         | `store.after-sales.inspect` + `store.inventory.adjust`  | M6.4；仅验收可售数量、稳定 operation key、同事务审计                                                                               |
| 创建换货             | `store.after-sales.exchange`                            | 同 SPU 等量 SKU、库存预留、近期 MFA、幂等                                                                                          |
| 换货运单             | `store.after-sales.exchange` + `store.shipments.create` | purpose=EXCHANGE_OUTBOUND，不推进原订单                                                                                            |
| COD 退款申请         | `store.after-sales.cod-refunds.request`                 | 仅 B7 设计；近期 MFA、服务端金额、真实转账证明入口缺失时保持 PENDING/REVIEW_REQUIRED                                               |
| COD 退款确认         | `store.after-sales.cod-refunds.confirm`                 | 仅 B7 设计；公开号、异人复核、近期 MFA；真实证明适配入口前不开放成功按钮                                                           |
| 政策/历史查看        | `store.after-sales.policy.read`                         | B2a 已实现；当前商城、签名微秒游标、不可变版本复验、ADMIN READ 限流/no-store                                                       |
| 设置/readiness 查看  | `store.after-sales.policy.read`                         | M6.3-A 已实现；令牌/Header/查询一致；平台跨商城需 AccessReason                                                                     |
| 政策草稿             | `store.after-sales.policy.manage`                       | B2a 已实现；严格三语/规范 hash、商城目标、expected version、24h 幂等、ADMIN WRITE 限流与审计                                       |
| 政策发布             | `store.after-sales.policy.publish`                      | B2a 已实现；近期 MFA、确认词/reason、不可变版本、目标冲突与 enforcement readiness 同事务                                           |
| 政策停用             | `store.after-sales.policy.disable`                      | B2a 已实现；近期 MFA、确认词/reason、只移除当前投影，历史版本/快照保持可读且 readiness 失败回滚                                    |
| 快照强制开关         | `store.after-sales.policy.enforce`                      | M6.3-A；MFA/确认/reason/expected version；跨店 AccessReason；24h 商城幂等；精确 before/after 审计                                  |

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

| 能力               | 身份与范围               | 控制                                                                                                                                |
| ------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 查看售后列表/详情  | 当前商城认证会员本人     | B1 已实现；显式 store/member scope + FORCE RLS、签名游标、严格 select、no-store                                                     |
| 创建/取消售后      | 当前商城认证会员本人     | B3 契约；同 policy/version/hash、权威交付、服务端金额；当前未授权、未注册写路由                                                     |
| 预上传/确认/查状态 | 当前商城认证会员本人     | D3 已实现且默认关闭；store+owner RLS、真实 bytes 校验、scan 排队、读写限流、安全状态投影                                            |
| 读取凭证正文       | 当前会员、当前售后单     | D5 default-disabled repository/local-test `COMPLETE`；owner RLS、已 claim READY ORIGINAL、授权期限/提交截止重验、READ 限流/失败关闭 |
| 提交返件信息       | 当前会员、已批准返件     | B5 契约；只写 SUBMITTED 并追加 START_RETURN 到 RETURN_PENDING；当前未授权、不能标记运输中                                           |
| 收藏               | 当前会员、当前商城商品   | PUT/DELETE 幂等；下架商品只返回受限摘要                                                                                             |
| 浏览历史           | 当前会员、当前商城商品   | 最多 100；可单删/清空；匿名不写入                                                                                                   |
| 会员中心           | 当前会员                 | 复用本人资料、地址、券和订单事实，不返回管理字段                                                                                    |
| 隐私请求受理/查询  | 当前会员、当前商城       | 真实 SUBMITTED 事实；不声称导出/删除/注销已完成                                                                                     |
| 创建/解析分享      | 当前商城；创建可选会员   | 只接受公共 code/locale/受限来源；服务端解析已发布目标                                                                               |
| 记录分享结果       | interaction token 持有人 | token 绑定 shortCode/交互/有效期；仅完成/取消统计                                                                                   |

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

### 4.1 SYSTEM 凭证生命周期 principal

- D0 新增的 evidence SYSTEM principal 不是 RBAC 权限、管理员 token 或上节售后 SYSTEM 的扩展。
  transaction-local 上下文必须精确设置 `actor_type=system`、
  `system_scope=after-sale-evidence-lifecycle`、当前 `store_id`、稳定 actor
  `00000000-0000-4000-8000-000000000006` 和非空 correlation ID。普通 StoreContext、任意管理员
  UUID 或 `system_scope=after-sale-transition` 均被 FORCE RLS/trigger 拒绝。
- 该 principal 只允许重扫请求、扫描结果、到期、逐对象删除、删除失败/重试/耗尽与 dead-letter reconciliation
  所需的生命周期事实，以及受控 DERIVATIVE/SCAN_TEMPORARY ledger 写入。它不能 claim、审核售后、
  作 legacy 决定、设置/解除 legal hold、创建退款/库存/物流事实或执行任何人工动作。
- evidence transition 仍由父行受控 lifecycle 变化（含同状态重扫）自动追加。除会员 `CLAIM` 外，D0 lifecycle transition 必须由该
  SYSTEM principal 产生，并记录固定 SYSTEM actor、精确 from/to、稳定 event/error code 与 correlation
  ID。运行角色不能直接 INSERT/UPDATE/DELETE transition，也不能直接执行 definer validator。
- scan/expire/delete outbox 写入还受严格 actor 规则：会员只能在初始化/确认/claim 的允许事务排队
  scan/expire；delete 只能由 evidence SYSTEM 排队。所有消息只携带
  `store_id/evidence_id/expected_version`，未来 worker 不得把消息当作授权或权威状态。
- D2 scan handler 与 dead-letter service 每次都通过 `createAfterSaleEvidenceSystemContext` 构造上述固定
  actor/scope，并只从服务端消息确定当前商城。worker 名称、管理员 token、请求体 actor/store/scope 或
  普通 StoreContext 都不能获得该 principal；外部扫描前后的数据库 lease 与权威 evidence 复核仍不可省略。

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
- B2a 政策管理同样不把 tenant RLS 当作 RBAC；service 在每次读/写前要求精确的
  `policy.read/manage/publish/disable`，并显式绑定 token、`X-Store-Code`、`store_id` 和平台跨商城 `X-Access-Reason`。
  新迁移只添加两个分页索引，不改写 RLS。ACTIVE-only 政策 RLS 方案被否决：它会使 B1 会员无法读取停用/替换后的
  已绑定历史版本，却仍不能隐藏 ACTIVE head 行内草稿列。保留既有 tenant SELECT 并由应用独立 RBAC/严格投影保护管理面。
- `app_security.lock_m63_after_sale_setting()` 是唯一有意允许 runtime 直接 EXECUTE 的 definer 例外。
  它固定安全 `search_path`，只读取 `app_security.current_store_id()`，只返回并锁定当前商城 enforcement
  布尔值；设置行缺失时失败关闭，不能更新设置、枚举商城或扩大任何 policy 权限。
- D0 的 `after_sale_evidence_objects` 启用 FORCE RLS。owner member 只可在初始化事务插入与当前
  `PENDING` 父行绑定的 ORIGINAL；专用 SYSTEM 可读取/插入 ledger，但列级 UPDATE 仅开放
  `object_key/deleted_at/version/updated_at`，trigger 进一步限制为无 hold 的 `DELETION_PENDING` 逐对象
  删除事实。运行角色没有 DELETE；父行与 ledger 的 deferred guard 禁止 `DELETED` 仍保留活动 key。
- D0 已撤销旧 evidence 宽 INSERT/UPDATE policy，分别建立 member 初始化/确认/claim、admin legal
  hold 和 evidence SYSTEM lifecycle policy。应用 RBAC 仍必须保护未来管理员 HTTP；数据库 admin hold
  policy 只是既有治理字段的数据边界，D0 没有提供设置/解除 hold 的 API。
- D1 已在 local/test 建立与 content 分离的固定 evidence bucket，以及不可互相替代的 upload/read/delete
  最小身份；content 身份不能访问 evidence，三种 evidence 身份不能访问 content 或执行角色外动作。
  bootstrap root 只用于创建 bucket/user/policy，应用与测试证据不得使用 root。production bucket/IAM/
  KMS/lifecycle/versioning/Object Lock 仍未验收，不能沿用 local/test 结论。
- D2 scan worker 只使用 D1 的 evidence read 身份执行 HEAD 和 GET，不获得 upload/delete、content bucket
  或 RBAC 权限。HEAD 必须取得非空 ETag，GET 必须带 `If-Match`；实际长度、SHA-256、magic 与 ClamAV
  共用同一有界流。消息中的 store/evidence/version 只能定位数据库事实，不能直接授权对象读取。
- D5 已在默认关闭的 capability 下注册 member/admin ORIGINAL 保护读取。管理员除
  `store.after-sales.evidence.read` 外仍须通过当前商城或显式跨商城授权、有效 session、逐次最终重验与审计；
  单独持有该权限不能绕过 case/evidence scope、`READY`/claim 状态或 ordinary-access deadline。生产对象
  存储 IAM/KMS、短期 bearer URL 风险接受与 rollout 仍未验收，不能把 local/test 结论当作生产授权。
- D4 凭证清理 worker 使用 D1 独立最小对象删除权限，只按数据库 ledger 中已持久化的精确商城对象 key
  删除原件、衍生物和扫描临时对象；provider 调用前后重锁并复核 lease、父 version/status、截止点、
  legal hold 与完整 ledger。legal hold 不赋予普通读取权限，删除失败只记录稳定错误类别并有界重试，
  日志不得包含签名 URL、对象正文或供应商原始错误。该运行时仅在 repository/local-test 边界完成；
  production versioned-object 物理删除、hold 管理和外部告警仍未验收。
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
- B2a 必测四类 policy 权限互不隐含、近期 MFA、严格 header/query/path/body、跨商城目标、create/update/version 冲突、
  同键复放/异参、ACTIVE 草稿不污染 checkout、同目标并发冲突、不可变历史、enforcement 下安全发布和危险发布/停用回滚。
  游标还要拒绝篡改、跨资源/跨 policy 重放；管理写 30/60 限流先于目标查询，审计必须含完整 before/after/reason/correlation，
  稳定 `409` 只公开 `details.reason_code`。
- B2a 还必须在注册路由前对目标库执行只读兼容性预检，覆盖旧 code、草稿/hash/product/head、版本/三语/assignment/
  标量与发布时间。本地测试库已 `PASS (policies=0, versions=0)`，但不能作为 staging/production 目标库证据。
- D0 必测错误 actor/scope、管理员冒用 SYSTEM、跨商城/跨会员已知 UUID、直接 transition/宽列 UPDATE、
  非规范对象路径/hash/role 和父行/ledger 半删除；数据库与服务层两层都须失败关闭。
- D0 必测同会员并发数量/字节配额，初始化/确认/重扫/scan 结果/claim/expire/delete 与严格 outbox 同事务，
  payload 无对象 key/hash/MIME/checksum/scanner/deadline/hold/error marker，以及旧 generation/version、
  重复/乱序和 DEAD_LETTER 不得放行或倒退。真实 worker lease 丢失属于完整 B2b 外部演练，D0 未运行。
- D0 必测 upload/claim/ordinary-access/retention 排他截止，已 claim READY 后晚到恶意结果仍使用
  retention 清理截止；hold 阻止删除但不延长普通访问；解除后 reconciliation 重排。删除必须覆盖
  ORIGINAL/DERIVATIVE/SCAN_TEMPORARY 精确 ledger 集合，第 5 次形成告警条件、第 8 次耗尽且不再
  自动重试。
- D0 owner preflight 的本地四类事实为 0；runtime RLS 连接以 SQLSTATE `42501` 失败关闭。任何
  staging/production 仍须对精确目标库重新执行并留证，非空不得 rollout。D0 没有 UI、HTTP、对象、
  scanner 或外部告警，相关验收为 `NOT_APPLICABLE` 或 `NOT_RUN/BLOCKED`，不能使用数据库 fixture
  冒充。

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
  单独实施 B1 不改变 B0 历史证据。B2a 的仓库完成边界以下节为准；B2b/B3-B7、UI、生产政策/启用、供应商调用、部署与发布仍未授权。

## 9. B2a 政策授权与当前边界

- 七个政策接口都先执行中央管理员商城授权。列表/详情/版本读取仅接受 `policy.read`；草稿仅接受 `policy.manage`；
  发布/停用分别仅接受 `policy.publish/disable`。任何一项都不能代替另一项，也不由前端按钮可见性代替服务端授权。
- 发布和停用必须经近期 MFA，并携带对应确认词、至少 10 字符业务 reason、expected version 与 Idempotency-Key。草稿同样
  要求 expected version 和幂等键，但不用发布/停用权限或 MFA 代替 manage 权限。平台跨商城继续要求中央 `X-Access-Reason` 授权/审计。
- 政策及 settings 读/写现分别消费 ADMIN READ 120/WRITE 30 次每 60 秒档位，scope 为商城+主体。Redis 故障不放行，
  在读取/写入目标事实前统一返回 `503 UPSTREAM_UNAVAILABLE`；超限返回 `429` 和 `Retry-After`。成功响应统一使用
  `private, no-store` 与安全 correlation ID。
- `Idempotency-Key` 与 `X-Access-Reason` 都按敏感字段处理；HTTP 和结构化日志必须脱敏，不能因审计需要记录其原文。
- B2a 不改变会员权限。B1 会员仍仅能通过本人售后投影读取已绑定历史政策；不得访问管理草稿路由。新迁移没有改写 RLS，
  不会因政策停用或新版本发布而让历史售后不可读。
- 定向权限/限流/契约单测、完整 integration 29 个文件/234 项、M2→current 42 段迁移、`verify`、OpenAPI 结构检查、生产依赖/Gitleaks 与
  独立高风险复审均通过，因此 B2a 仓库实施为 `COMPLETE`。目标库仍须逐库 preflight；B2/B2b、B3-B7、M6.3、UI、生产政策/enforcement/部署
  继续未完成或未授权且失败关闭。

## 10. B2b-D0 授权与当前边界

- D0 没有新增可授予的 STORE permission code，也不自动给任何生产角色扩权。
  `store.after-sales.evidence.read` 仍只是完整 B2b 管理员保护读取契约；没有 HTTP 路由、短期 URL 或
  每次读取审计实现时，持有该权限也不能读取对象。
- member 的 D0 数据库能力只存在于受限初始化、确认和未来 B3 transaction-scoped claim 原语：全部
  绑定当前 store + owner、精确 version、配额锁和排他 deadline。D0 不暴露可单独调用的 claim 路由，
  也不允许会员插入衍生/扫描临时对象、提交 scanner 结果、设置 hold 或删除 ledger。
- evidence SYSTEM 只通过内部构造的不可变 context 使用。它不接受 access token、请求体 actor/store/
  scope，也不由 worker 名称自动获得。未来 worker 处理每条消息前仍须建立精确商城 context、锁定
  evidence/ledger、复核 version/generation/deadline/hold，并在网络事务外调用 provider。
- D0 的本地参数和自动化 fixture 不是生产授权。upload/claim/access/retention TTL、数量/字节配额、
  删除重试/告警、专用 bucket/IAM/KMS/lifecycle 和 scanner SLA 均需逐环境审批与显式配置；缺项或
  不合法时未来 capability 必须 false。
- 因此 D0 只将 database repository implementation 标记 `COMPLETE`；其历史完成时对象存储、scanner、
  保护读取、worker、外部告警、生产 preflight/rollout 均为 `NOT_RUN/BLOCKED`。D1 后续完成的 local/test
  storage 子集以下节为准，B2b/B2/M6.3/M6/P0 仍保持未完成。

## 11. B2b-D1 storage IAM 与当前授权边界

- D1 不新增可授予的 STORE permission code、不修改角色 seed，也不自动给生产角色扩权。三种
  `EVIDENCE_STORAGE_*` 身份是 server-only provider 凭据，不是 RBAC 权限、管理员 token 或 evidence
  SYSTEM principal。
- local/test MinIO 已验证 content/evidence bucket 隔离，upload 只能 create-only PUT、read 只能
  HEAD/GET、delete 只能 DELETE；三者不得互相替代。root 只允许 bootstrap，任何应用/测试请求使用 root
  都不构成验收证据。
- D1 adapter 不接受请求方提供 store/actor/scope 取得权限。规范 key 中的 store/evidence UUID 必须与
  服务端对象身份逐段一致；provider 错误只返回稳定分类，禁止泄露 key、签名 query、凭据或正文。
- D1 没有调用 D0 evidence SYSTEM principal、数据库 claim 或 outbox。未来 worker 仍须为每条消息建立
  精确 store SYSTEM context、重读并锁定 ledger/version/deadline/hold，在网络操作后再次重锁提交事实。
- D1 收口时 `store.after-sales.evidence.read` 仍只是未来管理员保护读取契约；当时没有路由和访问审计，
  内部 `createProtectedReadTarget` 存在也不使 `protectedReadAvailable=true`。后续 D5 边界见第 15 节。
- 当前 delete-only adapter 不支持 version ID。固定 local/test evidence bucket 必须从未启用版本控制；
  production versioning/Object Lock/物理版本删除方案未冻结前，`deletionCompensationAvailable` 保持
  false。AWS 最小 read IAM 对不存在对象可能返回 `403`，目标 provider 的稳定错误映射仍待验收。
- 因此 D1 只将 repository implementation + local/test storage validation 标记 `COMPLETE`。D1 收口时
  HTTP、worker、scanner 和管理员读取审计尚未完成；后续 D2-D5 的局部状态以下节为准。生产 IAM/KMS/
  lifecycle 与 rollout 仍未完成，B2b/B2/M6.3/M6/P0 也未因此完成。

## 12. B2b-D2 scanner worker 与当前授权边界

- D2 不新增 STORE permission code、不修改角色 seed，也不创建可授予的 scanner 权限。ClamAV 网络
  配置和 evidence read provider 凭据都是 server-only 运行配置，不是 RBAC、管理员 token 或会员能力。
- scan handler 只接受严格 `after-sale.evidence.scan.requested` v1，并通过固定 evidence SYSTEM context
  读取权威消息/evidence/ORIGINAL ledger。网络调用前后分别校验；结果提交用数据库
  `clock_timestamp()` 复核 `PROCESSING`、lease owner、严格未到期 lease、消息 version、store/payload
  以及 evidence version/generation/status。lease 到期相等也拒绝，旧租约或旧 generation 不能写结果。
- loader 和 result primitive 在等待 evidence 行锁后都会重新读取数据库时钟并复核租约，且各自事务
  最长 2 秒。legal hold 等同状态 version 漂移只允许通过固定 SYSTEM scope 原子生成下一 generation/
  scan outbox，旧消息不能借此取得新版本授权。
- ClamAV 仅在单一 `zIDSESSION\0` 连接以 request 1/2 执行 VERSION/INSTREAM。严格协议、签名 freshness
  与 50 MiB 流边界通过后，只有精确 `2: stream: OK` 可成为 `CLEAN`；malware signature、provider
  原始错误、对象 key、签名 URL 和 checksum 均不得进入日志、审计或稳定数据库错误。
- scan `DEAD_LETTER` 由独立持久、有界轮询重新锁定权威事实。当前待扫描对象只能收敛为带
  `SCAN_OUTBOX_DEAD_LETTER` 的 `FAILED` 并排队清理；旧 version/generation 必须 `SUPERSEDED`。该内部
  收敛不构成管理员 dead-letter 管理入口或外部告警。
- D2 收口时 `store.after-sales.evidence.read` 仍不可用；D2 没有新增 HTTP 路由、短期读取 URL、管理员
  逐次读取审计、B3 claim 或 expire/delete worker，也不改变当时的 RLS、grant、trigger、enum、迁移或
  OpenAPI runtime status。后续 D4/D5 的局部状态见第 14、15 节。
- D2 已在全部适用测试、仓库门禁、文档和独立复审通过后，将 repository implementation + local/test
  scanner worker validation 局部标记 `COMPLETE`。production 仍需
  单独批准 TTL、Clamd loopback sidecar/网络隔离（TCP 本身无认证/TLS）、签名更新/freshness、HA/容量/
  监控/SLA、storage IAM/KMS/versioning/Object Lock/lifecycle/错误语义、删除补偿及 HTTP 授权/审计与 rollout；
  B2b/B2/M6.3/M6/P0 继续未完成。

## 13. B2b-D3 会员 HTTP 与当前授权边界

- D3 不新增 STORE permission code、不修改角色 seed，也不把 provider 凭据或 evidence SYSTEM scope
  转化为会员权限。三条路由只接受当前商城有效 member token，并同时绑定 `X-Store-Code`、token
  `store_id`、数据库 owner RLS 与显式 `store_id/member_id/evidence_id` 条件。
- 初始化与确认使用 MEMBER WRITE 10 次每 60 秒档位，owner 状态使用 MEMBER READ 60 次档位；scope
  为商城+会员。认证和限流先于 evidence 事实读取/写入，Redis 故障失败关闭，超限不会创建凭证事实。
- 会员只能获得 create-only 上传 URL、必需 header allowlist 和 `PENDING/READY/UNAVAILABLE` 状态。
  响应不包含 object key、bucket、checksum、scanner identity/result、hold、删除原因、供应商错误或签名
  凭据；跨会员或商城的已知 UUID 返回不可探测结果。
- D3 confirmation 只从 owner 声明取得内部规范 key，由 D1 read 身份验证真实 bytes；会员不获得
  SYSTEM-only ledger SELECT。D2 仍用固定 evidence SYSTEM scope 独立重读 ledger 后扫描，HTTP 校验
  不能自行投影 `CLEAN`。
- D3 收口时 `store.after-sales.evidence.read` 仍不可用。D3 的 owner 状态 GET 不是凭证正文访问，也不
  提供会员/管理员保护 URL、管理员逐次读取审计或 legal hold 管理；后续 D5 局部边界见第 15 节。
- D3 的独立 capability 默认 false，production 启用还需批准 TTL/配额、storage/scanner、隐私/合规和
  rollout。D3 收口时 B3 claim、protected read、expire/delete worker、外部告警与生产证据仍缺失；
  D4/D5 后续局部完成也不使完整 B2b/B2/M6.3/M6/P0 完成。

## 14. B2b-D4 删除 worker 与当前授权边界

- D4 不新增 STORE permission code、不修改角色 seed，也不把 delete-only 凭据变成管理员或会员权限。
  expire/delete handler 只使用固定 `after-sale-evidence-lifecycle` SYSTEM scope，并由数据库 FORCE RLS、
  payload store/evidence identity 与显式 `context.storeId` 共同约束商城。
- delete-only storage identity 可删除 ORIGINAL、DERIVATIVE、SCAN_TEMPORARY 规范路径，但 create-upload、
  HEAD/GET 验证和 protected-read 仍严格 ORIGINAL-only。role 扩展不产生任何公共 URL 或文件读取权限。
- provider 调用前后都校验当前 outbox lease、父 evidence version/status/legal hold 和完整 ledger。对象 key、
  provider 正文、checksum、凭据或签名 URL 不进入日志、outbox 或稳定错误；日志只记录稳定 code、商城和
  attempt 条件。
- lifecycle dead-letter reconciler 是内部 SYSTEM 补偿，不构成管理员 dead-letter 管理 API、人工删除
  按钮、legal hold 管理入口或外部告警。第 5/8 次仅形成本地稳定可观测事实。
- D4 本身未提供 `store.after-sales.evidence.read` runtime 或 B3 transaction-scoped claim；后续 D5 才在
  默认关闭条件下接入该读取权限。production IAM/KMS/versioning/Object Lock/lifecycle、历史版本物理删除和
  rollout 仍未验收，因此完整 B2b/B2/M6.3/M6/P0 继续未完成。

## 15. B2b-D5 保护读取与管理员逐次审计授权边界

- D5 default-disabled repository implementation + local/test protected-read validation 为
  `COMPLETE`，不新增 STORE permission code 或角色 seed。管理员读取只能通过
  `store.after-sales.evidence.read`，并同时通过既有 token、`X-Store-Code`、`store_id`、当前商城授权和
  FORCE RLS；平台跨商城仍需有效的 D5 固定 incident-reference `X-Access-Reason`，由既有跨商城审计记录。
  该路由拒绝自由文本，避免 URL、object key、checksum 或 provider 内容借审计 reason 落库。普通商城管理员不能借该权限
  读取其他商城。
- 会员只可读取自己、当前商城、指定售后 case 的已 claim `READY` ORIGINAL；管理员不可因凭证权限而取得
  object ledger、DERIVATIVE、SCAN_TEMPORARY、object key、checksum 或 scanner/provider 详情。错商城、错
  主体/案例、未 claim、过期、隔离、删除中和已删除均折叠为相同 `404`。
- member/admin 读取各复用现有 after-sales READ 限流；限流、默认关闭 capability、S3 signing、最终重验或
  admin 审计失败均失败关闭。签名 URL 是短期 bearer 能力，响应 `private, no-store` 与 `no-referrer`，并严格
  早于 `ordinary_access_deadline_at`、Bearer token 和持久 session 三者的最早截止点。
- 最终事务不仅复验 evidence：第 45 段授权感知 definer 锁定并复验 ACTIVE 商城、当前 member/admin、
  Bearer 及未撤销未到期 session；管理员还必须保有 direct store `evidence.read` 或 cross-store platform
  permission。第 47 段在 evidence `FOR SHARE` 已取得后再次检查 Bearer/session、signed URL 与
  ordinary-access deadline，避免等待 lifecycle 写锁期间过期。第 48 段
  `20260731100000_m63_b2b_d5_commit_deadline_revalidation` 进一步要求 URL 截止不晚于锁定的 Bearer/
  session 截止，并在锁后保留一秒 finalization margin；admin 写审计后还会在同一事务再次调用该重验，
  防止审计延迟跨过授权或 URL 提交截止。
- 每个成功 admin URL 恰在最终 `FOR SHARE` revalidation 事务中写一条
  `after-sale.evidence.protected_read.issued` 审计。审计 allowlist 不含 URL、key、checksum、文件内容、
  scanner 或 provider 数据；使用服务端生成且不接受客户端覆盖的 correlation ID，并保存来自受信请求
  peer 的规范化 `source_ip`。来源 IP 缺失/非法或审计写入失败均返回 `503` 且不返回 URL；production
  反向代理必须在受控网络边界配置，不能直接信任未经验证的 `X-Forwarded-For`。legal hold 只影响物理
  删除，不能提前撤销仍在 ordinary access window 内的读取。
- 第 44-48 段迁移使用 `zalo_shop_evidence_read_guard`，它必须 `NOLOGIN`、`NOINHERIT`、
  `NOSUPERUSER`、`NOCREATEDB`、`NOCREATEROLE`、`NOREPLICATION`、`NOBYPASSRLS` 且无角色关系。第 46 段
  `20260730104000_m63_b2b_d5_member_authorization_grant_fix` 仅补 guard 对 `members.store_id` 的列级
  `SELECT`，不扩大 member/runtime 读取或写入权限。第 44、45、47、48 段必须由 PostgreSQL `rolsuper`
  的受控 migration executor 部署，以转移或替换 definer ownership；runtime role 不能承担该部署权限。
- 回滚须先关闭 capability 并等待在途请求和 URL TTL。仅 local/test、无任何
  `after-sale.evidence.protected_read.issued` 审计事实时，才允许按 `48 -> 47 -> 46 -> 45 -> 44` 逆序执行；
  任一 issued-read audit 都 fail-fast。生产或已有该审计事实的数据库只允许前向修复，绝不删除 guard role。
- D5 没有 B3 claim caller、legal-hold/dead-letter 管理、外部告警、生产角色扩权或 rollout。production
  开启前仍需目标 provider 的 read IAM 隔离、HTTPS/KMS、versioning/Object Lock/lifecycle/legal-retention
  证据与 bearer-URL 风险接受；local/test MinIO 不能替代。完整 B2b/B2、B3-B7、M6.3、M6 与 P0 均未
  完成。完整门禁与阻断项见
  `docs/reports/m6.3-b2b-d5-protected-evidence-read-completion-report.md`。
