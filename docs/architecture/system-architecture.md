# 系统架构提案

> 状态：已批准
>
> 版本：1.0
>
> 日期：2026-07-29
>
> 依据：`REQUIREMENTS.md` V2.1、`AGENTS.md`

批准记录：用户于 2026-07-17 批准本架构，授权先实施 P0 计划的 M0；用户于
2026-07-23 批准 M4 专项计划，地址、服务端结算、订单、COD 与配送策略按本文边界实施；用户于
2026-07-27 先批准 M6 双轨契约冻结，随后授权 M6.2 数据/RLS/迁移实施；2026-07-28 授权 M6.3，
先完成 M6.3-A checkout 政策快照与物流 purpose 前置安全收口，随后完成 M6.3-B0 契约与前向
数据库修复。B0 完成时不授权任何 B1-B7 运行时；用户随后按推荐边界单独授权 B1，现已完成四个
会员/管理员只读接口及适用门禁。2026-07-29 又授权 B2a 政策控制面；七个管理员接口、两个分页索引、只读兼容性
预检、settings 契约偏差收口与适用仓库门禁均已完成，B2a 仓库实施标记 `COMPLETE`。用户随后只授权
M6.3-B2b-D0 数据库生命周期与可靠排队底座；D0 已建立专用 SYSTEM scope、对象 ledger、并发配额锁、
严格 outbox 身份和 reconciliation 数据原语。D0 不注册 HTTP 或 worker，不接对象存储/scanner，也不
启用生产配置。每个目标库 rollout 前仍须逐库 preflight；B2/B2b、B3-B7、M6.3、UI、生产政策/启用、
供应商调用、部署与发布仍未完成或未授权并保持失败关闭，原有外部上线门禁保持不变。

用户随后授权 B2b-D1。当前仓库已增加独立 evidence S3-compatible adapter、失败关闭配置和本地/测试
MinIO 最小 IAM/真实 bytes 校验；该局部结论仅为 repository implementation + local/test storage
validation `COMPLETE`；最终 verify、Gitleaks、差异复审、生产依赖 high 与 OpenAPI 回归均通过。D1
没有注册 HTTP、worker 或 scanner，也未取得生产 KMS/lifecycle/versioning/Object Lock/rollout 证据；B2/B2b、B3-B7、
M6.3、M6 和 P0 继续未完成。

用户随后授权 B2b-D2。仓库已把 D1 的受控读取流、真实 ClamAV adapter、scan outbox handler、租约
绑定数据库投影和持久 scan dead-letter 收敛接成 local/test worker 链路，并通过适用仓库门禁与独立
复审；该局部结论只标记为 repository implementation + local/test scanner worker validation
`COMPLETE`。这仍不完成 B2b/B2、B3-B7、M6.3、M6、P0、HTTP、保护读取/审计、expire/delete
worker、外部告警或生产 rollout。

用户随后授权 B2b-D3。仓库已开放默认关闭的会员凭证初始化、确认和 owner 状态三条 HTTP 路由，
把 D0 生命周期与配额、D1 create-only 上传及真实 bytes 校验、D2 scan outbox 接成 local/test 完整
链路，并通过真实 PostgreSQL、Redis、MinIO 与 ClamAV 验证。D3 没有 B3 claim、会员/管理员保护读取、
管理员逐次读取审计、expire/delete worker、生产参数批准或 rollout；完整 B2b/B2、B3-B7、M6.3、
M6 与 P0 继续未完成。

用户随后授权 B2b-D4。仓库已消费 D0 expire/delete outbox，以租约绑定数据库复核、role-bound
delete-only provider 身份、完整 ledger 提交、领域重试和 lifecycle dead-letter reconciliation 接成
local/test 删除补偿链路。该局部结论只标记 repository implementation + local/test deletion worker
validation `COMPLETE`；B3 claim、保护读取/管理员审计、legal hold 管理、外部告警和 production
versioned storage/rollout 继续未完成。

用户随后授权 B2b-D5，仓库已交付默认关闭的 member/admin 保护读取、锁后授权/到期重验与管理员逐次
审计，并完成 repository/local-test validation；production provider/IAM/KMS/versioning/Object Lock/
lifecycle/retention 与 rollout 仍未授权、未运行。2026-07-31 用户批准 M6.3-B3 计划及第 3 节默认值，
仅授权三条默认关闭的售后申请/取消/商家主动退款 repository/local-test 写命令及其迁移、测试和文档。
B3 default-disabled repository implementation + local/test validation 已完成；生产策略、TTL、对象存储、
真实供应商、部署和 rollout 均保持
`NOT_AUTHORIZED / NOT_RUN`，不因仓库实现而改变既有外部上线门禁。

用户随后按相邻切片授权 B4、B5 与 B6。B4 已完成默认关闭的管理员审核/人工复核和 SYSTEM 寄回到期；
B5 已完成默认关闭的会员返件登记、管理员可信 `IN_TRANSIT/DELIVERED` 物流事实与 B1 待验收读取复用；
B6 已完成默认关闭的 ONLINE settlement、M5 refund/link 原子协调和 provider 结果向售后同步。
三者均只完成 repository implementation + local/test validation；真实物流/支付商、验收、库存恢复、COD、
换货、UI、生产配置、部署与 rollout 均为 `NOT_AUTHORIZED / NOT_RUN`，B2/B2b、B7、M6.3、M6 和 P0
仍未完成。

## 1. 决策范围

本文确定首次脚手架前需要批准的技术方向，覆盖应用边界、多商城隔离、数据与集成原则、部署形态和质量门禁。本文不定义完整表字段、最终 API 契约或供应商私有参数；这些内容在后续专项设计中完成。

### 目标

- 用一套代码支持美妆和服装两个独立商城。
- 从数据库、服务端、异步任务、缓存、文件和报表各层保护商城隔离。
- 支持越南语默认、中文和英文完整覆盖以及整数 VND 结算。
- 为订单、库存、支付、物流、退款和售后提供可审计、幂等、可补偿的基础。
- 在 P0 阶段保持可维护的模块化单体，避免过早引入微服务运维复杂度。
- 让 Zalo、支付和物流供应商可替换，供应商协议不污染领域模型。

### 非目标

- 不建设第三方商家入驻、多卖家结算或平台佣金能力。
- 不在首期建设微服务、事件流平台、跨地域多活或独立数据仓库。
- 不把 P1/P2 的积分、KOL/KOC、ERP/WMS、AI 推荐提前塞入 P0。
- 不使用静态假回调或永远成功的适配器作为生产集成。

## 2. 提议技术栈

| 层次      | 提议                                               | 选择理由与边界                                                          |
| --------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| 运行时    | Node.js 24 LTS、TypeScript strict                  | 本机已有 Node.js 24；统一前后端语言，Node.js 官方建议生产使用 LTS       |
| 包管理    | Corepack 管理的 pnpm workspace                     | 单仓库依赖去重、可重复锁定；不依赖全局 pnpm                             |
| 买家端    | Zalo Mini App CLI、React、TypeScript、ZaUI         | 贴合 Zalo 官方工具链和 Mini App 交互能力                                |
| 管理端    | React、Vite、TypeScript                            | PC 后台为客户端应用，不需要首期引入 SSR 复杂度                          |
| API       | NestJS 11、REST、OpenAPI                           | 模块边界、验证、守卫和依赖注入适合复杂业务；Node.js 24 满足官方运行要求 |
| 后台任务  | NestJS application context + BullMQ                | 与 API 共享领域包，独立进程处理超时释放、回调重试、对账和轨迹同步       |
| 数据库    | PostgreSQL、Prisma ORM + 审核过的原生 SQL          | 一般事务和迁移类型安全；库存锁、复杂约束和报表允许显式原生 SQL          |
| 缓存/队列 | Redis                                              | 缓存、限流、短期幂等辅助和 BullMQ；不能替代数据库事实来源               |
| 对象存储  | S3 兼容存储                                        | 商城、路径和对象元数据均带 `store_id`，通过短期签名 URL 访问            |
| 搜索 P0   | PostgreSQL FTS + `pg_trgm` + 规范化检索列          | 先满足三语、越南语变音符号与联想；达到规模阈值后再评估 OpenSearch       |
| 测试      | Vitest/Jest、Supertest、Testcontainers、Playwright | 覆盖单元、数据库集成、API、跨商城安全和端到端流程                       |
| 可观测性  | OpenTelemetry、结构化日志、指标和错误追踪适配器    | 统一 trace/correlation ID，日志默认脱敏且包含商城维度                   |

依赖版本在脚手架阶段锁定到当时经过验证的具体版本，不使用无上限的 `latest`。Node.js 版本写入 `.nvmrc`/`.node-version` 与 `package.json#engines`，CI 使用同一主版本。

## 3. 单仓库布局

```text
apps/
  mini-app/       Zalo 买家端
  admin-web/      PC 管理后台
  api/            HTTP API 与第三方回调入口
  worker/         异步任务、超时、同步、对账
packages/
  domain/         领域类型、状态机和纯业务规则
  contracts/      API DTO、事件契约和错误码
  database/       schema、迁移、种子与数据库访问
  integrations/   Zalo、支付、物流、对象存储适配器
  i18n/           三语资源、回退和格式化
  ui/             公共设计令牌与基础组件
  config/         TypeScript、Lint、测试等共享配置
docs/
  architecture/   架构与 ADR
  database/       ERD、字段字典和迁移说明
  api/            接口与回调契约
  plans/          已批准计划与状态
```

`domain` 不依赖供应商 SDK。应用层通过端口调用 `integrations` 中的适配器；适配器把外部状态映射成内部统一状态，并保存脱敏后的原始请求、响应和回调记录。

## 4. 领域边界

1. 商城、主题与页面装修。
2. Zalo 身份、会员、管理员、RBAC 与授权同意。
3. 品牌、类目、行业属性、SPU、SKU、翻译与合规。
4. 仓库、库存余额、库存锁和库存流水。
5. 搜索、购物车、促销和可解释价格计算。
6. 订单、订单快照和订单状态机。
7. 支付、退款、财务流水、COD 与对账。
8. 物流、履约、供应商状态映射与轨迹。
9. 售后、退货、换货和退款协调。
10. 内容、分享、OA 通知和国际化。
11. 报表、审计、隐私请求和运营告警。

模块间通过应用服务和明确事件协作，不允许跨模块直接修改对方核心表。例如支付成功只能提交幂等领域命令，由订单/库存模块在同一事务或可靠消费流程中完成合法状态转换。

