# Zalo Shop

面向越南市场的 Zalo 多品牌自营商城底座。项目使用一套代码支持美妆商城和服装商城，所有商城业务数据与配置必须按 `store_id` 隔离。

当前状态：M1 商城安全上下文、身份、RBAC、三语、本地化与审计基础已实现；M2 商品目录、媒体、合规、装修、三语管理端、买家目录和受限导入导出已实现；M3.1-M3.7 已完成库存/预留、三语搜索/筛选、促销/优惠券/可信计价、会员购物车、并发与安全回归。M4 已按批准计划实现商城隔离的三级行政区、加密地址、服务端最终报价、COD 幂等下单、订单/快照/状态机、库存消费/释放/恢复、配送策略、买家端交易页面和管理工作台；M4 不包含真实线上支付、物流、退款或售后。

Post-M3 仓库内就绪收口证据继续有效。Zalo Testing 版本 6 已完成 iPhone 美妆商城登录和中国手机号保存成功路径；Android、服装商城及完整异常矩阵仍为 `PARTIAL`。M4 浏览器验收使用真实本地 API、PostgreSQL 和 Zalo 测试桥，不能替代 Zalo 宿主真机。真实 staging S3/CDN、越南权威行政区主数据、近生产规模性能、支付/物流沙箱、生产凭据/权限、远程 CI 和越南/中国个人信息专业合规签字仍待外部输入。阶段证据见 `docs/reports/m4-completion-report.md`。

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

库存预留过期由 worker 按数据库事实逐商城轮询，默认每 5 秒处理最多 100 条；可通过 `INVENTORY_EXPIRATION_INTERVAL_MS`（1000–300000）和 `INVENTORY_EXPIRATION_BATCH_SIZE`（1–500）调整。动作键和数据库终态保证重复执行幂等；M4 会在预留进入终态后关闭仍待确认的订单或推进已消费订单，失败保留计数供下轮重试。当前无需 BullMQ。

公共搜索默认按来源地址每 60 秒最多 120 次请求；可通过 `SEARCH_RATE_LIMIT_WINDOW_SECONDS`（10–3600）和 `SEARCH_RATE_LIMIT_MAX_REQUESTS`（10–10000）调整。Redis 仅保存短期限流计数，不作为搜索或商城数据事实来源。

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

浏览器 E2E 首次运行需安装 Chromium 与 WebKit。测试使用真实 API、PostgreSQL、Redis 和 MinIO，自动启动管理端以及美妆/服装两个 Mini App Web 预览进程；生成的报告位于 `playwright-report/`：

```powershell
corepack pnpm test:e2e:install
corepack pnpm infra:up
corepack pnpm test:e2e
corepack pnpm infra:down
```

`test:e2e` 会从 `.env.test.example` 使用测试 API 端口；如需覆盖端口，可在 PowerShell 先设置
`$env:E2E_API_PORT='3100'`。Windows 某些环境会将 2984–3083 列为排除端口，遇到
`listen EACCES` 时应使用 3100 或其他未被排除的端口。该 E2E 覆盖桌面 Chromium、Android
Chromium 与 iPhone WebKit 的 Web 预览。认证后购物车用例只在 Playwright 启动的 localhost
Mini App 且显式设置 `VITE_ZALO_TEST_BRIDGE=true` 时安装测试桥，之后仍调用 test provider、
真实 API 与数据库；它不进入正常生产配置，也不替代 Zalo Mini App 宿主真机测试。M4 用例覆盖地址创建、服务端报价、COD 快速双击防重、订单详情/取消、三语标题和移动端横向溢出。

## 数据库迁移与本地种子

M1 包含商城、身份、RBAC、会话、同意和审计表，并强制 runtime role RLS。M4 迁移新增三级行政区、地址、配送策略、订单、订单行、快照、转换、幂等与会员券核销门禁；权限迁移只登记 M4 权限 code，不给生产角色自动扩权。种子仅创建可识别的 local/test 商城、行政区测试夹具、三语配置、配送策略、权限目录和系统商城角色，不创建默认管理员、会员、订单或真实 Zalo ID。staging/production 必须先为每个商城导入并复核带 `source_version` 的越南权威省/区/坊数据；没有有效父链时地址写入和未知偏远省份配置会被服务端拒绝。

```powershell
corepack pnpm db:generate
corepack pnpm db:validate
corepack pnpm --filter @zalo-shop/database migrate:dev
corepack pnpm --filter @zalo-shop/database migrate:deploy
$env:NODE_ENV='test'
corepack pnpm --filter @zalo-shop/database seed
```

