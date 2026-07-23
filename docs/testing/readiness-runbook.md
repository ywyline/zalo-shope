# 上线准备测试安全运行说明

> 适用范围：M3 后续的 HTTP 基线与 staging 对象存储/CDN 预检。
>
> 本说明不授权生产压测、生产写入、Zalo Testing 上传或外部发布。

## 1. 共同安全边界

- 所有命令从仓库根目录运行；凭据只从当前进程环境或批准的 Secret Manager 注入，不写入命令参数、文件、报告或 Git。
- HTTP 工具只发送 `GET`，不接受 Authorization、自定义 Header 或请求体。对象存储工具只写 staging guard 明确授权的独立前缀。
- `READINESS_TARGET_ENV=production` 始终拒绝。远程 HTTP origin 必须先经代码审查加入 `config/readiness-targets.json`，再验证目标同源固定路径上 24 小时内到期的 staging guard；对象存储必须先读取位于可写前缀之外的 staging guard，guard 未通过时零写入。
- 每次执行会在任何 guard/network 操作前以 `${run_id}-${execution_uuid}.json` 预留被 Git 忽略的 `test-results/readiness/` 证据文件，重复 run ID 不会覆盖；中途失败至少保留脱敏失败状态。报告可归档到受控证据库，但不得包含签名 URL、Access Key、Session Token、完整手机号或其他个人数据。
- 运行前记录 Git commit、部署 ID、执行人、时间、目标环境和批准工单；运行后检查告警、清理结果和目标服务状态。

## 2. 仓库内技术收口门禁

启动本地基础设施后运行 M2-only 原地升级回归：

```powershell
corepack pnpm infra:up
corepack pnpm test:migration:m2-upgrade
```

该命令只允许 `NODE_ENV=test`、loopback PostgreSQL 和随机 `zalo_shop_m2_upgrade_*` scratch 名称；它不操作现有开发数据库，并在成功或失败后删除 scratch 与临时迁移树。CI 的 secret scan 使用根目录 `.gitleaks.toml` 中按规则、路径和精确测试指纹限定的 allowlist；不得为通过扫描排除整个测试目录。`NODE_ENV=production` 配置单元测试必须证明公开 JWT、PII 与 S3 示例值 fail fast，且错误只包含字段名。

M2-only fixture、secret-scan 误报和生产占位值接受三个技术缺口，只有迁移门禁、`corepack pnpm verify`、完整集成/E2E、生产依赖审计、Compose、gitleaks 与差异检查全部通过后才能关闭。真实 staging/生产输入不属于这三个仓库内结论。

## 3. HTTP smoke/baseline

正式规模验收前，先填写并批准 `docs/testing/performance-acceptance-matrix.md` 中的拓扑、数据规模、流量模型、SLO、停止条件和证据责任人；未填写时本工具只产出 baseline。

### 3.1 本地 smoke

先启动本地基础设施和 API，再在新的 PowerShell 中运行：

```powershell
$env:READINESS_TARGET_ENV='local'
$env:READINESS_HTTP_BASE_URL='http://127.0.0.1:3000'
$env:READINESS_HTTP_PATH='/health/live'
$env:READINESS_HTTP_PROFILE='smoke'
corepack pnpm test:readiness:http
```

本地模式只接受 `localhost`、`127.0.0.1` 或 `::1`。目录接口示例需要额外设置 `READINESS_HTTP_STORE_CODE`，并将 path 指向只读公开接口。

### 3.2 staging 目标策略与 guard

基础设施所有者先通过受审查提交把精确 staging API origin 加入 `config/readiness-targets.json`；空列表表示禁止所有远程目标。远程运行会拒绝未被 HEAD 跟踪、存在 staged/unstaged 差异或无法取得 commit 的策略文件，并在报告记录 HEAD 与策略 SHA-256。工具不接受环境变量临时扩展 allowlist，也不会跟随重定向。随后，staging ingress 必须在同一 origin 的固定路径 `/.well-known/zalo-shop-http-readiness.json` 提供短期 JSON；guard 的 `git_commit` 必须等于当前受审查 HEAD，该文件不含秘密，但必须由基础设施所有者生成并限制为 24 小时内有效：

