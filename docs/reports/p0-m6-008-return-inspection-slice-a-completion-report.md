# P0-M6-008 返件验收与库存恢复 Slice A 完成报告

> 状态：Slice A default-disabled repository implementation + local/test validation `COMPLETE`；
> 适用仓库门禁 `PASS`；P0-M6-008 继续 `In Progress`，Slice B 与生产验收未完成
>
> 日期：2026-08-01
>
> 依据：`docs/plans/p0-m6-008-return-inspection-fulfillment-plan.md`、`REQUIREMENTS.md`、
> `AGENTS.md`、`TASKS.md`

## 1. 阶段结论

P0-M6-008 Slice A 已完成默认关闭的返件完整验收、退款/换货资格派生和 exactly-once 可售库存恢复。
管理员只能对目标商城、已由 B5 可信送达推进到 `INSPECTION_PENDING` 的返件提交完整 approved 行处置；
客户端不能提供 SKU、warehouse、金额、目标状态或库存动作。

只有 `RESTOCK_SELLABLE` 会从原订单已消费 reservation 的唯一权威原仓恢复库存，并原子生成一个 M3
RESTORE operation、movement 和售后 inventory action。隔离、报废与退还会员只形成不可变验收事实，
不增加可售库存。任何接受数量把退货退款派生到 `REFUND_PENDING`、换货派生到
`EXCHANGE_PENDING`；全部拒绝才进入 `REJECTED`，不伪造退款或换货已完成。

该结论只覆盖 repository implementation + local/test validation。`P0-M6-008` 的 Slice B replacement
reservation、释放/消费、`EXCHANGE_OUTBOUND` 与换货协调尚未实现，任务保持 `In Progress`。真实仓库、
物流 provider、Zalo 宿主、sandbox/staging、部署、生产启用和 rollout 均未授权或未运行，项目不是
Production Ready。

## 2. 已实现范围

### 2.1 严格 API 与条件性授权

- 新增 `POST /v1/admin/after-sales/{afterSaleId}/inspection`，请求严格包含确认词、reason、aggregate/
  inspection expected version 和每个 approved `order_item_id` 的完整唯一处置；未知字段、内部 ID、SKU、
  warehouse、金额、状态或库存结果在契约层拒绝。
- 所有验收要求目标商城直接 `store.after-sales.inspect`、有效 Bearer/session、近期 MFA 和 ADMIN WRITE
  限流；包含 `RESTOCK_SELLABLE` 时额外要求同商城直接 `store.inventory.adjust`。cross-access-only 不能
  替代直接权限。
- 数据库在全部 advisory/行锁等待后以权威时间最终重验 ACTIVE 商城、管理员、session/token、MFA、
  角色分配及条件性直接权限；等待期间撤权或会话/MFA 失效在首笔业务事实前失败。

### 2.2 完整验收与 exactly-once 库存

- inspection/allocation 精确覆盖全部 approved 行，四种正整数处置数量守恒；deferred 完整性 guard 在
  状态转换前显式置为 immediate，部分覆盖、重复行/处置、全零或版本漂移原子回滚。
- 可售恢复只绑定原订单 `ORDER/CONSUMED` reservation 中目标 SKU 的唯一 warehouse；缺失、未消费、
  多仓或原消费量不足失败关闭。累计恢复受累计可售验收、订单行数量和原消费量三重容量限制。
- `ADMIN_INSPECT_RETURN` operation、inspection/allocation、RESTORE operation/movement/action、售后
  transition、严格 result summary 和 audit 必须同事务成套提交；底层 runtime 通用写入仍被 RLS/ACL/
  trigger 拒绝。
- 同键并发只提交一个 winner。唯一冲突在原事务回滚后用新 `ReadCommitted` 事务读取，并仅重放售后、
  request hash、已提交状态和严格响应 schema 都匹配的 winner；同键异参或损坏结果冲突。

### 2.3 配置、迁移与回滚

- `AFTER_SALE_FULFILLMENT_COMMANDS_ENABLED=false` 默认关闭；production 配置解析和 service 双重拒绝启用。
- 第 57 段迁移复用既有 M6.2 inspection/action 与 M3 inventory 表，新增受限命令、最终授权函数、
  operation completion/command atomicity guard、最小 runtime EXECUTE 和固定安全 `search_path`；
  `PUBLIC` 无执行权。
- 前向或 `down.sql` 遇到 inspection/action、验收 transition、operation 或 audit 任一 M6.4 事实均以
  SQLSTATE `55000` 停止。有事实环境只允许受审前向修复；应用回滚只关闭入口并保留业务事实。

