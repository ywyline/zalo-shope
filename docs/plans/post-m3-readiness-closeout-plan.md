# M3 后续上线准备与验证收口计划

> 状态：仓库内技术收口已完成并通过本地全量门禁；外部验收保留
>
> 日期：2026-07-22
>
> 批准记录：用户于 2026-07-22 明确要求按建议执行。本计划不授权生产写入、生产压测、Zalo Testing 上传、审核/发布或替代越南专业意见。

实现与验证记录（2026-07-22）：M2-only 升级 fixture、精确 gitleaks allowlist、生产示例占位值拒绝、目标 bucket `HeadBucket` 与 STS session token、HTTP baseline、guard-first staging S3/CDN 预检及外部证据矩阵已实现。`verify`（23 文件/173 项）、M2 升级连续两轮、19 文件/103 项集成测试、15/15 Playwright、gitleaks 正反向、生产依赖审计、Compose 与本地 HTTP smoke 均通过；仓库内三个技术缺口关闭。远程 CI 尚未运行，真实外部项目继续保持待验收，详见 `docs/reports/post-m3-readiness-closeout-report.md`。

## 1. 目标与非目标

目标：

- 把只含 M2 schema 与代表性双商城数据升级到当前 M3 的流程固化为可重复、自动清理的 local/CI 门禁。
- 精确消除 gitleaks 测试伪值误报，并在生产配置解析阶段拒绝仓库公开的本地占位密钥。
- 将对象存储就绪检查从集群级 bucket 枚举改为目标 bucket 最小权限探测，并提供只能显式启用的 staging 生命周期预检。
- 建立不新增第三方依赖的 HTTP 性能 smoke/baseline 工具，输出延迟、吞吐和错误率证据；生产容量结论仍以批准的 SLO 和近生产 staging 为准。
- 为 Zalo Android/iPhone 真机和越南法律、税务、隐私及行业合规验收提供逐项证据清单与签字矩阵。

非目标：

- 不创建或修改订单、支付、物流、退款、售后、地址或结算能力，不进入 M4。
- 不修改 Prisma schema、既有迁移、业务数据模型或公开 API。
- 不接收、记录或提交真实密钥，不连接生产数据库，不向生产制造测试数据。
- 不在没有真实设备和开发者账号时声称 Zalo 宿主通过；不把自动化结果描述为越南法律意见。
- 不在本计划内决定生产容量、云供应商、CDN 或最终 SLO，也不直接对生产执行压力测试。

## 2. 涉及模块与文件

- `tests/migration/`：M2 fixture、升级断言和严格命名 scratch 数据库编排。
- `package.json`、`.github/workflows/quality.yml`：独立迁移门禁和精确 secret scan 配置。
- `.gitleaks.toml`：仅按规则、路径和测试指纹允许已审查的伪值；不得排除整个测试目录。
- `packages/config/src/`：生产占位密钥拒绝规则及脱敏错误测试。
- `packages/platform/src/`：目标 bucket 就绪探测及单元测试。
- `tests/readiness/`：显式启用的 staging 对象存储预检和 HTTP 性能基线工具。
- `docs/testing/`：容量/SLO 输入表、Zalo 真机证据清单、越南专业合规签字矩阵和安全运行说明。
- `README.md`、M3 计划/完成报告：同步新命令、已关闭保留项和仍需外部证据的边界。

## 3. 数据模型、接口与配置变化

- 不改变数据库 schema、迁移或公开 HTTP 契约。
- M2 升级测试只在 `NODE_ENV=test`、loopback PostgreSQL 和固定 scratch 前缀同时满足时运行；使用当前迁移树的前四条重建 M2，再用完整九条迁移升级。
- 生产配置继续接受部署方提供的真实值，但明确拒绝 `.env.example`/`.env.test.example` 中公开的 JWT、PII 和 S3 占位值；错误只包含字段名。
- 对象存储 readiness 只验证配置的 `S3_BUCKET` 可访问，不再要求 `ListBuckets` 权限。staging 生命周期预检使用独立前缀并在 `finally` 清理。
- 性能工具所有目标、并发、时长和阈值均由环境变量显式提供；默认仅允许 loopback，远程 staging 需要额外确认开关，生产主机始终拒绝。

