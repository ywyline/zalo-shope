# M5 支付、退款、物流与集成任务权限矩阵

> 状态：M5.2 权限目录已实施；P0-M5-005 Slice C 复用已登记财务对账权限
>
> 日期：2026-07-24
>
> 边界：ZaloPay 通过 Zalo Checkout，物流为 GHN；两个商城独立渠道配置

## 1. 权限目录

| 权限 code                      | 用途                                             | 风险 |
| ------------------------------ | ------------------------------------------------ | ---- |
| `store.payments.read`          | 查看当前商城支付尝试、脱敏供应商引用和状态时间线 | 高   |
| `store.payments.reconcile`     | 主动查单、发起支付对账和处理支付复核             | 极高 |
| `store.refunds.read`           | 查看退款、可退款余额和退款时间线                 | 高   |
| `store.refunds.create`         | 以整数 VND 创建部分/全额退款                     | 极高 |
| `store.shipments.read`         | 查看当前商城运单、费用分解和轨迹                 | 高   |
| `store.shipments.create`       | 报价并为待履约订单创建 GHN 运单                  | 极高 |
| `store.shipments.cancel`       | 请求取消仍允许取消的 GHN 运单                    | 极高 |
| `store.shipments.label.read`   | 获取当前商城运单的短期面单访问                   | 极高 |
| `store.shipments.reconcile`    | 主动同步轨迹、COD/费用对账和物流复核             | 极高 |
| `store.integrations.read`      | 查看脱敏渠道状态、能力、环境和预检结果           | 高   |
| `store.integrations.manage`    | 创建、启停和轮换当前商城渠道 secret reference    | 极高 |
| `store.integration-jobs.retry` | 受审重试当前商城 dead-letter 外部任务            | 极高 |
| `store.finance.read`           | 查看当前商城脱敏财务对账批次与逐笔差异           | 高   |
| `store.finance.reconcile`      | 导入规范化结算事实并以 maker-checker 关闭差异    | 极高 |

M5.2 与 P0-M5-005 Slice A 迁移只登记权限目录，不自动授予生产角色；Slice B/C 不新增权限或角色授权。local/test `store-admin` 可显式获得这些权限以
支持自动化测试；生产必须按岗位和最小权限受审分配。任何 `read` 都不隐含写入、退款、对账、
面单或重试权限。

## 2. 管理端动作矩阵

| 动作               | 所需权限                                          | 附加控制                                                                           |
| ------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 支付列表/详情      | `store.payments.read`                             | RLS、商城 Header/查询一致、供应商引用掩码                                          |
| 支付主动查单       | `store.payments.reconcile`                        | `Idempotency-Key`、expected version、原因、审计；不接受结果/金额                   |
| 退款列表/详情      | `store.refunds.read`                              | 当前商城支付复合关系和 RLS                                                         |
| 创建退款           | `store.refunds.create`                            | MFA freshness、二次确认、expected payment version、可退款余额行锁、原因和审计      |
| 查询退款结果       | `store.payments.reconcile` + `store.refunds.read` | 只调用已绑定供应商退款引用，不接受客户端供应商 ID                                  |
| 运单列表/详情/轨迹 | `store.shipments.read`                            | 地址/手机号掩码，未知供应商文案不直出                                              |
| GHN 报价           | `store.shipments.create`                          | 从订单/仓库/地址重载重量、地区和 COD；请求不接受费用                               |
| 创建运单           | `store.shipments.create`                          | MFA freshness、二次确认、订单版本、状态机、全量行、幂等和审计                      |
| 取消运单           | `store.shipments.cancel`                          | MFA freshness、二次确认、运单版本、供应商当前状态复核                              |
| 获取面单           | `store.shipments.label.read`                      | 单次/短期访问、格式 allowlist、每次读取审计，不返回 GHN Token                      |
| 主动同步物流/对账  | `store.shipments.reconcile`                       | 受控批次、原因、幂等、差异只追加                                                   |
| 读取渠道           | `store.integrations.read`                         | 不回显 secret ref 全值、密钥、GHN Token 或 Checkout Private Key                    |
| 修改/启停/轮换渠道 | `store.integrations.manage`                       | MFA freshness、二次确认、目标环境 allowlist、配置预检、版本和审计                  |
| 读取失败任务       | 对应领域 `read`                                   | 只返回错误类别/计数/时间，不返回原始 payload                                       |
| 重试 dead-letter   | `store.integration-jobs.retry` + 对应领域写权限   | MFA freshness、expected version、原因、审计；不能改 payload/商城                   |
| 读取财务对账批次   | `store.finance.read`                              | FORCE RLS、目标商城、稳定游标、引用掩码；平台跨商城读取需访问原因                  |
| 导入支付/退款批次  | `store.finance.reconcile`                         | 直接商城角色、近期 MFA、幂等键、固定确认码、原因、规范化输入和只追加审计           |
| 读取 COD 应收      | `store.finance.read`                              | 仅当前商城 GHN 已签收 COD 运单、可信历史报价、状态先筛选后稳定分页、引用掩码       |
| 导入 GHN COD 回款  | `store.finance.reconcile`                         | 直接商城角色、近期 MFA、幂等、确认、规范化金额/费用、跨批次重复检测和只追加审计    |
| 关闭对账差异       | `store.finance.reconcile`                         | 直接商城角色、近期 MFA、异于导入人、幂等键、批次版本、固定确认码、原因和只追加审计 |