## 5. 多商城隔离设计

### 5.1 数据库

- 使用共享数据库、共享 schema；所有商城业务表都包含不可为空的 `store_id`。
- 唯一约束包含 `store_id`，例如 `(store_id, sku_code)`，避免一个商城占用另一个商城的业务编码。
- 跨表关系优先使用包含 `store_id` 的复合外键，阻止把 A 商城订单关联到 B 商城 SKU。
- 面向普通商城请求的数据库访问必须携带不可变 `StoreContext`；Repository API 不提供无商城参数的查询入口。
- 对订单、支付、库存、会员、物流等高风险表启用 PostgreSQL RLS 作为纵深防御。应用事务使用 transaction-local 商城上下文；迁移角色与运行角色分离。
- 超级管理员跨商城查询走显式授权的专用用例，必须记录原因、操作者、目标商城与结果范围，不复用普通商城绕过开关。

### 5.2 非数据库资源

- 缓存键：`{environment}:{store_id}:{domain}:{key}`。
- 队列任务：消息信封强制包含 `store_id`、事件 ID、版本和 correlation ID。
- 对象路径：`{environment}/{store_id}/{resource}/{object-id}`，下载前再次授权。
- 售后凭证使用独立 evidence bucket 与专用 upload/read/delete 身份；ORIGINAL key 固定为
  `{environment}/{store_id}/staged/{evidence_id}/original`，不得与 catalog/content bucket、凭据或 key
  空间复用。
- 导出文件、定时任务、报表物化结果和幂等键均包含商城维度。
- 日志包含 `store_id`，但手机号、地址、Token、密钥和完整支付载荷默认脱敏。

### 5.3 必测不变量

- 使用商城 A 的身份读取或修改商城 B 的任何资源均返回不可泄漏存在性的错误。
- 篡改请求体、URL、Header、队列消息或缓存键不能绕过商城归属。
- 超级管理员跨商城操作必须显式授权且生成审计日志。
- 同编码可在不同商城存在，跨商城复合外键必须失败。

## 6. 核心一致性策略

### 金额与价格

- 所有金额以整数 VND 保存和计算；禁止二进制浮点数。
- 客户端价格仅用于显示，服务端重新加载有效规则并输出可解释的价格分解。
- 订单保存商品、品牌、SKU、单价、折扣、地址、运费和政策版本快照。
- M4 报价 hash 排除请求时间等波动字段，但包含商品、促销/券、地址、配送策略版本和最终金额事实；创建订单时必须重新加载并匹配。

### 库存

- 库存模型至少包含实际库存、锁定库存、可售库存与不可变流水。
- 锁库存使用数据库事务、行级锁/条件更新和唯一业务键防止超卖。
- 在线支付下单锁定、超时释放、支付成功确认扣减；COD 扣减时点由商城策略决定，默认建议在人工/规则确认有效后扣减。
- 释放或恢复库存必须引用原库存动作，重复回调和任务重试不得产生第二笔变化。
- M4 已采用 COD 下单预留、确认有效后 `CONSUME`、确认前取消 `RELEASE`、确认后发货前取消追加 `RESTORE` 的策略；订单行锁、稳定操作键和不可变流水共同保证幂等。

### 订单、支付与异步事件

- 状态转换由显式状态机控制，API 不直接写状态字段。
- 支付单、业务订单和退款单分离；供应商交易号按商城和渠道唯一。
- 回调先验证签名、时间戳/重放、金额、币种、商城和订单状态，再按供应商事件 ID 幂等处理。
- 关键事务写入 transactional outbox；worker 重试发布，消费者使用 inbox/处理记录去重。
- 外部调用使用超时、有限重试、退避、熔断与人工补偿入口，不能把数据库事务跨越网络调用。
- M5.3 已实现数据库 outbox：运行角色先通过只返回活动商城安全字段的注册函数发现商城，再逐商城
  设置 transaction-local RLS 上下文；`FOR UPDATE SKIP LOCKED` 领取短租约，领取即递增尝试次数，
  完成/失败必须匹配商城、租约 owner、有效期和 expected version。过期租约可由其他实例恢复，
  最后一次租约耗尽自动死信。
- 可重试失败使用带 20% 抖动的有限指数退避，永久失败和人工复核直接死信。人工重放要求当前
  商城任务重试权限、对应支付/退款/物流领域权限、近期 MFA、二次确认、原因和 expected version；
  只重置调度字段并追加不含 payload 的审计。Inbox 由供应商、渠道、环境和外部事件键的数据库
  唯一约束承担并发去重，摘要不一致稳定拒绝。
- worker handler 以 `event_type + event_version` 注册，并至少兼容当前和上一事件版本。M5.3 仅在
  `NODE_ENV=test` 注册无外部调用的探针处理器。M5.4 新增 `payment.create.requested.v1` handler；
  M5.5 增加真实 Zalo Checkout 查询补偿；M5.6 增加 GHN 建单、取消和权威查单 handler。供应商
  handler 均在数据库事务外发起网络请求，渠道默认禁用且缺少真实配置时明确失败。

### M5.4 已实施支付事务边界

- `ONLINE` 下单复用 M4 Serializable 事务，原子创建 `PENDING_PAYMENT` 订单、库存预留、首个
  `CREATED` 支付尝试、初始转换和 `payment.create.requested.v1` outbox；渠道默认不存在/禁用，
  只有测试中显式启用的商城独立 sandbox fixture 可进入该路径。
- worker 在事务内读取商城绑定支付/订单事实，结束事务后调用 `PaymentProvider.createPayment`，
  再校验 attempt/order/store/amount/expiry/extradata 并只保存 launch/nonce hash、供应商幂等引用和
  显式转换。崩溃重试继续使用同一内部尝试 ID，不跨数据库事务调用供应商。
- 主动查单和未来回调共用 `applyPaymentProviderFact`。匹配成功在一个事务内把支付尝试推进成功、
  消费预留一次并记录订单 `PENDING_PAYMENT -> CONFIRMED -> PENDING_FULFILLMENT` 两条转换；重复
  成功无第二次库存动作。金额/商城/订单/attempt 篡改、未知状态和迟到成功进入人工复核。
- 单次失败不关闭订单；支付窗口内允许幂等创建新尝试且同订单最多一个活动尝试。取消/到期按
  订单后支付尝试的统一锁顺序终止活动尝试并释放预留，迟到成功不能复活终态订单。

### M5.5 已实施 Zalo Checkout 适配器与回调边界

- API 与 worker 通过商城渠道解析器选择 Zalo Checkout 或受限 test provider；缓存身份包含商城、
  App ID、method、environment、渠道/密钥版本和 secret reference。真实密钥只由受限 resolver 在
  进程内解析，`disabled` 不回退 test provider。
- provider-order 绑定只把客户端 Checkout order ID 当作查单提示；服务端重建并核对 launch，调用
  `getOrderStatus` 后才绑定供应商事实。回调先用 App ID/method 唯一定位商城，再用原始 body、
  `mac/overallMac`、商城/订单/attempt/nonce、method 和整数 VND 金额完成验证。
- 验证后的 webhook 通过 callback/inbox 唯一键和可回收处理租约去重，再复用
  `applyPaymentProviderFact`；HTTP 到 PostgreSQL 的重复投递测试证明同一成功事实只消费一次库存，
  跨商城 RLS 查询不可见。已有回调事实时 M5.5 resolver 迁移拒绝回滚。
- 已绑定供应商单号的尝试可在接受后最多 2 分钟、且尽量早于支付到期 30 秒追加商城隔离的
  `payment.reconcile.requested.v1`。worker 在网络事务外查单，pending 使用固定上限延迟交回可靠
  outbox，成功/失败/未知/迟到结果只经 `applyPaymentProviderFact` 推进；有限尝试耗尽后死信。
- 真实商户凭据、HTTPS callback/trusted proxy、Zalo sandbox 查单/丢回调演练和 Zalo Testing
  真机仍未验收。生产保持默认禁用，不据此标记 M5.5 或 M5 完成。

### M5.6 已实施 GHN 物流事务边界

- Checkout 在创建 COD/ONLINE 订单前要求 SKU 重量和长宽高完整，并把四项正整数复制到不可变
  订单行快照；既有订单不从当前 SKU 回填，缺失可信物理事实时拒绝建单。
- 仓库履约资料以商城/仓库复合主键保存，联系人、电话和详细地址加密；管理端只读取配置完整性、
  地区、启用状态和版本。更新要求库存管理权限、近期 MFA、expected version、输入式确认和审计。
- 报价与建单只从服务端加载订单地址、订单行、默认仓库、渠道、服务和 COD 金额。建单短事务创建
  `CREATION_PENDING`、全量 shipment items、operation 和 outbox；GHN 成功只推进
  `PENDING_PICKUP`，不等于订单已经发货。
- `shipment.create/cancel/query.requested.v1` handler 在事务外调用按商城解析的 GHN provider；
  响应必须匹配 ShopId、稳定 `client_order_code` 和供应商单号。主动查单才可通过内部状态映射推进
  一次 `SHIP/DELIVER`；拒收、退回、异常、未知或倒退状态保守进入人工处理。
- provider 报价按基础、保险、COD、偏远与其他已知附加费保存并校验总额恒等式；成功的物流
  operation 为单调终态，outbox 重放在再次调用供应商前短路，迟到错误不能覆盖既有成功事实。
- GHN webhook 永远保存为 `UNVERIFIED_HINT` 并仅调度主动查单。面单通过 60 秒内部 JWT 代理，
  上游只允许固定 GHN HTTPS origin/path、禁止 redirect、限制 PDF 类型和 8 MiB，不向浏览器返回
  Token URL。真实 GHN sandbox、两个商城 ShopId/Token、测试仓库和 Zalo 宿主仍未验收。

### M4 已实施事务边界

- 地址、配送策略、订单、行、快照、转换和下单幂等记录均为强制 RLS 的商城事实；复合外键阻止跨商城拼接。
- COD 下单在单个 Serializable 事务中完成服务端重算、库存预留、订单/快照/转换、匹配购物车转换和会员券核销；任一失败整体回滚。
- 管理端 COD 确认把库存预留消费、两段订单转换和审计放在同一事务；取消/关闭同样把库存释放或 RESTORE 与转换放在同一事务。
- worker 先把过期预留推进终态，再关闭仍待确认的订单；冲突记录失败元数据并在下一轮重试，不删除订单或库存事实。
- M4 没有外部支付或物流调用，因此不伪造 outbox 事件、支付成功、运单或供应商报价；M5.2 已建立 outbox/inbox 数据边界，但在 M5.3 worker 落地前仍不创建虚构消息或外部业务事实。

