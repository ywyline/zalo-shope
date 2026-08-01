# M5 支付、退款、物流与可靠消息数据字典

> 状态：M5.1 契约已冻结；M5.2-M5.7 数据、可靠消息、支付、退款与 GHN 仓库自动化已实施，真实供应商验收未完成
>
> 日期：2026-07-26
>
> 供应商：ZaloPay（通过 Zalo Checkout）、GHN；两个商城独立渠道配置

## 1. 统一约定

- 所有商城业务表包含 `store_id uuid NOT NULL`、`UNIQUE (store_id, id)`，领域引用使用带
  `store_id` 的复合外键。所有新商城表启用并强制 RLS；没有事务级商城上下文时默认拒绝。
- 金额使用非负 `bigint` VND；API 只接受和返回 JavaScript 安全整数。货币字段固定 `VND`，
  不进行隐式货币或最小单位换算。
- 内部 UUID、面向用户的支付/退款/运单号和供应商引用分离。供应商引用按渠道账户和环境唯一，
  不允许仅凭供应商单号绕过商城归属。
- `*_transitions`、回调、轨迹、outbox 和 inbox 是只追加事实；状态字段只能由受保护领域命令
  更新。运行角色撤销这些历史表的 `UPDATE/DELETE`。
- 商户密钥、Zalo Checkout Private Key、ZaloPay Key 1/Key 2、GHN Token 不写业务表。数据库只
  保存部署密钥系统的 secret reference、不可逆指纹和版本；API、审计和日志从不返回密钥。
- 供应商原始请求/响应先执行字段 allowlist 和敏感值清除。确需保留的原文使用独立加密载荷和
  有限保留期；授权 Header、密钥、完整手机号/地址和支付授权数据不得进入普通 JSON 或日志。
- 时间使用 `timestamptz` UTC 保存，展示按商城 `Asia/Ho_Chi_Minh`；业务日期另存越南时区日期。
- M5.2 已按以下契约实施 Prisma、SQL、索引、强制 RLS、权限和回滚门禁。M5.3 及以后只能在
  此边界上新增可靠 worker、运行时服务和不改变业务模型的向前约束加固，不能绕过数据库不变量。

## 2. 官方契约基线

| 外部能力                | 冻结来源                                                                                                                                          | 2026-07-24 核验结论                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zalo Checkout 配置      | `https://docs.zaloplatforms.com/docs/MA/checkoutSdk/integration-process/overview/setting`                                                         | 页面标记最后更新 2026-06-15；通用配置含 Callback URL、Private Key 和 HmacSHA256；ZaloPay 配置含 Merchant App ID、Key 1、Key 2                                                       |
| ZaloPay 方法 code       | `https://docs.zaloplatforms.com/docs/MA/checkoutSdk/method`                                                                                       | sandbox=`ZALOPAY_SANDBOX`，production=`ZALOPAY`；页面标记最后更新 2026-06-15                                                                                                        |
| Checkout 创建支付       | `https://docs.zaloplatforms.com/docs/MA/checkoutSdk/apis/createOrder`                                                                             | ZMP SDK 2.45.0 起必须传服务端生成的 MAC；`extradata`、`method` 以 JSON String 传入，`item` 数组以 JSON String 参与 MAC；method 为 `{id,isCustom}`；当前项目 SDK 2.51.8 满足最低版本 |
| Checkout 回调/查单      | `https://docs.zaloplatforms.com/docs/MA/checkoutSdk/webhooks/callback`、`https://docs.zaloplatforms.com/docs/MA/checkoutSdk/apis/getOrderStatus`  | 回调用 Private Key 校验 `mac/overallMac`；无回调 20 分钟后主动查单；查单返回 amount、method、transId、merchantTransId、extradata 和处理状态                                         |
| Checkout 退款           | `https://docs.zaloplatforms.com/docs/MA/checkoutSdk/apis/createRefund`、`https://docs.zaloplatforms.com/docs/MA/checkoutSdk/apis/getRefundStatus` | ZaloPay 支持全额/部分退款；服务端主动调用并查询处理中退款；最终能力仍受商户协议约束                                                                                                 |
| GHN 报价/服务/时效      | `https://api.ghn.vn/home/docs/detail?id=76`、`id=77`、`id=52`                                                                                     | sandbox origin=`https://dev-online-gateway.ghn.vn`；请求使用商城独立 Token/ShopId；重量为 gram，地址使用 GHN district/ward code                                                     |
| GHN 建单/查单/取消/面单 | `https://api.ghn.vn/home/docs/detail?id=123`、`id=66`、`id=73`、`id=67`                                                                           | `client_order_code` 是调用方唯一幂等引用；面单 token 官方说明有效 30 分钟；供应商 `order_code` 与内部 ID 分离                                                                       |
| GHN webhook/状态        | `https://api.ghn.vn/home/docs/detail?id=47`、`id=48`                                                                                              | webhook 文档说明非 200 会以 5 秒间隔重试 10 次，但未声明签名字段；因此回调只能作为未验证同步提示，必须主动查单后才形成权威状态事实                                                  |

