# M3 库存、搜索、促销、报价与购物车数据字典

> 状态：M3.1 冻结；M3.2 数据库基础与 M3.3 仓库/库存服务已实施
>
> 日期：2026-07-20
> 依据：`REQUIREMENTS.md` 第 4、5、9、10、11、15、20、22、23、24 节与已批准的 `docs/plans/m3-implementation-plan.md`

## 1. 统一约定

- 所有 M3 业务表使用 UUID 内部主键、非空 `store_id`、`timestamptz(6)` 与 snake_case 数据库名。
- 商城内实体同时提供 `UNIQUE (store_id, id)`，所有领域关系使用包含 `store_id` 的复合外键；禁止通过更新 `store_id` 跨商城移动记录。
- 所有商城表启用并强制 RLS，策略读取 `app_security.current_store_id()`；上下文缺失或无效时默认拒绝。
- 金额使用 `bigint` 非负整数 VND；API 只接受 JavaScript 安全整数（最大 `9007199254740991`）。百分比使用 1–10000 整数基点。
- 库存数量使用 `integer`，范围 0–2147483647；购物车单行数量为 1–99。`version` 为从 1 开始的正整数乐观锁。
- 业务 code 统一转小写，格式为 `^[a-z][a-z0-9-]{1,63}$`；幂等键为 16–128 个受限 ASCII 字符，请求体以规范 JSON 计算 SHA-256。
- 流水、发布后的促销版本和预留终态不可原地修改或删除。修正库存必须新增引用原动作的反向调整。
- 后续阶段只能按本字典新增向后兼容结构；如果字段或状态发生实质变化，先更新本字典和 OpenAPI 再实施。

## 2. 枚举与状态机

### 2.1 枚举

| 枚举                           | 值                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `inventory_movement_type`      | `ADJUSTMENT_IN`、`ADJUSTMENT_OUT`、`RESERVE`、`RELEASE`、`CONSUME`、`RESTORE` |
| `inventory_operation_type`     | `ADJUST`、`IMPORT`、`RESERVE`、`RELEASE`、`CONSUME`、`EXPIRE`、`RESTORE`      |
| `inventory_reservation_status` | `ACTIVE`、`RELEASED`、`CONSUMED`、`EXPIRED`                                   |
| `promotion_status`             | `DRAFT`、`ACTIVE`、`PAUSED`、`ENDED`                                          |
| `promotion_version_status`     | `DRAFT`、`PUBLISHED`                                                          |
| `pricing_bucket`               | `ITEM`、`ORDER`、`COUPON`、`SHIPPING`                                         |
| `promotion_benefit_method`     | `FIXED_VND`、`PERCENTAGE_BPS`、`FREE_SHIPPING_QUALIFICATION`                  |
| `promotion_target_type`        | `STORE`、`BRAND`、`CATEGORY`、`PRODUCT`、`SKU`                                |
| `coupon_status`                | `DRAFT`、`ACTIVE`、`PAUSED`、`ENDED`                                          |
| `member_coupon_status`         | `CLAIMED`、`EXPIRED`、`DISABLED`                                              |
| `cart_status`                  | `ACTIVE`、`CONVERTED`、`ABANDONED`；M3 只创建 `ACTIVE`，其余为 M4 端口保留    |

### 2.2 状态转换

| 对象     | 合法转换                                        | 幂等重试                         | 非法转换处理                             |
| -------- | ----------------------------------------------- | -------------------------------- | ---------------------------------------- |
| 库存预留 | `ACTIVE -> RELEASED                             | CONSUMED                         | EXPIRED`                                 | 相同终态事件返回第一次结果                        | 终态之间转换返回 `RESERVATION_TRANSITION_INVALID` |
| 促销根   | `DRAFT -> ACTIVE`；`ACTIVE <-> PAUSED`；`ACTIVE | PAUSED -> ENDED`                 | 相同命令与版本返回第一次结果             | `ENDED` 不可恢复；返回 `PROMOTION_STATE_CONFLICT` |
| 促销版本 | `DRAFT -> PUBLISHED`                            | 对同一版本重复发布返回第一次结果 | 发布后字段与目标不可修改；修改需新建版本 |
| 优惠券   | `DRAFT -> ACTIVE`；`ACTIVE <-> PAUSED`；`ACTIVE | PAUSED -> ENDED`                 | 同状态命令不产生第二次审计               | `ENDED` 不可恢复                                  |
| 购物车   | M3 仅维护 `ACTIVE`                              | PUT 设置同一 SKU 数量天然幂等    | M4 才实现 `CONVERTED/ABANDONED`          |

