# M2 商品内容数据字典与迁移设计

> 状态：M2.1 已冻结；M2.2 已按本文实现并验证
>
> 日期：2026-07-17
>
> 适用范围：品牌、类目、属性模板、商品、SKU、媒体、合规、商品版本与页面装修

## 1. 设计约定

- 所有商城业务表都包含不可为空的 `store_id uuid`；所有跨商城业务关系使用包含 `store_id` 的复合外键。
- 稳定内部主键使用 UUID；面向运营的 `code` 与内部主键分离，并以 `(store_id, code)` 唯一。
- 时间字段使用 `timestamptz`，金额使用非负 `bigint` 整数 VND，重量使用整数克，尺寸使用整数毫米。
- `created_by`、`updated_by`、`submitted_by`、`reviewed_by` 引用 `admin_users.id`；自动任务使用受审系统操作者标识，不使用空字符串或伪造管理员。
- 所有可编辑聚合使用正整数 `version` 做乐观并发控制；请求必须提交 `expected_version`。
- 品牌、类目、商品和媒体使用停用/软删除；被引用记录不物理删除。发布版本和审核记录只追加。
- 越南语 `vi` 是发布必填语言；`zh`、`en` 缺失时买家 API 回退 `vi`，响应同时返回 `requested_locale` 与 `resolved_locale`。
- JSON 仅用于已验证的展示配置、属性类型值和不可变快照；商城归属、编码、状态、金额及核心关系必须使用受约束列。

## 2. 状态与转换

### 2.1 商品状态 `ProductStatus`

| 状态             | 含义                       | 允许转换                              |
| ---------------- | -------------------------- | ------------------------------------- |
| `DRAFT`          | 可编辑草稿                 | `PENDING_REVIEW`、`DISABLED`          |
| `PENDING_REVIEW` | 等待发布审核，业务字段冻结 | `DRAFT`（驳回/撤回）、`PUBLISHED`     |
| `PUBLISHED`      | 当前可对买家展示           | `UNPUBLISHED`、`DISABLED`             |
| `UNPUBLISHED`    | 已下架，可继续修订         | `DRAFT`、`PENDING_REVIEW`、`DISABLED` |
| `DISABLED`       | 运营停用，历史版本保留     | 无直接恢复；受审命令创建新草稿状态    |

禁止 API 直接写状态列。提交、发布、驳回、下架和停用均为独立命令，在同一事务中校验状态、`expected_version`、权限和上架门禁，并写审计事件。上架生成新的不可变 `product_versions` 记录。

### 2.2 合规状态 `ComplianceStatus`

| 状态             | 允许转换                                              |
| ---------------- | ----------------------------------------------------- |
| `PENDING_REVIEW` | `APPROVED`、`REJECTED`                                |
| `APPROVED`       | 到期后由读取/任务派生为 `EXPIRED`；资料变更创建新记录 |
| `REJECTED`       | 不原地改为通过；修改资料后创建新审核记录              |
| `EXPIRED`        | 不可恢复；提交新资料                                  |

`MISSING` 是完整度计算结果，不创建空记录。`APPROVED` 必须有 `reviewed_by`、`reviewed_at`，且 `reviewed_by <> submitted_by`。即使异步任务尚未写入 `EXPIRED`，`expires_at <= now()` 也必须实时阻断上架。

### 2.3 其他状态

- `LifecycleStatus`：`ENABLED`、`DISABLED`。
- `AttributeTemplateStatus`：`DRAFT`、`ACTIVE`、`RETIRED`；激活版本不可修改定义。
- `MediaStatus`：`PENDING_UPLOAD`、`PROCESSING`、`READY`、`FAILED`、`QUARANTINED`、`DISABLED`。
- `PageStatus`：`DRAFT`、`PUBLISHED`、`DISABLED`。
- `PublicationStatus`：`DRAFT_SNAPSHOT`、`PUBLISHED`、`WITHDRAWN`。

## 3. 品牌与类目

### 3.1 `brands`