### M5.2 已实施数据库边界

- 支付/物流渠道、支付尝试与转换、回调、退款与转换、报价、运单/行/轨迹/operation 以及 outbox/inbox 共 14 张商城表均强制 RLS；复合外键阻止跨商城订单、渠道、仓库和行项目拼接。
- 支付尝试的 `amount_vnd/currency` 由复合外键绑定订单应付快照；活动支付与活动运单使用部分唯一索引，退款创建锁定成功支付行并将请求中、处理中、人工复核中和成功金额合计限制在已捕获金额内。
- GHN webhook 在数据库层只能保存为 `NOT_AVAILABLE/UNVERIFIED_HINT`，不能伪装成已验签事实；支付回调和多态 inbox 必须匹配同商城、渠道和供应商环境。
- 转换、报价、运单行和轨迹不可更新/删除，其他 M5 事实禁止删除；运行角色对可变表只获得受审配置、状态、供应商结果和重试列的更新权限。
- 迁移与 seed 不创建渠道、支付、退款、运单、轨迹或消息事实。真实渠道仍默认不存在/禁用，后续只由受审管理流程创建并在 M5.5/M5.7 完成外部验收。

### M5.7 已实施退款与异常工作台边界

- API 仅允许具备当前商城退款权限、近期 MFA、expected payment version、原因、确认词和幂等键的
  管理员针对成功 ONLINE 支付创建整数 VND 退款；服务端重算余额，客户端不能提交供应商引用、
  退款状态、订单状态或库存动作。
- 退款创建最多调用一次 Zalo Checkout。网络结果不确定、未知返回码、金额/引用不一致或成功后的
  倒退进入人工复核，且继续占用可退款容量，不能用自动重试或新建退款冒险产生第二笔退款。
  处理中退款通过受审主动查询有限收敛。
- 退款成功只投影 `order.payment_status=PARTIALLY_REFUNDED/FULLY_REFUNDED`，不改变订单履约状态、
  运单或库存；退货退款、换货、库存恢复和拒收自动退款仍属于 M6。
- 管理端订单工作台读取商城隔离的支付、退款和脱敏 outbox 状态，支持退款、支付/退款查询和
  dead-letter 重放；任务元数据还按支付、退款、物流领域 read 权限过滤。买家订单详情只读本人
  公开退款事实。三语 UI 不展示原始 payload、密钥、完整供应商引用或管理员内部原因。
- 当前对账能力仅为逐笔权威查询、本地转换/异常和死信视图。Zalo 商户结算文件、手续费、日界线、
  GHN COD 回款及差异处置材料未提供，保持外部 `BLOCKED/NOT_RUN`，不得称为日结对账完成。

### P0-M5-005 Slice A 已实施支付/退款财务对账边界

- 管理员财务工作台只提交已复核的规范化 `PAYMENT/REFUND` 逐笔；服务端按目标商城、支付渠道和
  已有 provider reference 匹配内部支付/退款事实，计算整数 VND 毛额、手续费、带方向净额、
  本地预期和差异。它不解析 ZaloPay 文件、不调用供应商，也不推进任何业务状态。
- 导入先取得商城/source/幂等 advisory lock，在同一 `Serializable` 事务内重新锁定并验证商城、
  管理员、session、近期 MFA、token 有效期和直接商城 `store.finance.reconcile` 权限；锁等待期间
  撤销权限会失败关闭。同键同请求返回冻结结果，同键异参或同渠道批次引用冲突。
- 批次与逐笔表 FORCE RLS 且只追加，runtime 仅有 `SELECT/INSERT`。复合外键阻止跨商城匹配；
  延迟约束在提交时重算 header/lines 汇总，并验证支付或退款属于批次绑定渠道，任一差异整批回滚。
- 列表按 `created_at/id` 稳定倒序游标分页，详情和三语管理 UI 只显示引用掩码。导入审计只保存
  批次 ID、日期、数量和整数汇总，不保存规范化原文、完整供应商引用或幂等键。
- Slice A 只是 repository/local-test 支付/退款对账能力。COD 应收/GHN 回款仍属于本任务 Slice B，
  maker-checker 差异关闭属于 Slice C；真实结算文件、sandbox、资金、部署和 production rollout
  继续 `BLOCKED/NOT_RUN`，不能据此宣称 P0-M5-005、M5 或 Production Ready。

### P0-M5-005 Slice B 已实施 COD 应收与 GHN 规范化回款边界

- COD 应收只从当前商城 GHN 渠道、普通订单出库目的、COD 且已签收运单投影；预期 COD 取不可变
  运单金额，预期费用只取建单前同订单/渠道/service 的最近可信 provider 报价。没有历史可信报价时
  显式进入缺失费用异常，不用当前费率或客户端值回填。
- 财务工作台只接受显式规范化的 GHN COD 回款、运费和 COD 费；不解析或猜测 GHN 结算文件，不
  调用 sandbox/production，也不确认真实现金。服务端区分金额、费用、非终态、非应收、引用缺失和
  重复异常，不改变订单、运单、支付、库存或现金状态。
- 同批次或此前批次已出现的同商城/物流渠道 provider shipment reference 均为重复回款异常，不再次
  绑定运单。应收状态筛选在稳定 `(delivered_at,id)` 扫描内完成，避免过滤后空页、重复或幻影游标。
- 批次按 source 恰好绑定支付或物流渠道。COD 行以 `(store_id,shipment_id)` 复合外键绑定同商城
  `ORDER_OUTBOUND` 运单；延迟 guard 同时重算 COD/费用汇总并复验渠道。runtime 授权仍只有两表
  `SELECT/INSERT`，迁移不扩生产角色权限。
- 管理端提供来源筛选、三语 GHN 导入、COD 应收与窄屏状态；商城切换立即清除旧商城详情。Slice B
  仍只是 repository/local-test 规范化边界，真实 GHN 文件/账号/资金证据继续由 `P0-M5-004` 和外部
  门禁跟踪，maker-checker 差异关闭仍属于 Slice C，因此任务继续 `In Progress`。

### M6.1 已冻结售后、会员与主动分享边界

- 售后是独立聚合，不把售后状态写入 `orders.status`，也不让退款、供应商或物流状态直接决定售后
  终态。线上退款复用 M5 `refunds`、容量 guard 和 outbox；COD 使用独立、双人复核的受审线下
  结算事实，不能伪装成线上退款。
- 退款成功、返件签收、质检结论和库存恢复是独立事实。仅已消费订单行中实际验收且判定可再次
  销售的数量，才能使用稳定 operation key 恢复一次库存；退款或物流退回本身不恢复库存。
- P0 换货只允许同 SPU、相同数量、仅政策允许属性不同、等价 SKU 且不自动处理价差。返件与换货
  出库必须使用显式 `AFTER_SALE_RETURN`/`EXCHANGE_OUTBOUND` 目的，不能触发原订单
  `SHIP/DELIVER`。
- 新订单行需要保存已发布售后政策版本、规范 JSON 和摘要快照；历史无快照订单进入
  `status=REVIEW_REQUIRED` 且标记 `legacy_policy_review=true`，不得使用当前政策伪造回填；
  `LEGACY_REVIEW_REQUIRED` 不是独立状态枚举。
- 收藏和浏览历史按商城及认证会员隔离；匿名访问不写会员历史。分享服务只接受目标类型、公开
  code、locale 和受限来源参数，服务端解析当前商城已发布对象，不接受任意 URL、展示文案、图片、
  内部 ID、`store_id` 或会员标识。
- Zalo 分享仅由用户点击触发，使用 `getShareableLink` 后调用 `openShareSheet`；浏览器兜底固定
  allowlist origin，并防止 XSS/open redirect。M6 持久化最小、可查询的隐私请求受理事实，但提交
  不代表访问/删除/匿名化/注销完成；管理员履约、导出和执行仍属于 M7。
- M6.1 当时仅冻结数据字典、权限、OpenAPI、严格 DTO 和纯领域规则，未创建 Prisma schema、迁移、
  运行时 API、worker、UI 或外部集成；该阶段的历史完成证据保持不变，后续数据实施见下节。

### M6.2 已实施售后、会员与分享数据边界

- 十一段前向迁移建立 30 个商城模型/表、Prisma 复合关系、30 表 FORCE RLS、会员 owner scope、
  只追加事实、列级最小授权和 12 项只登记不自动赋予生产角色的 STORE 权限。定向数据库 38/38 与
  35 段 M2-to-current、重复部署、M6/M5 down/重新前滚及 `55000` 门禁演练已通过。
- 数据库把政策、不可变版本/assignment、订单行快照及 canonical payload/hash 精确绑定；只有商城
  enforcement 已启用时，deferred commit guard 才要求订单行同事务存在快照。M6.2 交付时不创建生产
  政策，所有商城 enforcement 保持 OFF，resolver/writer、readiness API 和受审启用命令尚未实现；
  这些历史边界由下述 M6.3-A 向后兼容扩展。
- 初始第六段 `20260727115000_m62_integrity_closeout` 要求普通售后从 `PENDING_REVIEW`、legacy 售后从
  `REVIEW_REQUIRED` 安全初态开始；legacy 决定绑定当前管理员、未受污染的初态和唯一受审转换。
  售后状态只能由只追加 transition 原子投影，运行角色不能直接改 header 状态。后续五段前向修复
  统一请求/批准容量、immutable order allocation、M5/M6 advisory/order/payment 锁序、definer
  fail-closed actor scope，并只让已批准或已有副作用的案例持续占用订单级批准额度。
- 同 case settlement 在锁定售后聚合后校验允许状态、容量、ONLINE M5 Refund 精确链接及 COD 非空
  digest/加密凭证/异人确认。返件提交、到期、raw shipment、验收、库存恢复和换货履约共享聚合锁，
  使拒绝、到期、转退款与副作用并发串行；库存恢复还绑定原订单已消费 reservation、唯一 RESTORE
  movement 和累计验收容量，换货每次 UPDATE 都重新核对聚合状态。
- 凭证使用严格 staged/scan/claim/hold/delete 状态机、NULL-safe CLEAN 校验、到期重试门禁和自动
  append-only transition。跨 RLS 读取所需 trigger function 固定 definer owner/search path，且 PUBLIC
  与 runtime 的直接 EXECUTE 均撤销。这些 guard 不替代 M6.3/M6.4 的领域命令、幂等、审计和外部协调。
