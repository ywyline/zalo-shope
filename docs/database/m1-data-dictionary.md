# M1 数据字典与迁移说明

> 状态：随 M1 实施
>
> 迁移：`packages/database/prisma/migrations/20260716175514_m1_foundation`

## 1. 模型分组

| 分组      | 表                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------- |
| 商城      | `stores`、`store_localizations`、`store_themes`、`store_zalo_apps`                                  |
| 平台 RBAC | `admin_users`、`permissions`、`platform_roles`、`platform_role_permissions`、`admin_platform_roles` |
| 商城 RBAC | `store_roles`、`store_role_permissions`、`admin_store_roles`                                        |
| 会员身份  | `members`、`member_external_identities`、`member_phone_contacts`、`consents`                        |
| 会话      | `admin_sessions`、`member_sessions`                                                                 |
| 审计      | `audit_logs`                                                                                        |

完整字段、类型和 ORM 关系以 `packages/database/prisma/schema.prisma` 为准；Prisma 不能表达的约束、RLS、权限和触发器以迁移 SQL 为准。

## 2. 商城隔离不变量

- 商城表的 `store_id` 非空，且运行时不可修改。
- 会员、外部身份、手机号、同意和会员会话使用 `(store_id, member_id)` 复合外键。
- 商城角色授权使用 `(store_id, role_id)` 复合外键。
- 商城角色编码唯一键为 `(store_id, code)`，允许不同商城使用相同角色编码。
- runtime role 对首批商城表启用强制 RLS；缺少 `app.store_id` 时查询结果为空，写入失败。
- StoreContext 仅通过 `withStoreTransaction` 写入 transaction-local PostgreSQL setting。

## 3. 非 Prisma 约束

- 商城币种只能为 `VND`，时区只能为 `Asia/Ho_Chi_Minh`。
- `REVOKED` 同意事件必须包含 `revoked_at`，其他状态不得包含。
- 会话过期时间必须晚于创建时间。
- 触发器拒绝把租户记录更新到其他商城。
- 触发器拒绝平台权限绑定商城角色或商城权限绑定平台角色。
- 审计表只追加；runtime role 没有 UPDATE/DELETE 权限，触发器提供第二层保护。

## 4. 数据库角色

- `DATABASE_URL`：migration owner，仅用于迁移、种子和受控维护。
- `DATABASE_RUNTIME_URL`：`zalo_shop_runtime`，API、worker、就绪检查和集成测试使用。
- fresh local 数据库通过 `packages/database/docker/init-runtime-role.sh` 创建 runtime 登录角色。
- 生产环境必须在迁移前由基础设施流程创建等价 runtime role，不得使用本地密码或 migration owner 运行应用。

## 5. 本地种子

`corepack pnpm --filter @zalo-shop/database seed` 只允许 `NODE_ENV=development|test`，创建：

- `beauty-local` 与 `fashion-local` 两个可识别商城。
- vi/zh/en 名称与两套主题 token。
- 未启用且不含真实标识的 TEST Zalo 配置。
- 平台/商城权限目录与每店 `store-admin` 系统角色。

种子不创建管理员、会员、密码、真实 Mini App ID、OA ID 或任何生产凭据。

## 6. 回滚

`down.sql` 只适用于没有真实身份、同意和审计数据的 M1 开发/测试环境。产生真实记录后采用向前修复，不执行破坏性回滚。应用可先回退到 M0 并保留未使用的 M1 表，再由受审维护流程处理数据库。
