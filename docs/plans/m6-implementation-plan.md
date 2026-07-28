# M6 售后、会员、内容与主动分享专项实施计划

> 状态：已批准；M6.1 契约冻结已完成；M6.2 数据/RLS/迁移已完成；M6.3 未开始
>
> 版本：0.3
>
> 日期：2026-07-27
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
定向数据库 38/38、完整 integration 26 个文件/201 项与 35 段 M2-to-current、重复部署、M6/M5 down/重新前滚及 `55000`
门禁演练已通过；仓库级 `verify` 保持 51 个文件/352 项单元测试通过。M6.3 运行时 API/worker/UI 尚未
开始；所有商城政策快照 enforcement 保持 OFF，没有生产政策、checkout 快照 writer/readiness 命令、
生产角色自动扩权或真实外部调用。

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

- 买家提交/取消、管理员审核、返件登记、验收和售后时间线。
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
- 新运单目的默认 `ORDER_OUTBOUND`，确保旧数据不被改写。M6.2 数据库已约束 purpose 与售后类型，
  但既有 M5 订单物流查询、命令、callback 和 worker 尚未全面按 purpose 分流；M6.3 创建售后运单前
  必须显式过滤 `ORDER_OUTBOUND`，非订单 purpose 只能由售后协调器处理且不得推进原订单。
- M6.2 已通过明确本地数据库 drop/recreate 后的 fresh deploy、M2-to-current、重复 deploy、
  down/重新前滚、RLS、列级权限和 PostgreSQL catalog 约束。`prisma migrate reset` 遇到
  `app_security` 残留对象的尝试不计成功证据；Prisma 无法表达的跨行容量 guard 使用审查过的原生 SQL。
- `down.sql` 只允许无 M6 售后、结算、证据、库存、收藏/历史、隐私请求或分享事实的 local/test scratch。
  有事实时以 SQLSTATE `55000` 拒绝；生产只允许向前修复。
- 应用回滚可关闭新建售后/分享入口，但必须保留兼容 worker 处理已有退款、结算、库存预留和运单至终态。

## 7. 风险、外部依赖和停止条件

- 美妆卫生、开封例外、售后期限、证据、运费承担和服装换码规则需越南业务/合规人员确认后才可
  发布生产政策；local/test 规则不是法律意见。
- COD 真实退款渠道、收款信息保存、财务复核和到账凭证尚无生产方案；实现必须默认禁用并保持
  `REVIEW_REQUIRED`，不能使用永远成功的手工按钮。
- M5 外部支付、退款、GHN、结算和 Zalo 宿主仍未验收。若真实契约改变 M6 假设，先更新本计划、
  数据字典、OpenAPI、迁移和安全测试。
- M6.2 只交付数据事实边界。买家/管理员售后、收藏、历史、隐私和分享运行时均未交付；表和权限
  目录存在不等于对应产品能力可用。
- 证据对象视为敏感且不可信；必须限制类型、magic bytes、大小、数量、扫描状态、保留期和下载授权。
  到期立即停止普通访问；无 legal hold 时幂等删除原件、衍生物与扫描临时对象，失败有界重试并告警；
  legal hold 只延迟删除，不延长普通访问，删除后仅保留受 RLS 保护的最小审计元数据。会员和普通
  管理员响应只投影 `PENDING/READY/UNAVAILABLE`，不得区分隔离、删除中、删除失败或已删除。
- M6.2 完成后不自动进入 M6.3。M6.3 涉及 checkout 快照写入、售后资金/物流协调和运行时权限，
  需依据本计划重新确认继续实施，并先关闭上述 enforcement 与 shipment purpose 风险。

## 8. 测试与验收

- 单元：所有合法/非法状态转换，类型守卫，终态不可重开，安全整数、数量/金额容量、库存恢复、
  寄回截止点和证据 legal hold/删除门禁，以及同 SPU 等价换货；分享类型、code、locale 回退与路径注入。
- 集成：RLS/复合 FK、同订单行多售后并发容量、退款/结算幂等、库存只恢复一次、换货预留释放、
  返件不推进原订单、证据授权和旧订单 legacy review。
- API 安全：商城/会员 IDOR、严格 DTO、金额/状态/退款/库存字段篡改、幂等键冲突、RBAC/MFA、
  凭证越权、凭证内部状态投影脱敏、分享目标投毒、XSS、open redirect、限流和错误脱敏。
- E2E：双商城三语仅退款、退货退款、换货、收藏、历史、隐私入口、六类分享目标和异常恢复。
- 真机：Android/iPhone 中由用户主动分享并打开正确商城、语言和对象；Web 预览不替代宿主证据。
- 阶段门禁：定向测试、`corepack pnpm verify`、相关集成/E2E、迁移演练、生产依赖审计、Gitleaks、
  `git diff --check` 和最终高风险差异审查。未运行项必须说明原因。
