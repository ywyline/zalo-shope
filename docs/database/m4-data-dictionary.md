# M4 地址、结算、订单与 COD 数据字典

> 状态：M4 已按批准计划实施；当前事实以本字典、迁移和 `docs/reports/m4-completion-report.md` 为准
>
> 日期：2026-07-23
>
> 依据：`REQUIREMENTS.md` 第 4、5、10、11、12、14、17、20、22、23、24 节与已批准的 `docs/plans/m4-implementation-plan.md`

## 1. 统一约定

- 所有 M4 业务表使用 UUID 内部主键、非空 `store_id`、snake_case 数据库名与 `timestamptz(6)`。
- 商城内实体提供 `UNIQUE (store_id, id)`；领域引用使用含 `store_id` 的复合外键。所有新商城表启用并强制 RLS，商城上下文缺失时默认拒绝。
- VND 金额使用非负 `bigint`，API 仅暴露 JavaScript 安全整数；数量、版本和状态均由数据库约束保护。
- 订单号、SKU code 和内部 UUID 分离；公开订单号仅在商城内唯一。
- 地址敏感字段与订单地址快照使用版本化密文；手机号查重使用 HMAC。API 不返回手机号明文，管理员读取订单地址也写审计。
- `order_items`、`order_snapshots` 和 `order_transitions` 只追加；订单状态只能通过受保护命令变更。
- M4 仅启用 COD。`ONLINE` 和 `PENDING_PAYMENT` 是 M5 兼容端口，不是已完成的支付集成。

## 2. 枚举与状态机

### 2.1 枚举

| 枚举                        | 值                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `address_status`            | `ACTIVE`、`DISABLED`                                                                                                                      |
| `administrative_area_level` | `PROVINCE`、`DISTRICT`、`WARD`；父子层级由数据库触发器与服务端共同校验                                                                    |
| `order_status`              | `PENDING_PAYMENT`、`PENDING_CONFIRMATION`、`CONFIRMED`、`PENDING_FULFILLMENT`、`SHIPPED`、`DELIVERED`、`COMPLETED`、`CANCELLED`、`CLOSED` |
| `order_payment_method`      | `COD`、`ONLINE`；M4 只创建 `COD`                                                                                                          |
| `order_payment_status`      | `PENDING`、`PROCESSING`、`SUCCEEDED`、`FAILED`、`EXPIRED`、`CANCELLED`；M4 COD 创建为 `PENDING`                                           |
| `order_snapshot_type`       | `ADDRESS`、`PRICING`、`DELIVERY_POLICY`、`COUPON`                                                                                         |
| `member_coupon_status` 扩展 | M4 增加 `USED`；只允许一次 `CLAIMED -> USED`                                                                                              |

### 2.2 M4 订单转换

| 命令/事实        | 前置状态                                   | 结果状态                                    | 库存动作                            |
| ---------------- | ------------------------------------------ | ------------------------------------------- | ----------------------------------- |
| COD 下单         | 无订单                                     | `PENDING_CONFIRMATION`                      | 创建 `ACTIVE` 预留                  |
| 确认 COD         | `PENDING_CONFIRMATION`                     | 依次记录 `CONFIRMED`、`PENDING_FULFILLMENT` | `CONSUME` 预留，仅一次              |
| 买家取消         | `PENDING_CONFIRMATION`                     | `CANCELLED`                                 | `RELEASE` 预留，仅一次              |
| 管理员取消待确认 | `PENDING_CONFIRMATION`                     | `CANCELLED`                                 | `RELEASE` 预留，仅一次              |
| 管理员取消待履约 | `PENDING_FULFILLMENT`                      | `CANCELLED`                                 | 追加 `RESTORE` 反向库存动作，仅一次 |
| 关闭             | `PENDING_CONFIRMATION` / `PENDING_PAYMENT` | `CLOSED`                                    | 有活动预留时 `RELEASE`              |
| 预留超时 worker  | 预留终态 + 待确认订单                      | `CLOSED`                                    | 先完成 `EXPIRE/RELEASE`，再推进订单 |

