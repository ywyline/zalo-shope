# P0-M5-005 财务对账完成报告

> 状态：repository implementation + local/test validation `COMPLETE`
>
> 日期：2026-08-01
>
> 依据：`REQUIREMENTS.md`、`AGENTS.md`、`TASKS.md` 与
> `docs/plans/p0-m5-005-financial-reconciliation-plan.md`

## 1. 阶段结论

`P0-M5-005` 已在既有 provider-neutral M5 事实之上完成支付结算、手续费、退款差异、COD 应收、
GHN 规范化回款和 maker-checker 异常关闭的完整仓库/local-test 纵向切片。全部金额使用整数 VND，
所有读写绑定目标商城，异常关闭只追加独立复核事实，不修改支付、退款、订单、库存、运单或现金状态。

本任务不解析或推测真实 ZaloPay/GHN 结算文件，不调用供应商 sandbox/production API，不确认真实资金，
也不执行部署、rollout 或生产角色授权。`P0-M5-003`、`P0-M5-004` 及相应外部门禁继续独立跟踪真实
provider 验收，因此本报告不代表 M5、P0 或项目 Production Ready。

## 2. 已实现范围

### 2.1 财务事实与数据库边界

- Slice A 提供商城隔离、只追加的支付/退款结算批次和逐笔差异，保存整数 VND 汇总、摘要与掩码，
  不保存供应商文件或完整引用。
- Slice B 投影当前商城已签收 GHN COD 应收，并导入规范化 COD 回款、运费和 COD 费；重复、金额、
  费用、非终态、非应收和缺失引用均进入可解释异常，不改变物流或订单事实。
- Slice C 增加每个异常批次最多一条 `financial_reconciliation_reviews` 复核事实，只允许
  `CLOSED_ACCEPTED` 或 `CLOSED_ESCALATED`，并以复合商城外键、唯一约束、FORCE RLS、append-only
  trigger、延迟 maker-checker guard 和 runtime `SELECT/INSERT` 最小授权保护。
- 三个迁移均为加法式。空白 local/test scratch 只能按 Slice C -> B -> A 逆向；存在相应事实时
  `down.sql` 以 SQLSTATE `55000` 失败关闭，已有事实或 production 环境只允许向前修复。

### 2.2 服务、API 与安全控制

- 导入和复核命令要求目标商城直接 `store.finance.reconcile`、近期 MFA、固定确认码、原因和
  `Idempotency-Key`；advisory lock 等待后在 Serializable 事务内重新验证商城、管理员、session、
  token/MFA、直接角色和权限。
- 复核人不能是批次导入人。相同幂等键和请求重放冻结结果；同键异参、已有关闭事实或并发不同结论
  返回冲突，任意竞争最多落一条不可变 review。
- 列表支持商城、来源、批次状态、业务日期和 `OPEN/CLOSED_ACCEPTED/CLOSED_ESCALATED` 复核结论
  筛选；详情和导入响应返回不可变异常分类汇总、复核状态与可空 review。
- 审计只保存复核 ID、decision、批次整数汇总和异常分类，不保存幂等键、规范化原文或完整供应商引用。
  跨商城平台权限只允许带原因只读，不能替代目标商城直接写权限。

### 2.3 管理端与契约

- 三语管理端提供支付/物流来源、批次状态和复核结论筛选、COD 应收、规范化导入、异常汇总、独立
  复核确认表单与已关闭结果；商城切换清除旧详情和复核表单状态。
- 640px 窄屏下筛选、异常表格、复核字段和结果按响应式约束展示，表格在自身容器内滚动，不产生
  页面级横向溢出。
- `docs/api/openapi.m5.yaml`、Prisma schema、数据字典、权限矩阵、系统架构与 README 已同步；所有
  新路径、表和响应字段均为加法式，既有支付、退款、订单、库存和物流状态机保持不变。

## 3. 验证证据