库存预留状态转换、余额变化、操作记录和流水必须在同一事务内完成。促销根保存当前发布版本指针；旧发布版本保持不可变的 `PUBLISHED` 历史，不通过改写版本状态表示替换。

## 3. 仓库与库存

### 3.1 `warehouses`

| 字段                        | 类型        | 空值/默认    | 约束与说明                                       |
| --------------------------- | ----------- | ------------ | ------------------------------------------------ |
| `id`                        | uuid        | PK，自动生成 | 内部 ID                                          |
| `store_id`                  | uuid        | 非空         | FK `stores(id)`；商城不可变                      |
| `code`                      | varchar(64) | 非空         | `UNIQUE(store_id, code)`                         |
| `enabled`                   | boolean     | `true`       | 停用后保留历史                                   |
| `is_default_fulfillment`    | boolean     | `false`      | 每商城至多一个 `true AND enabled` 的部分唯一索引 |
| `version`                   | integer     | `1`          | `>= 1`，编辑时递增                               |
| `created_at` / `updated_at` | timestamptz | `now()`      | 审计时间                                         |

索引：`(store_id, enabled, code)`。P0 买家可售量只读取启用的默认履约仓库；创建商城不自动填造仓库或库存。

### 3.2 `warehouse_localizations`

| 字段                        | 类型         | 空值/默认      | 约束与说明                                 |
| --------------------------- | ------------ | -------------- | ------------------------------------------ |
| `store_id` / `warehouse_id` | uuid         | 复合 PK 一部分 | 复合 FK 到同商城仓库                       |
| `locale`                    | `locale`     | 复合 PK 一部分 | `vi/zh/en`                                 |
| `name`                      | varchar(160) | 非空           | 越南语记录必需；中英文允许缺失并回退越南语 |
| `created_at` / `updated_at` | timestamptz  | `now()`        | 审计时间                                   |

主键：`(store_id, warehouse_id, locale)`。

### 3.3 `inventory_balances`

| 字段                                   | 类型              | 空值/默认 | 约束与说明                         |
| -------------------------------------- | ----------------- | --------- | ---------------------------------- |
| `id`                                   | uuid              | PK        | 内部 ID                            |
| `store_id` / `warehouse_id` / `sku_id` | uuid              | 非空      | 分别复合 FK 到同商城仓库与 SKU     |
| `on_hand`                              | integer           | `0`       | `0 <= on_hand <= 2147483647`       |
| `reserved`                             | integer           | `0`       | `0 <= reserved <= on_hand`         |
| `available`                            | integer generated | 只读      | `on_hand - reserved`；应用不得写入 |
| `version`                              | integer           | `1`       | 每次成功变化加 1                   |
| `created_at` / `updated_at`            | timestamptz       | `now()`   | 审计时间                           |

唯一键：`(store_id, warehouse_id, sku_id)`；索引：`(store_id, warehouse_id, available)`、`(store_id, sku_id)`。无余额行和零可售量都表示不可售，不代表无限库存。M3.3 起，通过商品管理服务创建的新 SKU 在当前启用默认履约仓建立显式零余额；这不是非零库存事实。存在非零余额、流水、预留或购物车引用的 SKU 禁止通过“整组替换”物理删除，运营应停用历史 SKU。

### 3.4 `inventory_operations`

