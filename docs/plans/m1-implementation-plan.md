# M1 分阶段实施计划

> 状态：实施完成，验收有保留
>
> 版本：0.1
>
> 日期：2026-07-17
>
> 专项设计：`docs/architecture/m1-security-and-data-design.md`

批准记录：用户于 2026-07-17 批准本计划，授权按 M1.1 至 M1.6 顺序实施 M1。

实施记录：M1.1 至 M1.6 已按顺序完成实现和自动化验证。当前会话的 Browser 运行环境无可用浏览器，故移动/桌面视觉与点击验收未执行；真实 Zalo 凭据和真机流程未获授权且未验收。详细证据见 `docs/reports/m1-completion-report.md`。

## 1. 目标与非目标

M1 建立后续领域共同依赖的商城安全上下文、身份、RBAC、国际化和审计基础。实施仅覆盖 M1；商品、库存、价格、订单、支付、物流、售后、装修内容和报表仍属于后续里程碑。

## 2. 涉及模块

- `packages/database`：Prisma schema、首迁移、RLS SQL、种子、运行时事务封装。
- `packages/domain`：StoreContext、权限判定、身份和同意领域类型。
- `packages/contracts`：认证、商城、RBAC、审计 DTO 与错误码。
- `packages/integrations`：Zalo 身份端口与仅测试环境实现。
- `packages/i18n`：三语资源、回退与越南本地化格式器。
- `packages/logger`：商城/操作者上下文与扩展脱敏。
- `apps/api`：认证、商城、RBAC、审计模块、Guard、过滤器与 OpenAPI。
- `apps/mini-app`：身份启动、三语切换、授权拒绝与手工手机号流程。
- `apps/admin-web`：登录/MFA、商城切换、RBAC 与审计基础页面。
- `tests`：数据库集成、API 安全和 UI/E2E 测试。
- `docs/database`、`docs/api`：ERD/字段字典、迁移、API 与权限矩阵。

## 3. 实施阶段

### M1.1：契约、纯领域与国际化

交付：

- 建立 `domain`、`contracts`、`i18n` package。
- 实现不可变 StoreContext、deny-by-default 权限计算、错误码。
- 实现 vi/zh/en 资源、越南语回退、VND/日期/手机号/地址格式器。
- 先写单元测试覆盖设计第 11 节相应用例。

验收：运行单元测试、格式、Lint、类型、构建与阶段 diff；不得引入数据库或网络假成功。

### M1.2：数据库、迁移、RLS 与种子

交付：

- 实现设计第 3 节数据表、复合约束、索引和触发器。
- 创建 migration owner/runtime role 分权 SQL 与 `withStoreTransaction`。
- 启用首批强制 RLS；提供 local/test 幂等种子和可审查 `down.sql`。
- 同步 ERD、字段字典和迁移说明。

验收：

- 空库 up、已有 M0 库 up、重复 deploy、down/up 演练。
- 使用 runtime role 验证无上下文、跨商城、复合外键、租户换店和审计不可变。
- 运行静态门禁和阶段 diff。

### M1.3：认证、Zalo 契约与会话

交付：

- 实现 JWT、刷新轮换、管理员 scrypt + TOTP、会话撤销。
- 实现 Zalo 端口和严格的 test provider；production 禁用测试 provider。
- 实现 Zalo exchange、refresh、logout、admin password/MFA、member profile/consent/manual phone API。
- 实现 PII 加密/哈希、认证限流边界和统一错误响应。

验收：

- Token/Header、签名、过期、audience、商城归属、MFA、锁定、刷新重放测试。
- 验证不保存明文 Zalo Token、refresh token、手机号、密码或 MFA secret。
- 运行静态门禁、API 测试和阶段 diff。

### M1.4：商城、RBAC、审计 API

交付：

- 实现 StoreResolver、Guard、商城配置、角色/权限/授权和审计查询 API。
- 普通管理员按商城角色授权；平台管理员逐店访问并强制原因。
- 写操作使用乐观版本/唯一键防止无声覆盖，写入脱敏审计。
- 同步 OpenAPI、权限矩阵和错误码文档。

验收：

- 覆盖跨商城读写、Header/请求体篡改、平台权限误绑定、未授权存在性泄漏。
- 超级管理员逐店审计证据完整。
- 运行数据库、API、安全测试和阶段 diff。

### M1.5：Mini App 与管理端 UI

交付：

- Mini App：身份启动、真实加载/错误/重试、三语、手机号授权拒绝和手工流程。
- Admin：登录/MFA、商城选择、RBAC、审计列表、跨店访问原因。
- 公共设计 token 复用；不展示未完成的商城业务入口。

验收：

- 三语与越南语回退，移动视口，键盘焦点，加载/空/错误/禁止状态。
- Browser 模拟只验 UI；Zalo Token 和手机号真实流程明确标为待真机。
- 运行 UI/E2E、构建和阶段 diff。

### M1.6：总体验收与文档收口

交付：

- 全量 `verify`、数据库/API/UI/E2E、安全测试、依赖审计与敏感信息扫描。
- 空库迁移、已有库迁移、回滚演练和种子复验。
- 更新 `AGENTS.md`、README、P0 状态和 M1 完成报告。
- 最终 `git diff --check`、`git diff --stat` 和高风险差异审查。

只有全部适用检查通过并逐项对照需求后，M1 才标记完成；真实 Zalo 真机项如无凭据必须单列“未验收”。

## 4. 依赖策略

预计新增依赖必须逐项核验维护状态、许可证、Node 24 与现有工具兼容性：

- JWT/JWK：优先 `jose`。
- OpenAPI：Nest 官方 Swagger 包。
- 浏览器 E2E：Playwright，仅作为开发依赖。
- 数据校验继续使用 Zod；密码 scrypt、随机令牌、AES-GCM、HMAC 和 TOTP 优先使用 Node `crypto`，避免无必要的原生依赖。

锁定精确版本，安装后运行 production audit；存在无法接受的高危漏洞则暂停该依赖。

## 5. 迁移与回滚

- 开始 M1.2 前保存数据库卷备份或使用独立测试卷。
- 首迁移是纯新增，可在无业务数据环境用受审 `down.sql` 回滚。
- 一旦产生真实身份、同意或审计记录，只允许向前修复，不自动删除。
- 应用回滚到 M0 时 M1 表可暂留但 M0 不读取；数据库删除另走显式人工步骤。
- production、staging 和真实 Zalo 配置不在本计划操作范围。

## 6. 风险控制

- RLS 测试必须用非 owner runtime role，避免 owner 默认绕过造成假通过。
- 请求 Header 不能直接成为 StoreContext；必须经过 token、商城配置和 RBAC 交叉验证。
- 平台管理员不获得通用跨店 Repository；每店操作都要独立上下文和审计。
- 测试 Zalo provider 只能测试构建注入，production 配置发现后启动失败。
- PII 加密密钥缺失或弱默认值时 production 启动失败。
- UI 不存储明文 refresh/Zalo token 到浏览器 LocalStorage、SessionStorage 或日志。

## 7. 范围确认

批准本计划后按 M1.1 → M1.6 顺序实施，每个子阶段独立测试和检查差异。批准不包含 M2、外部发布、远程推送、生产资源或真实凭据操作。