官方文档未来发生字段、端点、签名、状态或安全变化时，先更新本字典和契约测试，不允许适配器
静默接受未知成功状态。GHN 示例页面出现的 Token、手机号和地址仅属于官方示例，不复制进
仓库、测试快照或日志。

## 3. 枚举与状态机

### 3.1 渠道

- `integration_environment`：`SANDBOX | PRODUCTION`。本地/test/staging 只能绑定 `SANDBOX`；
  production 是否启用生产渠道由独立上线门禁控制。
- `integration_channel_status`：`DISABLED | ACTIVE | SUSPENDED`。新记录默认 `DISABLED`。
- `payment_provider_code`：M5 只允许 `ZALO_CHECKOUT_ZALOPAY`。
- `shipping_provider_code`：M5 只允许 `GHN`。

### 3.2 支付尝试

`payment_attempt_status`：`CREATED | PROVIDER_PENDING | SUCCEEDED | FAILED | EXPIRED |
CANCELLED | REVIEW_REQUIRED`。

| 标准事件             | 前置                       | 结果                | 说明                                        |
| -------------------- | -------------------------- | ------------------- | ------------------------------------------- |
| `PROVIDER_ACCEPTED`  | `CREATED`                  | `PROVIDER_PENDING`  | 已生成/绑定 Checkout order，尚无成功事实    |
| `PROVIDER_SUCCEEDED` | `CREATED/PROVIDER_PENDING` | `SUCCEEDED`         | 只接受验签回调或主动查单且全部事实匹配      |
| `PROVIDER_FAILED`    | `CREATED/PROVIDER_PENDING` | `FAILED`            | 未知 code 不映射为失败或成功，进入复核      |
| `EXPIRE/CANCEL`      | `CREATED/PROVIDER_PENDING` | `EXPIRED/CANCELLED` | 与订单关闭及库存释放在受保护事务中协调      |
| `LATE_SUCCESS`       | `FAILED/EXPIRED/CANCELLED` | `REVIEW_REQUIRED`   | 不复活订单、不消费库存；按批准策略查单/退款 |
| `REQUIRE_REVIEW`     | 非成功活动/失败状态        | `REVIEW_REQUIRED`   | 金额、商城、未知状态或竞态异常              |

重复的同一供应商成功事件由 callback/inbox 唯一约束返回首次处理结果，不再次执行状态转换或
库存动作。首次合法成功在同一事务内：支付尝试成功、库存预留 `CONSUME` 一次、订单
`PENDING_PAYMENT -> CONFIRMED -> PENDING_FULFILLMENT` 两次显式转换、outbox 和审计事实一起
提交。

### 3.3 退款

`refund_status`：`REQUESTED | PROCESSING | SUCCEEDED | FAILED | CANCELLED | REVIEW_REQUIRED`。

- `REQUESTED -> PROCESSING/SUCCEEDED/FAILED/CANCELLED/REVIEW_REQUIRED`；
  `PROCESSING -> SUCCEEDED/FAILED/REVIEW_REQUIRED`；成功和取消不回退。
- 同一支付尝试的 `SUCCEEDED + REQUESTED + PROCESSING` 退款金额之和不得超过成功支付金额。
  应用行锁和数据库延迟约束/受保护函数共同防止并发超额。
- M5 退款成功只更新支付聚合投影为 `PARTIALLY_REFUNDED/FULLY_REFUNDED`，不自动恢复库存、
  完成售后或改变物流事实。M6 售后命令再决定库存恢复。

### 3.4 运单

`shipment_status`：`CREATION_PENDING | PENDING_PICKUP | IN_TRANSIT | OUT_FOR_DELIVERY |
DELIVERED | REFUSED | RETURNING | RETURNED | EXCEPTION | CANCELLED | REVIEW_REQUIRED`。

- 建单请求先记录 `CREATION_PENDING`，GHN 成功返回 `order_code` 后进入 `PENDING_PICKUP`。
- `IN_TRANSIT/OUT_FOR_DELIVERY` 可触发一次订单 `SHIP`；`DELIVERED` 在必要时按顺序补记
  `SHIP` 后触发 `DELIVER`。重复供应商里程碑幂等。
