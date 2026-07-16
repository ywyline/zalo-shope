# M1 完成报告

日期：2026-07-17

结论：M1 代码实施完成，自动化门禁通过；由于当前会话无可用 Browser 实例且没有真实 Zalo 凭据，UI 视觉/点击和 Zalo 真机项未验收。M1 保持“验收有保留”，不得将未验证项描述为已通过，也不自动进入 M2。

## 已交付

- 不可变 `StoreContext`、deny-by-default 平台/商城权限和逐店跨商城审计路径。
- 18 张 M1 表、复合外键、唯一约束、强制 RLS、审计不可变触发器、runtime role 和可审查 `down.sql`。
- Zalo 身份端口与仅测试环境 provider；会员/管理员会话、刷新轮换、密码 + TOTP、撤销和首管理员 CLI。
- AES-256-GCM PII 加密、HMAC 查重、递归日志/审计脱敏；手机号 API 只返回掩码。
- 当前商城、会员偏好/同意、Zalo/手工手机号、商城配置、RBAC 和审计 API；OpenAPI 与权限矩阵同步。
- Mini App 官方 SDK 身份/手机号调用、授权拒绝和手工降级；管理端登录/MFA、商城选择、跨店原因、RBAC 和审计界面。
- vi/zh/en 资源和越南语回退、VND/日期/手机号/地址格式器、共享响应式设计 token。

## 验证证据

- `corepack pnpm verify`：格式、lint、类型、33 个单元测试、全部生产构建和 Prisma schema 校验通过。
- `corepack pnpm test:integration`：4 个测试文件、18 个测试通过，覆盖 runtime RLS、复合外键、审计不可变、Token/Header 商城绑定、刷新轮换、MFA、手机号加密、Zalo 一次性手机 token、普通/平台管理员跨店和 RBAC 审计。
- Mini App 与管理端生产构建通过；本地 API、管理端和 Mini App HTML/模块端点可响应。
- `git diff --check` 通过；阶段差异审查包含未跟踪文件，未发现明文密钥、生产凭据、静态成功路径或未授权跨商城查询。
- M1.2 已在隔离数据库验证空库迁移、重复 deploy、种子和 `down.sql` 回滚；M1.6 再次执行独立临时数据库复验。

## 未验收与限制

- Browser 插件运行环境报告无可用浏览器，未执行 Android/iPhone/桌面视口截图、键盘导航和真实点击 E2E。
- 未提供真实 Zalo production provider、Mini App/父 App 凭据或真机环境；官方 `getAccessToken`、`getPhoneNumber` 的端到端流程待真机验收。
- 测试 provider 只允许 `NODE_ENV=test`，不能作为生产集成替代品。
- 平台角色写 API、平台审计聚合、大规模跨店报表不属于 M1。
- 商品、库存、价格、订单、支付、物流、售后、装修和报表仍未实现。

## 后续门槛

1. 在可用 Browser 环境执行三语、常见 Android/iPhone 和桌面视口的加载/空/错误/禁止状态与键盘焦点验收。
2. 批准真实 Zalo 测试凭据和密钥引用方案后，实现 production provider，并进行 Zalo 真机登录、拒绝授权、手机号 token 和手工降级验收。
3. 上述 M1 保留项关闭并经用户确认后，再单独规划和批准 M2。
