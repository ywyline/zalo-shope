# P0-M6-008 M6.4 返件验收与换货履约实施计划

> 状态：Slice A repository/local-test complete；Slice B pending；P0-M6-008 继续 `In Progress`
>
> 日期：2026-08-01
>
> 范围：default-disabled repository implementation + local/test validation
>
> 依赖：`P0-M3-001`、`P0-M6-005`、`P0-M6-006`

## 1. 目标与非目标

### 目标

- 管理员只对目标商城、已由可信物流事实推进到 `INSPECTION_PENDING` 的返件执行完整验收；请求必须
  覆盖每个 approved 售后行，并以公开 `order_item_id`、正整数数量和明确处置表达结论。
- 只有 `RESTOCK_SELLABLE` 处置可以恢复可售库存；`QUARANTINE`、`SCRAP` 和
  `RETURN_TO_MEMBER` 只保存不可变验收事实，不增加可售库存。
- 在同一数据库事务内完成最终 direct-store RBAC、有效 session/token、近期 MFA、聚合/验收版本、
  完整验收、exactly-once RESTORE operation/movement/action、售后转换、幂等结果和审计重验。
- 每行累计恢复量同时受最新累计可售验收量、原订单行实际数量和原订单已消费 reservation 数量限制；
  重放、并发、更正验收或 worker 重试不得产生第二笔库存恢复。
- 全部验收数量拒绝时进入 `REJECTED`；存在接受数量时，`RETURN_REFUND` 进入
  `REFUND_PENDING`，`EXCHANGE` 进入 `EXCHANGE_PENDING`，且验收本身不伪造退款成功或换货完成。
- 后续 Slice B 只为已通过验收的换货创建同商城、同 SPU、等量、等价且政策允许属性变化的替换预留，
  使用 `EXCHANGE_OUTBOUND` 运单履约，并在失败、取消或超时时释放预留。

### 非目标

- 不调用 GHN、ZaloPay、VNPay 或其它真实供应商，不接收生产凭据，不部署、不推送、不发布。
- 不把签收、退款成功、验收或换货出库互相替代，也不推进原订单 `SHIP/DELIVER` 状态。
- 不支持跨 SPU、跨商城、跨仓自动分配、多换一、价差补收/退款、负库存或无库存假运单。
- Slice A 不创建 replacement reservation、换货运单或完整买家/管理员 UI；这些分别留给本任务
  Slice B 和 `P0-M6-011`，因此 Slice A 收口后任务仍保持 `In Progress`。
- 不修改生产政策，不把 local/test fixture 或自动化结果表述为真实仓库、物流、真机或 production 验收。

## 2. 数据、事务与迁移

- 新增专用数据库命令原语，不复用通用库存调整的结果快照。每个可售恢复生成精确
  `source_type='AFTER_SALE_RESTORE'`、稳定 source ID 及单一 warehouse/SKU/quantity item 的
  `RESTORE` operation，并绑定唯一 movement 和只追加 `after_sale_inventory_actions`。
- 命令按商城/幂等 advisory lock -> 售后聚合 -> approved 售后行/原订单行 -> 原订单已消费
  reservation -> inspection version -> inventory balance/operation 的固定顺序锁定；所有数量来自数据库
  权威事实，不接受客户端 SKU、仓库、operation 或库存动作。
- inspection/allocation 写入后，在追加 `ACCEPT_INSPECTION`/`REJECT_INSPECTION` 前显式将验收投影
  constraint trigger 设为 immediate，确保状态 guard 读取已更新的 inspection version 和接受数量。
- 新迁移只新增最终授权重验、命令函数及其最小 runtime EXECUTE/列授权；保持 FORCE RLS、既有
  capacity/atomicity guard 和 runtime 对底层 operation 表直接写入的撤销状态，不放宽 guard 来适配应用。
- 前向迁移预检任何与新命令契约冲突的 M6.4 历史事实时以 SQLSTATE `55000` 停止。`down.sql` 仅允许
  没有 M6.4 验收、库存恢复、transition、operation 或 audit 事实的 local/test scratch；有事实后只允许
  向前修复。

## 3. 契约、服务、API 与权限

- 新增 strict DTO：`confirmation_code`、`expected_version`、`expected_inspection_version`、`reason` 和
  完整唯一的 `order_item_id + dispositions`；拒绝内部售后行 ID、SKU、仓库、金额、状态、库存结果和
  未知字段。
- 管理员路由要求商城 Header/query 一致、ADMIN WRITE 限流、近期 MFA 和目标商城直接
  `store.after-sales.inspect`；请求含任一 `RESTOCK_SELLABLE` 时还要求直接
  `store.inventory.adjust`。cross-access-only 不得替代直接权限。
- API 层预授权只提供快速拒绝；数据库命令必须在全部锁等待后重新校验 ACTIVE 商城、管理员账号、
  session、token、MFA 和全部动态权限，撤销竞态必须失败且不留下任何业务事实。
