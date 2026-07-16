# M1 商城、身份、RBAC、国际化与审计专项设计

> 状态：已批准
>
> 版本：0.1
>
> 日期：2026-07-17
>
> 依据：`REQUIREMENTS.md` V2.0、`AGENTS.md`、`docs/architecture/system-architecture.md`、`docs/plans/p0-development-plan.md`

批准记录：用户于 2026-07-17 批准本专项设计与配套实施计划，授权实施 M1；不包含 M2、外部发布、生产资源或真实凭据操作。

## 1. 决策范围

本设计只覆盖 P0 的 M1：商城安全上下文、会员与管理员身份、RBAC、Zalo 登录契约、三语基础、越南本地化、同意记录和审计。它是 M2 及后续业务表的安全前置，不实现商品、库存、价格、订单、支付、物流、售后或报表。

### 1.1 目标

- 让每个商城请求在进入领域服务前获得不可变且可信的 `StoreContext`。
- 从数据库约束、RLS、Repository 和 API Guard 四层阻止跨商城访问。
- 建立 deny-by-default 的平台级与商城级 RBAC，避免用 `is_admin` 一类布尔值绕过权限模型。
- 使用 Zalo 身份交换本系统短时访问令牌；Mini App 只通过 Header 认证。
- 在需要手机号时按场景申请权限；拒绝授权后允许手工输入并记录同意依据。
- 默认越南语，中文和英文缺失时回退越南语，统一 VND、日期、手机号和地址格式。
- 管理端高风险操作和超级管理员跨商城操作可追踪，敏感值不进入日志和审计差异。

### 1.2 非目标

- 不接入生产 Zalo App、OA、支付、物流或生产密钥。
- 不建立商品、库存、订单等 M2-M7 表或接口。
- 不实现社交分享、OA 通知、Checkout SDK 或第三方传统账号登录。
- 不在 Mini App 中展示用户名/密码登录表单。
- 不把测试身份提供者编译或启用到 production 配置。

## 2. 核心安全决策

### 2.1 StoreContext

```ts
type StoreContext = Readonly<{
  storeId: string;
  storeCode: string;
  actor: { type: 'member' | 'admin'; id: string };
  locale: 'vi' | 'zh' | 'en';
  correlationId: string;
  accessReason?: string;
}>;
```

- `StoreContext` 由服务端解析并冻结，不接受请求体中的 `store_id`。
- 买家登录交换前，`X-Store-Code` 只是路由提示。真实 Zalo 适配器还必须返回父 App/Mini App 标识，并与 `store_zalo_apps` 的启用配置匹配后才能确定商城。
- 已登录买家后续请求以访问令牌中的 `store_id` 为准；Header 与令牌冲突时拒绝。
- 管理请求可用 `X-Store-Id` 选择目标商城，但 Guard 必须验证有效商城角色。平台级跨商城权限仍需逐个商城建立上下文，不开放无范围 Repository。
- 超级管理员跨商城操作必须携带 `X-Access-Reason`，并为每个目标商城记录审计；M1 不引入 RLS 全局绕过开关。

### 2.2 数据库会话上下文

所有商城 Repository 操作必须运行在数据库事务内：

```sql
SELECT set_config('app.store_id', $1, true);
SELECT set_config('app.actor_id', $2, true);
SELECT set_config('app.actor_type', $3, true);
SELECT set_config('app.correlation_id', $4, true);
```

`true` 表示 transaction-local。连接池归还连接后不得残留上下文。RLS 使用 `current_setting('app.store_id', true)`；未设置、空值或非法 UUID 均 fail closed。Prisma Client 只能通过封装的 `withStoreTransaction(context, callback)` 进入商城 Repository。

### 2.3 跨商城专用路径

- 普通 Repository 的方法签名必须包含 `StoreContext`，且不得暴露 `findManyAcrossStores`。
- 平台管理员查询多个商城时，应用服务先验证 `platform.stores.cross_access`，再对明确的商城 ID 列表逐店执行 `withStoreTransaction`。
- 每个商城生成独立审计记录；响应不得包含未请求商城的数据。
- 以后如出现大规模跨店报表，必须在 M7 形成独立的只读报表角色和专项设计，不能复用 M1 路径绕过 RLS。

