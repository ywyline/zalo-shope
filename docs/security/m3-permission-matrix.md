# M3 库存与促销权限矩阵

> 状态：M3.1 冻结；M3.5 促销/报价与 M3.6 购物车已实施
>
> 日期：2026-07-21
> 商城范围：所有 `store.*` 权限都必须同时通过管理员令牌、商城授权、`X-Store-Code` 与数据库 RLS 校验。

## 1. 新增权限

| 权限 code                  | 用途                                             | 风险等级 |
| -------------------------- | ------------------------------------------------ | -------- |
| `store.inventory.read`     | 查看仓库、余额、预警和库存流水                   | 中       |
| `store.inventory.manage`   | 创建/编辑/停用仓库、执行受限初始库存导入 dry-run | 高       |
| `store.inventory.adjust`   | 提交非零库存调整或正式导入                       | 极高     |
| `store.promotions.read`    | 查看促销、版本、优惠券与报价预览                 | 中       |
| `store.promotions.manage`  | 创建/编辑草稿、目标、时间窗和优惠券草稿          | 高       |
| `store.promotions.publish` | 发布/暂停/结束促销或启停优惠券                   | 极高     |

生产迁移只创建权限目录项，不给现有生产角色静默扩权。local/test `store-admin` 由显式、幂等种子获得六项权限；生产授权必须由受审管理员动作完成。

## 2. 管理端动作矩阵

| 动作/接口                                                                      | read | manage | adjust | promo read | promo manage | promo publish | 额外控制                                                                     |
| ------------------------------------------------------------------------------ | :--: | :----: | :----: | :--------: | :----------: | :-----------: | ---------------------------------------------------------------------------- |
| `GET /admin/inventory/warehouses`、`balances`、`movements`                     |  ✓   |        |        |            |              |               | 逐商城 RLS；游标上限                                                         |
| `POST /admin/inventory/warehouses`、`PATCH .../{id}`                           |      |   ✓    |        |            |              |               | 乐观锁；写前后审计                                                           |
| `POST /admin/inventory/imports?dry_run=true`                                   |      |   ✓    |        |            |              |               | 文件类型/大小/表头/逐行校验，不写余额                                        |
| `POST /admin/inventory/adjustments`                                            |      |        |   ✓    |            |              |               | TOTP 会话、二次确认、`Idempotency-Key`、request hash、同事务流水             |
| `POST /admin/inventory/imports?dry_run=false`                                  |      |   ✓    |   ✓    |            |              |               | 两项权限同时要求；二次确认；整批/分批结果受审                                |
| `GET /admin/promotions`、`GET /admin/coupons`、`GET /admin/promotions/targets` |      |        |        |     ✓      |              |               | 逐商城 RLS；目标候选只返回同店编码与三语名称                                 |
| 创建促销根/草稿版本/目标，编辑优惠券草稿                                       |      |        |        |            |      ✓       |               | 乐观锁；严格 DTO；不接受 `store_id`                                          |
| 发布/暂停/结束促销，`POST /admin/coupons/{id}/status`                          |      |        |        |            |              |       ✓       | 二次确认、幂等键、不可变发布版本、前后审计                                   |
| `POST /pricing/quotes` 管理预览                                                |      |        |        |     ✓      |              |               | 无副作用；券预览假设持券/新客资格，不产生领取、核销、库存或订单事实；M4 重算 |

`store.inventory.manage` 不隐含 `store.inventory.adjust`；`store.promotions.manage` 不隐含 `store.promotions.publish`。服务端逐项判权，不通过前端隐藏按钮代替权限校验。

## 3. 买家与公共访问