- capability 使用独立 `AFTER_SALE_FULFILLMENT_COMMANDS_ENABLED=false`，默认关闭且 production
  显式拒绝启用。响应只公开售后编号、状态/版本、验收版本、行级处置汇总和安全库存恢复摘要，不公开
  内部主键、库存余额、权限目录或敏感审计字段。
- 同一幂等键只重放匹配 request hash 和严格响应 schema 的已提交结果；同键异参冲突。序列化冲突可按
  既有上限重试，但业务版本、容量、授权或永久唯一冲突不得重跑业务逻辑。

## 4. Slice B 换货履约边界

- 仅从 `EXCHANGE_PENDING` 为同商城、同 SPU、等量等价且政策允许属性变化的 replacement SKU 建立
  `source_type='AFTER_SALE_EXCHANGE'` reservation；无唯一仓库/库存或规则不明确时进入人工复核。
- 创建、取消、超时和出库消费必须复用 M3 reservation 原语并保持 exactly once；任何运单创建失败或
  取消都不得遗留锁定库存。
- 换货运单固定 `purpose='EXCHANGE_OUTBOUND'`，只推进换货聚合为
  `EXCHANGE_IN_TRANSIT/COMPLETED`；不创建原订单 `SHIP/DELIVER` 事件。
- 真实物流 provider、label、tracking、失败补偿和 Zalo 宿主验收仍由独立外部任务提供证据；仓库切片
  只能交付 provider-neutral、default-disabled 的本地契约和协调逻辑。

## 5. 兼容、回滚、风险与停止条件

- 现有 B1-B7 读取、申请、审核、返件登记、退款/COD 结算保持兼容；新路由默认关闭，应用回滚只关闭
  入口并保留已提交验收、库存、transition、audit 和未来换货履约事实。
- 缺少唯一可证明的原订单消费、仓库、SKU、数量容量、验收完整性、版本或 direct-store 权限时失败
  关闭；不得猜测仓库、拆分多仓、恢复到当前商品 SKU 或以人工按钮绕过。
- 跨商城、数量越界、累计恢复超量、operation/result snapshot 不精确、全零/部分覆盖、重复行、
  disposition 不守恒、权限/session/MFA 锁等待撤销或 constraint trigger 未投影时停止事务并原子回滚。
- 若迁移预检、RLS/列授权、库存 exactly-once、状态机、幂等、敏感信息或回滚门禁失败，停止受影响
  路径并记录精确恢复条件；不通过弱化数据库 guard、测试特例或伪造成功继续。

## 6. 测试与验收

- 单元/契约：完整验收汇总、退款/换货派生状态、四种 disposition、库存容量、strict DTO、动态权限、
  confirmation/reason/version 边界和响应敏感字段拒绝。
- 数据库/集成：双商城/已知 UUID、完整覆盖、数量守恒、仅可售恢复、已消费 reservation、累计容量、
  多验收版本、幂等同键/异参、并发单胜者、权限/session/MFA 锁等待撤销、原子回滚、直接写/RLS/
  operation snapshot/transition guard 和 exactly-once movement/action。
- API：default-disabled/production fail-closed、商城 Header/query、direct RBAC、MFA、限流、客户端
  SKU/仓库/金额/状态篡改、no-store/correlation 和稳定 4xx/409/422/503 错误边界。
- 迁移：fresh、M2-to-current、重复 deploy、无事实 down/forward、有 M6.4 事实时 `55000` fail-fast，
  并核对 owner/runtime EXECUTE、列授权、SECURITY DEFINER search path 和 guard fingerprint。
- Slice B 另覆盖等价换货、replacement reservation 创建/消费/释放、并发库存不足、
  `EXCHANGE_OUTBOUND` 目的、供应商异常人工复核及原订单不推进。
- 阶段门禁：定向测试、完整 integration、`NODE_OPTIONS=--max-old-space-size=4096 corepack pnpm verify`、
  完整 browser E2E 回归、迁移演练、OpenAPI strict YAML/local refs、生产依赖审计、Compose、Gitleaks、
  `git diff --check` 和高风险差异审查。真实仓库/provider/Zalo 真机/部署/rollout 为
  `NOT_AUTHORIZED / NOT_RUN`，不能由 repository/local-test 证据替代。

## 7. Slice A 收口状态

Slice A 已按本计划交付默认关闭的严格验收 HTTP、锁后 direct-store 授权重验、完整验收/派生状态、
exactly-once 可售库存恢复、迁移 57、集成/迁移回归与同步文档。适用 repository/local-test 门禁通过，
精确计数与限制见 `docs/reports/p0-m6-008-return-inspection-slice-a-completion-report.md`。

本检查点不改变 Slice B 范围，也不完成 `P0-M6-008`：replacement reservation、取消/超时释放、出库消费、
`EXCHANGE_OUTBOUND` 及 provider-neutral 换货协调仍待实施。真实仓库/provider、Zalo 宿主、staging、
production、部署与 rollout 均未授权或未运行。