| 字段               | 类型              | 约束/说明                             |
| ------------------ | ----------------- | ------------------------------------- |
| `id`               | uuid              | 主键；另建唯一 `(store_id, id)`       |
| `store_id`         | uuid              | 非空，复合外键到 `stores` 可用键      |
| `code`             | varchar(64)       | 小写业务编码；唯一 `(store_id, code)` |
| `country_code`     | char(2)           | ISO 3166-1 alpha-2，可空              |
| `official_website` | varchar(2048)     | 仅允许 `https`，可空                  |
| `recommended`      | boolean           | 默认 false                            |
| `sort_order`       | integer           | 非负，默认 0                          |
| `status`           | `LifecycleStatus` | 非空                                  |
| `version`          | integer           | 正整数乐观锁                          |
| `disabled_at`      | timestamptz       | `DISABLED` 时必填                     |
| 审计字段           | timestamptz/uuid  | `created_at/by`、`updated_at/by`      |

索引：`(store_id, status, sort_order, id)`、`(store_id, recommended, status)`。品牌停用不级联商品或版本。

### 3.2 `brand_localizations`

主键 `(store_id, brand_id, locale)`；复合外键 `(store_id, brand_id)` → `brands`。字段：`name varchar(240)`、`introduction text`、`share_title varchar(240)`、`share_summary varchar(500)`。每个品牌最多 vi/zh/en 三行。

### 3.3 `categories`

| 字段                | 类型             | 约束/说明                                |
| ------------------- | ---------------- | ---------------------------------------- |
| `id`、`store_id`    | uuid             | 主键及商城归属；唯一 `(store_id, id)`    |
| `parent_id`         | uuid             | 可空；复合自外键 `(store_id, parent_id)` |
| `code`              | varchar(64)      | 唯一 `(store_id, code)`                  |
| `depth`             | smallint         | 只能为 1 或 2                            |
| `sort_order`        | integer          | 非负                                     |
| `homepage_featured` | boolean          | 默认 false                               |
| `status`、`version` | enum/integer     | 生命周期和乐观锁                         |
| `disabled_at`       | timestamptz      | 停用时间                                 |
| 审计字段            | timestamptz/uuid | 创建、更新操作者                         |

数据库约束阻止 `id = parent_id`；服务层使用父链加锁校验循环和最大两级。根类目 `parent_id is null AND depth=1`；子类目 `parent_id is not null AND depth=2`。索引：`(store_id, parent_id, status, sort_order, id)`。

### 3.4 `category_localizations`

主键 `(store_id, category_id, locale)`；字段：`name varchar(160)`、`description text`、`share_title varchar(240)`、`share_summary varchar(500)`。复合外键保证同商城。

## 4. 属性模板

属性模板采用稳定根与不可变版本分离，避免已发布商品引用的定义被原地修改。

### 4.1 `attribute_templates`

字段：`id`、`store_id`、`code varchar(64)`、`industry StoreIndustry`、`status AttributeTemplateStatus`、`current_version integer`、`version integer`、审计字段。唯一 `(store_id, code)` 和 `(store_id, id)`。

### 4.2 `attribute_template_versions`

主键 `id`；字段：`store_id`、`template_id`、`version integer`、`name varchar(160)`、`status`、`activated_at/by`、`created_at/by`。唯一 `(store_id, template_id, version)`；激活后 UPDATE/DELETE 触发器拒绝修改。

### 4.3 `attribute_definitions`

| 字段                                    | 类型        | 说明                                                      |
| --------------------------------------- | ----------- | --------------------------------------------------------- |
| `id`、`store_id`、`template_version_id` | uuid        | 复合商城关系                                              |
| `code`                                  | varchar(64) | 模板版本内唯一                                            |
| `data_type`                             | enum        | `TEXT`、`INTEGER`、`DECIMAL`、`BOOLEAN`、`DATE`、`OPTION` |
| `usage`                                 | enum        | `DESCRIPTION`、`FILTER`、`SPECIFICATION`                  |
| `required`、`multiple`                  | boolean     | 必填和多值规则                                            |
| `unit_code`                             | varchar(32) | 可空；如 `ml`、`g`、`mm`                                  |
| `validation_rules`                      | jsonb       | 长度、范围、格式等受 Zod/数据库检查的规则                 |
| `sort_order`                            | integer     | 非负                                                      |