| 检查项                                                        | 状态                   | 证据                                                                                                |
| ------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| P0-M5-005 定向 integration                                    | `PASS_LOCAL_TEST`      | 14/14；含双商城/RLS、RBAC/MFA、撤权重验、幂等冲突、并发单赢家、append-only、最小授权和 guarded down |
| 完整 integration                                              | `PASS_LOCAL_TEST`      | 39 个文件，351/351；本地 PostgreSQL、Redis、MinIO、ClamAV                                           |
| `NODE_OPTIONS=--max-old-space-size=4096 corepack pnpm verify` | `PASS`                 | format、lint、typecheck、76 个文件/633 项 unit、production build、Prisma validate                   |
| 完整浏览器 E2E                                                | `PASS_LOCAL_TEST`      | 26/26；Admin Chromium、Android Chromium、iPhone WebKit，含三语财务对账、复核和窄屏回归              |
| M2-to-current 迁移演练                                        | `PASS_LOCAL_TEST`      | 55 条迁移 fresh deploy、重复 deploy、Slice C -> B -> A guarded down/forward、catalog/RLS/grant 恢复 |
| 生产依赖 high 审计                                            | `PASS_WITH_DISCLOSURE` | 退出码 0；3 moderate、0 high/critical                                                               |
| M5 OpenAPI 严格 YAML/本地引用                                 | `PASS_WITH_LIMITATION` | OpenAPI 3.1.0；302 个本地引用，0 外部/缺失引用；仓库仍无专用 OpenAPI 3.1 语义 linter                |
| Gitleaks、敏感信息与调试扫描                                  | `PASS`                 | Gitleaks 8.30.1 扫描 49 个可达提交无泄漏；新增高信号密钥、TODO/FIXME/HACK/debug 和冲突标记均为 0    |
| Compose 与差异                                                | `PASS`                 | `docker compose config --quiet`、`git diff --check` 和最终高风险差异复审通过                        |
| ZaloPay/GHN sandbox、真实资金、Zalo 宿主与 production         | `BLOCKED / NOT_RUN`    | 缺少批准账号、凭据、网络、真实交易/回款材料和生产授权；local/test 结果不替代外部验收                |

完整 `verify` 在本工作站继续临时使用 4096 MiB Node heap，以避免全量 ESLint 超出默认约 2 GiB 堆；没有
修改仓库运行配置或放宽任何检查。

## 4. 已知限制与阻塞

1. 真实 Zalo Checkout/ZaloPay 双商城 sandbox、回调、主动查询、退款和结算验收仍由 `P0-M5-003`、
   `EXT-PAY-001` 与 `EXT-NET-001` 阻塞。
2. 真实 GHN 双商城报价、建单、轨迹、面单、COD 与回款验收仍由 `P0-M5-004`、`EXT-GHN-001` 与
   `EXT-NET-001` 阻塞；当前输入是明确标识的规范化 local/test 事实，不代表 GHN 官方文件契约。
3. 自动拉取供应商结算材料属于新近可执行的 `P1-FIN-001`，不在本任务范围；电子发票、税务和会计
   集成仍依赖 `EXT-LEGAL-001` 与 `P2-ACC-001`。
4. React Router 仍有 3 项 moderate 公告；专用 OpenAPI 3.1 语义 lint、生产部署、监控、性能、法律
   签字和完整 Zalo 真机矩阵均未完成，项目仍为 `Not Ready`。

## 5. 回滚与任务流

- 应用层可回滚新增 review API、投影字段和管理端表单；已产生的财务批次、逐笔和 review 事实不得
  删除或改写，应通过兼容读取或向前修复处理。
- 仅无相应事实的 local/test scratch 可按 Slice C -> B -> A 使用受保护的 `down.sql`；production
  和事实环境禁止逆向删除。
- `P0-M5-005` 可在 `TASKS.md` 标记 `Done`。下一个最高优先级且依赖已满足的 Ready Task 是
  `P0-M6-007`；它必须在独立任务分支开始时从 `Todo` 更新为 `In Progress`。
