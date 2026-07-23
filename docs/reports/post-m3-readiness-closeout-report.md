# Post-M3 上线准备技术收口报告

> 日期：2026-07-23
>
> 状态：仓库内技术门禁已通过；Zalo iPhone 美妆商城成功路径为 `PARTIAL`，其余真实外部验收仍为 `NOT_RUN` / `BLOCKED`

## 1. 已关闭的仓库内技术缺口

- M2-only 自动升级 fixture 已进入 CI：从前四条真实迁移重建代表性双商城 M2 数据，再升级到全部九条迁移，验证重复 deploy、checksum/fingerprint、搜索回填、零虚构 M3 事实、RLS/函数权限和自动清理。
- gitleaks 使用默认规则加精确路径/规则/测试指纹 allowlist；生产配置拒绝两个 env example 中的 JWT、PII 和 S3 占位值，包括与公开 PII key 等价的非规范 base64 表示，错误只显示字段名。
- 对象存储启动探测改为目标 bucket `HeadBucket`，S3 客户端支持可选 STS session token。create-only 签名 PUT、冲突保留原正文、对象归属核验和明确 404 删除证明均有自动化回归。
- HTTP/staging storage readiness 工具具备 production 拒绝、显式开关、受版本控制的 staging origin 策略、同源短期 guard、流量保险丝、证据预留、唯一对象和失败安全清理。Zalo、性能和越南合规已提供证据/签字矩阵。

本结论关闭“仓库内 fixture/门禁缺失”，不等于远程 CI 已运行、真实生产凭据已验证或生产上线获批。

## 2. 本轮验证证据

| 验证                   | 结果                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node / pnpm / 锁文件   | Node `v24.14.1`、pnpm `11.13.1`；`install --frozen-lockfile` 通过                                                                                                                        |
| `corepack pnpm verify` | 通过；26 个单元测试文件、206 项测试，格式、lint、应用/脚本类型、生产构建和 Prisma schema 均通过                                                                                          |
| Zalo iPhone 真机       | Testing 版本 6 在美妆商城完成真实登录和中国手机号授权保存；脱敏数据库结果为 1 条 `ZALO` 来源、1 条已验证联系方式，其他商城已验证数为 0；未归档完整设备元数据和签字，因此仅关闭该成功路径 |
| M2-to-current 升级     | 最新代码连续两轮通过；每轮 4→9 条迁移、重复 deploy、fingerprint/RLS/权限与 finally 清理通过                                                                                              |
| 完整集成测试           | 19 个文件、103 项通过；含 PostgreSQL/Redis/MinIO 与 create-only PUT 冲突保护                                                                                                             |
| 浏览器 E2E             | 15/15 通过：管理端 Chromium、Android Chromium、iPhone WebKit                                                                                                                             |
| HTTP local smoke       | 100/100 成功、错误率 0%、p95 2.63 ms；因本地短样本且无批准 SLO，仅标记 baseline                                                                                                          |
| readiness 负向门禁     | HTTP/storage 的 production CLI 均退出 1；策略、guard commit、query、404、foreign object 和敏感 CDN Header 回归通过                                                                       |
| gitleaks `v8.24.3`     | 当前候选文件扫描 0；未获准高熵 `apiKey` 探针被检出                                                                                                                                       |
| 生产依赖审计           | `No known vulnerabilities found`                                                                                                                                                         |
| Compose                | 配置有效；PostgreSQL 17、Redis 8、MinIO 启动期间均为 healthy                                                                                                                             |

本地 HTTP 证据位于被 Git 忽略的 `test-results/readiness/http/`；只归档脱敏 JSON，不提交生成文件。M2 scratch 数据库、临时迁移树和 gitleaks 临时探针均已清理。

## 3. 仍未验证的外部项目

| 项目                              | 状态      | 关闭所需输入                                                                                       |
| --------------------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| Zalo Android/iPhone 宿主真机      | `PARTIAL` | 补齐 Android、服装商城、拒绝授权、同 token 重放、异常网络、设备元数据、受控证据 URI/SHA-256 和签字 |
| 真实 staging S3/CDN/IAM/KMS       | `NOT_RUN` | 已审 staging target、短期 guard、临时最小权限凭据、生命周期/CDN/IaC 证据                           |
| 真实生产凭据与秘密注入            | `BLOCKED` | Secret Manager/KMS、轮换/撤销、最小权限和部署审计证据；不得向仓库提供秘密                          |
| 近生产规模性能与越南 4G 首屏      | `NOT_RUN` | 批准的拓扑、数据量、流量模型、SLO、停止条件、指标和责任人签字                                      |
| 越南/中国个人信息、税务与行业合规 | `BLOCKED` | 越南律师、会计、DPO/安全、适用美妆/美瞳/口腔/私护专家，以及中国个人信息与跨境处理专业复核逐项签字  |
| 远程 Quality workflow             | `NOT_RUN` | 本变更尚未提交/推送；推送后归档对应 commit 的远程运行证据                                          |

这些项目不能由本地 MinIO、Web 预览、空白模板或本报告替代。M4 仍未批准。