| 字段                        | 类型               | 空值/默认 | 约束与说明                                    |
| --------------------------- | ------------------ | --------- | --------------------------------------------- |
| `id`                        | uuid               | PK        | 动作 ID                                       |
| `store_id`                  | uuid               | 非空      | 商城隔离                                      |
| `operation_key`             | varchar(128)       | 非空      | `UNIQUE(store_id, operation_key)`             |
| `request_hash`              | char(64)           | 非空      | 相同键不同 hash 返回 `IDEMPOTENCY_KEY_REUSED` |
| `operation_type`            | enum               | 非空      | 动作类型                                      |
| `result_snapshot`           | jsonb              | 非空      | 仅存脱敏、确定性的首次成功结果                |
| `admin_id`                  | uuid               | 可空      | 管理动作的操作者；系统/M4 动作为空            |
| `source_type` / `source_id` | varchar(32) / uuid | 可空      | M4 订单或系统任务对接端口，不伪造来源         |
| `created_at`                | timestamptz        | `now()`   | 只追加                                        |

操作记录与余额/流水在同一事务提交。业务校验失败不改变余额，也不创建“成功”操作记录；并发同键请求等待首次事务后返回相同结果。

### 3.5 `inventory_reservations`

| 字段                         | 类型               | 空值/默认 | 约束与说明                                 |
| ---------------------------- | ------------------ | --------- | ------------------------------------------ |
| `id`                         | uuid               | PK        | 预留 ID                                    |
| `store_id`                   | uuid               | 非空      | 商城隔离                                   |
| `reservation_key`            | varchar(128)       | 非空      | `UNIQUE(store_id, reservation_key)`        |
| `status`                     | enum               | `ACTIVE`  | 仅允许冻结状态机                           |
| `expires_at`                 | timestamptz        | 非空      | 必须晚于创建时间                           |
| `terminal_operation_id`      | uuid               | 可空      | 终态动作；同商城复合 FK                    |
| `source_type` / `source_id`  | varchar(32) / uuid | 可空      | M4 接入真实订单后填写；M3 不虚构           |
| `created_at` / `terminal_at` | timestamptz        | 创建/可空 | `ACTIVE` 时 `terminal_at` 为空，终态时非空 |

索引：`(store_id, status, expires_at)` 供 worker 扫描。worker 载荷只含 `store_id`、`reservation_id` 和动作键。

### 3.6 `inventory_reservation_items`

| 字段                          | 类型        | 空值/默认 | 约束与说明      |
| ----------------------------- | ----------- | --------- | --------------- |
| `id`                          | uuid        | PK        | 行 ID           |
| `store_id` / `reservation_id` | uuid        | 非空      | 同商城复合 FK   |
| `warehouse_id` / `sku_id`     | uuid        | 非空      | 同商城复合 FK   |
| `quantity`                    | integer     | 非空      | `1..2147483647` |
| `created_at`                  | timestamptz | `now()`   | 创建时间        |

唯一键：`(store_id, reservation_id, warehouse_id, sku_id)`。创建整批预留前按 `(warehouse_id, sku_id)` 排序锁行；任一行不足则整批回滚。

### 3.7 `inventory_movements`

| 字段                                       | 类型         | 空值/默认 | 约束与说明                       |
| ------------------------------------------ | ------------ | --------- | -------------------------------- |
| `id`                                       | uuid         | PK        | 流水 ID                          |
| `store_id` / `balance_id` / `operation_id` | uuid         | 非空      | 同商城复合 FK                    |
| `reservation_item_id`                      | uuid         | 可空      | 预留类动作关联行                 |
| `movement_type`                            | enum         | 非空      | 流水类型                         |
| `on_hand_before/after/delta`               | integer      | 非空      | `after = before + delta`         |
| `reserved_before/after/delta`              | integer      | 非空      | `after = before + delta`         |
| `reason_code`                              | varchar(64)  | 非空      | 受控原因码                       |
| `note`                                     | varchar(500) | 可空      | 不存手机号、Token 或任意敏感载荷 |
| `created_at`                               | timestamptz  | `now()`   | 只追加时间                       |

触发器拒绝 UPDATE/DELETE，并检查前后值、差量和余额约束。索引：`(store_id, balance_id, created_at DESC, id DESC)`、`(store_id, operation_id)`。

### 3.8 M3.3 初始导入与过期执行约定