| 能力              | 身份                               | 商城来源                     | 数据边界                                               |
| ----------------- | ---------------------------------- | ---------------------------- | ------------------------------------------------------ |
| 商品搜索与联想    | 公共                               | 可信 `X-Store-Code`          | 仅同商城当前已发布商品；无 RLS bypass                  |
| 热门词            | 公共                               | 可信 `X-Store-Code`          | 仅商城级聚合，不含会员/匿名标识                        |
| 搜索历史读取/清空 | 商城绑定会员令牌                   | 令牌商城必须等于 Header 商城 | 仅当前会员、当前商城                                   |
| 优惠券列表/领取   | 商城绑定会员令牌                   | 令牌商城必须等于 Header 商城 | 仅当前会员、当前商城；领取天然幂等，M3 不核销          |
| 商品金额报价      | 公共或商城绑定会员；券资格需要会员 | Header；令牌存在时必须匹配   | 请求不接受价格/折扣/`store_id`；不核销券               |
| 购物车读写        | 商城绑定会员令牌                   | 令牌商城必须等于 Header 商城 | 仅当前会员 ACTIVE 购物车；内存令牌，不用浏览器持久存储 |

M3.6 已实现的购物车写操作还要求行版本匹配；重复的设置数量不累加、不重复递增版本，跨会员/跨商城的行 ID 统一按当前会员资源不存在处理，库存只读且不创建预留。

## 4. 建议角色映射

| 角色示例                          | 权限                                               |
| --------------------------------- | -------------------------------------------------- |
| 库存查看员                        | `store.inventory.read`                             |
| 库存管理员                        | `store.inventory.read`、`store.inventory.manage`   |
| 库存调整员                        | 上述两项 + `store.inventory.adjust`                |
| 促销编辑                          | `store.promotions.read`、`store.promotions.manage` |
| 促销发布人                        | 上述两项 + `store.promotions.publish`              |
| 商城管理员（local/test 系统角色） | 六项权限                                           |

角色名称不是授权依据；API 只检查权限 code 和逐商城授权。对同一人同时授予编辑与发布权限是业务选择，不改变发布端的二次确认和审计要求。

## 5. 拒绝、审计与敏感数据规则

- 未认证返回 `401` 与信封 code `AUTHENTICATION_REQUIRED`；商城不匹配、无授权或无权限统一返回不泄露目标存在性的 `403 AUTHORIZATION_DENIED`；同商城不存在资源返回 `404 RESOURCE_NOT_FOUND`。
- 库存调整、正式导入和促销发布类命令要求 `Idempotency-Key`。促销/券高风险命令在强制 RLS、只允许追加写的 `promotion_operations` 中按 `(store_id, operation_key)` 唯一保存请求 hash 和首次结果；相同键同请求返回首次结果，相同键不同请求 hash 返回 `409 CONFLICT` 与稳定 `details.reason_code=IDEMPOTENCY_KEY_REUSED`。并发唯一冲突必须开启新商城事务读取已提交结果，不得重复状态变化或审计。
- 乐观锁、余额不足与非法状态转换统一使用 `409 CONFLICT`，分别以 `details.reason_code=VERSION_CONFLICT`、`AVAILABLE_INSUFFICIENT` 或对应 `..._STATE_CONFLICT` 区分。
- 审计保存商城、actor、权限、动作、资源、前后快照、时间、request/correlation ID；不保存密码、TOTP、Zalo Token、手机号明文、上传文件内容或任意请求 Header。
- 库存 note 和促销说明不是秘密存储，长度受限并在日志中转义；错误响应不返回 SQL、堆栈、内部路径、跨商城 ID 或 request hash 原文。

## 6. 必须通过的安全测试

1. 对每张 M3 表验证无商城上下文默认拒绝、正确商城允许、错误商城拒绝、`store_id` 更新拒绝；`promotion_operations` 还必须拒绝 UPDATE/DELETE。
2. 对每个管理端资源验证跨商城路径 ID、Body ID、游标和幂等键都不能泄漏目标存在性。
3. 验证 `manage` 不能调整库存，`promo manage` 不能发布；生产既有角色迁移后不自动拥有新权限。
4. 验证会员令牌商城与 Header 不一致、跨会员购物车/历史 ID、跨店 SKU 与促销目标全部拒绝。
5. 验证相同幂等键/相同 hash、相同键/不同 hash、并发相同键、版本冲突和失败后重试。
6. 验证金额字段、`store_id`、管理员 ID 等越权字段因严格 DTO 被拒绝，敏感信息不进入错误响应或审计快照。
7. 验证 `store.promotions.read` 只能执行无副作用报价预览；券预览不创建会员券或核销事实，且不能把假设资格结果当作 M4 结算凭据。