唯一 `(store_id, template_version_id, code)`。`SPECIFICATION` 必须使用 `OPTION` 或经批准的数值规格类型。

### 4.4 `attribute_options`

字段：`id`、`store_id`、`attribute_definition_id`、`code`、vi/zh/en 标签、`sort_order`、`status`。唯一 `(store_id, attribute_definition_id, code)`。标签在本表三列保存，是有限选项配置而非富文本内容；商品内容仍使用独立本地化表。

### 4.5 `category_attribute_templates`

主键 `(store_id, category_id, template_version_id)`；字段：`is_primary boolean`、`created_at/by`。同一类目最多一个 `is_primary=true` 的激活模板版本。

## 5. 商品与 SKU

### 5.1 `products`

| 字段                                | 类型             | 约束/说明                             |
| ----------------------------------- | ---------------- | ------------------------------------- |
| `id`、`store_id`                    | uuid             | 主键及商城归属；唯一 `(store_id, id)` |
| `code`                              | varchar(64)      | 唯一 `(store_id, code)`               |
| `brand_id`                          | uuid             | 复合外键 `(store_id, brand_id)`       |
| `main_category_id`                  | uuid             | 必须是启用的末级类目，由命令校验      |
| `attribute_template_version_id`     | uuid             | 复合外键，发布版本固定                |
| `status`                            | `ProductStatus`  | 非空                                  |
| `recommended`                       | boolean          | 默认 false                            |
| `cod_allowed`                       | boolean          | M2 只保存商品策略标志，M4 再参与结算  |
| `after_sale_policy_code`            | varchar(64)      | 可空，M6 绑定正式策略                 |
| `current_published_version_id`      | uuid             | 可空，指向不可变版本                  |
| `scheduled_publish_at/unpublish_at` | timestamptz      | 可空；发布命令再次校验门禁            |
| `version`                           | integer          | 乐观锁                                |
| `disabled_at`                       | timestamptz      | 停用时间                              |
| 审计字段                            | timestamptz/uuid | 创建、更新操作者                      |

索引：`(store_id, status, id)`、`(store_id, brand_id, status, id)`、`(store_id, main_category_id, status, id)`、`(store_id, scheduled_publish_at)`。

### 5.2 `product_secondary_categories`

主键 `(store_id, product_id, category_id)`；所有关系使用复合外键。主类目不能重复出现在辅助类目中。

### 5.3 `product_localizations`

主键 `(store_id, product_id, locale)`。字段：`name varchar(240)`、`subtitle varchar(500)`、`selling_points text`、`description_document jsonb`、`usage_instructions text`、`seo_title varchar(240)`、`seo_description varchar(500)`、`share_title varchar(240)`、`share_summary varchar(500)`。`description_document` 只接受受支持节点/属性允许列表，不存任意 HTML。

### 5.4 `product_attribute_values`

字段：`id`、`store_id`、`product_id`、`attribute_definition_id`、`locale`（仅本地化文本值使用）、`text_value`、`integer_value`、`decimal_value`、`boolean_value`、`date_value`、`option_id`。检查约束要求每行只设置一种值类型，且与定义 `data_type` 一致。多值属性允许多行；单值属性用部分唯一索引限制。

### 5.5 `skus`

| 字段                                 | 类型             | 约束/说明                                           |
| ------------------------------------ | ---------------- | --------------------------------------------------- |
| `id`、`store_id`、`product_id`       | uuid             | 同商城复合关系                                      |
| `code`                               | varchar(64)      | 唯一 `(store_id, code)`                             |
| `barcode`                            | varchar(64)      | 可空；商城内非空值唯一                              |
| `sale_price_vnd`                     | bigint           | 非负整数                                            |
| `market_price_vnd`、`cost_price_vnd` | bigint           | 可空、非负；成本价不进入买家 API                    |
| `weight_grams`                       | integer          | 可空、正数                                          |
| `length_mm/width_mm/height_mm`       | integer          | 可空、正数                                          |
| `option_combination_key`             | varchar(1024)    | 规范化 `attribute=option` 排序串                    |
| `option_combination_hash`            | char(64)         | key 的 SHA-256；唯一 `(store_id, product_id, hash)` |
| `status`、`version`                  | enum/integer     | 生命周期与乐观锁                                    |
| 审计字段                             | timestamptz/uuid | 创建、更新操作者                                    |