## 3. 数据模型

### 3.1 通用规则

- 内部主键使用 UUID，数据库默认 `gen_random_uuid()`。
- 时间使用 `timestamptz`，统一保存 UTC；展示按 `Asia/Ho_Chi_Minh`。
- 所有商城表的 `store_id` 非空，唯一约束和业务外键包含 `store_id`。
- 可变记录包含 `created_at`、`updated_at`；身份与授权记录不使用物理级联删除破坏历史。
- `locale` 仅允许 `vi`、`zh`、`en`；`currency` 在 P0 仅允许 `VND`。
- JSON 字段只存受 schema 校验的扩展配置，不替代核心关系和约束。

### 3.2 商城与展示配置

| 表                    | 关键字段                                                                                  | 约束与用途                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `stores`              | `id`, `code`, `industry`, `status`, `default_locale`, `timezone`, `currency`, timestamps  | `code` 全局唯一；P0 时区为 `Asia/Ho_Chi_Minh`、货币为 `VND`；商城不能硬删除                  |
| `store_localizations` | `store_id`, `locale`, `display_name`, `short_description`, timestamps                     | 主键 `(store_id, locale)`；越南语为发布必填，中英可空并回退越南语                            |
| `store_themes`        | `store_id`, `version`, `color_tokens`, `typography_tokens`, `radius_tokens`, timestamps   | `store_id` 主键；JSON token 使用 Zod schema；M1 不保存媒体文件                               |
| `store_zalo_apps`     | `store_id`, `environment`, `parent_app_id`, `mini_app_id`, `oa_id`, `enabled`, timestamps | 主键 `(store_id, environment)`；同环境 `mini_app_id` 唯一；只保存公开标识，不保存 App Secret |

枚举：`store_industry = BEAUTY | FASHION`，`record_status = ACTIVE | DISABLED`，`deployment_environment = TEST | STAGING | PRODUCTION`。

### 3.3 管理员与 RBAC

| 表                          | 关键字段                                                                                                                                                               | 约束与用途                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `admin_users`               | `id`, `email`, `email_normalized`, `display_name`, `password_hash`, `mfa_secret_ciphertext`, `mfa_enabled`, `status`, `failed_login_count`, `locked_until`, timestamps | `email_normalized` 唯一；密码使用带参数版本的 scrypt；MFA 密钥加密保存；不提供默认密码 |
| `permissions`               | `code`, `scope`, `description`                                                                                                                                         | 全局不可变权限目录；`scope = PLATFORM                                                  | STORE` |
| `platform_roles`            | `id`, `code`, `name`, `is_system`, timestamps                                                                                                                          | `code` 唯一；只包含平台权限                                                            |
| `platform_role_permissions` | `platform_role_id`, `permission_code`                                                                                                                                  | 复合主键；权限必须为 PLATFORM                                                          |
| `admin_platform_roles`      | `admin_user_id`, `platform_role_id`, `granted_by`, `granted_at`                                                                                                        | 复合主键；授权行为写审计                                                               |
| `store_roles`               | `store_id`, `id`, `code`, `name`, `is_system`, timestamps                                                                                                              | 主键 `id`，另有唯一 `(store_id, id)` 和 `(store_id, code)`                             |
| `store_role_permissions`    | `store_id`, `role_id`, `permission_code`                                                                                                                               | 复合主键；复合外键 `(store_id, role_id)`；权限必须为 STORE                             |
| `admin_store_roles`         | `store_id`, `admin_user_id`, `role_id`, `granted_by`, `granted_at`                                                                                                     | 复合主键 `(store_id, admin_user_id, role_id)`；复合外键阻止跨店角色关联                |

首批权限目录：

- PLATFORM：`platform.stores.read`、`platform.stores.manage`、`platform.stores.cross_access`、`platform.rbac.manage`、`platform.audit.read`。
- STORE：`store.config.read`、`store.config.manage`、`store.members.read`、`store.rbac.read`、`store.rbac.manage`、`store.audit.read`。

