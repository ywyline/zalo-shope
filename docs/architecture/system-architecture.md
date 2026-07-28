# 系统架构提案

> 状态：已批准
>
> 版本：0.4
>
> 日期：2026-07-27
>
> 依据：`REQUIREMENTS.md` V2.0、`AGENTS.md`

批准记录：用户于 2026-07-17 批准本架构，授权先实施 P0 计划的 M0；用户于
2026-07-23 批准 M4 专项计划，地址、服务端结算、订单、COD 与配送策略按本文边界实施；用户于
2026-07-27 先批准 M6 双轨契约冻结，随后授权 M6.2 数据/RLS/迁移实施，外部上线门禁保持不变。

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
  enforcement 已启用时，deferred commit guard 才要求订单行同事务存在快照。M6.2 不创建生产政策，
  所有商城 enforcement 保持 OFF，checkout resolver/writer、readiness API 和受审启用命令尚未实现。
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
  在锁定售后聚合后校验 purpose、case type 和允许状态，并阻止 reject/convert 后留下晚到运单。既有
  M5 查询、命令、callback 和 worker 尚未全面 purpose-aware，
  M6.3 创建任何返件/换货运单前必须分流，且只有 `ORDER_OUTBOUND` 可推进原订单 `SHIP/DELIVER`。
- M6.2 没有开放售后、收藏、历史、隐私或分享的买家/管理员运行时，也没有 worker、UI、对象存储/
  扫描、真实 COD/GHN/Zalo 调用或生产 rollout。表存在只表示数据事实基础完成；M6.3 尚未开始，
  M5.5-M5.7、整个 M5 和 P0 的外部上线门禁保持不变。

## 7. 身份、安全与隐私

- Mini App 使用 Zalo Token/Header 与服务端会话交换，不依赖普通浏览器 Cookie、LocalStorage 或 SessionStorage 作为认证根。
- 手机号、定位等权限只在对应场景请求；拒绝后提供手动地址/联系方式流程。
- 地址收货人、E.164 手机号和详细地址以版本化密文保存，手机号另存 HMAC 用于会员范围查重；订单地址快照也保存密文，公开响应仅返回掩码手机号。
- 管理端使用短时访问令牌、可轮换刷新令牌和双重验证；权限采用 deny-by-default。
- 密钥来自环境或密钥管理服务，按环境与商城隔离，不进入前端、日志、测试快照或 Git。
- 管理操作、状态机变更、合规审核和隐私请求写入防篡改审计记录。
- 数据删除采用业务允许的删除、匿名化或保留策略，历史订单法定记录不被级联破坏。

## 8. 第三方集成边界

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
- PostgreSQL 执行自动备份和定期恢复演练；对象存储启用版本/生命周期策略。
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