- M5 `shipments` 已新增 `purpose` 与售后复合关联；旧数据和普通建单默认 `ORDER_OUTBOUND`，数据库
  在锁定售后聚合后校验 purpose、case type 和允许状态，并阻止 reject/convert 后留下晚到运单。
- M6.2 交付时没有开放售后、收藏、历史、隐私或分享的买家/管理员运行时，也没有 worker、UI、对象
  存储/扫描、真实 COD/GHN/Zalo 调用或生产 rollout。表存在只表示数据事实基础完成；M6.2 的历史
  范围不因后续 M6.3-A/B1 增量而被改写，当前能力只以以下各节为准。

### M6.3-A 已完成 checkout 政策与 shipment purpose 前置边界

- checkout 在订单创建的同一商城事务中取得 `m62-policy:{store_id}` advisory lock，并通过受限
  `app_security.lock_m63_after_sale_setting()` 锁定当前商城稳定 settings 行。OFF 时不解析、不写快照，
  保持旧订单兼容；ON 时重新验证 readiness，并按商品覆盖、订单行主类目的最近祖先、商城默认顺序
  选择唯一不可变版本，为全部订单行写入 canonical payload、SHA-256、policy/version 精确快照。
  任一默认、assignment、runtime capability、父链、payload/hash 或数据库 guard 冲突都使下单事务
  失败，不留下订单、库存预留或幂等成功事实。
- readiness 只从当前商城活动投影和不可变版本构建，验证 ACTIVE head/current version、完整三语内容、
  目标集合、effective time 与 payload hash，并将版本化 checkout snapshot runtime capability 纳入
  readiness hash。已启用 settings 还必须与当前默认 policy/version/hash 同步；应用能力变化不会静默
  复用旧 ready 事实。
- `GET /v1/admin/after-sale-settings` 要求 `store.after-sales.policy.read`；`PUT` 独立要求
  `store.after-sales.policy.enforce`、近期 MFA、匹配确认词、AccessReason（平台跨商城时强制）、
  expected version 与商城范围
  Idempotency-Key。命令在 Serializable 事务内以固定锁序执行，有限重试冲突，幂等响应保留 24 小时并
  返回 `Idempotency-Replayed`。审计 before/after 精确包含 enforcement、settings version、默认
  policy/version ID、readiness time/hash，不把敏感政策正文或凭据写入日志。
- 四段向前迁移依次让数据库快照 guard 支持最近类目祖先解析、为既有商城补稳定 OFF settings 行、
  提供只锁当前 RLS 商城且仅返回 enforcement 布尔值的受限 definer 函数，并通过 stores AFTER INSERT
  trigger 为新增商城自动 provision 同样的稳定 OFF 行。该 lock 函数是运行角色可直接 EXECUTE 的
  明确最小例外；其他跨 RLS 校验/投影函数继续撤销 PUBLIC/runtime 直接调用。
- 既有 M5 订单物流 API 固定只读写 `ORDER_OUTBOUND`；callback body 不能选择 purpose，首次 hint 和
  后续 provider operation 都从商城隔离的本地 shipment 事实携带 purpose。旧建单 worker 对非订单
  purpose 永久拒绝；查单/取消的供应商事实可更新对应 shipment，但领域映射仅为 `ORDER_OUTBOUND`
  生成原订单 `SHIP/DELIVER`，返件/换货状态不会污染原订单。
- 取消可以与供应商建单并发：provider reference 尚未写回时取消 operation 保持 `PENDING` 并通过
  outbox 有界重试；operation 真缺失仍永久失败。创建事实落库后同一取消 operation 继续使用已写回
  的供应商单号，避免并发窗口留下活动运单。
- 当前定向 unit 55/55、M6.2 数据库 39/39、M4 15/15、M5.6 13/13、完整 integration 26 个文件/
  206 项、39 段迁移演练、`verify`（54 个文件/381 项单元测试）、21/21 E2E、交付候选 Gitleaks、
  `git diff --check` 与生产依赖 high 门禁均通过；审计另有 3 项 React Router moderate 公告并已明确
  结转。M6.3-A 完成时 B1-B7 运行时均未开始、未授权；此历史证据不因随后单独实施 B1 而改变。
  所有商城默认 OFF，不创建生产政策、返件/换货运单或真实外部调用；M5/P0 外部上线门禁不变。

### M6.3-B0 已完成的契约与前向修复边界

- B0 只冻结并修复领域、严格 DTO、OpenAPI、Prisma/schema、RLS/guard 与前向迁移，当时不创建
  controller、service、worker、UI 或生产配置。B0 已通过独立完成报告所列领域/契约、数据库、完整
  integration、迁移演练、静态验证、依赖审计、泄漏扫描和最终差异复审等适用门禁；由于没有新增
  运行时或 UI，未执行或声称 B0 专属 E2E。B0 完成不自动进入 B1；随后 B1 的单独授权不改变这组
  历史范围与证据。
- 非 legacy 售后单的所有订单行必须来自完全相同的 policy、不可变 version 和 canonical payload
  hash；售后 header 显式保存该精确身份，不能任取第一行政策。每个订单行的权威 `delivered_at`
  只从 `shipment_items` 关联的 `ORDER_OUTBOUND` 运单解析，并要求订单行全部数量已有可证明的签收
  事实；冲突或无法证明的旧事实进入 `legacy_policy_review`，禁止使用当前时间或订单更新时间推断。
- 创建申请与审核都锁定原订单行并使用同一安全整数 VND 余数算法。管理员审核逐行提交
  `approved_quantity`，客户端不提交批准金额；覆盖全部剩余数量时取得全部剩余 VND，且总额继续受
  订单与 M5 退款容量保护。reason code 必须来自冻结政策 allowlist；政策要求证据时，上传校验、恶意
  文件扫描、READY claim、受保护读取或删除补偿任一能力不可用都必须失败关闭且不创建售后单。
- 会员首次提交返件只原子创建/占用 `SUBMITTED` 返件事实并追加 `START_RETURN`，把售后从
  `APPROVED` 推进到 `RETURN_PENDING`；会员不能追加 `RETURN_SHIPPED` 或声称运输中/已签收。
  `RETURN_SHIPPED/RETURN_RECEIVED` 只能来自可信物流查询或受审管理员事实。完整 `inspect-return`
  及其 exactly-once 库存恢复整体延至 M6.4；M6.3-B 只冻结返件与待验收读取/物流事实。
- SYSTEM 使用独立 `actor_type=system`、`system_scope=after-sale-transition`、当前商城、系统 actor 和
  correlation ID 上下文，只允许 `RETURN_EXPIRED`、退款权威结果、`REQUIRE_REVIEW` 与必要的
  `COMPLETE`。审核、legacy 决定、COD 确认、`REFUND_REQUESTED` 和其他人工动作不在 allowlist；
  `COMPLETE` 只允许无新增资金副作用地把 `REFUNDED -> COMPLETED` 做确定性收口。
- B0 同时冻结但不实现读取公共契约：会员 locale 按 `preferredLocale -> vi`，管理员按显式 locale、
  商城默认、`vi` 回退；`c1_` 游标以独立可轮换 HMAC key 绑定版本、商城、主体、资源、过滤、排序和
  过期时间；售后公开号为至少 128-bit 随机的 `ASC-[A-Z0-9]{16,32}`。会员/管理员读写分别按
  60/10 与 120/30 次每 60 秒、商城+主体限流，所有响应以同一 correlation ID 贯穿事务、转换、审计、
  日志和错误；冲突只暴露公开 allowlist。B6 ONLINE Refund 与 B7 COD 双人结算在 B0 仅为设计，
  不代表 M5 事务原语、协调 worker、真实转账证明或成功按钮已经交付。

### M6.3-B1 已实现的售后只读边界

- B1 只注册 `GET /v1/after-sales`、`GET /v1/after-sales/{afterSaleId}`、
  `GET /v1/admin/after-sales` 与 `GET /v1/admin/after-sales/{afterSaleId}`。会员服务查询显式包含
  `store_id/member_id`；管理员先通过中央商城授权和 `store.after-sales.read`，再以显式 `store_id`
  查询。两条应用层边界均叠加 PostgreSQL FORCE RLS，已知 UUID 也不能跨商城或跨会员探测。
- 列表在单个 `REPEATABLE READ` 商城事务内分两阶段读取：原生 SQL 仅取 `limit + 1` 个 page key，
  再只对白名单 ID 使用严格 Prisma `select` 加载响应所需字段并按 page key 重排。会员固定
  `created_at DESC, id DESC`，管理员固定 `updated_at DESC, id DESC`；禁止宽关系 `include` 把证据
  对象 key/扫描详情、结算密文、transition actor/reason 或 header 内部 hash 带入进程。
- PostgreSQL `timestamptz(6)` page key 以六位微秒 UTC 文本返回并写入游标，下一页直接使用数据库
  `(timestamp, id)` tuple seek；不得先转为 JavaScript `Date` 再回灌查询。这样保留同一毫秒内记录的
  全部排序精度，避免分页重复或漏项。
- `c1_` 游标由独立 `AFTER_SALE_CURSOR_HMAC_KEYS` key ring 保护：配置为 1–3 把唯一、解码后至少
  32 字节的 base64url 密钥，第一把签发、全部验证；payload 绑定版本、商城、主体、资源、规范筛选、
  微秒排序键、UUID 和过期时间。轮换必须先置入新主密钥，等待最长 TTL 后才移除旧验证密钥。
- 响应由严格 schema allowlist 复验。非 legacy 历史政策只从绑定的不可变版本读取，会员 locale 按
  `preferredLocale -> vi`、管理员按显式 locale、商城默认、`vi` 回退；缺少必要政策/version/越南语
  事实时失败关闭。凭证只公开 `PENDING/READY/UNAVAILABLE`，原因 ciphertext、管理员字段、供应商
  payload 和内部资金引用不返回；成功响应统一 `Cache-Control: private, no-store`。
- 读限流使用 Redis 60 秒窗口并绑定商城+主体：会员 60 次、管理员 120 次；Redis 故障不静默放行，
  超限返回 `429` 与 `Retry-After`。所有响应延续同一个安全 correlation ID。管理员无 status 列表新增
  `(store_id, updated_at DESC, id DESC)` 前向索引；Prisma 仅补记数据库原有
  `after_sale_refunds(store_id, settlement_id)` 唯一约束以修复 schema drift，不重复创建索引。