- `REFUSED/RETURNING/RETURNED/EXCEPTION` 不自动完成、退款或恢复库存。
- 供应商跳过中间里程碑可以接受，但 `DELIVERED/RETURNED/CANCELLED` 的倒退状态拒绝并进入
  复核。未知 GHN 状态记录原始 code，标准状态不变并告警。

GHN M5.1 映射：

| GHN 状态                                                            | 内部状态           |
| ------------------------------------------------------------------- | ------------------ |
| `ready_to_pick/picking/money_collect_picking`                       | `PENDING_PICKUP`   |
| `picked/storing/transporting/sorting`                               | `IN_TRANSIT`       |
| `delivering/money_collect_delivering`                               | `OUT_FOR_DELIVERY` |
| `delivered`                                                         | `DELIVERED`        |
| `delivery_fail/waiting_to_return/return_fail/exception/damage/lost` | `EXCEPTION`        |
| `return/return_transporting/return_sorting/returning`               | `RETURNING`        |
| `returned`                                                          | `RETURNED`         |
| `cancel`                                                            | `CANCELLED`        |

`delivery_fail` 不等于买家明确拒收；只有经 GHN reason code、客服事实或后续售后确认才能形成
内部 `REFUSED`。

## 4. 商城渠道配置

### 4.1 `store_payment_channels`

| 字段                             | 类型/空值                       | 约束与说明                                                     |
| -------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| `id/store_id`                    | uuid，非空                      | `UNIQUE(store_id,id)`；强制 RLS                                |
| `deployment_environment`         | 现有 enum，非空                 | 与 `(store_id, environment)` 的 `store_zalo_apps` 复合引用一致 |
| `provider_environment`           | integration enum，非空          | 非 production 部署只能为 `SANDBOX`                             |
| `provider_code`                  | payment provider enum，非空     | M5 固定 `ZALO_CHECKOUT_ZALOPAY`                                |
| `method_code`                    | varchar(64)，非空               | sandbox 固定 `ZALOPAY_SANDBOX`；production 固定 `ZALOPAY`      |
| `checkout_app_id`                | varchar(128)，非空              | 必须等于同商城/环境启用的 Mini App ID，不从客户端读取          |
| `merchant_reference`             | varchar(160)，可空              | 公开/脱敏 ZaloPay Merchant App ID 引用，不是密钥               |
| `private_key_secret_ref`         | varchar(512)，非空              | Zalo Checkout Private Key 的部署密钥引用；禁止回显             |
| `secret_fingerprint/key_version` | varchar，非空                   | 轮换审计与 callback 双版本窗口；不可用于还原密钥               |
| `status`                         | channel status，默认 `DISABLED` | 启用前需配置预检和审计                                         |
| `payment_window_seconds`         | int，非空                       | 受配置范围约束；不能长于库存预留窗口                           |
| `version/timestamps`             | int/timestamptz                 | 乐观锁和审计时间                                               |

唯一：`(store_id, deployment_environment, provider_code)` 与 `(checkout_app_id, method_code)`；
后者保证无认证 callback 在设置 RLS 商城上下文前只能定位一个候选渠道。`checkout_app_id` 在同部署
环境全局唯一继续由 `store_zalo_apps` 保证。两个商城即使共享法人，也必须是两条独立记录和
secret reference。

### 4.2 `store_shipping_channels`

| 字段                                 | 类型/空值                       | 约束与说明                                                              |
| ------------------------------------ | ------------------------------- | ----------------------------------------------------------------------- |
| `id/store_id`                        | uuid，非空                      | 商城复合唯一；强制 RLS                                                  |
| `provider_environment/provider_code` | enum，非空                      | M5 为 `SANDBOX/GHN`，生产启用另行门禁                                   |
| `shop_id`                            | varchar(64)，非空               | GHN ShopId；按环境唯一解析商城回调提示                                  |
| `token_secret_ref`                   | varchar(512)，非空              | GHN Token 部署密钥引用；不回显                                          |
| `secret_fingerprint/key_version`     | varchar，非空                   | 轮换、预检和审计                                                        |
| `status`                             | channel status，默认 `DISABLED` | 新建禁用                                                                |
| `origin_allowlist_key`               | varchar(64)，非空               | 只能选择代码内固定 GHN sandbox/production origin，禁止自由 URL/SSRF     |
| `default_service_code`               | varchar(64)，可空               | 内部稳定服务 code；运行时解析 GHN service id/type id                    |
| `webhook_path_token_hash`            | bytea，可空                     | 可选高熵路径 token 的 hash，只是附加防护，不使 GHN webhook 成为权威事实 |
| `version/timestamps`                 | int/timestamptz                 | 乐观锁和审计                                                            |