订单客服的 `store.orders.read/manage` 不自动拥有支付退款、渠道、运单或面单能力。仓库岗位可获
运单 create/read/label，但不获退款和渠道管理；财务岗位可获支付/退款/对账，但不获渠道密钥
轮换。批次导入人与差异关闭人必须不同；拥有同一权限不取消运行时 maker-checker 校验。

## 3. 买家能力

| 能力                 | 身份与归属                       | 安全/一致性控制                                                                                        |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 在线支付下单         | 商城绑定会员 + 当前会员地址/订单 | M4 服务端重算；请求只含 SKU/数量/券/地址/ONLINE/quote hash；创建订单、预留、支付尝试和 outbox 同事务   |
| 获取 Checkout launch | 当前会员本人待支付订单           | 短期 launch token 绑定 store/member/order/payment/amount/nonce；MAC 只由服务端生成；前端无 Private Key |
| 绑定 SDK `orderId`   | 当前会员 + launch token          | 客户端 orderId 仅为查单提示；必须主动查单并核对 amount/method/extradata 后才成为绑定事实               |
| 查询支付结果         | 当前会员本人订单                 | 只返回内部标准状态和恢复建议；客户端 PaymentDone/checkTransaction 不确认成功                           |
| 重试支付             | 本人仍在支付窗口的订单           | 新支付尝试、独立幂等键；同订单最多一个活动尝试                                                         |
| 查看物流轨迹         | 当前会员本人订单                 | 内部三语 message key、地点掩码；不返回 GHN Token、ShopId、内部错误或其他商城引用                       |

会员不能提交或修改 `store_id`、金额、币种、供应商 method、MAC、支付/退款/物流状态、GHN
ShopId、费用、COD、面单 URL 或供应商 transaction/order code。前端隐藏字段不是信任边界。

## 4. 外部回调信任边界

### 4.1 Zalo Checkout

- 回调路由不使用会员/管理员 Token，但设置原始 body 大小、内容类型、读取超时和速率限制。
- 通过唯一 App ID 定位单个候选商城/环境，再取对应 Checkout Private Key；`mac` 必须按官方
  字段顺序 HmacSHA256 校验，存在 extra/method 等字段时必须再校验覆盖全部字段的
  `overallMac`。比较使用恒定时间函数。
- 官方当前列出的 Checkout Server IP 只作为附加 allowlist/告警信号，不能代替 MAC；IP 列表
  必须配置化并在变更时审查，不能硬编码成永久事实。
- MAC 通过后仍核对 App、provider order、内部订单、store、VND amount、method、状态和
  `extradata` nonce。任何不匹配进入 `REVIEW_REQUIRED`，不消费库存。
- 重复/乱序 callback 由 provider callback、inbox 和支付状态三层幂等；HTTP 应答不泄露内部
  订单或验签细节。20 分钟未收合法回调时由 worker 主动 getOrderStatus。

### 4.2 GHN

- 2026-07-24 可访问的 GHN webhook 文档没有声明签名或 MAC，因此任何 webhook body、ShopID、
  ClientOrderCode、OrderCode、Status、Fee 或 COD 字段均不作为权威事实。