- B1 本身不开放申请、取消、审核、凭证访问、返件、退款、COD 结算或任何写路径，也不交付 UI、worker、生产政策/启用或外部调用。
  随后增加并完成下节 B2a 政策控制面，并在独立授权下完成默认关闭的 B3-B6 repository-local-test
  写命令与 worker；这不改变 B1 的历史只读结论。完整 B2b、B7、返件验收与库存恢复 M6.4、生产 rollout、
  部署和发布仍需独立授权。
  B1 可读不代表整个 M6.3、M6、M5 或 P0 完成。

### M6.3-B2a 政策控制面仓库完成边界

- B2a 在不改变 M6.2 领域模型的前提下注册 policy head 列表/详情、草稿 `PUT`、不可变 version 列表/详情、
  publish 和 disable 七个管理员接口。读、草稿、发布、停用分别要求独立 RBAC；发布/停用要求近期 MFA、
  确认词、reason、expected version 和商城范围幂等。七个路由的成功响应使用 `private, no-store` 和 correlation ID，
  读/写分别使用管理员 120/30 次每 60 秒档位。
- B2a 收口同时修正了已有 settings GET/PUT 的契约偏差：现在严格校验 Store-Code/Access-Reason/query，成功响应返回
  correlation/no-store，并进入同一 ADMIN READ/WRITE 限流；Redis 不可用时在读取/变更政策或 settings 之前失败关闭。
- 草稿 payload 按冻结类型、小写 UUID、reason code、`vi/zh/en` 和目标集规范化并哈希。ACTIVE head 可保存下一版草稿，
  但只在发布事务创建新版本/三语/冻结 assignment 并切换活动投影；草稿不会提前改变 checkout。停用只移除该
  policy 的当前解析投影，不删除版本、assignment、订单快照或售后引用。
- 发布/停用在 `m62-policy:{store_id}` advisory lock 下再锁 policy head，用同一数据库 `CURRENT_TIMESTAMP` 生成生效/发布/
  readiness 时间。目标冲突稳定拒绝；enforcement ON 时发布或停用若使权威 readiness 不成立，settings 与命令事务一起回滚。
  审计保留 policy/settings 完整 before/after、reason、actor 和 correlation ID；公开 `409` 只投影白名单
  `details.reason_code`。
- heads 与 versions 列表继续使用 B1 `c1_` HMAC key ring，但以不同 resource 并额外绑定 policy code/筛选；分页保留
  PostgreSQL `timestamptz(6)` 的六位微秒。读取还会重新验证草稿 hash/product replace-set、版本 payload/hash/标量/
  三语与冻结 assignment，损坏事实失败关闭。
- B2a 迁移只增加 heads 的 `(store_id, updated_at DESC, id DESC)` 和 versions 的
  `(store_id, policy_id, published_at DESC, id DESC)` 两个索引，不改写 RLS。保留既有 tenant policy 是有意的历史兼容决策：
  B1 会员售后仍能读取已绑定但现已停用/被替换的不可变政策版本。不采用“只允许 ACTIVE assignment”的 RLS，因为它会破坏
  这一历史读，又无法隐藏 ACTIVE head 行内草稿列；管理操作由应用层独立 RBAC 和显式 store scope 叠加 FORCE RLS 保护。
- 旧数据库允许下划线 code 与非严格 object payload，新 API 不接受这些事实。仓库的只读分批预检已在本地测试库通过
  （`policies=0, versions=0`）；适用仓库门禁均已通过，B2a 仓库实施为 `COMPLETE`。每个目标库在 rollout 前仍必须重新执行并留证；
  B2/B2b、B7、M6.3、UI、生产政策与启用/部署仍未完成或未授权并保持失败关闭；B3-B6 的局部完成
  不构成 M6.3 或生产启用。

### M6.3-B2b-D0 凭证数据库生命周期与可靠排队边界

- D0 只建立仓库内数据库底座。它没有注册
  `POST /v1/after-sales/evidence-uploads`、确认、owner 状态或保护读取路由，没有在
  `apps/worker` 注册 scan/expire/delete handler，也没有对象存储、真实 scanner、短期 URL、外部告警
  或生产配置。D0 收口时 OpenAPI 中相关操作仍是 contract-only；后续 D1-D5 分片和 B3 默认关闭写命令
  不改写这一历史范围。当前 B3 对要求凭证或携带 evidence 的申请仍在任一必要 capability 缺失时
  失败关闭。
- `after_sale_evidence_files` 新增上传确认、扫描请求/完成/generation、可信 scanner 身份、独立普通
  访问截止与删除耗尽事实。普通读取与物理保留从此分离：B1 对已 claim 的 `READY` 只使用
  `ordinary_access_deadline_at`，不能因对象仍处于 retention 或 legal hold 而继续读取；物理清理使用
  `retention_deadline_at`。活动 hold 只阻止删除，不重写两类原始截止点。
- 新的 `after_sale_evidence_objects` 是 D0 新写路径的规范对象 ledger。原件、衍生物和扫描临时对象逐行
  保存 `store_id/evidence_file_id/role/key/hash/version/deleted_at`；原件与活动扫描临时对象有唯一约束，
  key 路径由环境、商城和 evidence ID 组成。对象逐个形成删除事实，父 evidence 只有在所有 ledger key
  均清空后才能进入 `DELETED`。M6.2 的父行 key/JSON 字段暂作兼容投影，不再是新删除原语的权威清单。
- lifecycle mutation 使用固定 SYSTEM actor
  `00000000-0000-4000-8000-000000000006` 和独立
  `system_scope=after-sale-evidence-lifecycle`。该 principal 与普通管理员、会员和
  `after-sale-transition` SYSTEM scope 互不替代；FORCE RLS、列级 grant、触发器和 transition actor
  allowlist 共同阻止宽更新、跨商城写入和人工动作冒用。transition 继续 append-only，并强制记录
  correlation ID 与稳定错误类别。
- 初始化先取得 `(store_id,member_id)` transaction-scoped 配额锁，再按权威表聚合同商城同会员未
  claim 且未物理删除的数量/字节；claim 和最终删除沿用同一锁序。D0 原语支持 local/test 显式传入
  TTL/配额，但没有生产默认值或合规结论。上传初始化、确认、SYSTEM 重扫请求、scan 结果、claim、到期、删除失败/
  完成及 DEAD_LETTER reconciliation 均绑定商城、行版本和必要的 scan generation；过期、重复或乱序
  事实只能安全 no-op/冲突，不能倒退状态。
- scan/expire/delete outbox 的 aggregate 固定为 `AFTER_SALE_EVIDENCE`、event version 固定为 1，
  payload 键集合精确为 `store_id/evidence_id/expected_version`。数据库约束触发器要求确认或关键
  生命周期变化与对应消息同事务提交，并禁止对象 key、hash、MIME、checksum、scanner 结果、截止点、
  hold 或供应商错误进入消息。消息只是定位提示，未来 worker 仍必须重读权威行和 ledger。
- D0 的删除失败模型固定第 5 次形成持久告警条件、第 8 次耗尽，单次重试至少 60 秒且最多 6 小时；
  耗尽后保留 `DELETE_FAILED`、受保护对象 key 与 `delete_exhausted_at`，不自动无界重试。
  reconciliation 对 scan/expire/delete dead letter 只收敛为安全失败、重排当前权威版本或耗尽事实，
  不能把死信直接标成业务成功。
- 迁移 `20260729120000_m63_b2b_d0_evidence_lifecycle` 要求目标库没有任何既有 evidence、transition、
  evidence outbox 或 evidence idempotency 事实；非空以 SQLSTATE `55000` 停止，不能猜测外部对象状态。
  `down.sql` 还检查 ledger 事实，只允许空事实 local/test；生产及任何已有凭证事实环境只允许受审
  前向修复。应用回滚必须保留 D0 数据底座，直至未来兼容 worker 把所有已存在事实收敛到安全终态。
- D0 的仓库完成结论只涵盖 schema、迁移、RLS/trigger、数据库原语和自动化证据。它不等于真实
  MIME/magic/checksum 校验、scanner、对象删除或保护读取已经发生，也不完成 B2b、B2、M6.3、M6、
  M5 或 P0；外部对象、scanner、URL、告警和生产参数验收均保持 `NOT_RUN/BLOCKED`。

### M6.3-B2b-D1 专用对象存储与内容校验边界

- D1 在 integrations 层新增独立 `AfterSaleEvidenceObjectStorageProvider`，不复用
  `MediaStorageProvider`。它提供 create-only 上传目标、HEAD + 有界流式 GET 校验、内部短期 no-store
  读取目标和幂等删除；稳定错误只暴露分类与 retryable，不暴露签名 query、对象 key、凭据或供应商
  正文。
- 上传签名绑定规范 ORIGINAL key、Content-Length、Content-Type 与 SHA-256，并强制
  `If-None-Match: *`。校验不能信任 provider metadata，必须读取实际 bytes，精确复算长度/checksum 并
  检测 JPEG/PNG/WebP/MP4 magic；magic 通过不等于 malware scan `CLEAN`。
- config 默认 disabled。启用 S3 mode 时要求 evidence bucket 与 content bucket 分离，upload/read/delete
  三组 access key/secret 彼此且与 content 凭据不同；production 还要求 HTTPS、`aws:kms` 与 KMS key
  ID。这里只是启动配置门禁，不证明 provider 侧 KMS grant、lifecycle 或恢复已经验收。
- local/test MinIO root 只负责 bootstrap。固定 content/evidence bucket、content 身份和三种 evidence
  身份通过正向/反向 IAM；初始化可幂等重跑，并拒绝固定 evidence bucket 曾启用版本控制。真实 MinIO
  7/7 覆盖四种对象、签名防篡改、create-only、欺骗、隔离、幂等删除与最终无残留。
- D1 没有 API/controller、worker handler、D0 outbox 消费、scanner、B3 claim 调用方或管理员读取
  审计。OpenAPI evidence operations 保持 contract-only，五项 runtime capability 继续不可用。
- production 仍受两项明确阻断：当前 delete-only adapter 没有 version ID，版本化 bucket 的普通 DELETE
  可能只创建 delete marker；AWS 最小 read IAM 对不存在对象可能返回 `403` 而非 `404`。必须在目标
  provider/staging 冻结物理删除和稳定错误语义，不能以 MinIO 替代。