唯一：`(store_id, provider_environment, provider_code)` 和
`(provider_environment, provider_code, shop_id)`。商城仓库/退货地址仍从 M3/M4 可信数据读取。

## 5. 支付与退款聚合

### 5.1 `payment_attempts`

| 字段组        | 关键字段                                                                 | 约束与说明                                                                           |
| ------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 身份          | `id/store_id/order_id/channel_id/public_payment_number/attempt_sequence` | 订单和渠道使用商城复合 FK；同订单 sequence 唯一；公开号全局唯一                      |
| 金额          | `amount_vnd/currency`                                                    | 正整数安全范围；`currency='VND'`；等于订单应付快照                                   |
| 状态          | `status/version/expires_at`                                              | 显式状态机、乐观锁；一个订单最多一个 `CREATED/PROVIDER_PENDING` 活动尝试             |
| Checkout 绑定 | `launch_nonce_hash/launch_payload_hash/provider_order_id`                | nonce 只保存 hash；provider order 可空直至 Mini App createOrder 返回；同渠道环境唯一 |
| 供应商事实    | `provider_transaction_id/provider_status/provider_occurred_at`           | 成功时 transaction id 非空；供应商状态只是原始 code                                  |
| 结果时间      | `succeeded_at/failed_at/cancelled_at/expired_at/review_required_at`      | 与状态匹配的 CHECK/触发器                                                            |
| 幂等审计      | `create_idempotency_key_hash/correlation_id/created_at/updated_at`       | 不保存原始高熵幂等键                                                                 |

Zalo Checkout `createOrder` 在 Mini App 内产生 `orderId`，不是服务端预先生成。服务端返回的短期
launch token 绑定商城、会员、内部订单、支付尝试、金额、过期时间和 nonce；客户端回传
`provider_order_id + launch_token` 只作为绑定/查单提示。服务端随后调用 `getOrderStatus`，并
验证响应 `amount/method/extradata`。`extradata` 必须精确包含服务端签名的 attempt ID、内部订单
引用和 nonce；未完成这些校验的客户端绑定不能形成成功事实。

索引：订单时间线、活动尝试部分唯一、待查单/过期 worker、供应商订单/交易引用、运营状态。

### 5.2 `payment_transitions`

`id/store_id/payment_attempt_id/from_status/to_status/event/source/provider_event_id/actor_type/
actor_id/reason/correlation_id/created_at`。只追加；`source` 区分 `MEMBER/ADMIN/WEBHOOK/QUERY/
RECONCILIATION/SYSTEM`。供应商 payload 不进入 reason。

### 5.3 `provider_callbacks`

记录 `id/store_id/channel_kind/channel_id/provider/environment/external_event_id/event_digest/
received_at/signature_status/trust/processing_status/payload_ciphertext_ref/payload_digest/
attempt_count/next_attempt_at/last_error_code/completed_at/version`。

- Zalo Checkout 先按原始字段校验 `mac`；存在 `method/extradata` 时同时校验覆盖全部字段且按键
  字典序生成的 `overallMac`。使用对应商城/环境 Private Key 和恒定时间比较；校验前不信任
  app/order/amount。
- `appId` 只用于定位候选渠道；成功处理前仍核对渠道、商城、provider order、VND 金额和订单。
- M5.5 的 `app_security.resolve_payment_callback_channel(appId, method)` 是最小 `SECURITY DEFINER`
  路由函数，只向 runtime 返回单一商城的渠道解析字段；函数不返回密钥，Private Key 仍由部署
  secret reference resolver 读取。函数返回零行或多行均失败关闭，不回显候选商城。
- GHN callback 没有官方签名契约，`signature_status=NOT_AVAILABLE`、
  `trust=UNVERIFIED_HINT`。仅用 ShopID/order code 定位候选运单并追加同步 outbox；主动查单
  返回才可创建权威轨迹/状态。
- 去重优先使用稳定外部 event/transaction ID；缺少时使用渠道、环境和规范化原文摘要。摘要
  不替代业务状态幂等。

### 5.4 `refunds` 与 `refund_transitions`

`refunds` 保存 `id/store_id/order_id/payment_attempt_id/public_refund_number/amount_vnd/status/
version/reason/requested_by/provider_refund_id/provider_status/idempotency_key_hash/requested_at/
succeeded_at/failed_at/review_required_at/timestamps`。同支付行锁计算可退款余额；公开退款号全局
唯一，供应商退款引用按渠道环境唯一。

`refund_transitions` 结构同支付转换且只追加。失败可由新的受审幂等命令重试，不能覆盖或删除
首次退款事实。