系统角色只允许修改显示名，不允许删除或移除必备权限。自定义商城角色只能绑定 STORE 权限。

### 3.4 会员、外部身份、联系方式与同意

| 表                           | 关键字段                                                                                                                            | 约束与用途                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `members`                    | `store_id`, `id`, `status`, `preferred_locale`, `display_name`, `avatar_url`, `last_seen_at`, timestamps                            | 唯一 `(store_id, id)`；同一自然人在不同商城形成独立会员关系                                         |
| `member_external_identities` | `store_id`, `id`, `member_id`, `provider`, `provider_app_id`, `provider_subject_id`, timestamps                                     | 唯一 `(store_id, provider, provider_app_id, provider_subject_id)`；复合外键 `(store_id, member_id)` |
| `member_phone_contacts`      | `store_id`, `member_id`, `phone_hash`, `phone_ciphertext`, `source`, `verified_at`, timestamps                                      | 一店一会员一条当前联系方式；AES-256-GCM 密文，HMAC-SHA-256 查重；API 和日志不返回完整号码           |
| `consents`                   | `store_id`, `id`, `member_id`, `purpose`, `status`, `policy_version`, `source`, `occurred_at`, `revoked_at`, `evidence`, timestamps | 追加式同意事件；撤回新增事件，不覆盖历史；证据 JSON 禁止 Token/完整手机号                           |

枚举：`identity_provider = ZALO`，`consent_purpose = PROFILE | PHONE | LOCATION | TERMS | PRIVACY`，`consent_status = GRANTED | DENIED | REVOKED`，`contact_source = ZALO | MANUAL`。

手机号仅在对应场景中处理：

1. Mini App 先使用 `getSetting` 判断授权状态。
2. 用户主动进入需要手机号的流程后调用 `authorize(scope.userPhonenumber)`。
3. 授权成功后，客户端把一次性 token 交给 API；解码操作只在服务端适配器进行。
4. 拒绝时展示手工输入；服务端规范化为 E.164 越南号码并记录 `DENIED` 与后续 `MANUAL` 来源。
5. 未配置真实 Zalo 服务端凭据时不调用或伪造解码 API。

### 3.5 会话

| 表                | 关键字段                                                                                                                             | 约束与用途                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `admin_sessions`  | `id`, `admin_user_id`, `refresh_token_hash`, `mfa_verified_at`, `expires_at`, `revoked_at`, `ip_hash`, `user_agent_hash`, timestamps | 刷新令牌单次轮换；重用旧令牌撤销 token family                |
| `member_sessions` | `store_id`, `id`, `member_id`, `refresh_token_hash`, `expires_at`, `revoked_at`, `zalo_token_expires_at`, timestamps                 | 复合外键 `(store_id, member_id)`；RLS；不保存明文 Zalo Token |

- 访问令牌：JWT，15 分钟，固定 issuer/audience，包含 `sub`、`actor_type`、`store_id`（会员必填）、`session_id`、`jti`；权限不长期写死在令牌中，管理员每次从短 TTL 授权缓存或数据库加载。
- 刷新令牌：256-bit 随机不透明值，数据库只保存 SHA-256/HMAC 摘要，轮换后旧值不可再次使用。
- Mini App 通过 `Authorization: Bearer` 发送本系统令牌；不依赖 Cookie、LocalStorage 或 SessionStorage。客户端会话先保存在内存，需要跨启动持久化时只使用 Zalo Native Storage，并在真机安全复核后启用。
- 管理端访问令牌保存在内存；刷新令牌使用 Secure、HttpOnly、SameSite 的专用 Cookie，部署拓扑不满足同站条件时改用受保护的 Header 流程并形成 ADR。

### 3.6 审计

| 表           | 关键字段                                                                                                                                                                            | 约束与用途                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `audit_logs` | `id`, `store_id?`, `actor_type`, `actor_id`, `action`, `target_type`, `target_id`, `before_data`, `after_data`, `reason`, `correlation_id`, `source_ip`, `user_agent`, `created_at` | 只追加；运行角色禁止 UPDATE/DELETE；`store_id` 为空只允许平台动作 |