- 初始库存导入只接受 UTF-8 CSV 或 XLSX；XLSX 工作表固定为 `inventory`，两种格式都必须严格使用 `warehouse_code,sku_code,quantity,note` 四列。
- 文件最大 5 MiB、最多 5000 个数据行；数量必须为正整数且不超过库存上限，仓库必须启用，SKU 必须启用，备注不得包含手机号、Token 等敏感信息。
- dry-run 和正式执行返回逐行报告。任一行错误时正式请求不写余额、动作、流水或审计；全部行有效时在一个商城事务内原子执行。初始导入只允许无余额或 `on_hand=reserved=0`、`version=1` 且无流水的目标。
- 正式导入和调整都使用 `Idempotency-Key` 与规范请求 hash；同键同请求返回首次结果，同键不同请求返回 `IDEMPOTENCY_KEY_REUSED`。
- 预留过期 worker 通过 `app_security.list_active_stores()` 逐商城扫描数据库事实，批大小由 `INVENTORY_EXPIRATION_BATCH_SIZE` 控制，轮询间隔由 `INVENTORY_EXPIRATION_INTERVAL_MS` 控制；固定动作键和终态条件保证重复扫描不产生第二笔流水。当前数据库轮询满足部署与可靠性要求，不引入 BullMQ。

## 4. 搜索

### 4.1 `product_search_documents`

| 字段                             | 类型           | 空值/默认 | 约束与说明                                              |
| -------------------------------- | -------------- | --------- | ------------------------------------------------------- |
| `id`                             | uuid           | PK        | 文档 ID                                                 |
| `store_id` / `product_id`        | uuid           | 非空      | 同商城复合 FK                                           |
| `locale`                         | `locale`       | 非空      | 每商品每语言一份                                        |
| `display_text`                   | text           | 非空      | 已发布商品/品牌/类目/筛选属性的展示文本                 |
| `canonical_text`                 | text           | 非空      | NFC、小写、空白归一化，保留变音；展示仍使用发布内容原文 |
| `folded_text`                    | text           | 非空      | NFD 去组合符并显式 `đ -> d`，不用于展示                 |
| `search_vector`                  | tsvector       | 非空      | 受控配置生成                                            |
| `brand_id` / `main_category_id`  | uuid           | 非空      | 同商城筛选 FK                                           |
| `category_ids` / `filter_values` | uuid[] / jsonb | 非空      | 只含已发布投影的受控值                                  |
| `minimum_sale_price_vnd`         | bigint         | 非空      | 非负整数 VND                                            |
| `published_at`                   | timestamptz    | 非空      | 上新排序                                                |
| `source_version`                 | integer        | 非空      | 商品发布版本，幂等重建依据                              |
| `updated_at`                     | timestamptz    | `now()`   | 投影更新时间                                            |

唯一键：`(store_id, product_id, locale)`。索引包括 `(store_id, locale, published_at)`、价格 B-tree、`search_vector` GIN、`folded_text gin_trgm_ops`。只存在当前可展示的发布商品；库存与当前促销通过同商城事实连接，不将 Redis 作为事实源。

规范化样例：

| 输入               | `canonical_text` | `folded_text`   |
| ------------------ | ---------------- | --------------- |
| `Son dưỡng ĐẸP!`   | `son dưỡng đẹp!` | `son duong dep` |
| 分解形式 `MỸ PHẨM` | NFC `mỹ phẩm`    | `my pham`       |
| `美妆 Serum`       | `美妆 serum`     | `美妆 serum`    |

查询文本如提供则限制为 1–100 Unicode code points；允许无查询文本的纯筛选浏览，此时不写搜索历史。筛选最多 20 项，结果每页最多 100，游标最大 1000 字符。所有原生 SQL 参数化。

### 4.2 `member_search_history`

| 字段                                                 | 类型         | 空值/默认 | 约束与说明                           |
| ---------------------------------------------------- | ------------ | --------- | ------------------------------------ |
| `id`                                                 | uuid         | PK        | 历史 ID                              |
| `store_id` / `member_id`                             | uuid         | 非空      | 同商城会员复合 FK                    |
| `display_query` / `canonical_query` / `folded_query` | varchar(100) | 非空      | 归一化展示文本、小写原文与去变音文本 |
| `locale`                                             | `locale`     | 非空      | 查询语言                             |
| `last_searched_at`                                   | timestamptz  | `now()`   | 最近时间                             |