- 因此只将 D1 repository implementation + local/test storage validation 标记 `COMPLETE`。最终
  verify（62 个单元文件/482 项）、Gitleaks、差异复审、生产依赖 high 与 OpenAPI 回归均通过；B2b/B2、
  M6.3、M6、P0、生产 storage、HTTP、worker、scanner、告警与 rollout 均未完成。

### M6.3-B2b-D2 真实扫描与租约安全 worker 边界

- D2 只消费 `after-sale.evidence.scan.requested` v1。worker 为每条消息构造固定 actor/scope 的
  `createAfterSaleEvidenceSystemContext`，不接受或冒用管理员、会员及普通 StoreContext。条件注册要求
  storage 与 scanner 配置同时完整；任一依赖缺失时失败关闭。
- `AfterSaleEvidenceScanner` 使用 ClamAV TCP `zIDSESSION\0` 单连接会话：request 1 执行
  `zVERSION\0`，request 2 执行 `zINSTREAM\0`，最后发送 `zEND\0`。帧不超过 64 KiB，总量不超过
  50 MiB；响应 ID、顺序、NUL 终止、尾随字节、VERSION 产品名和签名时间均严格校验。内部 engine
  固定为 `clamav`，只有精确 `2: stream: OK` 可成为 `CLEAN`；`FOUND` 只投影稳定
  `MALWARE_DETECTED`，恶意签名正文不记录、不返回、不持久化。
- storage consumer 先 HEAD 并要求非空 ETag，再以 `If-Match` GET 绑定同一对象。实际长度、SHA-256、
  magic 与 scanner 都消费同一条最大 50 MiB 的有界流；对象验证和扫描响应必须都完整成功，才能进入
  数据库结果投影，provider metadata 或单独 magic 检查都不能产生 `CLEAN`。
- `loadAfterSaleEvidenceScanWorkForLease` 在网络调用前重读消息/evidence/ORIGINAL ledger；
  `applyAfterSaleEvidenceScanResultForLease` 在单独 SERIALIZABLE 事务中用数据库
  `clock_timestamp()` 再次复核消息仍为 `PROCESSING`、lease owner 一致、lease 严格未到期、消息
  version、商城与严格 payload 身份，以及 evidence version/generation/status。lease 截止相等也拒绝；
  两个入口在等待 evidence 行锁后都会重新读取数据库时钟并复核租约，事务各限制为 2 秒；loader
  成功不构成提交授权。过期、重领、乱序或已投影消息只能 `SUPERSEDED`，不能覆盖新事实。
- legal hold 等同状态更新可能只推进 evidence version。旧 scan message 发现这种漂移时，会在同一
  SYSTEM 事务把 generation/version 再推进一次并排队唯一的新 scan outbox；旧 worker 只返回
  `SUPERSEDED`，避免权威 `PENDING` 凭证失去可收敛的扫描身份。
- 通用 outbox 不会重领 `DEAD_LETTER`，因此 D2 另以持久、有界批次轮询 scan v1 候选。
  `listAfterSaleEvidenceScanDeadLetterCandidates` 与
  `reconcileAfterSaleEvidenceScanDeadLetter` 重锁权威事实：仍可操作的当前 scan 死信把 `PENDING`
  收敛为带 `SCAN_OUTBOX_DEAD_LETTER` 的 `FAILED` 并可靠排队 expire；旧 version/generation 返回
  `SUPERSEDED`，不能覆盖新扫描或把死信直接标成成功。
- D2 不新增 schema、迁移、RLS、grant、trigger、enum 或 OpenAPI runtime status；M2→current 仍为
  43 段。它不注册上传/确认/状态 HTTP，不提供 B3 claim、保护读取/管理员读取审计，也不消费
  expire/delete outbox 或物理删除对象。
- 没有 heartbeat 的 D2 worker 要求租约至少覆盖 HEAD + max(GET, scanner) + 两个 2 秒数据库事务 +
  5 秒提交余量；默认超时组合的最小租约为 29 秒。关闭进程时 outbox、dead-letter 和库存轮询先停止
  领取并等待在途工作，随后才断开共享 Prisma 和销毁 S3 client。
- D2 已在全部适用门禁通过后获得 repository implementation + local/test scanner worker validation
  `COMPLETE` 的局部结论。production 仍需批准 TTL，冻结 Clamd loopback sidecar/网络隔离
  （Clamd TCP 本身无认证/TLS）、签名更新与 freshness、HA/吞吐/容量/监控/SLA，以及 storage
  IAM/KMS/versioning/Object Lock/lifecycle/错误语义和删除补偿方案；任一缺失时 production capability
  与 rollout 保持关闭。

### M6.3-B2b-D3 会员凭证 HTTP 生命周期边界

- D3 注册 `POST /v1/after-sales/evidence-uploads`、
  `POST /v1/after-sales/evidence-uploads/{evidenceId}/confirm` 与
  `GET /v1/after-sales/evidence-uploads/{evidenceId}`。三条路由要求会员 Bearer、匹配
  `X-Store-Code`、owner scope、Redis 读写限流和安全 correlation/no-store/no-referrer header；已知
  异商城或异会员 UUID 统一不可探测。
- 独立 `AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED` 默认关闭。启用必须同时具备 D1 S3 storage、
  D2 ClamAV、显式上传 TTL 和未 claim 文件/字节配额；签名 URL TTL 不得超过数据库上传 TTL。示例
  local/test 值不是 production 保留政策或合规批准。
- 初始化先由 D0 在配额锁下原子创建 evidence、ORIGINAL binding、expire outbox 与 24 小时幂等事实，
  再由 D1 upload 身份签发 create-only 目标。公共响应只返回完成上传必需的 header allowlist，不返回
  bucket、object key、凭据或内部生命周期截止点；签名失败可用同一幂等键重签同一身份。
- 确认前从 owner 事实加载声明并由 D1 对规范 key 执行 HEAD + `If-Match` GET，按真实 bytes 复算长度、
  SHA-256 与 magic。只有验证成功才由 D0 原子确认并排队 scan；HTTP 验证本身不产生 `CLEAN`，D2
  仍以 SYSTEM scope 从权威 ledger 独立重读、复验和扫描。
- owner 状态只投影 `PENDING/READY/UNAVAILABLE`。未确认上传在排他截止点到达后立即不可用；
  `READY_UNCLAIMED` 只在 claim 截止前投影 READY，已 claim READY 只在 ordinary-access 截止前投影
  READY；恶意、失败、隔离、删除与内部错误统一折叠为 UNAVAILABLE。
- D3 不新增 schema、迁移、RLS、grant、trigger、enum 或 STORE 权限，迁移仍为 43 段。它不实现 B3
  claim、会员/管理员保护读取、`store.after-sales.evidence.read`、管理员逐次审计、expire/delete worker、
  legal hold 管理、外部告警或生产 rollout，因此只标记 repository implementation + local/test member
  evidence HTTP validation `COMPLETE`。

### M6.3-B2b-D4 到期、删除与补偿 worker 边界

- expire/delete handler 只接受 `AFTER_SALE_EVIDENCE` 的 v1 严格 payload，并使用固定 evidence SYSTEM
  scope。loader 与 result 分离；provider 网络调用不持有数据库事务，提交前后均重锁 outbox、evidence
  与 ledger，并使用 `clock_timestamp()` 复核 owner/version/严格未过期 lease。
- expire 只对当前权威 version、具有删除截止的状态、无 legal hold 且截止已到的 evidence 原子推进
  `DELETION_PENDING` 并排队 delete。提前领取使用数据库返回的 `nextAttemptAt` 有界重试；旧 version、
  已 hold 或已收敛消息不会推进状态。
- delete loader 只返回 ORIGINAL、DERIVATIVE、SCAN_TEMPORARY 的完整活动 ledger。provider 删除全部并行
  等待；明确成功/已不存在才可收口。success/failure 投影都精确匹配加载时的父 version 与全部
  `(object id, version)`，租约、hold、父 version/status 或 ledger 漂移均拒绝提交。
- `DELETE_FAILED` 重试在数据库内推进到 `DELETION_PENDING`。若此后进程崩溃，同一消息只在已有失败
  计数且当前 version 精确为 payload `expected_version + 1` 时恢复；provider 成功但数据库提交前崩溃
  则依靠幂等 not-found 重试完成。第 5 次只记录本地 warning，第 8 次耗尽并停止自动排队。
- 生命周期 dead-letter 服务按活动商城有界轮询并重读权威事实；只允许重排当前截止、形成领域删除
  失败或返回 `SUPERSEDED/HELD/EXHAUSTED`。关闭时通用 outbox 和 dead-letter 先停止领取并等待在途，
  storage 在后续 application shutdown 才销毁。
- D4 默认关闭、与 ClamAV 解耦，不新增 schema/RLS/grant/trigger/enum/STORE 权限或迁移，M2→current
  保持 43 段。local/test MinIO 证明当前对象无残留，不证明 production versioning/Object Lock 下历史
  版本已物理删除；B3 claim、保护读取/审计、legal hold 管理、外部告警与 rollout 仍需后续授权。

### M6.3-B2b-D5 保护读取与管理员审计边界

- D5 已完成 default-disabled repository implementation 与 local/test 验收，并注册 member/admin evidence
  URL 路由。成员使用 owner RLS；管理员在既有
  `AdminService.authorize` 中要求 `store.after-sales.evidence.read`、显式 `store_id`，平台跨商城访问继续
  要求受审的固定格式 `X-Access-Reason` incident reference，拒绝自由文本以避免 URL、object key 或其他
  凭证敏感事实进入审计。两者复用 after-sales READ 限流，Redis、配置、storage 或审计不可用时
  失败关闭并不签发 URL。
- 读取只从 D0 evidence header 取得兼容 ORIGINAL key，不给 member/admin SELECT system-only ledger。
  D0 deferred ORIGINAL-binding guard 保证非 `DELETED` 父行 header key 对应唯一活动 ORIGINAL。首读、
  事务外 S3 签名、随后 `READ COMMITTED`/`FOR SHARE` 最终复验构成授权序列；网络签名不持有数据库事务。