- 脱敏器在写入前递归删除/替换 password、secret、token、authorization、cookie、phone、address、MFA、支付字段。
- `source_ip` 使用 PostgreSQL `inet`；向 API 返回时按权限脱敏。
- 普通商城管理员只能查询当前商城审计。平台审计通过 `platform.audit.read` 专用服务读取。
- 数据库触发器阻止运行角色更新或删除审计行；生产清理只允许受审归档流程。

## 4. 复合约束与 RLS

### 4.1 复合约束

首迁移至少建立并测试：

- `(store_id, member_id)` 外键：external identities、phone contacts、consents、member sessions → members。
- `(store_id, role_id)` 外键：store role permissions、admin store roles → store roles。
- 所有商城业务编码唯一键都包含 `store_id`；M1 首例是 `(store_id, store_role.code)`。
- `store_id` 不能通过更新改变；触发器拒绝租户记录换店。

### 4.2 首批 RLS 表

对以下表启用并强制 `ENABLE ROW LEVEL SECURITY` 与 `FORCE ROW LEVEL SECURITY`：

- `stores`（策略为 `id = current_store_id()`）
- `store_localizations`、`store_themes`、`store_zalo_apps`
- `store_roles`、`store_role_permissions`、`admin_store_roles`
- `members`、`member_external_identities`、`member_phone_contacts`、`consents`、`member_sessions`
- `audit_logs` 中 `store_id IS NOT NULL` 的商城行

策略同时定义 `USING` 与 `WITH CHECK`。迁移所有者与应用运行角色分离；集成测试必须用运行角色连接，否则 RLS 测试无效。平台表不通过商城 Repository 暴露。

## 5. 认证与 Zalo 适配器

### 5.1 端口

```ts
interface ZaloIdentityProvider {
  verifyAccessToken(input: { accessToken: string; expectedMiniAppId: string }): Promise<{
    parentAppId: string;
    miniAppId: string;
    subjectId: string;
    displayName?: string;
    avatarUrl?: string;
    expiresAt: Date;
  }>;

  decodePhoneToken(input: {
    token: string;
    accessToken: string;
    expectedMiniAppId: string;
  }): Promise<{ phoneE164: string }>;
}
```

- 真实适配器的 App Secret 仅来自服务端密钥配置。
- M1 提供 deterministic test provider，只有 `NODE_ENV=test` 且显式注入测试模块时存在；production 构建不注册该 provider。
- 测试 provider 仍验证签名、过期时间、Mini App 归属和一次性 phone token，不提供“任意字符串成功”路径。
- 没有真实 Mini App ID/凭据和 Zalo 真机证据时，只标记“契约与测试实现完成”。

### 5.2 管理员认证

- 密码至少 12 位，使用 Node.js `crypto.scrypt`，hash 字符串携带版本、参数、salt。
- 登录成功后必须完成 TOTP 才签发会话；恢复码只保存 hash。
- 连续失败实施账户级渐进锁定并记录审计，不通过错误响应泄漏账号是否存在。
- 首个管理员由显式 CLI 创建，CLI 要求交互或环境注入一次性值；种子脚本不创建默认管理员或密码。

## 6. API 契约

所有成功响应包含 `data`，错误响应包含稳定 `code`、本地化 `message_key`、`correlation_id`，不返回内部堆栈或资源存在性差异。

### 6.1 身份与会员

| 方法与路径                         | 认证                                 | 说明                                                                        |
| ---------------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `POST /v1/auth/zalo/exchange`      | `X-Zalo-Access-Token` + 商城路由提示 | 校验 Zalo token 与商城 Mini App 归属，创建/更新独立商城会员并签发本系统会话 |
| `POST /v1/auth/refresh`            | refresh credential                   | 单次轮换刷新令牌                                                            |
| `POST /v1/auth/logout`             | Bearer                               | 撤销当前会话                                                                |
| `POST /v1/auth/admin/password`     | 无                                   | 密码验证，只返回短时 MFA challenge                                          |
| `POST /v1/auth/admin/mfa/verify`   | MFA challenge                        | 验证 TOTP 后签发管理员会话                                                  |
| `GET /v1/members/me`               | member Bearer                        | 当前商城会员资料                                                            |
| `PATCH /v1/members/me/preferences` | member Bearer                        | 修改 `vi/zh/en` 偏好                                                        |
| `POST /v1/members/me/consents`     | member Bearer                        | 追加同意、拒绝或撤回事件                                                    |
| `PUT /v1/members/me/phone/manual`  | member Bearer                        | 手工手机号降级流程；规范化、加密并审计来源                                  |