唯一键：`(store_id, member_id, locale, folded_query)`；重复搜索更新时间。每会员每商城最多保留最近 50 条，DELETE 仅能清理本人当前商城记录。

### 4.3 `search_query_stats`

| 字段                                   | 类型                       | 空值/默认 | 约束与说明   |
| -------------------------------------- | -------------------------- | --------- | ------------ |
| `store_id` / `locale` / `folded_query` | uuid / enum / varchar(100) | 复合 PK   | 商城聚合键   |
| `display_query`                        | varchar(100)               | 非空      | 安全展示形式 |
| `search_count` / `result_click_count`  | bigint                     | `0`       | 非负聚合计数 |
| `last_searched_at` / `updated_at`      | timestamptz                | `now()`   | 聚合时间     |

不保存匿名用户 ID、Token、IP 或原始请求载荷。热门词只从同商城聚合读取。

## 5. 促销与优惠券

### 5.1 `promotions`

| 字段                                          | 类型               | 空值/默认 | 约束与说明                  |
| --------------------------------------------- | ------------------ | --------- | --------------------------- |
| `id`                                          | uuid               | PK        | 稳定促销根                  |
| `store_id` / `code`                           | uuid / varchar(64) | 非空      | `UNIQUE(store_id, code)`    |
| `status`                                      | enum               | `DRAFT`   | 冻结状态机                  |
| `active_version_id`                           | uuid               | 可空      | 当前发布版本的同商城复合 FK |
| `version`                                     | integer            | `1`       | 根乐观锁                    |
| `created_by_admin_id` / `updated_by_admin_id` | uuid               | 非空      | 操作者                      |
| `created_at` / `updated_at`                   | timestamptz        | `now()`   | 审计时间                    |

### 5.2 `promotion_versions`

| 字段                                     | 类型               | 空值/默认 | 约束与说明                                       |
| ---------------------------------------- | ------------------ | --------- | ------------------------------------------------ |
| `id`                                     | uuid               | PK        | 版本 ID；确定性 tie-break 最终使用此 ID          |
| `store_id` / `promotion_id`              | uuid               | 非空      | 同商城复合 FK                                    |
| `version_number`                         | integer            | 非空      | `UNIQUE(store_id, promotion_id, version_number)` |
| `status`                                 | enum               | `DRAFT`   | 发布后不可变                                     |
| `bucket`                                 | enum               | 非空      | `COUPON` 版本只能被优惠券引用，不参与自动促销    |
| `benefit_method`                         | enum               | 非空      | 与下列利益字段互斥校验                           |
| `fixed_discount_vnd`                     | bigint             | 可空      | 仅 `FIXED_VND` 非空且 `> 0`                      |
| `percentage_bps`                         | integer            | 可空      | 仅 `PERCENTAGE_BPS` 非空且范围 `1..10000`        |
| `maximum_discount_vnd`                   | bigint             | 可空      | 仅百分比可用且 `> 0`                             |
| `minimum_spend_vnd`                      | bigint             | 可空      | 非负；按对应计价阶段判断                         |
| `minimum_quantity`                       | integer            | 可空      | `1..99`                                          |
| `starts_at` / `ends_at`                  | timestamptz        | 非空/可空 | 有效窗口 `[starts_at, ends_at)`                  |
| `priority`                               | integer            | 非空      | 非负，数值小者优先 tie-break                     |
| `stackable_with`                         | `pricing_bucket[]` | 空数组    | 无重复且不包含自身；双方均允许才叠加             |
| `published_at` / `published_by_admin_id` | timestamptz / uuid | 可空      | 发布时同时填写                                   |
| `created_at`                             | timestamptz        | `now()`   | 创建时间                                         |

检查约束：`SHIPPING` 只能使用 `FREE_SHIPPING_QUALIFICATION` 且不产生商品应付折扣；其余槽不得使用该方法。发布触发器拒绝字段、目标和本地化 UPDATE/DELETE。

### 5.3 `promotion_version_localizations`

主键 `(store_id, promotion_version_id, locale)`；字段 `name varchar(240)`、可空 `description varchar(2000)`。越南语必需，中英文按越南语回退；发布后不可变。