M5.7 运行时创建退款时先锁定订单、成功支付尝试和既有退款事实，重算
`REQUESTED + PROCESSING + SUCCEEDED + REVIEW_REQUIRED` 占用金额；人工复核表示供应商结果
仍可能成功，在受审解决前不得释放容量。退款、初始转换、脱敏审计和
`refund.create.requested.v1` outbox 在同一 Serializable 事务提交。商城/支付范围的
`Idempotency-Key` 只保存 SHA-256，重复同键同金额/原因返回首次事实，异参冲突。

Zalo Checkout 官方退款创建接口未提供可传递的供应商幂等键，因此 create outbox 的
`max_attempts=1`。超时、断连、无效/不一致响应等“可能已受理”结果进入 `REVIEW_REQUIRED`，
禁止自动再次创建供应商退款且继续占用可退款容量；只有已取得 `provider_refund_id` 的
`PROCESSING` 事实才允许通过
`refund.query.requested.v1` 有限主动查询。成功事实单调，迟到失败或供应商引用碰撞不能覆盖。

## 6. 物流聚合

### 6.0 `warehouse_fulfillment_profiles` 与订单物理快照

`warehouse_fulfillment_profiles` 以 `(store_id,warehouse_id)` 为主键，保存联系人、电话、详细地址
密文，服务端解析的省/区/坊 code 与名称、启用状态、版本、更新管理员和时间戳。仓库、三级行政区
均通过同商城复合外键绑定，表强制 RLS；普通仓库读取只返回是否配置、地区、启用状态和版本，
不回显联系人、电话、详细地址密文或原文。创建/替换资料需要 `store.inventory.manage`、近期 MFA、
expected version、输入式确认并写脱敏审计。

`order_items` 增加 `weight_grams/length_millimeters/width_millimeters/height_millimeters` 四项可空
历史快照。M5.6 后的新订单在服务端从 SKU 复制完整正整数物理属性，任一缺失即以
`SKU_PHYSICAL_PROFILE_INCOMPLETE` 阻断结算；旧订单保持空值且不得用当前可变 SKU 或管理员请求
伪造回填。建单时重量按行重量乘数量求和，尺寸按当前单包裹保守规则生成不可变 parcel snapshot。

### 6.1 `shipping_quotes`

保存 `id/store_id/order_id/channel_id/request_hash/service_code/provider_service_id/
provider_service_type_id/base_fee_vnd/insurance_fee_vnd/cod_fee_vnd/remote_fee_vnd/
other_fee_vnd/total_fee_vnd/estimated_delivery_at/provider_quote_ref/source/expires_at/created_at`。

- 地址、仓库、重量/尺寸、COD 和服务从服务端事实计算 request hash；请求体不能提交金额。
- GHN 响应费用逐项使用整数 VND：`service_fee` 为基础费，保险费与 COD 费独立保存，揽收/派送
  偏远地区费合并为 `remote_fee_vnd`，其余已知附加费合并为 `other_fee_vnd`。`total_fee_vnd`
  必须等于五项非负安全整数之和；显式 `null`、负数、小数、无法表达的 coupon 折扣或总额不一致
  均失败关闭，不把总额冒充基础费。
- 结算采用的 quote/source/过期时间写入 M4 订单快照。过期后下单必须重新报价。

### 6.2 `shipments` 与 `shipment_items`

`shipments` 保存 `id/store_id/order_id/warehouse_id/channel_id/public_shipment_number/status/version/
client_order_code/provider_shipment_id/service_code/provider_service_id/provider_service_type_id/
cod_amount_vnd/address_snapshot_ciphertext/parcel_snapshot/label_metadata/created_operation_id/
cancelled_operation_id/provider_created_at/picked_up_at/delivered_at/returned_at/timestamps`。

- `client_order_code` 使用内部运单公开号且在 GHN 商城账户内唯一；重试建单必须复用，利用 GHN
  官方幂等返回已有订单。
- M5 API 强制同订单最多一个活动运单并覆盖全部可履约数量。`shipment_items` 仍以
  `store_id/shipment_id/order_item_id/quantity` 复合约束保留未来拆单能力。
- provider shipment/order code 只能来自 GHN 主动响应/查单，不能来自管理员请求。
- 地址/包裹快照不可变；普通读返回掩码，不把完整地址或手机号写入日志/审计 diff。

### 6.3 `tracking_events` 与 `shipping_operations`

`tracking_events` 保存 `id/store_id/shipment_id/provider_event_key/status/provider_status/reason_code/
message_key/location_masked/occurred_at/received_at/source/payload_ciphertext_ref`。同运单 provider event
key 唯一且只追加；三语界面通过内部 `message_key` 翻译，不直接展示未审供应商文案。

