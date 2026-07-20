# M2 商品内容权限矩阵

> 状态：M2.1-M2.7、M2.8.1-M2.8.3 已实施；本矩阵覆盖目录、商品属性、合规、装修、导入、导出、版本、批量命令与管理端工作台
>
> 日期：2026-07-19

M2 延续 M1 默认拒绝模型。所有权限均为商城范围，只能绑定 `StoreRole`；平台角色不能通过平台权限直接绕过目标商城 RLS。平台跨店人员仍必须具备 `platform.stores.cross_access`、提供 10 至 500 字符原因，并对每个目标商城生成审计事件。

| 权限                      | 读取                                                  | 创建/编辑                                   | 状态/审核                                  | 敏感字段                                                |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `store.catalog.read`      | 品牌、类目、属性模板、商品、SKU、媒体元数据与脱敏版本 | 否                                          | 否                                         | 版本快照响应递归移除成本价；不含合规文件内容            |
| `store.catalog.manage`    | 同上                                                  | 品牌/类目/模板草稿、商品草稿、SKU、媒体关联 | 可停用普通内容；不能发布或审核合规         | 成本价仅在同时具备明确财务扩展权限后返回；M2 默认不返回 |
| `store.catalog.publish`   | 发布门禁结果、版本摘要                                | 不能修改合规审核结果                        | 提交审核、驳回到草稿、发布、下架、强制停用 | 不读取私有合规文件正文                                  |
| `store.compliance.read`   | 合规要求、状态、到期日、脱敏编号                      | 可提交资料需同时具备 `store.catalog.manage` | 否                                         | 文件下载另做短期授权                                    |
| `store.compliance.review` | 完整审核资料                                          | 只能追加审核意见                            | 批准/驳回；审核人与提交人必须不同          | 每次查看/下载写审计                                     |
| `store.content.read`      | 页面、版本、模块和媒体元数据                          | 否                                          | 否                                         | 无密钥/供应商配置                                       |
| `store.content.manage`    | 同上                                                  | 编辑草稿、排序、定时、媒体关联              | 发布/下线页面版本                          | 外部跳转受允许列表约束                                  |

## 1. 角色建议

| 角色         | 建议权限                                                                   |
| ------------ | -------------------------------------------------------------------------- |
| 商城管理员   | M2 全部商城权限；仍受审核人分离约束                                        |
| 商品运营     | `store.catalog.read/manage`、`store.compliance.read`、`store.content.read` |
| 商品发布审核 | `store.catalog.read/publish`、`store.compliance.read`                      |
| 合规审核     | `store.catalog.read`、`store.compliance.read/review`                       |
| 内容运营     | `store.catalog.read`、`store.content.read/manage`                          |

local/test `store-admin` 系统角色可获得全部 M2 权限用于验收。迁移只创建权限目录；种子只更新可识别 local/test 系统角色，不得自动扩大已有真实管理员权限。

## 2. 命令权限

| 命令                       | 必需权限                                         | 附加规则与审计动作                                        |
| -------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| 创建/编辑品牌、类目        | `store.catalog.manage`                           | `catalog.brand.*`、`catalog.category.*`；记录前后版本     |
| 移动类目/批量移动商品      | `store.catalog.manage`                           | 加锁校验父链、目标商城、末级类目；逐项结果入审计          |
| 创建/编辑模板草稿          | `store.catalog.manage`                           | 激活版本不可原地修改                                      |
| 激活属性模板版本           | `store.catalog.publish`                          | `catalog.attribute_template.activated`                    |
| 创建/编辑商品与 SKU        | `store.catalog.manage`                           | 请求体不接收 `store_id`；成本价不写普通响应日志           |
| 读取商品属性编辑器         | `store.catalog.read`                             | 只返回同商城固定模板、非规格定义、启用选项和当前值        |
| 全量替换商品属性           | `store.catalog.manage`                           | 草稿状态 + 乐观锁；`catalog.product.attributes_replaced`  |
| CSV/XLSX 校验/导入商品草稿 | `store.catalog.manage`                           | 文件/行数/ZIP 受限；逐商品事务；不导入库存或自动发布      |
| 导出脱敏商品与 SKU XLSX    | `store.catalog.read`                             | 只限当前商城；不含成本、内部 ID、合规证件或对象存储信息   |
| 读取商品发布版本           | `store.catalog.read`                             | 同商城 RLS；版本详情响应移除成本价                        |
| 提交商品审核               | `store.catalog.publish`                          | 冻结业务版本并返回完整门禁问题列表                        |
| 发布/下架/停用商品         | `store.catalog.publish`                          | 二次确认；生成不可变版本和状态转换审计                    |
| 提交合规资料               | `store.catalog.manage` + `store.compliance.read` | 记录提交人；文件路径按商城隔离                            |
| 审核合规资料               | `store.compliance.review`                        | 提交人与审核人不得相同；只追加审核记录                    |
| 读取合规工作台概览         | `store.compliance.read`                          | 只返回掩码编号、日期、媒体计数与商品摘要，不返回文件/人员 |
| 初始化/确认媒体上传        | `store.catalog.manage` 或 `store.content.manage` | MIME、大小、checksum、对象键与商城均校验                  |
| 编辑/发布页面装修          | `store.content.manage`                           | 发布前校验三语、时间窗和内部跳转目标商城                  |

## 3. 必测拒绝场景

- 只有 `store.catalog.manage` 的运营人员不能发布商品或批准合规记录。
- 合规提交人即使拥有 `store.compliance.review` 也不能审核自己的记录。
- 商城 A 管理员不能通过路径 ID、查询参数、请求体 ID、媒体 ID 或批量条目引用商城 B 对象。
- 平台跨店权限没有访问原因时拒绝；有原因时仍逐店执行 RLS 事务并写审计。
- 买家目录 API 不接受管理员权限替代发布状态，只返回当前商城已发布版本。
- 媒体签名 URL 不能用于另一个商城、过期对象、隔离/失败对象或未经授权的合规文件。
- CSV/XLSX 不接受库存、商城、状态或发布字段；跨商城品牌/类目编码只返回逐项失败，不泄露对象。XLSX 额外拒绝公式、宏、外链、隐藏/额外工作表和超限 ZIP。
- `store.catalog.read` 商品导出不得包含其他商城哨兵、成本价、内部/商城 ID、合规证件或媒体对象键；超出同步上限不得静默截断。
- `store.catalog.read` 不能通过商品版本详情旁路读取成本价；批量目标重复时在写入前拒绝。
- 只读运营不能替换属性；跨商城商品 ID、非当前模板定义、规格定义和停用选项均不得写入，失败不泄露其他商城对象。
