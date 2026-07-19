# Zalo Shop

面向越南市场的 Zalo 多品牌自营商城底座。项目使用一套代码支持美妆商城和服装商城，所有商城业务数据与配置必须按 `store_id` 隔离。

当前状态：M1 商城安全上下文、身份、RBAC、三语、本地化与审计基础已实现；M2.1-M2.4 商品目录数据、品牌/类目/属性模板、商品/SKU、媒体与合规后台 API 已实现。装修 UI、买家目录 UI、真实 Zalo 生产适配器、真机验收及交易领域尚未完成。

## 应用与包

```text
apps/api         NestJS API 与健康检查
apps/worker      独立 worker 进程及健康检查
apps/admin-web   PC 管理端 React 应用
apps/mini-app    Zalo Mini App React 应用
packages/config  运行时环境变量校验
packages/logger  结构化日志与 correlation ID
packages/platform PostgreSQL、Redis、对象存储就绪检查
packages/database Prisma schema 与迁移入口
packages/domain  StoreContext 与 deny-by-default 权限规则
packages/contracts API 输入与错误契约
packages/security JWT、scrypt、TOTP 与 PII 加密
packages/integrations Zalo 身份端口和测试 provider
packages/i18n    vi/zh/en 回退与越南本地格式器
packages/design-tokens Mini App/管理端共享设计 token
```

M2.4 的媒体适配器使用 S3 兼容对象存储。`infra:up` 会通过一次性 `minio-init` 服务创建本地 bucket；生产 bucket 仍必须由批准的基础设施流程预先创建。

架构与范围以 `REQUIREMENTS.md`、`AGENTS.md` 和 `docs/` 下已批准文档为准。

## 前置环境

- Node.js 24 LTS
- Corepack（Node.js 官方安装包已包含）
- Docker Desktop 或兼容的 Docker Compose 环境
- Git

仓库通过 `packageManager` 固定 pnpm 版本，不需要全局安装 pnpm：

```powershell
corepack pnpm --version
```

如果 Windows PowerShell 策略阻止 `.ps1`，可在首次启用前使用：

```powershell
corepack.cmd pnpm --version
```

## 本地启动

```powershell
Copy-Item .env.example .env
corepack pnpm install --frozen-lockfile
corepack pnpm infra:up
corepack pnpm dev
```

默认地址：

- API 存活检查：<http://localhost:3000/health/live>
- API 就绪检查：<http://localhost:3000/health/ready>
- Worker 存活检查：<http://localhost:3001/health/live>
- 管理端：<http://localhost:5173>
- Mini App Web 预览：由 ZMP CLI 输出地址；也可运行 `corepack pnpm --filter @zalo-shop/mini-app dev:web` 后打开其输出地址（旧版 Vite 本地预览必要时追加 `/index.html`）
- MinIO Console：<http://localhost:9001>

Mini App 身份启动和手机号授权直接调用官方 ZMP SDK，服务端生产适配器尚未配置。真机模式需要有效的 Zalo Mini App ID、父 App 配置、开发者登录和官方 ZMP CLI 流程；本仓库不保存这些凭据。

## 质量检查

```powershell
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm build
corepack pnpm db:validate
corepack pnpm verify
```

基础设施集成测试：

```powershell
corepack pnpm infra:up
corepack pnpm test:integration
corepack pnpm infra:down
```

## 数据库迁移与本地种子

M1 包含商城、身份、RBAC、会话、同意和审计表，并强制 runtime role RLS。种子仅创建可识别的 local/test 商城、三语配置、权限目录和系统商城角色，不创建默认管理员、会员或真实 Zalo ID。

```powershell
corepack pnpm db:generate
corepack pnpm db:validate
corepack pnpm --filter @zalo-shop/database migrate:dev
corepack pnpm --filter @zalo-shop/database migrate:deploy
$env:NODE_ENV='test'
corepack pnpm --filter @zalo-shop/database seed
```

迁移目录提供人工审查的 `down.sql`，仅允许用于无真实身份/审计数据的 local/test 环境；有数据后采用向前修复。首个管理员使用 `admin:create` CLI 和一次性环境变量创建，不得把密码或 TOTP secret 写入文件。

## M1 API 与安全边界

- API 从 `/v1` 开始，契约见 `docs/api/openapi.m1.yaml`。
- 买家令牌绑定 `store_id`，后续请求的 `X-Store-Code` 必须与令牌一致。
- 普通管理员只能访问明确授权商城；平台跨店访问必须携带 `X-Access-Reason` 并逐店审计。
- 手机号使用 AES-256-GCM 加密和 HMAC 查重，API 只返回掩码；刷新令牌只保存 hash。
- 管理端访问令牌只保存在内存，不写入 LocalStorage 或 SessionStorage。

## 环境与密钥

- `.env.example` 和 `.env.test.example` 只包含本地开发占位凭据。
- `.env`、生产凭据、Zalo Token、支付密钥和物流密钥禁止提交。
- API/worker 启动时会验证数据库、Redis 和对象存储配置。
- 日志默认遮盖认证、Cookie 和 Zalo Token 请求头。
- `ZALO_IDENTITY_PROVIDER=test` 只允许 `NODE_ENV=test`；生产环境会拒绝启动该 provider。
- 真实 Zalo 登录使用 `ZALO_IDENTITY_PROVIDER=open-api`，并要求服务端配置 `ZALO_APP_ID`、`ZALO_MINI_APP_ID` 和 `ZALO_APP_SECRET`。App Secret 只能写入被 Git 忽略的本地环境或部署密钥，禁止写入 `VITE_*`、前端代码、终端输出和版本库。
- `ZALO_OPEN_API_TIMEOUT_MS` 控制 Graph API 短超时；`ZALO_TOKEN_METADATA_TTL_SECONDS` 只是官方响应未给出过期时间时的保守元数据，不替代每次敏感操作的上游实时校验。
- `CONTENT_EXTERNAL_TARGET_HOSTS` 是逗号分隔的页面外跳 HTTPS 主机白名单；默认空值表示禁止全部外跳，配置不含协议或路径。

## Zalo Mini App 真机与 Testing

`apps/mini-app` 是现有 Vite Web App 的 ZMP deploy-only 项目。首次联调在该包目录登录对应 Mini App，CLI 凭据会进入被忽略的 `.env`：

```powershell
corepack pnpm --filter @zalo-shop/mini-app exec zmp login
corepack pnpm --filter @zalo-shop/mini-app zmp:device
```

Device 模式通过 Zalo 官方隧道连接本地 Vite 与 `/api` 代理，适合验证 `getAccessToken`、手机号允许/拒绝和手工降级。上传 Testing 前先构建，并确保 `VITE_API_BASE_URL` 是手机可访问的受控 HTTPS API；不能把本地 `localhost` 或 Vite 代理用于托管版本：

```powershell
corepack pnpm --filter @zalo-shop/mini-app build
corepack pnpm --filter @zalo-shop/mini-app zmp:deploy:testing -- --desc "real-device identity validation"
```

Testing 上传不等于审核或发布。正式提交前仍需完成 Mini App 主体/行业资质、生产 API 域名、隐私政策和完整真机回归。