### 5.4 `promotion_targets`

| 字段                                                 | 类型        | 空值/默认 | 约束与说明                             |
| ---------------------------------------------------- | ----------- | --------- | -------------------------------------- |
| `id` / `store_id` / `promotion_version_id`           | uuid        | 非空      | 同商城关系                             |
| `target_type`                                        | enum        | 非空      | 类型化目标                             |
| `brand_id` / `category_id` / `product_id` / `sku_id` | uuid        | 可空      | `STORE` 全空；其他类型恰好对应一列非空 |
| `created_at`                                         | timestamptz | `now()`   | 创建时间                               |

每个实体 FK 都包含 `store_id`；表达式唯一索引禁止同版本重复目标。发布后不可修改。

### 5.5 `coupons`

| 字段                        | 类型                      | 空值/默认 | 约束与说明                             |
| --------------------------- | ------------------------- | --------- | -------------------------------------- |
| `id` / `store_id` / `code`  | uuid / uuid / varchar(64) | 非空      | `UNIQUE(store_id, code)`               |
| `promotion_version_id`      | uuid                      | 非空      | 必须引用同商城已发布 `COUPON` 版本     |
| `status`                    | enum                      | `DRAFT`   | 冻结状态机                             |
| `total_claim_limit`         | integer                   | 可空      | 正整数；空表示不限领取，不代表不限核销 |
| `per_member_claim_limit`    | integer                   | `1`       | M3 固定为 1；多次领取策略另行变更契约  |
| `claimed_count`             | integer                   | `0`       | 非负，仅领取事务递增                   |
| `version`                   | integer                   | `1`       | 乐观锁                                 |
| `created_at` / `updated_at` | timestamptz               | `now()`   | 审计时间                               |

### 5.6 `member_coupons`

字段：`id`、`store_id`、`coupon_id`、`member_id`、`status`、`claimed_at`、可空 `expires_at`、`created_at/updated_at`。全部关系使用同商城复合 FK。M3 使用唯一键 `(store_id, coupon_id, member_id)` 保证公开领取天然幂等，并以 `(store_id, member_id, status, expires_at)` 支持列表。M3 不创建 `REDEEMED` 或伪造核销记录，M4 在真实订单事务中扩展核销事实。

### 5.7 计价与叠加规则

- 服务器只接收 SKU code、数量与可选券码；每行基础金额为 `sale_price_vnd * quantity`，先以 bigint 计算并检查 API 安全整数边界。
- 百分比折扣为 `floor(basis_vnd * bps / 10000)`，再应用上限，最后封顶到当前基数；任何阶段不得为负。
- 应用顺序：每行 `ITEM` 最优规则 → 汇总 → `ORDER` 最优规则 → 最多一张 `COUPON` → 商品应付。`SHIPPING` 只返回资格，等待 M4 真实运费。
- 同一应用槽只选 VND 优惠最大者；相同金额按较小 priority、稳定 code、较早版本号、版本 ID 字典序决定。
- 不同槽默认互斥；所有入选版本必须两两在 `stackable_with` 中互相声明。相同槽永不叠加。
- 报价保存/返回规则 code、版本 ID、适用基数、折扣、未适用原因、时间与 `quote_hash`；M3 不把报价写成订单，也不核销优惠券。
- 报价事务只读取一次数据库时钟作为 `quoted_at`。`quote_hash` 为 SHA-256 小写十六进制，输入是按字段名递归排序、数组保持请求/应用顺序、整数以十进制表示的 UTF-8 规范 JSON；其中包含 `schema_version=m3-v1`、内部 `store_id`、会员资格指纹、`quoted_at`、SKU/数量、所有事实版本、规则分解和金额，但不包含 Token、手机号或展示文案。hash 不是客户端授权凭据，M4 仍必须重新加载事实并计价。

## 6. 购物车

### 6.1 `carts`