- D5 的第 44-48 段迁移没有新增业务表、列、枚举或 STORE permission code。第 44 段
  `20260730100000_m63_b2b_d5_protected_read_lock` 建立最小 evidence lock；第 45 段
  `20260730103000_m63_b2b_d5_authorization_revalidation` 把 runtime 入口转为授权感知函数，锁定并复验
  ACTIVE 商城、actor、Bearer/session、member 商城归属及管理员 direct/cross-store RBAC；第 46 段
  `20260730104000_m63_b2b_d5_member_authorization_grant_fix` 只授予 guard `members.store_id` 列级
  `SELECT`；第 47 段 `20260730105000_m63_b2b_d5_expiry_revalidation` 在 evidence `FOR SHARE` 已取得后
  再校验所有 bearer/session/URL/evidence deadline，覆盖等待 lifecycle 写锁造成的过期；第 48 段
  `20260731100000_m63_b2b_d5_commit_deadline_revalidation` 把 URL 截止绑定到 bearer/session 并保留提交余量。
- 集群级 `zalo_shop_evidence_read_guard` 必须不可登录、不可继承、非 superuser、不可创建数据库/角色、
  不可复制、不可绕过 RLS 且无角色成员关系。它拥有固定 `search_path`、`row_security=on` 的受限
  security-definer 函数；专用 RLS/column grant 只允许该函数取得锁读，仍与生命周期写冲突，却不扩大
  `zalo_shop_runtime` 或 member `UPDATE` 权限。第 44、45、47、48 段需要受控 migration executor 是 PostgreSQL
  `rolsuper`，以把 definer ownership 转给无关系的 guard role；runtime 连接不得承担此部署权限。
- URL expiry 以固定整秒签名时间，从 D1 configured read TTL 与数据库
  `ordinary_access_deadline_at` 取更短值并保留安全余量，严格早于截止。最终重验同时绑定商城、主体/案例、
  `READY`、claim、header key、状态/截止和版本；legal-hold-only version 漂移可继续，因为 hold 只阻止
  物理删除，不能提前撤销仍在普通读取窗口内的访问。
- admin 在最终复验的同一事务内写一次
  `after-sale.evidence.protected_read.issued` 审计；仅 allowlist actor/store/case/evidence/version/
  correlation/access reason，禁止 URL、key、checksum、scanner、provider response 或文件内容。事务未提交
  不返回 URL。回滚先关闭能力并等待在途请求和 URL TTL；仅 local/test 且没有任何 issued-read audit 时按
  `48 -> 47 -> 46 -> 45 -> 44` 执行 `down.sql`；第 48、47 段的逆向脚本只做审计事实 guard，不恢复较弱
  函数，任一 audit 均 fail-fast。逆序回滚只删除当前数据库的函数、policies 和 grants，不删除 cluster-level
  guard role；生产或已有受保护读取审计事实的环境只允许向前修复。
- 生产仍须独立验证 S3 read IAM 与 upload/delete 身份隔离、HTTPS、KMS、versioning/Object Lock/lifecycle、
  legal retention 语义、稳定不存在对象错误和短期 bearer URL 风险接受；local/test MinIO 不是这些证据。
  D5 的 44-48 迁移回归、定向/完整验证和适用仓库门禁已通过，但该 repository + local/test `COMPLETE`
  状态不代表生产就绪；完整证据见
  `docs/reports/m6.3-b2b-d5-protected-evidence-read-completion-report.md`。

### M6.3-B3 默认关闭的售后申请、取消与商家主动退款仓库边界

- B3 只新增三条写命令：会员 `POST /v1/after-sales` 创建
  `REFUND_ONLY/RETURN_REFUND/EXCHANGE`，会员 `POST /v1/after-sales/{afterSaleId}/cancel` 取消本人
  可取消初态，管理员 `POST /v1/admin/orders/{orderId}/after-sales` 创建
  `MERCHANT_REFUND + PENDING_REVIEW`。三条命令只返回由 operation `result_summary` 重建的不可变
  acknowledgement；当前完整聚合使用既有 B1 GET projector。B3 不新增平行聚合或审批、退款 provider、
  库存、返件、换货履约和 UI。
- `AFTER_SALE_COMMANDS_ENABLED` 默认关闭，config 在 production 拒绝启用，service 也对 production
  失败关闭。会员命令依赖当前商城/member/session；管理员命令只接受目标商城直接
  `store.after-sales.review`、近期 MFA 和 ADMIN WRITE 限流。当前 B3 不接受 cross-access-only，
  `X-Access-Reason` 不能替代目标商城权限；数据库 finalizer 在同一事务再次复验 active store、actor、
  Bearer/session 截止和 RBAC，不能以请求体覆盖这些事实。
- 应用 primitive 使用 `Serializable` 事务锁定订单、订单行、售后容量、政策快照、支付和
  `ORDER_OUTBOUND` 交付事实。服务端计算整数 VND 逐行权益、每订单一次 merchant-paid 运费权益和
  exchange 等价性；reason 必须命中政策 allowlist，越南自然日窗口排他截止，legacy 只进入
  `REVIEW_REQUIRED`。当前仓库只证明唯一 ONLINE 成功收款；没有可锁定复验的 COD 已确认收款事实，
  因此 COD 与任何无法证明的 payment/delivery/policy 条件都失败关闭。
- evidence 要求或 evidence id 非空时，upload validation、malware scan、claim、protected read 和 deletion
  compensation 以及显式 `ordinary < retention` TTL 必须全部可用；D0 claim 与 header/items/operation/
  transition/audit 同事务提交。取消只追加 `CANCELLED`、operation 和审计，不 unclaim、不缩短期限、不
  删除对象、不执行退款或库存动作。
- 第 49 段迁移 `20260731110000_m63_b3_after_sale_commands` 在任何 DDL 前只读校验草稿、版本、订单行快照
  与售后快照的 reason allowlist/子集合约；不兼容时以 `55000` 停止且不回填。随后为 transition 增加
  `operation_id` 复合 FK、每 case 单一 `SUBMIT`、operation/link/completion/atomicity/deferred commit
  guards 和两个窄 security-definer finalizer。普通 runtime 不能直接 INSERT operation；只能执行提交/取消函数，
  `MEMBER_CREATE`、`MERCHANT_REFUND_CREATE`、`MEMBER_CANCEL` 的 request hash 与不可变
  `result_summary` 支持稳定幂等重放和异参冲突。
- B3 create 与审批准备共享 per-order advisory lock。item/header/allocation/legacy-approve 的 early guard
  在锁冲突时以 `40001` 回滚整笔审批，transition lock trigger 排在 B0 contract guard 前；这消除了审批
  先持售后行、B3 先持 order lock 时的反向等待，并为后续 B4 保留明确的整事务重试契约。
- create/cancel 只对 Prisma `P2034` 或 PostgreSQL `40001` 做最多三次 Serializable 事务尝试；
  `expected_version` 冲突显式排除在重试之外并稳定返回版本冲突，避免旧前置条件在重试中被接受。
- B3 default-disabled repository implementation + local/test validation 已完成，适用仓库门禁证据见
  `docs/reports/m6.3-b3-after-sale-commands-completion-report.md`。生产策略、TTL、对象存储、真实支付/
  物流供应商、部署与 rollout 均为 `NOT_AUTHORIZED / NOT_RUN`；后续 B4 局部完成不改写 B3 历史范围。

### M6.3-B4 默认关闭的审核、复核与寄回到期仓库边界

- 两条管理员路由分别处理非 legacy 初审和 `REVIEW_REQUIRED` 的 ordinary/legacy 解决；两者复用 B3
  订单锁、最终授权复验、稳定 request hash、operation acknowledgement 和最多三次 Serializable 尝试。
  普通批准金额只由冻结请求行按整数 VND 重算，legacy 不回填当前政策。商家主动退款采用不同管理员
  maker-checker。
- B4 复用 M6.2/B0 append-only transition 投影。`ADMIN_REVIEW/ADMIN_RESOLVE_REVIEW` operation、恰一条
  transition 与审计必须同事务提交；第 51 段前向修复消除了 deferred guard 的局部变量/列名歧义。
- 独立 worker 逐 ACTIVE 商城调用 `after-sale-transition` SYSTEM 原语，只对已到期且无冲突副作用的
  `APPROVED RETURN_REFUND/EXCHANGE` 追加 `RETURN_EXPIRED`。`SKIP LOCKED` 使并发批次不重复处理，状态
  trigger 保证返件与到期至多一个成功。
- `AFTER_SALE_REVIEW_COMMANDS_ENABLED` 与 `AFTER_SALE_RETURN_EXPIRATION_WORKER_ENABLED` 默认关闭，
  production 拒绝启用。B4 不调用退款/COD/物流 provider，不创建返件、验收、库存恢复、换货履约或 UI；
  B5-B7、M6.3、M6、P0 和 production rollout 继续未完成。

### M6.3-B5 默认关闭的返件登记与可信物流事实仓库边界

- B5 只注册会员返件登记与管理员可信物流事实两条写路由。会员命令只在截止点前创建唯一
  `SUBMITTED` 并追加 `START_RETURN`；管理员只接受 `IN_TRANSIT/DELIVERED`，由受审数据库入口追加
  `RETURN_SHIPPED/RETURN_RECEIVED`。直接送达在同一事务写两条事件，并以至少一微秒的时间顺序保证 B1
  `(created_at,id)` 时间线稳定；最终 `INSPECTION_PENDING` 仅表示待验收。
- 运单号在应用边界 trim 后计算 `PII_HASH_KEY` keyed HMAC，并只持久化摘要与首尾掩码。request hash
  绑定商城、actor、path、幂等键与 aggregate/返件版本；明文不能进入 SQL 参数之外的持久事实、日志、
  audit、operation result、公开响应或错误。
- 两条命令在 `Serializable` 事务中采用幂等 advisory lock、订单 advisory lock、订单/header/返件的固定
  行锁序；只对 `P2034/40001` 最多尝试三次，明确 expected-version 冲突不重试。第 52 段迁移把
  operation、一条或两条 transition 与 audit 绑定为 deferred 原子提交，并拒绝 runtime 直接返件或
  operation 表写入。
- 会员最终提交前重验 ACTIVE 商城、本人 member/session/token；管理员额外要求目标商城直接
  `store.after-sales.review`、近期 MFA、确认词和 reason，并在全部锁等待后再次重验。只有 platform
  cross-access 固定失败关闭。两条写响应均为不可变 operation acknowledgement；掩码返件、当前状态、
  时间线和 `INSPECTION_PENDING` 队列继续由 B1 严格 GET 投影读取。
- `AFTER_SALE_RETURN_COMMANDS_ENABLED` 默认 `false`，production 配置解析与 service 双重拒绝启用。
  第 52 段 `down.sql` 仅允许无 B5 operation/可信状态/transition/audit 的 local/test，以 `55000` 阻止
  有事实回滚。B5 不调用 provider，不执行 inspection、库存恢复、退款/COD、换货或 UI；完整 B2/B2b、
  B7、M6.3、M6、P0、部署和 rollout 继续未完成。