`SHIPPED -> DELIVERED -> COMPLETED` 仅保留领域枚举，M4 没有物流事实时不开放对应 API。重复的同一终态命令返回当前结果；其他非法跳转返回 `ORDER_STATE_CONFLICT`。

## 3. 配送策略与地址

### 3.1 `administrative_areas`

| 字段                        | 类型         | 空值/默认 | 约束与说明                                            |
| --------------------------- | ------------ | --------- | ----------------------------------------------------- |
| `id` / `store_id`           | uuid         | 非空      | 商城复合唯一并强制 RLS                                |
| `code`                      | varchar(32)  | 非空      | `UNIQUE(store_id, code)`；规范小写 code               |
| `level`                     | enum         | 非空      | 省/市、区/县、坊/社                                   |
| `parent_code`               | varchar(32)  | 省级为空  | 同商城自引用；区级父项必须为省级，坊/社父项必须为区级 |
| `name`                      | varchar(160) | 非空      | 服务端权威展示名；创建地址时覆盖客户端兼容名称字段    |
| `enabled`                   | boolean      | `true`    | 仅已启用且完整父链可用于地址和偏远省份策略            |
| `source_version`            | varchar(128) | 非空      | 行政区数据来源版本；生产导入必须记录并经运营复核      |
| `created_at` / `updated_at` | timestamptz  | `now()`   | 审计时间                                              |

runtime 角色只有 `SELECT` 权限；管理导入走受控 owner/迁移流程。API 只按当前认证商城列出行政区，创建/更新地址时重新验证省 -> 区 -> 坊父链。商城没有有效主数据时地址写入稳定失败，不回退到客户端自报代码。

### 3.2 `store_delivery_policies`

| 字段                          | 类型        | 空值/默认 | 约束与说明                                |
| ----------------------------- | ----------- | --------- | ----------------------------------------- |
| `id` / `store_id`             | uuid        | 非空      | 每商城一条；同商城复合唯一                |
| `version`                     | integer     | `1`       | `>= 1`；管理端 `expected_version` 乐观锁  |
| `enabled`                     | boolean     | `true`    | 停用时结算返回策略不可用                  |
| `flat_shipping_fee_vnd`       | bigint      | 非空      | 固定配送费，非负整数 VND                  |
| `free_shipping_threshold_vnd` | bigint      | 可空      | 达到商品应付门槛时抵扣配送费              |
| `remote_surcharge_vnd`        | bigint      | `0`       | 偏远地区附加费                            |
| `remote_province_codes`       | text[]      | 空数组    | 受控省/市 code 集合，结算按地址 code 匹配 |
| `cod_enabled`                 | boolean     | `true`    | 商城 COD 总开关                           |
| `cod_max_amount_vnd`          | bigint      | 可空      | COD 订单应付上限                          |
| `updated_by_admin_id`         | uuid        | 可空      | 最近更新管理员                            |
| `created_at` / `updated_at`   | timestamptz | `now()`   | 审计时间                                  |

生产与 staging 必须导入并复核越南权威行政区主数据后才可启用策略；local/test 种子中的代码只用于受控测试，不是权威数据集或物流商报价。

`remote_province_codes` 更新时必须全部命中同商城已启用的 `PROVINCE` 事实，防止错误配置或客户端地址绕过附加费。

### 3.3 `addresses`