| 字段                            | 类型        | 空值/默认 | 约束与说明                                                 |
| ------------------------------- | ----------- | --------- | ---------------------------------------------------------- |
| `id` / `store_id` / `member_id` | uuid        | 非空      | 同商城会员复合 FK                                          |
| `status`                        | enum        | `ACTIVE`  | 每 `(store_id, member_id)` 至多一条 ACTIVE（部分唯一索引） |
| `version`                       | integer     | `1`       | 购物车聚合乐观锁                                           |
| `created_at` / `updated_at`     | timestamptz | `now()`   | 审计时间                                                   |

### 6.2 `cart_items`

| 字段                                     | 类型        | 空值/默认 | 约束与说明                               |
| ---------------------------------------- | ----------- | --------- | ---------------------------------------- |
| `id` / `store_id` / `cart_id` / `sku_id` | uuid        | 非空      | 全部同商城复合 FK                        |
| `quantity`                               | integer     | 非空      | `1..99`                                  |
| `selected`                               | boolean     | `true`    | 是否进入本次报价                         |
| `added_unit_price_vnd`                   | bigint      | 非空      | 加入时基础价，只用于变化提示，不可信结算 |
| `added_promotion_fingerprint`            | char(64)    | 可空      | 检测促销变化，不作为当前规则事实         |
| `version`                                | integer     | `1`       | 行乐观锁                                 |
| `created_at` / `updated_at`              | timestamptz | `now()`   | 审计时间                                 |

唯一键 `(store_id, cart_id, sku_id)`。读取与修改必须重新加载商品发布状态、SKU 状态、默认仓可售量和服务端报价。下架、SKU 停用、零库存、库存不足为阻断问题；价格/促销变化为提示并展示重算金额。加入购物车不创建库存预留。

## 7. 审计、RLS 与不可变保护

- 仓库编辑、库存调整、促销发布/暂停/结束和优惠券状态变化写既有 `audit_logs`，前后快照脱敏；库存流水本身即事实审计但管理动作仍记录操作者。
- 所有 SELECT/INSERT/UPDATE/DELETE 策略要求行 `store_id = app_security.current_store_id()`；服务方法必须在商城事务中设置上下文，不依靠 Header 字符串拼接 SQL。
- 商城归属不可变触发器覆盖本字典所有表。库存流水和发布版本额外触发器拒绝 UPDATE/DELETE；预留终态触发器拒绝恢复或改换终态。
- 复合 FK 拒绝跨商城仓库/SKU/商品/会员/促销引用。普通商城管理员无跨商城 bypass；超级管理员也必须逐商城进入受审事务。

## 8. M4 对接端口

M3.3/M3.5 必须形成但不对买家公开以下内部端口：

1. `reserveInventory(storeId, operationKey, expiresAt, items[])`：整批、稳定锁顺序、失败不部分预留。
2. `releaseReservation(storeId, reservationId, operationKey)`、`consumeReservation(...)`、`expireReservation(...)`：终态幂等。
3. `quoteMerchandise(storeId, memberId, skuCode/quantity[], couponCode?, quotedAt)`：只从可信事实计算，返回完整分解与 hash。
4. `evaluateShippingQualification(quote, destinationContext)`：M3 只返回规则候选；M4 加入地址、运费和偏远附加费后计算最终结果。
5. M4 订单事务必须重新计价、预留库存、校验优惠券并保存快照；不得直接接受 M3 购物车金额或在 M3 伪造订单/核销。

## 9. 迁移、回填与回滚门禁

- M3.2 新增表和扩展，不删除/重命名 M1/M2 结构。先检测 PostgreSQL 17 的 `unaccent`、`pg_trgm` 可用性与迁移角色 `CREATE` 权限，再在受控 schema/search_path 安装。
- 不为已有 SKU 生成虚假库存。local/test 可创建命名清晰的默认测试仓和零余额；非零测试库存必须通过受审 `INITIAL_LOAD` 动作与流水写入。
- 已发布商品搜索文档按商城/商品/语言幂等回填，支持重跑和受审重建；搜索派生数据可重建，库存/发布版本/购物车事实不可被重建脚本删除。
- 仅无真实 M3 数据的 local/test 环境允许人工执行 `down.sql`。产生库存流水、发布版本或购物车数据后只允许向前修复；应用回滚到 M2 时保留 M3 schema 和数据。