```json
{
  "schema_version": 1,
  "environment": "staging",
  "purpose": "http-readiness",
  "guard_id": "approved-change-id",
  "git_commit": "0123456789abcdef0123456789abcdef01234567",
  "allowed_origins": ["https://api.staging.example"],
  "expires_at": "2099-01-01T00:00:00.000Z"
}
```

示例日期仅说明格式；实际 `expires_at` 必须在运行时未来 24 小时内。执行时设置：

```powershell
$env:READINESS_TARGET_ENV='staging'
$env:READINESS_ALLOW_REMOTE_STAGING='true'
$env:READINESS_HTTP_BASE_URL='https://api.staging.example'
$env:READINESS_EXPECTED_HTTP_ORIGIN='https://api.staging.example'
$env:READINESS_STAGING_GUARD_EXPECTED_ID='approved-change-id'
$env:READINESS_HTTP_PATH='/v1/catalog/home?locale=vi'
$env:READINESS_HTTP_STORE_CODE='beauty-staging'
$env:READINESS_HTTP_PROFILE='baseline'
$env:READINESS_HTTP_DURATION_SECONDS='60'
$env:READINESS_HTTP_CONCURRENCY='10'
corepack pnpm test:readiness:http
```

可配置输入及硬上限：

| 变量                                       | 含义             | staging 上限   |
| ------------------------------------------ | ---------------- | -------------- |
| `READINESS_HTTP_DURATION_SECONDS`          | 负载持续时间     | 300 秒         |
| `READINESS_HTTP_CONCURRENCY`               | 闭环并发 worker  | 25             |
| `READINESS_HTTP_MAX_REQUESTS`              | 总请求保险丝     | 25,000         |
| `READINESS_HTTP_REQUEST_TIMEOUT_MS`        | 单请求超时       | 120,000 ms     |
| `READINESS_HTTP_MAX_RESPONSE_BYTES`        | 单响应读取上限   | 25 MiB         |
| `READINESS_HTTP_EXPECTED_STATUS`           | 唯一成功状态     | 默认 200       |
| `READINESS_HTTP_MAX_ERROR_RATE_PERCENT`    | 错误率门限       | 默认 0         |
| `READINESS_HTTP_MAX_P95_MS` / `MAX_P99_MS` | 可选延迟门限     | 未设置则不判定 |
| `READINESS_HTTP_MIN_SUCCESSFUL_RPS`        | 可选成功吞吐门限 | 未设置则不判定 |

`READINESS_HTTP_PATH` 只允许无查询参数，或唯一的 `locale=vi|zh|en` 查询参数；不得把 Token、签名、用户查询或其他敏感值放入 URL。报告包含请求数、状态/结果分布、p50/p95/p99、成功吞吐和错误率。未提供已批准的延迟/吞吐门限时，结果只能称为 `baseline`，不能称为容量验收。

HTTP 工具不测浏览器渲染、Zalo 宿主开销、图片 LCP 或“正常越南 4G 首屏不超过 3 秒”。该要求仍需在近生产 staging 使用现有 Playwright 做明确网络/CPU 配置的合成测试，并用越南真实网络或 RUM/真机证据复核。

## 4. staging S3/CDN 预检

### 4.1 基础设施前置

- 使用独立、可撤销、最小权限的 staging 凭据。若使用 STS，设置可选 `S3_SESSION_TOKEN`。
- 账号只允许读取 guard，并只允许在 `staging/{store_uuid}/readiness/*` 执行 Put/Get/Head/Delete；不能修改 guard，不能访问 production bucket/prefix。
- bucket 级 readiness 使用 `HeadBucket`，不要求账户级 `ListBuckets`。供应商若对 `HeadBucket` 要求 bucket 级 `ListBucket`，只授予目标 bucket。
- guard 由 IaC/基础设施所有者预置在可写前缀之外，内容如下：