| 字段                            | 类型            | 空值/默认 | 约束与说明                                                    |
| ------------------------------- | --------------- | --------- | ------------------------------------------------------------- |
| `id` / `store_id` / `member_id` | uuid            | 非空      | 会员复合 FK，禁止跨商城引用                                   |
| `recipient_name_ciphertext`     | text            | 非空      | 收货人密文                                                    |
| `phone_hash`                    | varchar(128)    | 非空      | 规范 E.164 的 HMAC；`UNIQUE(store_id, member_id, phone_hash)` |
| `phone_ciphertext`              | text            | 非空      | 越南/中国大陆移动号密文                                       |
| `province_code/name`            | varchar(32/160) | 非空      | 已验证省/市代码和服务端主数据当时名称                         |
| `district_code/name`            | varchar(32/160) | 非空      | 已验证区/县代码和服务端主数据当时名称                         |
| `ward_code/name`                | varchar(32/160) | 非空      | 已验证坊/社代码和服务端主数据当时名称                         |
| `detail_ciphertext`             | text            | 非空      | 详细地址密文                                                  |
| `label`                         | varchar(64)     | 可空      | 用户标签                                                      |
| `is_default`                    | boolean         | `false`   | 每商城/会员至多一个活动默认地址                               |
| `status`                        | enum            | `ACTIVE`  | 删除转为 `DISABLED`，不物理删除                               |
| `version`                       | integer         | `1`       | 乐观锁；默认地址切换也递增受影响版本                          |
| `created_at` / `updated_at`     | timestamptz     | `now()`   | 审计时间                                                      |

## 4. 订单聚合

### 4.1 `orders`

| 字段组    | 关键字段                                                                              | 约束与说明                                         |
| --------- | ------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 归属      | `id`、`store_id`、`member_id`                                                         | 同商城会员复合 FK；RLS 强制隔离                    |
| 来源      | `cart_id`、`address_id`、`reservation_id`                                             | 全部同商城复合 FK；每预留最多绑定一单              |
| 标识      | `order_number`                                                                        | `UNIQUE(store_id, order_number)`；不作为内部主键   |
| 状态      | `status`、`payment_method`、`payment_status`、`currency`                              | `currency='VND'`；M4 只创建 COD/PENDING            |
| 商品金额  | `base_subtotal_vnd`、`item_discount_vnd`、`coupon_discount_vnd`、`order_discount_vnd` | 非负整数 VND，由服务端重算                         |
| 配送金额  | `shipping_fee_vnd`、`remote_surcharge_vnd`、`shipping_discount_vnd`                   | 非负整数 VND，来自接受时策略                       |
| 总额      | `payable_vnd`                                                                         | `商品小计 - 各折扣 + 运费 + 偏远附加费 - 运费优惠` |
| 接受事实  | `quote_hash`                                                                          | 64 位 SHA-256；订单创建时重新计算并匹配            |
| 运营      | `cancellation_reason`、`admin_note`、`tags`                                           | 长度受限；备注/标签更新写审计                      |
| 并发/时间 | `version`、`confirmed_at`、`cancelled_at`、`closed_at`、`created_at`、`updated_at`    | 订单行锁和版本保护并发命令                         |

索引：会员时间线 `(store_id, member_id, created_at DESC, id DESC)`、运营状态 `(store_id, status, created_at DESC, id DESC)`。

### 4.2 `order_items`

| 字段组   | 字段                                                                      | 说明                       |
| -------- | ------------------------------------------------------------------------- | -------------------------- |
| 引用     | `store_id`、`order_id`、`sku_id`、`product_id`、`brand_id`、`category_id` | 全部同商城复合 FK          |
| 目录快照 | `sku_code`、`product_name`、`brand_name`、`option_snapshot`               | 订单历史不随目录修改       |
| 金额     | `unit_price_vnd`、`quantity`、`subtotal_vnd`、三类折扣、`payable_vnd`     | 非负且 `quantity > 0`      |
| 审计     | `created_at`                                                              | 行创建后拒绝 UPDATE/DELETE |

### 4.3 `order_snapshots`

`(store_id, order_id, snapshot_type)` 唯一。`payload` 必须为 JSON object，`payload_hash` 为规范 JSON 的 SHA-256。地址载荷中的收货人、手机号、详细地址是密文；API 只在受授权场景解密并对手机号掩码。快照创建后拒绝 UPDATE/DELETE。