## 4. 迁移、兼容与回滚

- M2 fixture 先复制当前仓库前四条迁移到忽略的临时目录，不写造假的 `_prisma_migrations` 记录，不依赖 Git 历史或浅克隆可用性。
- 每次运行创建随机 scratch 数据库；失败与成功路径都终止连接并删除数据库和临时目录。安全守卫失败时不执行任何创建/删除。
- 新生产配置校验属于 fail-fast 安全收紧；部署前必须将示例值替换为 Secret Manager/KMS 注入的独立值。
- bucket readiness 从 `ListBuckets` 改为目标 bucket 探测，减少所需权限；如供应商不支持标准 S3 `HeadBucket`，在批准适配方案前保持启动失败，不回退到宽权限枚举。
- 所有测试/文档变更可直接代码回滚；不需要数据库 down，也不删除现有业务事实。

## 5. 风险、未决问题与外部依赖

| 项目                            | 处理                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| scratch 误连真实数据库          | 同时校验 `NODE_ENV=test`、loopback host、固定数据库前缀和容器服务；最终删除前再次核对精确名称  |
| M2 fixture 不能代表全部历史数据 | 覆盖双商城、三语、主辅类目、筛选属性、发布/草稿、启用/停用 SKU、不可变版本，并保留 fingerprint |
| secret scan allowlist 过宽      | 只允许精确规则、文件路径和已审查测试文本；用新伪秘密验证扫描仍会失败                           |
| staging 凭据泄露或越权          | 仅从进程环境读取，输出不回显；使用临时最小权限账号和独立对象前缀                               |
| 性能数字被误当生产容量          | 报告明确环境与输入；未批准 SLO 或非近生产拓扑只能标记 baseline，不能标记验收通过               |
| Zalo/合规外部证据缺失           | 保持保留项，记录责任人、日期、证据链接和签字，不用模拟结果代替                                 |

外部依赖包括 Zalo 开发者账号与 Android/iPhone、受控 HTTPS API、选定云厂商 staging bucket/CDN、生产近似数据库/Redis/运行指标，以及越南律师、会计和相关行业合规人员。

## 6. 测试与验收

- `corepack pnpm test:migration:m2-upgrade`：M2 前四迁移、代表性 fixture、完整升级、重复部署、fingerprint、搜索回填、无虚构 M3 事实、RLS/权限和自动清理。
- 配置单元测试：生产示例值逐项拒绝、真实非占位值通过、错误不泄露值。
- secret scan：当前仓库通过；注入未允许伪秘密的负向自检仍以非零退出。
- platform 单元/集成：调用目标 bucket 探测，不调用 `ListBuckets`；本地 MinIO 全链路继续通过。
- staging S3/CDN 预检：验证显式开关、production 拒绝、精确 endpoint/bucket、短期 guard 和独立前缀；随后创建唯一 checksum 对象、HEAD/签名读取、可选 CDN 交付/cache Header，并在 `finally` 删除且确认不存在。错误凭据、跨前缀 IAM 拒绝、签名过期、生命周期和 CDN purge 仍由供应商/IaC 证据单独记录，脚本不以危险负向写入代替权限审查。
- HTTP baseline：记录请求数、并发、p50/p95/p99、吞吐、错误率与目标环境；远程/生产保护必须有测试。
- Zalo 与合规：证据矩阵每项必须有执行人、日期、环境、结果和不可变证据位置；空白项不能标记完成。
- 最终运行 `corepack pnpm verify`、完整集成测试、15 项 Playwright、生产依赖审计、Compose 校验、gitleaks 和 `git diff --check`。

## 7. 完成边界

最终本地门禁已满足，现关闭 M2-only 自动升级 fixture 缺失、secret-scan 误报配置和生产占位密钥接受三个仓库内技术保留项。由于本变更尚未提交/推送，远程 Quality workflow 仍为 `NOT_RUN`。未取得真实外部输入前，Zalo 真机、真实 staging 对象存储/CDN、生产凭据/权限、近生产规模性能和越南专业合规仍保持“待外部验收”，不得写为通过。
