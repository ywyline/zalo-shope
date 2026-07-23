# M4 地址、结算、订单与 COD 专项实施计划

> 状态：实施完成，外部验收有保留
>
> 日期：2026-07-23
>
> 依据：`REQUIREMENTS.md` 第 4、5、10、11、12、14、17、20、22、23、24 节，
> `AGENTS.md`，`docs/plans/p0-development-plan.md`，
> `docs/plans/m3-implementation-plan.md`，`docs/architecture/system-architecture.md`，
> `docs/database/m3-data-dictionary.md`

批准记录：用户于 2026-07-23 明确批准本计划并授权按文档实施；该批准不授权真实支付、物流、生产部署、推送或发布。

## 1. 目标与非目标

### 1.1 目标

- 建立按商城和会员隔离的越南三级地址模型，支持越南和中国大陆手机号，敏感字段加密、接口脱敏。
- 在服务端重新加载商品、SKU、库存、促销、优惠券、地址和商城配送策略，输出可解释的最终 VND 报价。
- 以一次数据库事务创建 COD 订单、订单行与不可变快照，并把 M3 库存预留绑定到订单。
- 实现 COD `待确认 -> 确认有效 -> 待发货`、取消、关闭、库存释放/扣减与超时路径。
- 提供买家确认订单、订单列表/详情/取消和管理端查询、备注、标签、COD 确认与取消能力。
- 为 M5 线上支付和物流适配器留下稳定端口，但不伪造支付成功、运费供应商响应或物流单号。

### 1.2 非目标

- 不接入 Zalo Checkout、ZaloPay、VNPay、银行卡或任何真实支付回调；M4 只允许明确启用的 COD。
- 不接入 GHN、GHTK、Viettel Post 或其他物流商，不生成虚假运单、轨迹、预计送达时间或 COD 回款事实。
- 不实现退款、退货、换货、售后、分享、会员积分和报表；这些进入后续里程碑。
- 不修改 `REQUIREMENTS.md` 的商业规则，不使用生产凭据、生产数据库或外部发布环境。
- 不把客户端金额、库存、地址名称、订单状态或 `store_id` 当作可信事实。

## 2. 现状与边界决策

- M3 已提供购物车、促销/优惠券资格、整数 VND 报价和库存预留原语；购物车报价的
  `order_payable_vnd` 当前必须为 `null`，不能直接转成订单金额。
- M4 采用“提交 COD 订单时创建 ACTIVE 预留，人工/规则确认有效后 CONSUME”策略；
  待确认超时或取消执行 RELEASE/EXPIRE。确认后、发货前取消需要有审计的 RESTORE
  反向库存动作，不能改写原始消费流水。
- 运费和偏远地区附加费使用商城版本化配送策略（固定费用、免邮门槛、偏远省份代码、
  COD 开关和金额上限）计算。没有有效策略时结算明确失败，不填造零费用。
- 线上支付请求在 M4 返回稳定的“渠道未启用”错误且不创建订单；`PENDING_PAYMENT`
  只作为向 M5 兼容的状态枚举，不开放假支付成功路径。
- 地址省/市、区/县、坊/社使用商城维护的代码和名称快照。M4 不依赖实时行政区第三方
  服务；代码格式和层级一致性由服务端校验，正式上线前需补充越南权威数据复核。

## 3. 涉及模块与文件