### 4.4 `order_transitions`

记录 `from_status`、`to_status`、`event`、`reason`、`actor_type/id`、`correlation_id` 和 `created_at`。它是只追加状态时间线，不允许用更新历史行修正状态；修正必须追加受审命令。

### 4.5 `idempotency_records`

| 字段                                | 说明                                           |
| ----------------------------------- | ---------------------------------------------- |
| `store_id`、`member_id`、`order_id` | 商城、主体和首次结果归属                       |
| `operation`、`idempotency_key`      | `UNIQUE(store_id, operation, idempotency_key)` |
| `request_hash`                      | 规范请求 SHA-256；同键不同 hash 冲突           |
| `response`                          | 首次成功的脱敏响应快照                         |
| `expires_at`、`created_at`          | 有限保留与清理依据；清理不能删除订单事实       |

下单前按商城、会员、幂等键获取 advisory lock；确定性订单 UUID 和数据库唯一键共同处理并发重试。PostgreSQL `40001`/`40P01` 与 Prisma `P2028`/`P2034` 进入有限串行化重试，耗尽后返回稳定并发冲突。

## 5. M3 库存、购物车与优惠券扩展

- `inventory_reservations.source_type/source_id` 绑定 `ORDER` 与订单 ID；`orders.reservation_id` 使用同商城复合 FK 和唯一索引。
- 新增事务内库存原语 `adjustInventoryInTransaction`、`consumeReservationInTransaction`、`releaseReservationInTransaction`，公开包装函数保持兼容。
- 匹配当前选择事实的 `ACTIVE` 购物车在订单事务内转为 `CONVERTED`；未选历史行不被删除。
- `member_coupons` 增加 `used_at`、`used_order_id` 和 `USED` 状态；`used_order_id` 同商城引用订单并唯一。
- M3.7 的完全不可更新门禁会阻止真实核销，因此 `20260723130000_m4_coupon_redemption_guard` 以前向修复把门禁收窄为一次且完整的 `CLAIMED -> USED`。运行角色只获得 `status`、`used_at`、`used_order_id`、`updated_at` 的列级 UPDATE；身份、领取时间、商城、会员和券引用仍不可变，DELETE 仍拒绝。

## 6. RLS、权限与审计

- M4 新表全部 `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`，策略同时限制 `USING` 与 `WITH CHECK` 为 `app_security.current_store_id()`。
- `20260723140000_m4_permission_catalog` 只登记 `store.orders.read/manage` 与 `store.delivery.read/manage`，不自动给生产角色扩权；local/test 种子显式授权系统 `store-admin`。
- 管理员订单详情解密地址前写 `order.delivery-address.read` 审计；COD 确认、取消、关闭、备注和配送策略更新均记录商城、操作者、对象、前后事实或结果。
- 普通管理员逐商城授权；不存在无审计的跨商城读取或运行角色 RLS bypass。

## 7. 迁移、兼容与回滚

迁移顺序：

1. `20260723100000_m4_checkout_orders`：核心枚举、表、复合约束、RLS、追加写保护。
2. `20260723110000_m4_order_reservation_binding`：订单与库存预留双向绑定。
3. `20260723120000_m4_checkout_atomicity`：订单版本与会员券核销字段/复合 FK。
4. `20260723130000_m4_coupon_redemption_guard`：一次性核销门禁和最小列级权限。
5. `20260723140000_m4_permission_catalog`：只登记 M4 管理权限目录。

`down.sql` 仅允许在无真实身份、审计、地址、订单、预留绑定或优惠券核销事实的 local/test scratch 数据库人工执行；检测到订单、地址或 `USED` 会员券时以 SQLSTATE `55000` 拒绝。生产和已有事实环境只允许向前修复。应用回滚可关闭 checkout/COD 路由并保留 schema、订单和 worker 兼容处理，不能删除或改写业务事实。
