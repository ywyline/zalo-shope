# P0-M6-009 会员互动与隐私运行时完成报告

> 状态：repository implementation + local/test validation `COMPLETE`
>
> 日期：2026-08-01
>
> 依据：`REQUIREMENTS.md`、`AGENTS.md`、`TASKS.md` 与
> `docs/plans/p0-m6-009-member-runtime-plan.md`

## 1. 阶段结论

`P0-M6-009` 已完成当前商城、当前会员范围内的收藏、最近 100 个商品浏览历史、轻量交易汇总、
最新同意事实和隐私请求受理/查询/取消运行时，并交付越南语默认、中文和英文完整的 Mini App
会员中心、收藏、历史与隐私页面。

隐私请求创建只产生 `SUBMITTED` 受理事实；同意撤回只追加 `REVOKED` 事实。本任务没有声称或执行
数据导出、更正、删除、匿名化、账户关闭、法律保留判断或外部 Zalo 授权撤销，也没有启用任何真实
provider 或生产配置。

## 2. 已实现范围

### 2.1 API 与数据边界

- 收藏列表、单商品状态、幂等添加和删除；单商品状态避免用前 100 条列表推断收藏事实。
- 最近 100 个商品浏览历史的 touch、列表、单项删除和幂等清空；同一会员范围 advisory lock 防止
  并发 touch 破坏上限。
- 地址、优惠券、收藏、浏览历史和订单状态的轻量计数；不跨商城聚合。
- 每个 purpose 最新追加式同意事实的受限投影，不返回 evidence、内部 ID 或其他会员事实。
- 隐私请求创建、列表、详情和受限取消；公开编号使用 128-bit 随机值，说明使用既有 PII 密钥加密；
  取消只追加 transition，并只持久化规范化的非敏感原因，不保存客户端取消自由文本。
- 收藏、历史和隐私列表使用绑定商城、会员、资源、locale、微秒排序键与 ID 的 HMAC opaque cursor。
- 全部查询和写入显式绑定 Bearer 会员、`X-Store-Code`、服务端商城 ID 和会员 ID，并在
  `StoreContext` 事务与 FORCE RLS 下执行；会员读写分别实施 Redis 60/60 秒和 10/60 秒限流，写与
  隐私路径在 limiter 不可用时失败关闭。

### 2.2 Mini App

- 商品详情提供准确收藏状态、幂等切换，并只在已认证且商品成功渲染后记录浏览历史。
- 会员中心聚合订单、收藏、浏览历史、地址和隐私入口及计数。
- 收藏、历史和隐私列表消费服务端游标并支持继续加载；下架商品保留受限摘要但不生成伪链接。
- 隐私页提供最新同意事实、确认后撤回、结构化请求创建、查询和允许状态下取消。
- 越南语、中文、英文均覆盖加载、空、错误、成功、重试、确认和分页状态；无有效会话时不展示残留
  会员数据。

### 2.3 契约与兼容

- `docs/api/openapi.m6.yaml` 同步会员 consent、单商品收藏状态和既有 M6.5 运行时路径。
- 本任务复用 M6.2 schema、表、RLS、trigger 和索引，没有新增迁移或改写历史事实。
- 现有 API 保持兼容；单商品收藏状态为加法式 GET，Mini App 列表继续使用既有 opaque cursor。

## 3. 验证证据

| 检查项                                                        | 状态                   | 证据                                                                                                        |
| ------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| 会员 cursor 与 i18n 定向单元                                  | `PASS`                 | 2 个文件，18/18                                                                                             |
| M6.5 PostgreSQL/RLS/Redis 集成                                | `PASS_LOCAL_TEST`      | 6/6；含双商城/双会员隔离、收藏状态/幂等、历史 100 上限、同意、隐私说明加密、取消原因规范化、重放/冲突、限流 |
| 完整 integration                                              | `PASS`                 | 38 个文件，337/337；真实本地 PostgreSQL、Redis、MinIO、ClamAV                                               |
| `NODE_OPTIONS=--max-old-space-size=4096 corepack pnpm verify` | `PASS`                 | format、lint、typecheck、76 个文件/627 项 unit、production build、Prisma validate                           |
| 完整浏览器 E2E                                                | `PASS_LOCAL_TEST`      | 25/25；Admin Chromium、Android Chromium、iPhone WebKit，含三语会员、COD 与 ONLINE 回归                      |
| 生产依赖 high 审计                                            | `PASS_WITH_DISCLOSURE` | 退出码 0；3 moderate、0 high/critical                                                                       |
| OpenAPI 严格 YAML/本地引用                                    | `PASS_WITH_LIMITATION` | 6 份文档、1794 个本地引用/383 个唯一目标；重复键、外部或缺失引用均为 0；无专用 3.1 语义 linter              |
| Gitleaks 8.30.1                                               | `PASS`                 | 可达 Git 历史、tracked patch 与非忽略 untracked 交付候选无泄漏                                              |
| Compose 与差异                                                | `PASS`                 | `docker compose config --quiet`、`git diff --check` 和最终高风险复审通过                                    |
| Zalo 宿主/法律履约/production rollout                         | `BLOCKED / NOT_RUN`    | 缺少批准应用、真机矩阵、法律决定和生产环境；本地 E2E 不替代                                                 |

首次使用 Node 默认约 2 GiB 堆运行完整 `verify` 时，ESLint 以 V8 heap OOM/退出码 134 结束；没有产生
代码诊断。随后从头以临时 4096 MiB 堆运行完整命令并通过。该工作站资源要求继续作为技术债保留，
没有放宽 lint 或仓库配置。

## 4. 已知限制与阻塞

1. 隐私请求履约、数据导出/更正/删除/匿名化、账户关闭、保留政策和管理员工作台属于后续 M7 与
   `EXT-LEGAL-001`，本任务只提供真实受理事实。
2. M6.6 官方 Deep Link/Share 仍由 `EXT-ZALO-002` 阻塞；M6.7 还依赖 COD 退款、返件验收/库存/换货、
   分享和 Zalo 真机矩阵。
3. 真实 Zalo 宿主、生产部署、监控、性能和合规验收均未获授权或缺少外部输入，项目仍不具备
   Production Ready 条件。
4. React Router 仍有 3 项 moderate 公告；OpenAPI 仍缺专用 3.1 语义 linter。
5. M6.2 通用 `privacy_request_transitions.reason` 仍是明文字段；M6.5 会员取消只写规范化非敏感原因。
   M7 如需保存管理员或会员自由文本，必须先完成敏感数据分类和批准的加密向前迁移。

## 5. 回滚与任务流

- 应用回滚可移除 M6.5 controller/service、Mini App 页面/客户端和加法式 OpenAPI 路径；无需数据库
  down migration。
- 已产生的收藏、历史、consent 和隐私事实不得用回滚脚本删除或改写；应继续由既有 API、状态转换
  或向前修复处理。
- `P0-M6-009` 可在 `TASKS.md` 标记 `Done`。完成后没有依赖已满足的 P0 任务；工作流必须按 Stop
  Protocol 停止，不得用测试桥、假凭据或未批准假设绕过外部依赖。