```json
{
  "schema_version": 1,
  "environment": "staging",
  "purpose": "storage-readiness",
  "guard_id": "approved-change-id",
  "bucket": "staging-bucket-name",
  "endpoint": "https://objects.staging.example/",
  "store_id": "10000000-0000-4000-8000-000000000001",
  "allowed_prefix": "staging/10000000-0000-4000-8000-000000000001/readiness/",
  "cdn_origin": "https://cdn.staging.example",
  "expires_at": "2099-01-01T00:00:00.000Z"
}
```

不测试 CDN 时省略 `cdn_origin`。实际到期时间必须在未来 24 小时内；endpoint 必须与工具规范化后的配置完全一致。

### 4.2 执行

先由批准的秘密注入流程设置 `S3_ACCESS_KEY`、`S3_SECRET_KEY` 和可选 `S3_SESSION_TOKEN`，不要在终端记录值。再设置非秘密控制项：

```powershell
$env:NODE_ENV='production'
$env:READINESS_TARGET_ENV='staging'
$env:READINESS_STORAGE_PREFLIGHT='true'
$env:READINESS_EXPECTED_S3_ENDPOINT='https://objects.staging.example'
$env:READINESS_EXPECTED_S3_BUCKET='staging-bucket-name'
$env:READINESS_STORAGE_STORE_ID='10000000-0000-4000-8000-000000000001'
$env:READINESS_STORAGE_GUARD_OBJECT_KEY='readiness-guards/storage.json'
$env:READINESS_STORAGE_GUARD_EXPECTED_ID='approved-change-id'
corepack pnpm test:readiness:storage
```

工具按顺序执行：先预留证据文件；读并验证 guard；在运行标识后附加随机 UUID，对唯一对象签发带 `If-None-Match: *` 的 checksum-bound PUT；HEAD 校验；签名 GET 校验正文；可选 CDN 读取；在 `finally` 只删除正文能够证明属于本次探针的对象，并仅以签名 GET 明确返回 `404` 确认对象不存在。`409/412` 冲突对象、未知正文或无法确认归属的对象不会被删除；鉴权、权限或网络错误不能冒充清理成功。报告记录非敏感 object key 供人工处置，任何阶段失败都不得跳过归属/清理验证。

可选 CDN 配置：

```powershell
$env:READINESS_CDN_BASE_URL='https://cdn.staging.example/media/'
$env:READINESS_EXPECTED_CDN_ORIGIN='https://cdn.staging.example'
$env:READINESS_CDN_PROPAGATION_SECONDS='30'
$env:READINESS_CDN_EXPECTED_CACHE_HEADER='x-cache'
$env:READINESS_CDN_EXPECTED_CACHE_VALUE='hit'
```

期望 cache Header 只允许 `age`、`x-cache`、`cf-cache-status`、`x-cache-status`、`x-proxy-cache` 或 `x-vercel-cache`；任意响应头、认证头和 Cookie 不能进入证据。若不设置期望 cache Header，只验证 CDN 交付并记录上述常见 cache Header，不能据此宣称缓存策略通过。工具不会调用 CDN purge；探针正文是唯一随机非敏感数据，清理后可能按 staging TTL 短暂留在边缘缓存。

## 5. 不能由本机关闭的事项

- staging/生产凭据是否来自批准的 Secret Manager/KMS、IAM 是否真正最小权限、bucket 版本/生命周期/备份和 CDN 缓存/自定义域名策略。
- 近生产数据库、Redis、网络和节点规格下的容量、扩缩容、查询计划、批次时长和回滚窗口。
- Zalo Android/iPhone 宿主行为以及越南专业法律、税务、隐私和行业意见。

这些项目缺少外部环境或签字时必须保持 `BLOCKED`/`NOT_RUN`，不得以本地 MinIO、HTTP baseline 或空白模板标记完成。