`shipping_operations` 保存报价、建单、取消、查单、面单和人工补偿命令的
`operation_type/idempotency_key_hash/request_hash/status/attempt_count/next_attempt_at/error_code/
correlation_id/version/timestamps`。建单/取消不能靠覆盖 shipment 来表示重试。

## 7. Outbox 与 Inbox

### 7.1 `outbox_messages`

字段：`id/store_id/aggregate_type/aggregate_id/event_type/event_version/idempotency_key/payload/
status/available_at/lease_owner/lease_expires_at/attempt_count/max_attempts/last_error_code/
completed_at/version/timestamps`。

- 同业务命令 event key 唯一；payload 只含内部 ID、store_id 和版本，不含密钥、完整 PII 或
  supplier auth。
- worker 使用 `FOR UPDATE SKIP LOCKED` 获取短租约；失败按分类退避，达到上限为 `DEAD_LETTER`，
  不删除消息。
- `event_type + event_version` 明确版本；消费者支持当前和上一部署版本以满足应用回滚。
- M5.3 规定 `event_type` 不携带版本后缀，版本只写 `event_version`；注册键为二者组合。追加原语
  要求 payload 是不超过 16 KiB 的普通 JSON object，`payload.store_id` 必须等于行归属，并拒绝
  secret/token/authorization/private-key/raw-body 等敏感键。数据库约束再次校验 payload 商城。
- 领取同时把 `attempt_count + 1`；完成或失败更新必须匹配活动租约 owner、未过期时间和 expected
  version。可重试失败以 1 秒为默认基数、20% 抖动、5 分钟默认上限；达到 `max_attempts`、永久
  失败或人工复核进入 `DEAD_LETTER` 并保留终态时间和稳定错误类别。最后一次处理进程崩溃时，
  下一次扫描把已过期且耗尽的租约转为死信。
- 运行时每轮最多处理配置的 batch 数量，但每条消息只在即将处理前领取，避免串行批次中后排
  消息尚未执行就消耗租约；多 worker 实例仍依靠 `SKIP LOCKED` 并行领取不同消息。
- M5.5 的 `payment.reconcile.requested.v1` payload 只含 `store_id/payment_attempt_id`，商城内
  idempotency key 固定绑定支付尝试。首次可用时间为供应商接受后最多 2 分钟，并尽量保留支付
  到期前 30 秒的处理余量；pending 以 5 分钟为上限延迟重试，最多 8 次，成功/失败/复核终态后
  完成消息。
- M5.6 的 `shipment.create.requested.v1`、`shipment.cancel.requested.v1` 与
  `shipment.query.requested.v1` payload 只含 `store_id/shipment_id/operation_id/version`。worker
  在事务内读取商城、渠道、地址/包裹和命令事实，事务外调用 GHN，再以新事务应用经过商城、
  ShopId、client order code、供应商单号和状态核对的权威事实；未签名 webhook 只能追加查询任务。
- M5.7 的 `refund.create.requested.v1` payload 只含 `store_id/refund_id` 且最多领取一次；
  `refund.query.requested.v1` 只查询已有供应商退款引用，处理中结果按 5 分钟延迟、最多 8 次
  收敛。provider 网络调用均在数据库事务外，结果通过锁定支付与退款行的统一事实命令落库。
- 死信重放不修改商城、聚合、事件、幂等键或 payload；只在商城任务重试权限、对应领域写权限、
  近期 MFA、二次确认、原因和 expected version 全部满足时重置调度字段。重放前后计数、错误类别
  与版本写入 append-only `audit_logs`，审计不复制消息 payload。

### 7.2 `inbox_messages`

字段：`id/store_id/source/channel_id/environment/external_message_key/payload_digest/status/
received_at/processing_started_at/completed_at/error_code/version`。唯一
`(source,channel_id,environment,external_message_key)` 承担数据库并发去重；进程内缓存不作为防线。
M5.3 使用 `INSERT ... ON CONFLICT DO NOTHING` 后读取首次事实；同键同摘要返回首次处理记录，同键
不同摘要返回 `INBOX_IDEMPOTENCY_CONFLICT`。`RECEIVED/PROCESSING/RETRY_PENDING/COMPLETED/
REJECTED/DEAD_LETTER` 的开始、完成和错误字段组合由数据库约束保护。

## 8. `orders` 与 M4 兼容扩展

- `order_payment_status` 向后兼容增加 `PARTIALLY_REFUNDED/FULLY_REFUNDED`；COD 语义不变。
- `orders` 可增加成功支付尝试复合 FK/投影版本，但支付尝试仍是完整事实来源。
- 在线订单创建继续使用 M4 同一原子边界，区别是初始订单 `PENDING_PAYMENT`、支付尝试
  `CREATED` 和 `payment.create.requested.v1` outbox 同事务写入。M5.4 没有新增表或迁移，直接
  使用 M5.2 预置的金额复合外键、活动尝试唯一索引、RLS 和 append-only 转换事实。