- 可选高熵 webhook path token、HTTPS、来源网络策略、体积/速率限制只用于降低噪声。收到
  callback 后最多解析成候选运单提示并去重，随后使用该商城独立 GHN Token/ShopId 调用 Order
  Info；只有主动查询响应可以推进内部物流状态。
- callback 无法唯一解析商城或运单时返回稳定接受/拒绝策略并记录低敏告警，不跨商城遍历数据
  或把供应商输入拼接成 SQL/URL。

## 5. 密钥、SSRF 与敏感信息

- Zalo Checkout Private Key 和 GHN Token 只从部署密钥系统按 secret reference 获取，生命周期
  限于单次调用；Key 1/Key 2 在 Zalo 管理配置中使用，不复制到前端或普通数据库字段。
- 两个商城使用不同 secret reference、App/merchant/Shop 标识和签名上下文。缓存键至少含
  store/channel/environment/key version，轮换后清除旧缓存。
- 所有供应商 origin 来自代码 allowlist：Checkout server 官方 origin、GHN sandbox 或 production
  origin。管理端不能提交任意 URL、协议、Host、重定向目标或代理 Header。
- 外部请求设置连接/总超时、响应体上限、JSON/content-type 校验和有限重定向（默认禁用）。
  错误只映射为稳定类别，不把响应正文、密钥、Token、完整地址/手机号或堆栈写日志。
- 面单 URL/token 不长期缓存或直接进入审计；服务端校验授权后生成/代理短期访问，并设置
  `Cache-Control: private, no-store`。

## 6. 数据库和 worker 最小权限

- 回调解析、API 和 worker 均使用无 RLS bypass 的 runtime role；处理单条外部消息前解析唯一
  store，随后设置 transaction-local store context。
- 支付成功锁顺序固定为 order -> payment attempt -> inventory reservation/balance -> refunds/
  outbox，过期/取消使用相同顺序；避免死锁和成功/释放库存竞态。
- worker 用数据库租约和 `FOR UPDATE SKIP LOCKED`，不依赖进程内锁。租约到期可恢复；达到上限
  进入 dead-letter，不删除事实或无限热循环。
- outbox/inbox payload 不包含密钥、完整 PII 或 supplier auth；Redis/队列 key 含 store ID。
- 财务对账 runtime 只获批次/逐笔 `SELECT/INSERT`，没有 `UPDATE/DELETE`；延迟约束在提交时重算
  汇总并验证匹配支付/退款或 COD 运单仍属于批次互斥绑定的支付/物流渠道。原始批次、记录和供应商
  引用不写审计或 API；Slice B 不增加表级授权。
- 原始加密 payload 读取需要专用平台级应急权限、访问原因和审计；M5 普通商城权限均不提供。

## 7. 稳定拒绝与必测安全场景

- 未认证买家/管理员：`401 AUTHENTICATION_FAILED`；无商城或权限：
  `403 AUTHORIZATION_DENIED`；当前主体范围内不存在：`404 RESOURCE_NOT_FOUND`。
- DTO/Header/回调格式：`400 INPUT_INVALID`；版本、状态、幂等、金额、退款余额和活动运单冲突：
  `409 CONFLICT`；供应商暂不可用：`503` 且稳定 reason code，不泄露上游正文。
- 必测跨商城 App ID、ShopId、provider order/transaction/refund/shipment ID、管理员 query store、
  会员订单和 launch token；普通管理员不能通过已知 UUID 读取/操作另一商城。
- 必测伪/缺/错误 MAC、only-mac 绕过 overallMac、字段顺序、金额/订单/extradata 篡改、重复/乱序、
  迟到成功、callback 与订单过期竞态、退款超额并发。
- 必测 GHN 伪 callback 不推进状态，必须主动查单；未知/倒退状态、重复轨迹、跨 Shop order code、
  SSRF、恶意面单 URL、超大/慢响应和限流。
- 必测日志、审计、API、错误和测试快照不包含 Private Key、Key1/Key2、GHN Token、完整手机号/
  地址、MAC 原始 key、Authorization、SQL、堆栈或其他商城 UUID。
- 必测财务对账的直接商城授权、锁等待后权限撤销、同键重放/异参冲突、同批次引用并发、跨商城
  支付/退款/运单引用、金额/费用篡改、同批次及跨批次 GHN 重复引用、状态过滤末页游标、RLS、
  只追加和延迟约束原子回滚。