搜索文档属于可重建派生数据。需修复单个商城投影时，使用 runtime RLS 连接并显式记录执行人；该管理员必须在目标商城处于活动状态并具备 `store.catalog.publish`。命令按稳定商品 ID 每批处理 100 个商品，但删除、全部批次和审计位于单个 `REPEATABLE READ` 商城事务；任一失败整体回滚，重试从头执行，不是断点续跑：

```powershell
$env:SEARCH_REBUILD_STORE_CODE='beauty-local'
$env:SEARCH_REBUILD_ACTOR_ID='<authorized-admin-uuid>'
corepack pnpm --filter @zalo-shop/database search:rebuild
```

迁移目录提供人工审查的 `down.sql`，仅允许用于无真实身份、审计、M3/M4 业务事实和优惠券核销的 local/test 环境；检测到地址、订单或 `USED` 会员券会以 SQLSTATE `55000` 拒绝，已有事实后只采用向前修复。仓库提供严格限制为 `NODE_ENV=test`、loopback PostgreSQL 和随机 `zalo_shop_m2_upgrade_*` scratch 数据库的 M2-to-current 回归；它部署真实 M2 迁移前缀和代表性双商城数据，验证完整升级、重复部署、fingerprint、搜索回填、RLS/权限与零虚构交易事实，并在成功或失败后清理：

```powershell
corepack pnpm infra:up
corepack pnpm test:migration:m2-upgrade
```

该自动化不会改变已有开发数据库，也不替代真实生产数据的受控升级演练。首个管理员使用 `admin:create` CLI 和一次性环境变量创建，不得把密码或 TOTP secret 写入文件。

## Post-M3 readiness 工具

HTTP smoke/baseline 和 staging S3/CDN 预检不新增第三方依赖，也不默认连接远程环境：

```powershell
corepack pnpm test:readiness:http
corepack pnpm test:readiness:storage
```

HTTP 默认只允许 loopback；staging 必须同时提供显式开关、HEAD 中无差异的受审 origin 策略和目标同源、24 小时内有效的 guard，production 始终拒绝。对象存储预检只允许 staging，先读取可写前缀之外的 guard，再在 `staging/{store_id}/readiness/` 下执行 create-only checksum upload/head/read/可选 CDN 读取，并只删除能够证明属于本次探针的对象。完整环境变量、guard 格式、最小权限和证据边界见 `docs/testing/readiness-runbook.md`，近生产拓扑、数据量、SLO 和签字见 `docs/testing/performance-acceptance-matrix.md`。没有真实 staging、批准 SLO、Zalo 设备或专业签字时，工具/模板只能保持 `NOT_RUN`、`BLOCKED` 或 baseline，不能写成生产验收通过。

## M1 API 与安全边界

- API 从 `/v1` 开始，契约见 `docs/api/openapi.m1.yaml`。
- 买家令牌绑定 `store_id`，后续请求的 `X-Store-Code` 必须与令牌一致。
- 普通管理员只能访问明确授权商城；平台跨店访问必须携带 `X-Access-Reason` 并逐店审计。
- 手机号使用 AES-256-GCM 加密和 HMAC 查重，API 只返回掩码；刷新令牌只保存 hash。
- 管理端访问令牌只保存在内存，不写入 LocalStorage 或 SessionStorage。

## M4 交易边界

- 增量契约见 `docs/api/openapi.m4.yaml`，字段/约束见 `docs/database/m4-data-dictionary.md`，管理员授权见 `docs/security/m4-permission-matrix.md`。
- `POST /v1/checkout/quote` 和 `POST /v1/checkout/orders` 只信任商城绑定会员、地址 ID、SKU/数量、券 code 和报价 hash；金额、优惠、库存、运费、商城和订单状态均由服务端重新加载。
- M4 只允许 COD 下单。ONLINE 请求不会创建订单，仓库没有真实支付成功回调、物流报价、运单号或轨迹的假实现。
- 地址和订单地址快照中的敏感字段加密；API 只返回掩码手机号。正式 staging/production 前必须导入并复核越南权威三级行政区主数据。
- COD 确认消费库存预留；确认前取消释放预留；确认后发货前取消追加 RESTORE 反向流水。重复命令不会重复扣减或恢复。

## 环境与密钥

- `.env.example` 和 `.env.test.example` 只包含本地开发占位凭据。
- `NODE_ENV=production` 会在启动配置解析阶段拒绝上述示例中的 JWT、PII 和 S3 占位值；生产值必须由部署密钥系统独立注入。
- `.env`、生产凭据、Zalo Token、支付密钥和物流密钥禁止提交。
- API/worker 启动时会验证数据库、Redis 和对象存储配置。
- 对象存储就绪检查只对配置的 `S3_BUCKET` 执行 `HeadBucket`，不要求账户级 `ListBuckets`；临时 STS 凭据可通过可选的 `S3_SESSION_TOKEN` 注入。
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