`option_combination_key` 用于碰撞复核，不能只凭 hash 判等。库存字段不进入 M2 `skus`；M3 在独立库存聚合中维护实际、锁定和可售库存。

### 5.6 `sku_option_values`

主键 `(store_id, sku_id, attribute_definition_id)`；字段 `option_id`。复合外键保证 SKU、规格定义和选项同商城。触发器/服务校验属性用途为 `SPECIFICATION`，并重算组合 key/hash。

## 6. 媒体

### 6.1 `media_assets`

字段：`id`、`store_id`、`object_key`、`mime_type`、`byte_size bigint`、`width/height integer`、`checksum_sha256 char(64)`、`status MediaStatus`、`original_filename`（清洗后）、`alt_text_vi/zh/en`、`failure_code`、`version`、审计字段。唯一 `(store_id, object_key)`；对象键必须匹配 `{environment}/{store_id}/{resource}/{uuid}`。允许类型为经配置的 SVG、PNG、WebP 和批准的视频类型；SVG 在 READY 前必须清洗。

### 6.2 专用媒体关联表

不使用无法建立目标复合外键的多态 `entity_media`。创建以下结构一致的表：

- `brand_media(store_id, brand_id, media_id, purpose, sort_order)`
- `category_media(store_id, category_id, media_id, purpose, sort_order)`
- `product_media(store_id, product_id, media_id, purpose, sort_order)`
- `sku_media(store_id, sku_id, media_id, purpose, sort_order)`
- `page_module_media(store_id, page_module_id, media_id, purpose, sort_order)`

每张表均以目标和用途组成唯一键，并用两组复合外键同时校验目标与媒体商城归属。商品 `PRIMARY` 用部分唯一索引限制一张，图集按 `sort_order` 排序。

## 7. 合规与版本

### 7.1 `compliance_requirements`

字段：`id`、`store_id`、`code`、`industry`、`category_id`（可空）、`document_type`、`blocking`、`validity_days`、`condition_rules jsonb`、`version`、`status`、审计字段。唯一 `(store_id, code, version)`。规则变更新增版本，不静默改变历史发布判断。

### 7.2 `compliance_records`

字段：`id`、`store_id`、`product_id`、`requirement_id`、`document_number`、`issued_at`、`expires_at`、`status ComplianceStatus`、`submitted_by/at`、`reviewed_by/at`、`review_note`、`supersedes_record_id`、`version`。审核资料媒体通过 `compliance_record_media` 专用复合关联表保存。

索引：`(store_id, product_id, requirement_id, submitted_at desc)`、`(store_id, status, expires_at)`。审核记录不 UPDATE 为另一审核结果；资料修订新增记录并指向前一记录。

### 7.3 `product_versions`

字段：`id`、`store_id`、`product_id`、`version integer`、`publication_status`、`snapshot jsonb`、`content_hash char(64)`、`created_at/by`、`published_at/by`、`withdrawn_at/by`。唯一 `(store_id, product_id, version)` 和 `(store_id, product_id, content_hash)`。发布后业务字段不可修改；snapshot 包含品牌/类目/SKU/价格/媒体/三语/属性/合规规则版本，供 M4 订单快照来源追踪。

## 8. 页面装修

### 8.1 `pages`

字段：`id`、`store_id`、`code`、`status PageStatus`、`current_published_version_id`、`version`、审计字段。唯一 `(store_id, code)` 和 `(store_id, id)`。

### 8.2 `page_versions`

字段：`id`、`store_id`、`page_id`、`version`、`publication_status`、`published_at/by`、`created_at/by`。唯一 `(store_id, page_id, version)`；发布后不可修改。

### 8.3 `page_modules`

