# P0-M5-005 财务对账实施计划

> 状态：`Complete`；Slice A/B/C 已完成 repository implementation + local/test validation，真实
> provider、资金、部署与 production acceptance 由独立外部任务继续跟踪
>
> 日期：2026-08-01
>
> 任务来源：`TASKS.md` 的 `P0-M5-005`
>
> 批准边界：用户要求按 Task Tree 持续开发；本计划只授权仓库与 local/test 实现，不授权真实供应商调用、生产渠道启用、外部资金操作、部署或发布。

## 1. 目标与非目标

### 1.1 目标

- 以商城隔离、只追加的财务批次和逐笔记录保存支付结算、退款、手续费、COD 应收与物流商回款事实。
- 只用服务端已有支付、退款、订单、运单和渠道事实匹配规范化对账记录，全部金额使用整数 VND。
- 明确区分匹配、金额差异、引用不存在、非终态事实和重复记录；异常只进入人工复核，不自动改变支付、退款、订单、库存或运单状态。
- 为财务管理员提供受 RBAC、近期 MFA、幂等键、二次确认和审计保护的导入接口，以及三语批次/差异工作台。
- 覆盖跨商城、权限撤销、重复导入、金额篡改、并发、RLS、回滚和敏感引用脱敏。

### 1.2 非目标

- 不猜测 ZaloPay 或 GHN 未取得官方验收的结算文件格式，不调用真实商户、sandbox 或 production API。
- 不实现供应商自动结算文件拉取；该能力继续由 `P1-FIN-001` 跟踪。
- 不自动修复支付、退款、COD、订单、库存或物流状态，不执行真实退款、转账或记账。
- 不实现电子发票、税务会计集成或财务总账；这些能力继续由 `P2-ACC-001` 和外部专业审批跟踪。
- 不把 local/test 规范化输入或测试渠道宣称为真实供应商对账验收。

## 2. 纵向切片与提交边界

### 2.1 Slice A：支付与退款结算批次

- 新增通用财务对账批次/逐笔模型，但本切片只开放 `PAYMENT` 和 `REFUND` 记录。
- 管理员提交批次日期、渠道环境、批次引用和规范化逐笔记录；服务端解析当前商城支付渠道。
- 支付只匹配同商城、同渠道、`SUCCEEDED` 且具有供应商交易引用的支付尝试；退款只匹配同商城、同支付渠道、`SUCCEEDED` 且具有供应商退款引用的退款。
- 服务端计算毛额、手续费、净额、预期金额和差异。导入不会推进任何业务状态。
- 提供批次列表、详情和三语管理界面；所有供应商引用仅返回掩码。

### 2.2 Slice B：COD 应收与 GHN 回款

- 基于已签收/拒收/退回的可信订单与运单事实生成 COD 应收投影。
- 导入规范化 GHN 回款、运费和 COD 费用记录，匹配同商城 shipping channel 与运单。
- 明确未回款、少回款、多回款、费用差异、拒收/退回和重复汇款异常，不自动确认现金或改变订单状态。

### 2.3 Slice C：差异复核与任务收口

- 增加 maker-checker 的差异确认/关闭记录、不可变审计和可解释汇总。
- 完成双商城浏览器回归、迁移升级证据、文档与 Task Definition of Done；真实 provider 证据仍留在 `P0-M5-003`/`P0-M5-004`。

每个 Slice 独立验证、更新 `CHANGELOG.md`、提交并按 Merge Gate 评估同步；在全部 Slice 完成前，`P0-M5-005` 保持 `In Progress`。

## 3. 数据模型与约束

- `financial_reconciliation_batches`：`store_id`、来源、支付/物流渠道之一、业务日期、批次引用摘要/掩码、输入摘要、幂等摘要、状态、整数 VND 汇总、记录/匹配/异常数量、创建管理员、原因、版本与时间。
- `financial_reconciliation_lines`：`store_id`、批次、行号、类型、供应商记录/业务引用摘要与掩码、发生时间、毛额、手续费、带方向净额、本地预期金额、差异、匹配状态，以及可空的支付/退款/运单复合外键。
- `financial_reconciliation_reviews`：每个异常批次最多一条异人关闭记录，包含不可变 decision、原因、预期批次版本、reviewer、关联 ID 与请求/幂等摘要；不修改 batch 或逐笔事实。
- 批次必须恰好绑定一个与来源一致的商城渠道；逐笔匹配目标必须与批次商城一致。
- 支付净额为 `gross - fee`，退款净额为 `-(gross + fee)`；费用不得为负，所有输入和计算必须在 JavaScript safe integer 与 PostgreSQL bigint 范围内。
- 同商城、同来源、同渠道的批次引用不可重复；同批次记录引用不可重复。幂等重放必须返回原结果，不同请求使用同键必须冲突。
- 表启用并强制 RLS；运行角色只获得受限的 `SELECT/INSERT`，更新和删除默认禁止。已有事实环境只允许向前修复。