### 3.1 数据库与领域

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/<timestamp>_m4_checkout_orders/`
- `packages/database/src/order-primitives.ts`
- `packages/domain/src/order.ts`、`packages/domain/src/address.ts`
- `packages/contracts/src/checkout.ts`、`packages/contracts/src/order.ts`、`packages/contracts/src/address.ts`
- `packages/security/src/index.ts`（复用现有 PII 加密和掩码边界，不新增明文存储）
- `packages/database/prisma/seed.ts`（只增加可识别的 local/test 配送策略，不创建真实订单）

### 3.2 API 与 worker

- `apps/api/src/checkout/`：结算重算和 COD 下单事务
- `apps/api/src/orders/`：买家订单查询/取消
- `apps/api/src/orders-admin/`：管理端查询、COD 确认、取消、备注和标签
- `apps/api/src/address/`：买家地址 CRUD、默认地址和字段脱敏
- `apps/api/src/app.module.ts`
- `apps/worker/src/orders/`：预留过期后订单关闭/补偿；与现有库存过期 worker 使用同一商城上下文

### 3.3 前端与文档

- `apps/mini-app/src/checkout-*`、`apps/mini-app/src/orders-*`、`apps/mini-app/src/address-*`
- `apps/admin-web/src/order-workbench.tsx` 及现有设计 token/i18n 复用
- `packages/i18n/src/index.ts`
- `docs/api/openapi.m4.yaml`
- `docs/database/m4-data-dictionary.md`
- `docs/architecture/system-architecture.md`
- `README.md`、`docs/reports/m4-completion-report.md`

## 4. 数据模型与不变量

所有新表使用 UUID 内部 ID、非空 `store_id`、同商城复合外键、强制 RLS、`timestamptz(6)`、
追加审计字段和 snake_case 数据库命名。金额使用非负 `bigint` VND，数量使用受限整数。

### 4.1 地址

`addresses` 至少包含：`store_id`、`member_id`、收货人密文、E.164 手机号密文及查重
HMAC、`province_code/name`、`district_code/name`、`ward_code/name`、详细地址密文、标签、
默认标记、版本、启用/软删除状态和时间戳。默认地址使用商城/会员范围的部分唯一约束。

API 只返回掩码手机号；订单快照不保存明文收货人、手机号或详细地址，使用版本化加密载荷
和可检索的非敏感行政区快照。地址只能由所属会员在所属商城读取和修改，不能通过换商城
请求访问。

### 4.2 商城配送与 COD 策略

新增商城范围的版本化配送策略表，至少包含固定运费、免邮门槛、偏远省份代码集合、COD
启用、COD 金额上限、版本和更新审计信息。后台修改使用乐观锁；订单保存接受时的完整策略
快照。策略缺失、停用或金额溢出时结算失败，不使用默认虚构值。

### 4.3 订单与快照

- `orders`：内部 ID、商城、会员、公开订单号、订单状态、支付方式/状态、币种、各项
  商品/优惠/运费/偏远附加费/运费优惠/应付金额、接受报价 hash、地址/政策快照引用、
  购物车引用、取消原因、确认/完成时间和版本。
- `order_items`：SKU/商品/品牌/类目内部引用及下单时名称、规格、单价、数量、商品小计、
  商品折扣、优惠券/订单优惠分摊、行应付和完整商品政策快照。历史行不得随目录修改。
- `order_snapshots`：地址、价格分解、配送策略、优惠券事实和政策版本的不可变快照；敏感
  地址载荷加密，报价和规则事实使用确定性 JSON/哈希。
- `order_transitions`：只追加的状态转换、操作者、原因、请求关联 ID、前后状态和时间。
- `idempotency_records`：商城、会员、操作名称、幂等键、规范请求 hash、响应快照和过期
  时间；同键不同 hash 返回冲突，同键重试返回第一次结果。

订单号只在商城内唯一，不能把前端订单号当作内部主键。订单创建、快照、幂等记录、购物车
转换、优惠券核销（M4 真实会员券事实）和库存预留绑定必须在同一事务内完成；任何失败整体
回滚。M3 的 `Cart` 由 `ACTIVE` 转为 `CONVERTED`，未选中的历史行不被静默删除。

### 4.4 订单状态机

| 场景         | 合法路径                                                   | 说明                                      |
| ------------ | ---------------------------------------------------------- | ----------------------------------------- |
| COD          | `PENDING_CONFIRMATION -> CONFIRMED -> PENDING_FULFILLMENT` | 确认有效时消费库存预留                    |
| 兼容线上支付 | `PENDING_PAYMENT`                                          | M4 不开放创建，M5 才接支付事实            |
| 取消         | `PENDING_CONFIRMATION -> CANCELLED`                        | RELEASE/EXPIRE 预留                       |
| 确认后取消   | `CONFIRMED/PENDING_FULFILLMENT -> CANCELLED`               | 仅发货前允许，追加 RESTORE 反向动作       |
| 关闭         | `PENDING_CONFIRMATION/PENDING_PAYMENT -> CLOSED`           | 超时或人工关闭；必须有原因                |
| 后续履约     | `SHIPPED -> DELIVERED -> COMPLETED`                        | M4 只保留兼容状态，不开放无物流事实的跳转 |

重复同事件返回首次结果；终态或非法跳转返回稳定错误码。任何状态写入必须通过状态机命令，
禁止控制器直接更新 `orders.status`。

## 5. 接口契约

- `GET/POST/PATCH/DELETE /v1/member/addresses`：地址列表、创建、乐观锁更新、软删除和默认
  地址切换；响应只返回脱敏字段。
- `POST /v1/checkout/quote`：提交选中的购物车行、地址 ID、优惠券码和期望支付方式；服务端
  重新加载所有事实并返回商品、优惠、运费、偏远附加费、运费优惠、最终应付、规则事实、
  策略版本和 `quote_hash`。客户端金额只作为非可信展示值。
- `POST /v1/checkout/orders`：要求 `Idempotency-Key`，只接受当前启用的 COD；服务端忽略或
  拒绝客户端价格、库存、商城和状态字段，事务创建订单并返回 `PENDING_CONFIRMATION`。
- `GET /v1/orders`、`GET /v1/orders/:orderId`、`POST /v1/orders/:orderId/cancel`：只能读取
  当前会员/商城订单，取消需校验状态和幂等键。
- `GET /v1/admin/orders`、`GET /v1/admin/orders/:orderId`、`POST .../confirm-cod`、
  `POST .../cancel`、`POST .../close`、`PATCH .../notes`：普通管理员必须具备目标商城
  权限；跨商城访问需要显式授权原因和审计。

公开响应不回显加密原文、完整地址密文、内部数据库 ID 以外的敏感凭据、支付密钥或库存
操作载荷。错误码至少区分 `QUOTE_STALE`、`ADDRESS_NOT_FOUND`、`COD_UNAVAILABLE`、
`ORDER_IDEMPOTENCY_CONFLICT`、`ORDER_STATE_CONFLICT`、`STOCK_INSUFFICIENT`、
`STORE_CONTEXT_INVALID` 和 `ORDER_NOT_FOUND`。

## 6. 事务、迁移与回滚

1. 迁移先创建枚举、表、复合外键、RLS/权限、唯一索引和 deferred 约束，再启用 API。
2. 订单创建事务按稳定 `(warehouse_id, sku_id)` 顺序锁库存余额；校验购物车版本、可售量、
   商品/促销/优惠券、地址归属、配送策略和 COD 风控后建立预留。
3. M3 预留 primitive 增加 `source_type=ORDER`、订单消费和取消反向 RESTORE 的稳定端口；
   不直接改写库存余额或历史流水。
4. 预留过期 worker 先完成库存终态，再以受保护命令把仍待确认/待支付订单关闭；冲突时保留
   失败计数和审计，下一轮重试，不删除订单或库存事实。
5. 所有生产/已有业务数据迁移只向前修复。`down.sql` 仅在无身份、审计、库存、订单事实
   的 fresh local/test scratch 数据库允许执行，并在存在订单事实时以 `55000` 拒绝。
6. 应用回滚可关闭 checkout/COD 路由并继续运行现有 M3 API；已创建订单由兼容 worker 处理，
   不通过回滚迁移删除订单、快照、状态转换或库存流水。

## 7. 风险、外部依赖与未决项

- 越南三级行政区主数据需要运营方确认权威版本；未确认前只允许 local/test 受控 fixture，
  staging/production 必须显式导入并记录来源版本。
- COD 风控阈值、确认 SLA、取消窗口、确认后取消是否允许 RESTORE 需要业务负责人确认；
  默认实现为商城策略可配置、确认前可取消、发货前取消可审计恢复库存。
- 真实物流运费和预计送达需要 M5 供应商契约；M4 的商城配送策略只能作为明确配置事实，
  不能被描述成供应商报价。
- 订单地址和政策快照的加密密钥轮换、保留期、管理员解密权限需安全/隐私复核；默认只在
  受授权的后台订单详情读取并写入审计。
- M4 不授权 Zalo 宿主真机支付、生产部署、远程 CI 或越南法律/税务专业签字。

## 8. 测试与验收

- 单元：地址规范化和三级关系、手机号 `+84/+86`、VND 结算公式、配送策略、订单状态机、
  幂等键、快照不可变性、COD 风控和权限判断。
- 集成：双商城 RLS/复合外键、地址越权、金额篡改、重复下单、并发锁库存、预留过期/释放/
  消费/恢复、优惠券核销、购物车转换和状态审计。
- API：认证、输入边界、错误码、重复请求、跨商城订单号、管理员范围和敏感字段脱敏。
- E2E：三语移动端地址管理 -> COD 结算 -> 重复点击只生成一单 -> 管理端确认 -> 买家订单
  查询/取消；覆盖空、加载、失败、库存不足和 COD 不可用状态。
- 质量门禁：受影响测试、`corepack pnpm verify`、集成测试、浏览器 E2E、生产依赖审计、
  Compose、fresh scratch 迁移升级/回滚门禁、`git diff --check` 和敏感信息扫描。

完成报告必须列出实际命令及结果、跨商城/RBAC/金额/库存/状态机/三语/移动端证据、差异审查、
未验证外部条件、回滚方法和 M5 前置条件。

## 9. 批准范围记录

用户批准表示同意：

- 新增地址、配送策略、订单、快照、状态转换和幂等数据模型及迁移；
- 仅在测试/受控环境启用 COD，服务端最终计算金额并绑定库存预留；
- M4 不接入真实线上支付、物流、退款、售后或生产环境；
- 任何偏离本计划的状态、金额、库存、权限或数据保留规则先更新计划并重新确认。