- M4 checkout idempotency 请求 hash 包含 `payment_method=ONLINE`，同键跨 COD/ONLINE 冲突。
- M4 过期 worker 在关闭在线订单前锁定订单/活动支付尝试；与回调/查单成功争用同一锁顺序，
  避免成功与释放库存同时提交。
- M5.7 订单详情向本人和授权管理员追加 `refunds` 只读数组。买家只获得公开退款号、整数 VND
  金额、标准状态和请求/更新时间；不返回管理员原因、requested_by、provider refund ID、
  provider status、secret reference 或上游响应。查询先按认证 `member_id` 锁定订单关系，不能
  通过同商城任意退款 ID 横向读取。

## 9. P0-M5-005 Slice A 财务对账批次

### 9.1 `financial_reconciliation_batches`

支付/退款结算批次是商城隔离、只追加的财务事实，不是供应商文件或资金到账的替代品。字段与约束：

| 字段                                                  | 类型/语义             | 约束                                                 |
| ----------------------------------------------------- | --------------------- | ---------------------------------------------------- |
| `id/store_id`                                         | uuid                  | `UNIQUE(store_id,id)`；FORCE RLS                     |
| `payment_channel_id`                                  | uuid                  | 与 `store_id` 复合绑定当前商城支付渠道               |
| `source`                                              | enum                  | Slice A 仅 `PAYMENT_PROVIDER`                        |
| `business_date/currency`                              | date/char(3)          | 日期由财务输入；币种固定 `VND`                       |
| `batch_reference_digest/masked`                       | char(64)/varchar(160) | 原文不落库；同商城、渠道、摘要唯一                   |
| `input_digest/idempotency_key_hash`                   | char(64)              | 同商城/source 幂等；同键异参冲突                     |
| `status`                                              | enum                  | `MATCHED` 或 `REVIEW_REQUIRED`，必须与异常数量一致   |
| `record_count/matched_count/exception_count`          | integer               | 1..500；总数必须等于匹配与异常之和                   |
| `gross/fee/net/local_expected/difference_amount_vnd`  | bigint                | 服务端按逐笔计算；API 只返回 JavaScript safe integer |
| `reason/created_by/correlation_id/version/created_at` | 审计元数据            | 原因 10..500；版本固定 1；批次不可更新或删除         |

延迟约束触发器在提交时重算全部逐笔汇总并与 batch header 精确比较。它同时确认支付/退款匹配目标
属于批次绑定的支付渠道；创建后再追加逐笔而使 header 失真也会整事务拒绝。

### 9.2 `financial_reconciliation_lines`

| 字段                                   | 类型/语义             | 约束                                                             |
| -------------------------------------- | --------------------- | ---------------------------------------------------------------- |
| `id/store_id/batch_id/line_number`     | uuid/integer          | 批次复合 FK；同批次行号唯一，1..500                              |
| `type/status`                          | enum                  | `PAYMENT`/`REFUND`；匹配、金额差异、引用不存在、非终态或重复引用 |
| `record_reference_digest/masked`       | char(64)/varchar(160) | 同批次记录引用唯一；原文不落库                                   |
| `provider_reference_digest/masked`     | char(64)/varchar(160) | 摘要绑定商城、渠道与类型；API/审计只返回掩码                     |
| `occurred_at`                          | timestamptz           | 规范化输入的发生时间，不作为供应商权威时间证明                   |
| `gross/fee/net_amount_vnd`             | bigint                | 支付净额 `gross-fee`；退款净额 `-(gross+fee)`                    |
| `local_expected/difference_amount_vnd` | bigint nullable       | 找到事实时差异固定 `gross-local_expected`；未找到/重复时均为空   |
| `payment_attempt_id/refund_id`         | uuid nullable         | 按类型恰好绑定一个同商城事实；异常引用可均为空                   |

只有同商城、同渠道且已有供应商引用的支付/退款事实参与匹配。`SUCCEEDED` 且金额相等才是
`MATCHED`；其他状态只形成复核事实，不修改支付、退款、订单、库存、运单或供应商状态。

### 9.3 权限、迁移与回滚

- `store.finance.read` 只读批次/逐笔；`store.finance.reconcile` 要求直接商城角色、近期 MFA、
  `Idempotency-Key`、固定确认码与原因。迁移只登记权限，production 角色不自动获得。