字段：`id`、`store_id`、`page_version_id`、`module_type`、`sort_order`、`visible_from/to`、`status`、`background_config jsonb`、`target_type`、`target_id`、`target_url`。内部跳转使用允许的 `target_type + target_id` 并在发布时校验同商城；外部 URL 默认禁用，确需启用时走允许列表。

### 8.4 `page_module_localizations`

主键 `(store_id, page_module_id, locale)`；字段：`title`、`summary`、`button_label`、`content_config jsonb`。内容配置按模块类型使用独立 Zod schema，不接受任意脚本、HTML 或 URL。

## 9. 商城隔离、RLS 与触发器

M2.2 必须对本文件所有商城表：

1. 启用并强制 RLS，策略使用 `store_id = current_setting('app.store_id', true)::uuid`。
2. runtime role 缺少 `app.store_id` 时读取为空、写入失败。
3. 添加禁止修改 `store_id` 的触发器。
4. 对发布版本、激活模板版本和已完成合规审核添加不可变触发器。
5. 对专用媒体关联、商品品牌/类目/SKU、模板/定义/选项建立复合外键。
6. 普通商城事务继续只通过 `withStoreTransaction` 设置 transaction-local 上下文。

必须覆盖：相同业务编码可在不同商城存在；跨商城父类目、品牌、模板、SKU、媒体和合规关联全部失败；平台跨店访问仍走显式授权和逐店审计路径。

## 10. 迁移与回滚

- M2.2 使用扩展迁移新增 enum、表、索引、RLS、触发器和权限，不修改/删除 M1 列。
- M2.3 新增向前安全修复迁移 `20260717151500_m23_finalized_status_text`：通用终态触发器先按表分支，再将对应状态枚举转为文本比较，避免跨枚举字面量导致模板激活失败；不改变表结构或数据。
- 空库与已有 M1 数据库都必须可升级，重复 `migrate deploy` 无副作用。
- local/test `down.sql` 按反向依赖顺序删除 M2 对象，仅允许在确认没有真实 M2 数据时人工执行。
- 一旦产生商品版本、合规审核或媒体对象，只允许向前修复；应用回滚保留新增表。
- 种子只创建两商城的可识别属性模板、类目和权限配置，不创建冒充生产的商品或合规批准记录。

## 11. M2.4 实施说明

- 商品草稿自动绑定主末级类目的已激活主属性模板；品牌、主/辅助类目和模板均在同一商城事务内校验。
- SKU 集合仅允许在草稿或已下架状态用 `expected_version` 整体替换；规格选项必须来自商品固定模板，价格以安全整数 VND 写入。
- 媒体对象键使用 `{environment}/{store_id}/{resource}/{uuid}`；上传 URL 绑定 MIME、长度和 SHA-256 checksum，确认时再次核对对象元数据。SVG 在清洗能力交付前进入 `QUARANTINED`，不得关联商品或通过上架门禁。
- 合规资料媒体使用独立 `compliance` 资源路径；提交需要商品编辑与合规读取权限，审核只允许 `store.compliance.review` 且禁止提交人自审。
- 提交审核和发布均重新计算完整门禁；发布快照将 BigInt VND 转为 JSON 安全整数并写入不可变 `product_versions`。

## 12. M2.5 实施说明

- 页面创建同时生成首个空草稿版本；草稿按完整模块集合替换并用 `pages.version + expected_version` 做乐观并发控制。已发布页面再次保存时新增下一草稿版本，不修改当前发布版本。
- 发布前重新校验每个模块的越南语、中文和英文标题、展示时间窗、READY 页面媒体、内部跳转目标的商城与可用状态；页面不能跳转到自身。
- 外部跳转只接受 HTTPS，并要求主机精确命中 `CONTENT_EXTERNAL_TARGET_HOSTS`；空白名单默认拒绝全部外跳。
- `background_config` 与 `content_config` 使用严格结构化 DTO；不接受脚本、任意 HTML 或未声明字段。页面媒体只能来自 `{environment}/{store_id}/page/{uuid}` 对象路径。
- 发布要求页面编码二次确认并将草稿转为不可变 `PUBLISHED` 版本；创建、替换和发布均记录商城范围审计事件。