### 6.2 商城、RBAC 与审计

| 方法与路径                                                  | 权限                                        | 说明                                 |
| ----------------------------------------------------------- | ------------------------------------------- | ------------------------------------ |
| `GET /v1/stores/current`                                    | member/admin                                | 返回当前商城公开配置和本地化结果     |
| `GET /v1/admin/stores`                                      | platform/store assignment                   | 只返回管理员明确可访问的商城         |
| `GET/PATCH /v1/admin/stores/:id/config`                     | `store.config.read/manage`                  | 配置更新写审计并使用乐观版本号       |
| `GET/POST/PATCH /v1/admin/rbac/roles`                       | `store.rbac.read/manage`                    | 当前商城角色管理                     |
| `PUT/DELETE /v1/admin/rbac/roles/:roleId/permissions/:code` | `store.rbac.manage`                         | 拒绝绑定 PLATFORM 权限               |
| `PUT/DELETE /v1/admin/rbac/admins/:adminId/roles/:roleId`   | `store.rbac.manage`                         | 商城管理员授权；不能修改其他商城角色 |
| `GET /v1/admin/audit-logs`                                  | `store.audit.read` 或 `platform.audit.read` | 分页、范围受限、敏感字段脱敏         |

幂等写接口后续统一支持 `Idempotency-Key`；M1 的角色授权和同意事件以唯一业务键或事件 ID防重复。

## 7. 国际化与本地化

- 新建 `packages/i18n`，集中维护 `vi`、`zh`、`en` 资源和类型安全 key。
- 回退链固定为：请求语言 → `vi`；不使用中文或英文互相回退。
- 服务端错误返回 `message_key`；客户端决定显示语言，越南语资源是 CI 必填基线。
- VND 使用整数输入和 `Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 })`。
- 日期使用显式 `Asia/Ho_Chi_Minh`；数据库和 API 传 ISO 8601 UTC。
- 越南手机号接受 `0xxxxxxxxx`、`84xxxxxxxxx`、`+84xxxxxxxxx`，规范化为 `+84...`；不接受模糊长度或非移动/有效号段规则之外输入。
- 地址格式器按“详细地址，坊/社，区/县，省/市，Việt Nam”组合；M1 只实现结构与格式器，行政区主数据在 M4 引入。

## 8. UI 范围

### Mini App

- 启动时显示真实加载状态，完成 Zalo token 交换后进入商城身份概览。
- 提供越南语/中文/英文切换，越南语默认；显示空状态、错误状态和重试。
- 仅在用户进入联系方式场景后请求手机号权限；拒绝时显示手工输入表单。
- 不声称商品、购物车或订单功能已完成。

### 管理端

- 提供登录 + MFA、当前商城选择、可访问商城列表、角色/权限只读或管理页、审计列表。
- 超级管理员跨店选择时要求填写访问原因。
- 页面具备加载、空、错误、禁止访问状态和键盘焦点；不以静态假数据冒充 API 成功。

## 9. 环境与密钥

新增配置只给出名称，不在示例文件放真实值：

- `AUTH_JWT_SECRET`、`AUTH_JWT_ISSUER`、`AUTH_JWT_AUDIENCE`
- `AUTH_ACCESS_TTL_SECONDS`、`AUTH_REFRESH_TTL_SECONDS`
- `PII_ENCRYPTION_KEY`、`PII_HASH_KEY`
- `DATABASE_RUNTIME_URL`（非迁移所有者）
- 真实 Zalo 凭据在 M1 真机联调前另行定义密钥引用，不进入通用 `.env.example`

production 启动时必须拒绝弱默认值、测试 provider、缺失加密密钥或 migration-owner 数据库 URL。