## 4. 接口与权限

- 新权限：`store.finance.read`、`store.finance.reconcile`。迁移只登记权限，不自动赋予生产角色；local/test seed 的 `store-admin` 显式获得权限。
- `POST /v1/admin/financial-reconciliation/payment-batches`：要求目标商城、近期 MFA、直接商城权限、`Idempotency-Key`、确认码和原因；不接受 `store_id`、金额之外的业务状态或内部实体 ID。
- `POST /v1/admin/financial-reconciliation/cod-batches`：复用同一敏感操作边界，只接受规范化 GHN COD 回款、运费和 COD 费；同批次及此前批次已出现的渠道引用均进入重复异常。
- `GET /v1/admin/financial-reconciliation/cod-receivables`：只读当前商城 GHN 已签收 COD 运单，按建单前可信报价投影费用，并在状态过滤后提供稳定游标。
- `GET /v1/admin/financial-reconciliation/batches`：按商城、状态、来源和日期分页读取。
- `GET /v1/admin/financial-reconciliation/batches/{batchId}`：返回批次、逐笔差异、不可变异常分类汇总与可空 review；供应商引用只返回掩码。
- `POST /v1/admin/financial-reconciliation/batches/{batchId}/review`：只允许直接商城财务复核人以近期 MFA、确认码、原因、幂等键和 version 1 对异常批次追加 `CLOSED_ACCEPTED` 或 `CLOSED_ESCALATED`；importer 不能关闭自己的批次。
- 跨商城平台访问只用于只读且必须带审计原因；导入要求目标商城直接角色，不允许仅凭跨商城平台权限写入。

## 5. 原子性、兼容与回滚

1. 在 Serializable 事务内取得商城/渠道/批次幂等 advisory lock。
2. 锁定并重新验证商城、管理员、会话/MFA、token 到期时间和直接商城权限。
3. 解析同商城渠道，按稳定顺序读取匹配支付/退款事实；原始规范化输入不写入日志或审计。
4. 原子写入批次、逐笔记录和脱敏审计；差异关闭在独立 Serializable 事务追加 review、审计与异常分类，任一约束失败整批回滚。
5. 现有 M4/M5 支付、退款、订单、库存、运单 API 和状态机不变；新增 API 与表均为加法式。
6. `down.sql` 只允许无对应财务事实的 local/test scratch 环境；存在 review 时 Slice C、存在 shipping batch 时 Slice B、存在 batch/line 时 Slice A 均以 SQLSTATE `55000` 拒绝，逆向顺序固定为 C → B → A。生产或已有事实环境只允许向前修复。

## 6. 风险与外部依赖

- 供应商结算时间、手续费和批次规则尚无已验收的双商城官方事实，因此 P0 只接受显式规范化输入并保留来源摘要，不推断供应商文件语义。
- 同一供应商引用可能重复、跨商城碰撞或处于非终态；全部按目标商城和渠道匹配并失败关闭。
- 导入可能与支付/退款状态收敛并发；非终态事实进入复核，不能被导入提升为成功。
- 真实 ZaloPay/GHN 结算、费用、退款和资金证据依赖 `EXT-PAY-001`、`EXT-GHN-001` 和 `EXT-NET-001`，本任务不能替代。
- 财税处理、日界线和差异核销策略仍需 `EXT-LEGAL-001` 专业确认；仓库实现只提供可审计事实与复核工作流。

## 7. 测试与验收