- runtime role 仅有两表 `SELECT/INSERT`，显式撤销 `UPDATE/DELETE`；两表 FORCE RLS。
- `20260801090000_p0_m5_005_financial_reconciliation` 只增加枚举、两表、索引、约束、触发器和权限目录，
  不回填批次，不创建渠道，不生成供应商成功事实。
- `down.sql` 仅供没有任何 batch/line 的 local/test scratch；存在事实时以 SQLSTATE `55000` 拒绝。
  已有事实或 production 环境只能向前修复。

## 10. RLS、最小权限与审计

- API 运行角色只能在事务级 `app.store_id` 下访问渠道、支付、退款、物流和消息事实；回调入口
  使用不具备 RLS bypass 的专用解析流程，先由全局唯一公开 App/Shop 引用解析单个候选商城，
  再建立商城事务处理。
- 普通商城管理员不能读取 secret reference 的完整值、指纹原文、加密 payload 或其他商城
  供应商引用。超级管理员跨商城仍需要显式权限、目标商城和访问原因。
- 退款、渠道启用/轮换、人工物流状态、死信重放、面单读取和对账修复写不可变审计；支付/物流
  状态机转换同时写领域时间线，不以普通审计替代。
- worker、Redis key、队列、对象键和导出均包含 store ID。指标只使用商城 code、provider、
  environment、operation 和错误类别等受控低基数标签。

## 11. 迁移、兼容与回滚门禁

- M5.2 以四条前向迁移实施本字典：`20260725090000_m52_payment_shipping_foundation` 创建 14 张表、
  枚举、复合外键、约束、索引、强制 RLS 和不可变保护；`20260725093000_m52_permission_catalog`
  登记 12 项权限；`20260725100000_m52_callback_trust_guard` 固定 GHN 回调只能是未验证提示；
  `20260725103000_m52_payment_amount_and_permissions_guard` 将支付金额/币种复合绑定订单快照，并
  把运行角色更新权限收缩到受审配置、状态和供应商结果列。
- M5.3 新增前向迁移 `20260725110000_m53_reliable_message_guards`，不新增表或供应商事实，只把
  outbox payload 商城身份、租约/终态字段组合和 inbox 状态时间/错误组合提升为数据库约束。
  该迁移的 down 只允许没有 outbox/inbox 事实的 local/test scratch；已有事实环境继续向前修复。
- M5.5 新增 `20260726120000_m55_payment_callback_channel_resolver`，只提供按公开 App/method
  唯一定位支付回调商城的受限解析函数；已有 callback 事实时拒绝 down。
- M5.6 新增 `20260726130000_m56_shipping_fulfillment_facts`：创建仓库履约资料、订单行可空物理
  快照、复合外键、强制 RLS、运行角色最小权限和按 GHN ShopId 唯一定位未签名提示的受限函数。
  迁移不回填旧订单、不创建仓库资料/渠道/运单；有物理快照、履约资料、GHN secret reference、
  运单、operation 或轨迹事实时，down 以 SQLSTATE `55000` 拒绝。
- M5.7 新增 `20260727001000_m57_refund_review_capacity_guard`，不新增表或字段，只将
  `REVIEW_REQUIRED` 纳入应用与数据库退款容量占用，防止供应商结果不确定时重复退款；存在人工
  复核退款事实时，down 以 SQLSTATE `55000` 拒绝。
- P0-M5-005 Slice A 新增 `20260801090000_p0_m5_005_financial_reconciliation`，建立上述只追加
  支付/退款对账批次、延迟汇总/渠道完整性 guard、FORCE RLS 与两项财务权限；不解析供应商文件，
  不生成真实结算或资金事实。空 scratch 可执行 down；存在任一批次/逐笔时以 `55000` 拒绝。
- local/test seed 只登记权限，不创建持久化支付/物流渠道或任何业务事实。集成测试仅在回滚事务
  中创建禁用、非秘密测试渠道，避免把虚构商户配置误认为可用 sandbox。
- fresh deploy、M2-to-current、重复 deploy、生产运行角色权限、RLS、指纹和索引均需自动化
  验证。不回填任何支付、退款、运单、轨迹或供应商成功事实。
- 先部署 schema/禁用渠道和兼容消费者，再启 worker，最后逐商城启 sandbox。停止新建外部单不
  等于停止处理已有支付、退款、回调和运单。
- `down.sql` 仅允许无 M5 渠道密钥引用和业务事实的 local/test scratch 数据库；检测到支付、
  退款、回调、运单、轨迹、outbox/inbox 时以 SQLSTATE `55000` 拒绝。
- 生产或已有事实环境只允许向前修复。应用回滚保留 schema 和兼容 worker，不能删除或改写
  外部业务事实。