## 3. 验证证据

| 检查项                                                        | 状态                       | 证据与边界                                                                                                                                                             |
| ------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定向 unit/contract/service                                    | `PASS`                     | 100/100；严格 DTO、四种处置、派生状态、配置、动态权限、安全响应与错误映射                                                                                              |
| 售后数据库高风险定向                                          | `PASS_LOCAL_TEST`          | 37/37；完整覆盖、唯一原仓、容量、exactly-once、并发 winner、撤权/MFA、RLS/ACL/atomic guard                                                                             |
| 售后真实 HTTP 定向                                            | `PASS_LOCAL_TEST`          | 10/10；申请→审核→返件→送达→验收、双商城、strict DTO、RBAC/MFA、重放/异参、默认关闭 503                                                                                 |
| 完整 integration                                              | `PASS_LOCAL_TEST`          | 39 个文件、362/362；真实 PostgreSQL、Redis、MinIO 与 ClamAV                                                                                                            |
| `NODE_OPTIONS=--max-old-space-size=4096 corepack pnpm verify` | `PASS`                     | format、lint、typecheck、76 个文件/641 项 unit、生产 build 与 Prisma validate                                                                                          |
| M2-to-current 迁移演练                                        | `PASS_LOCAL_TEST`          | 57 段 fresh/redeploy、边界升级、guarded down/forward、五类 facts guard、catalog/ACL 恢复与清理                                                                         |
| 本地 migration 57 checksum 重建                               | `PASS_LOCAL_TEST`          | 五类 M6.4 facts 均为零后执行受保护 `down.sql`、删除本地 migration 记录并 redeploy；当前 checksum 为 `b0cded09a63c1e2a6a85ab76b384c47c9c223df6c8db2fd508bd587c2747452f` |
| 完整浏览器 E2E                                                | `PASS_AFTER_RERUN_WEB`     | 首轮 25/26 的既有 WebKit 搜索时序失败；定向 1/1、完整重跑 26/26；无前端修改，不能替代 Zalo 真机                                                                        |
| M6 OpenAPI                                                    | `PASS_WITH_LIMITATION`     | 6 个严格 YAML、49 operations、1907 local refs、355 unique targets；0 重复 operationId/外部/缺失引用                                                                    |
| 生产依赖审计                                                  | `PASS_WITH_DISCLOSURE`     | 退出码 0；3 moderate、0 high/critical，不表述为零漏洞                                                                                                                  |
| Gitleaks 8.30.1                                               | `PASS`                     | 52 个可达提交与当前暂存 Slice A diff 扫描无泄漏                                                                                                                        |
| Compose、差异与高风险复审                                     | `PASS`                     | `docker compose config --quiet`、`git diff --check`；商城/RBAC/库存/锁序/幂等/敏感投影/生产拒绝复核                                                                    |
| 真实仓库/provider/Zalo/staging/deployment/rollout             | `NOT_AUTHORIZED / NOT_RUN` | 未连接真实仓库、物流商或 Zalo 宿主，未部署、推送、启用 production 或发布                                                                                               |

完整 `verify` 首次在新增并发测试发现一个无意义的 TypeScript non-null assertion，ESLint 以 1 个 error
失败；移除不改变行为的断言后，定向 ESLint 和完整 `verify` 均通过。该失败没有被隐藏或计作通过。

## 4. 已知限制与后续

1. Slice B 尚未实现同商城/同 SPU/等量等价 replacement SKU 预留、失败/取消/超时释放、出库消费和
   `EXCHANGE_OUTBOUND`；`EXCHANGE_PENDING` 当前只是资格状态。
2. Slice A 没有管理员/买家 UI。完整三语、移动端、可访问性、冲突/重试状态和 Zalo host 验收属于
   `P0-M6-011`，浏览器回归不能替代真机。
3. 真实 GHN/物流 provider、仓库作业、label/tracking、支付退款、COD 资金、staging/production 均未验收；
   default-disabled local/test 能力不能宣称官方集成完成。
4. 生产政策、云资源、合规签字、可观测性、备份恢复、性能、部署与发布门禁仍开放；项目保持 Not Ready。

Slice A 具有独立价值并可独立回滚，但不满足 `P0-M6-008` 整体 Definition of Done。下一阶段继续同一 Task
的 Slice B；本阶段未修改 `REQUIREMENTS.md` 或 Task Tree，未启用 production capability，未推送远端。