- 单元：严格 DTO、整数 VND、支付/退款净额方向、引用掩码、重复检测和状态分类。
- 集成/API：fresh migration、RLS、最小权限、直接商城授权、近期 MFA、权限撤销、跨商城 IDOR、同键重放/冲突、批次引用并发、原子回滚、支付/退款金额差异和非终态事实。
- UI：越南语、中文、英文批次导入/列表/详情，加载、空、错误、成功和异常状态，常见桌面与窄屏无溢出。
- 静态与构建：`format:check`、`lint`、`typecheck`、`test:unit`、`build`、`db:validate`。
- 仓库门禁：受影响集成、迁移演练、`git diff --check`、生产依赖审计和敏感信息扫描。
- 真实 provider/sandbox/production：必须明确标记 `BLOCKED / NOT_RUN`。

## 8. Slice B 实施记录

- 前向迁移 `20260801100000_p0_m5_005_cod_reconciliation` 增加支付/物流来源互斥绑定、COD 回款行、
  运单复合商城外键、预期费用与费用差异；有物流对账事实时 down 以 `55000` 失败关闭。
- 匹配限定同商城、同 GHN 渠道、`ORDER_OUTBOUND`、COD 运单；可信费用限定运单创建前同订单、
  渠道和 service 的 provider 报价。同一 provider shipment reference 跨批次再次出现不会重复计入回款。
- COD 应收状态过滤通过有界扫描先筛选后分页，游标必须仍属于同商城应收范围；非法、跨商城或非
  应收游标返回 404。
- 管理端增加来源筛选、COD 应收、三语 GHN 规范化导入和商城切换详情清理；真实 GHN 格式、
  sandbox/production、资金、部署和 rollout 均未运行或仍阻塞。

## 9. Slice B 验证记录

- `verify` 通过：Prettier、ESLint、类型检查、631/631 单元测试、全部 workspace 构建和 Prisma
  schema 校验成功；本机仅临时使用 `NODE_OPTIONS=--max-old-space-size=4096` 避免默认 Node heap
  在全仓 ESLint 阶段耗尽，未修改仓库运行配置。
- 完整 infrastructure integration 39 个文件、348/348 项通过；Chromium/WebKit 浏览器 E2E
  26/26 项通过。
- M2 边界到 current 的 54 条迁移 fresh deploy、Slice B/Slice A guarded down 和重新前滚通过；
  scratch 数据库与临时迁移目录已清理。
- 生产依赖审计为 3 moderate、0 high/critical；M5 OpenAPI 3.1 严格 YAML 解析、285 个本地引用、
  0 个外部/缺失引用通过。仓库仍无专用 OpenAPI 3.1 语义 linter。
- `git diff --check`、高信号敏感信息和新增 TODO/FIXME/HACK/debug 扫描通过；未调用真实
  GHN/ZaloPay、未确认资金、未部署或启用 production capability。

## 10. Slice C 实施与最终验证记录

- 前向迁移 `20260801110000_p0_m5_005_reconciliation_closeout` 增加 review decision enum、
  `financial_reconciliation_reviews`、复合商城/批次外键、append-only trigger、延迟 maker-checker
  integrity guard、FORCE RLS 与 runtime `SELECT/INSERT` 最小授权；存在 review fact 时 down 以 `55000`
  失败关闭。
- 服务端以 batch scope advisory lock 和 Serializable 事务实现复核；锁等待后重新校验商城、管理员、
  session/MFA、直接角色与 `store.finance.reconcile`。同键重放冻结结果、同键异参冲突，任意不同结论
  并发只会落一条 review，batch importer 或撤权后的 reviewer 均失败关闭。
- 批次列表提供 `OPEN/CLOSED_ACCEPTED/CLOSED_ESCALATED` 筛选；详情和导入响应统一返回异常分类汇总、
  review status 与可空 review。管理端实现三语筛选、异常汇总、确认关闭表单、关闭结果和窄屏布局。
- 已通过 M5 contracts 11/11、P0-M5-005 integration 14/14、完整 integration 39 个文件/351 项、
  完整 `verify` 76 个文件/633 项 unit、完整 Chromium/WebKit E2E 26/26，以及 55 条迁移 fresh deploy
  和 C → B → A guarded down/forward 演练。
- 生产依赖审计为 3 moderate、0 high/critical；M5 OpenAPI 3.1.0 的 302 个本地引用均可解析且无外部
  或缺失引用；Gitleaks、Compose、`git diff --check`、敏感信息、调试标记与最终高风险差异复审通过。
- 完成证据见 `docs/reports/p0-m5-005-financial-reconciliation-completion-report.md`。真实 ZaloPay/GHN
  sandbox、资金、Zalo 宿主、部署和 production rollout 均保持 `BLOCKED / NOT_RUN`。