### M6.3-B6 默认关闭的 ONLINE 售后退款权威协调边界

- B6 只注册管理员 ONLINE 退款路由和退款同步 worker。HTTP 请求严格只接受确认词、expected version
  与 reason；服务端先取得共享 M5 订单退款锁，再锁订单、成功支付和售后聚合，以 `approved_total_vnd` 重算整数 VND 金额和
  M5 剩余退款容量，不信任客户端金额、支付分支或商城身份。
- 写入前要求目标商城直接 `store.after-sales.review`、`store.refunds.create`、
  `store.after-sales.read`、`store.refunds.read` 与近期 MFA；四项均拒绝 cross-access-only。同一事务在锁
  等待后以 `FOR SHARE` 锁定 ACTIVE 商城、管理员、有效 session/MFA、商城角色和四项直接权限，并在首笔
  业务写入前按数据库时钟最终重验，避免权限撤销竞态或资金事实提交后才发现读取权限不足。
- 售后命令幂等 advisory lock 后按共享 M5 order-refund advisory lock、order、成功 payment、after-sale、
  settlement/link 固定锁序，在同一
  `Serializable` 事务创建 `ONLINE_ORIGINAL` settlement、transaction-scoped M5 refund、唯一 link、
  M5/售后 transition、audit 和版本化 `after-sale.refund.sync` outbox。相同键重放冻结结果，同键异参
  冲突，客户端金额篡改在 DTO 层拒绝。
- worker 以锁定后的 M5 refund 为权威事实，将 `SUCCEEDED/FAILED/CANCELLED` 收敛到售后成功、失败或
  可重试待处理；UNKNOWN、金额/商城/payment/link/version 不一致和未来消息版本进入人工复核或失败关闭。
  重放缺少当前版本 sync 消息时补发，不把 outbox payload 或 provider 回调直接当成授权/金额依据。
- B6 不新增迁移，复用 M6.2/B0 settlement/link、RLS、SYSTEM allowlist 和完整性 guard。
  `AFTER_SALE_REFUND_COMMANDS_ENABLED` 默认 `false` 且 production 配置与 service 双重拒绝开启。应用回滚
  保持命令关闭并继续收敛已提交 M5 退款，不能删除或逆转资金事实。真实支付商、COD、inspection、库存
  恢复、换货、UI、部署与 rollout 未交付；B2/B2b、B7、M6.3、M6 和 P0 继续未完成。

## 7. 身份、安全与隐私

- Mini App 使用 Zalo Token/Header 与服务端会话交换，不依赖普通浏览器 Cookie、LocalStorage 或 SessionStorage 作为认证根。
- 手机号、定位等权限只在对应场景请求；拒绝后提供手动地址/联系方式流程。
- 地址收货人、E.164 手机号和详细地址以版本化密文保存，手机号另存 HMAC 用于会员范围查重；订单地址快照也保存密文，公开响应仅返回掩码手机号。
- 管理端使用短时访问令牌、可轮换刷新令牌和双重验证；权限采用 deny-by-default。
- 密钥来自环境或密钥管理服务，按环境与商城隔离，不进入前端、日志、测试快照或 Git。
- 管理操作、状态机变更、合规审核和隐私请求写入防篡改审计记录。
- 数据删除采用业务允许的删除、匿名化或保留策略，历史订单法定记录不被级联破坏。

## 8. 第三方集成边界

### 对象存储

catalog/content 继续使用既有 `MediaStorageProvider`；售后凭证只能使用 D1 独立 adapter 和凭据。MinIO
仅是 local/test S3-compatible 证据，不代表 AWS 或生产 provider。生产上线前必须在精确目标验证
checksum、create-only、SSE-KMS、最小 IAM、不存在对象错误、超时、物理删除、lifecycle 与恢复；任何
一项未确认时 evidence runtime capability 保持关闭。

D2 scan worker 只能通过 D1 的独立 read 身份读取规范 ORIGINAL。HEAD 的非空 ETag 与后续
`If-Match` GET 共同冻结本次读取对象，同一有界正文流同时服务实际内容校验和 ClamAV；worker 不直接
接收客户端 key、URL、商城或 actor 作为授权依据。

### Zalo

- 两个商城分别配置 Mini App ID、OA 与分享参数，代码共享。
- 支付功能按 Zalo 官方要求接入 Checkout SDK；优先评估平台的完整集成模式，自定义模式仅在获得平台审核和业务必要性时使用。
- 分享只由用户主动触发；Deep Link 必须携带并校验商城、语言和对象标识，提供浏览器兜底页。
- 发布权限、测试版本、审核材料和生产配置完全分离。

### 支付

定义 `PaymentProvider` 端口：创建支付、查询、验证回调、退款、查询退款和可用范围内的对账。M5 已批准使用 ZaloPay，通过 Zalo Checkout 的 `ZALOPAY_SANDBOX/ZALOPAY` 方法接入；两个商城使用独立 App/商户配置和 secret reference。Mini App SDK 结果不确认支付成功，服务端以 Checkout HmacSHA256 回调或主动 `getOrderStatus` 为权威事实。COD 是独立领域策略，不伪装为线上支付提供商。

### 物流

定义 `ShippingProvider` 端口：报价、创建/取消运单、面单、轨迹、COD 金额与对账。M5 已批准首家供应商为 GHN，两个商城使用独立 ShopId/Token secret reference。M5.6 已实现固定 sandbox/production origin、严格 DTO、超时/大小/redirect 门禁、商城渠道解析和可靠命令；生产不允许自由 URL 或 test fallback。2026-07-24 核验的 GHN webhook 官方文档未声明签名，因此回调只作为同步提示；内部状态必须由对应商城凭据的主动 Order Info 查询确认。其他供应商不在 M5 范围，不创建声称可用的适配器。

## 9. 部署与恢复

- 环境至少分为 local、test、staging、production，凭据与数据库完全隔离。
- API 与 worker 构建为独立容器；静态前端按 Zalo 发布流程和管理端托管策略发布。
- 数据库迁移采用向前兼容的 expand/migrate/contract；破坏性收缩需独立版本执行。
- 每次发布保留应用回滚版本；数据库变更必须有回滚脚本或明确的向前修复方案。
- PostgreSQL 执行自动备份和定期恢复演练；content 对象存储按批准策略启用版本/生命周期。evidence
  bucket 必须先冻结与 D0 ledger/物理删除兼容的 versioning/Object Lock/lifecycle 方案；D1 当前明确
  阻止在版本控制曾启用的固定本地 bucket 上冒充物理删除完成。
- 健康检查区分存活与就绪，关键队列积压、回调失败、库存异常和对账差异必须告警。

## 10. 质量门禁

每个里程碑至少执行：

1. 受影响单元、集成、API、E2E 和安全测试。
2. 格式化检查、Lint、TypeScript 类型检查和生产构建。
3. 数据库迁移在空库升级、已有数据升级和回滚/向前修复演练。
4. `git diff --check`、改动范围审查和敏感信息扫描。
5. 对照 `REQUIREMENTS.md`、本架构和里程碑验收清单逐项记录证据。

任何未运行的检查必须记录原因与影响，不得标记为通过。

## 11. 已核验的官方约束

- Zalo Checkout SDK 要求带支付能力的 Mini App 声明支付方式，并由用户确认、平台记录交易；服务端仍需处理支付结果：<https://docs.zaloplatforms.com/docs/MA/checkoutSdk/intro>
- Zalo Checkout `createOrder` 从 ZMP SDK 2.45.0 起必须携带服务端生成的 MAC；ZaloPay sandbox/production 方法分别为 `ZALOPAY_SANDBOX/ZALOPAY`，无合法回调时需主动查单：<https://docs.zaloplatforms.com/docs/MA/checkoutSdk/apis/createOrder>、<https://docs.zaloplatforms.com/docs/MA/checkoutSdk/webhooks/callback>
- GHN sandbox 使用固定 dev gateway、Token/ShopId，并提供报价、建单、查单、取消、面单与 webhook；当前 webhook 契约没有签名字段，不能单独作为权威物流事实：<https://api.ghn.vn/home/docs>
- 手机号、定位等权限需要 Zalo 和/或用户授权，官方建议在真实使用场景请求：<https://docs.zaloplatforms.com/docs/MA/intro/request-permission>
- Mini App 发布需经过审核，覆盖第三方跳转、性能、UI/UX、隐私、安全和 Zalo 认证：<https://docs.zaloplatforms.com/docs/MA/intro/public-mini-program>
- 官方命令行脚手架入口为 `create-zalo-mini-app`/ZMP CLI：<https://docs.zaloplatforms.com/docs/MA/intro/getting-started/dev-use-command-line>
- Node.js 官方建议生产应用使用 Active LTS 或 Maintenance LTS：<https://nodejs.org/en/about/previous-releases>

## 12. 上线与后续里程碑未决事项

以下事项不阻塞仓库基础脚手架，但会阻塞相应真实集成或生产发布：

1. 确认是否接受本技术栈和“模块化单体优先”的部署形态。
2. 确认美妆与服装是否各自使用独立 Zalo Mini App ID 和 OA（本文按独立配置设计）。
3. P0 线上支付已确认为 ZaloPay through Zalo Checkout；仍需提供两个商城的 Checkout/ZaloPay sandbox 商户条件、测试成员、密钥和 HTTPS 回调域名。
4. P0 物流已确认为 GHN；仍需提供两个商城的 sandbox ShopId/Token、服务地区、仓库/退货地址、COD、面单和 webhook 配置。
5. 确定云厂商、越南访问区域、域名、对象存储和密钥管理方案。
6. COD 默认扣库存时点已在 M4 确认为“确认有效后扣减”；上线前仍需业务方确认各商城金额、地区和风险阈值。
7. 确认“护肤 - 化妆品”是否应为“化妆水”；实现中保持类目可配置，不写死。
8. 上线前由越南本地法律、税务和行业合规人员确认资料与数据处理边界。
9. staging/production 启用地址与配送前，向商城隔离的 `administrative_areas` 导入并记录越南权威三级行政区数据来源和版本；数据库校验父子层级，API 只接受已启用完整父链并以服务端名称形成地址/计价事实。local/test fixture 不能作为权威主数据，缺少主数据时地址写入必须失败。