## 10. 迁移、兼容与回滚

- 首迁移只创建 M1 枚举、表、索引、复合外键、RLS、不可变触发器和应用运行角色授权。
- 迁移需提供对应 `down.sql`，只允许在无真实业务数据的 M1 环境执行；已有身份/审计数据后采用向前修复，不自动破坏性回滚。
- 空库升级、已有 M0 空 schema 升级、重复 deploy 和 down/up 演练均需测试。
- 种子仅在 local/test 创建 `beauty-local` 与 `fashion-local`、三语名称、主题 token、权限目录和系统角色；不创建会员、管理员、默认密码或真实 Mini App ID。
- API 从 `/v1` 开始；M1 内部变更在批准前完成，批准后只做向后兼容新增。

## 11. 测试与验收

### 单元

- deny-by-default 权限判定、平台权限不能绑定商城角色。
- 语言回退、缺失 key、整数 VND、时区日期、越南手机号与地址。
- 密码 hash/verify、TOTP、token 过期/受众、刷新令牌轮换。
- 审计递归脱敏与测试 Zalo token 的签名/过期/商城归属。

### 数据库集成

- 无上下文、错误商城、篡改 `store_id`、跨店复合外键全部失败。
- A 店相同角色编码不影响 B 店；普通运行角色无法绕过 RLS。
- 审计 UPDATE/DELETE 被拒绝；敏感字段未落库。
- 迁移空库、已有库和 down/up 演练通过。

### API 与安全

- 缺失/伪造/过期 Token、错误 Header、错误 audience、刷新重放。
- 普通管理员不能读取或写入未授权商城。
- 超级管理员必须具有显式权限和访问原因，跨店行为逐店审计。
- 登录错误不泄漏账号存在性；MFA、锁定和限流边界。

### UI

- 三语切换与越南语回退。
- 360×800、390×844、430×932 等常见移动视口。
- 加载、空、错误、权限拒绝、手工手机号和重试状态。
- 键盘焦点、可读标签、基础颜色对比度。

## 12. 风险与未决条件

1. 两个商城的真实 Parent App ID、Mini App ID 和 OA 尚未提供；本设计按独立配置实现。
2. 真实 Zalo Token/手机号解码只能在 Zalo 真机和服务端凭据具备后验收；浏览器模拟器不能证明集成完成。
3. 管理端生产域名/同站策略未确定，刷新 Cookie 部署形态需在部署方案确定后复核。
4. PII 生产密钥必须进入批准的密钥管理系统；M1 只能验证 local/test 密钥路径。
5. 越南手机号号段会变化；M1 只做严格 E.164 结构与常见移动前缀校验，生产发布前需更新权威号段数据。

## 13. 官方平台依据

- Zalo Mini App 认证应使用 Access Token 或系统 JWT，并通过 Header 传递；Cookie、LocalStorage、SessionStorage 不受支持：<https://docs.zaloplatforms.com/docs/MA/intro/getting-started/convert-web-app-to-mini-app>
- 用户信息、手机号和定位权限应按真实场景请求，手机号需要 Zalo 与用户授权：<https://docs.zaloplatforms.com/docs/MA/intro/request-permission>
- `authorize` 支持 `scope.userInfo`、`scope.userLocation`、`scope.userPhonenumber`，并建议先使用 `getSetting`：<https://docs.zaloplatforms.com/docs/MA/api/user/authorization/authorize>
- Token 解码等携带 App Secret 的 Server-to-Server API 不能从 Mini App 调用；真实 Access Token 流程需在 Zalo 真机环境验证：<https://docs.zaloplatforms.com/docs/MA/intro/getting-started/frequently-solved-issues>

## 14. 批准请求

批准本设计表示授权按 `docs/plans/m1-implementation-plan.md` 实施 M1，但不授权：

- 使用生产凭据、创建生产管理员或连接生产数据库；
- 启动 M2 或创建商品、库存、订单等后续表；
- 推送远程、部署、发布 Zalo Mini App 或购买外部资源；
- 在缺少真机和真实凭据时把 Zalo 集成标记为已验收。
