# M3 库存、搜索、购物车、促销与价格计算阶段总结

> 状态：M3.1-M3.7 已按批准边界完成自动化收口；M3 当时的保留项及 Post-M3 技术收口见第 6、7 节
>
> 日期：2026-07-22
>
> 范围：`docs/plans/m3-implementation-plan.md`；不包含 M4 地址、结算、订单、COD、支付、物流或售后，也不代表生产上线验收。

## 1. 分阶段交付索引

| 子阶段 | 主要结果                                                  | 证据                                     |
| ------ | --------------------------------------------------------- | ---------------------------------------- |
| M3.1   | 数据字典、状态机、权限、OpenAPI 与纯领域规则冻结          | `docs/reports/m3.1-completion-report.md` |
| M3.2   | M3 schema、RLS、复合约束、搜索扩展、回填与基础种子        | `docs/reports/m3.2-completion-report.md` |
| M3.3   | 仓库、库存、预留原语、过期 worker 与三语管理工作台        | `docs/reports/m3.3-completion-report.md` |
| M3.4   | 三语搜索、筛选、历史、热门词、投影同步与移动端搜索        | `docs/reports/m3.4-completion-report.md` |
| M3.5   | 促销、优惠券、整数 VND 可信报价、命令幂等与管理工作台     | `docs/reports/m3.5-completion-report.md` |
| M3.6   | 会员购物车、可售/促销投影、失效重算与移动端购物车         | `docs/reports/m3.6-completion-report.md` |
| M3.7   | 并发/安全回归、认证后浏览器矩阵、完整性迁移与 M3 阶段收口 | 本报告                                   |

## 2. 已达到的 M3 能力

- 一套代码承载美妆与服装商城；仓库、库存、搜索、促销、优惠券和购物车事实继续由 `store_id`、复合外键与强制 RLS 隔离。
- 库存余额区分现有量、锁定量与派生可售量；调整、初始导入、预留、释放、确认和过期使用稳定锁顺序、商城范围动作键、请求 hash、流水与终态保护。
- 搜索支持 vi/zh/en、越南语有/无变音符号、`đ/Đ`、FTS/trigram、联想、品牌/类目/行业属性/价格/库存/促销筛选、会员历史与商城热门词。
- 促销采用稳定根和不可变发布版本；服务端按 `ITEM -> COUPON -> ORDER`、整数 VND、确定性选优和最大余数分摊返回可解释报价。购物车和管理端预览不是最终订单金额。
- 会员购物车支持设置数量、选择、删除、同商品 SKU 替换、乐观冲突以及商品、SKU、库存、价格和促销变化重算；访问令牌只保存在内存。
- 管理端提供仓库/库存与促销/报价工作台；买家端提供双商城共用的三语搜索、详情、购物车和移动端状态反馈。

## 3. M3.7 收口结果

### 3.1 并发、幂等与数据库完整性

- 库存高并发预留继续以数据库行锁和稳定顺序阻止超卖；同终态使用新动作键时也会绑定请求 hash，避免该键随后被复用于另一预留。不可变 `RESERVE` 动作的 `result_snapshot` 封存完整预期预留明细集合，实际 INSERT 的预留明细必须与该集合逐项一致；预留根、动作与明细由前向迁移及运行时最小权限共同保护。
- 预留终态新增 deferred 事实守恒：终态操作在商城内只能绑定一条预留，operation type、终态 status 和结果 snapshot 必须互相对应；预期明细数、实际明细数和终态流水数必须一致，每个明细有且只有一条属于该终态操作的流水，类型、原因和现有量/锁定量 delta 必须守恒，提交时余额必须等于流水 after 值。只更新预留 status/终态字段而不写完整操作、流水和余额的裸 UPDATE 会被拒绝。
- INSERT 边界同样冻结终态事实：只允许为 `ACTIVE` 预留追加明细；操作一旦绑定为 `terminal_operation_id`，不再允许追加其流水。插入守卫以 `FOR SHARE` 与终态更新互斥；deferred movement-binding 约束从不可变终态 operation snapshot 推导预留，并在提交时核对 `movement.reservation_item_id` 属于该预留。即使一笔事务先插入流水、另一笔事务随后绑定 `terminal_operation_id`，READ COMMITTED 和 REPEATABLE READ 下的旧快照并发回归都会被拒绝。
- 预留过期批处理逐条隔离异常并返回 `expired/failed/scanned` 计数；失败记录保存累计次数、最近失败时间和受控错误码。重试索引明确使用 `last_expiration_failed_at ASC NULLS FIRST`，worker 因而优先处理未失败记录，再按最早失败时间公平重试，避免坏行反复填满 batch；部分失败输出脱敏 `warn`，但不阻塞同商城后续合法预留。
- 优惠券多会员并发领取受总配额约束；同码券、领取限流和计价限流按商城与会员独立。`claimed_count` 与 `member_coupons` 事实通过延迟约束触发器在提交时核对，优惠券根不可删除，会员领取事实创建后只追加。
- 促销相同幂等键的并发发布只产生一次状态变化、命令记录和审计；不同键竞争同版本时稳定返回一个成功和一个冲突。`CATEGORY` 目标仍只精确匹配当前主/辅助类目，不递归后代。
- 购物车识别 Prisma 包装的 PostgreSQL `40001` 序列化冲突并执行有界整事务重试；同一旧版本的并发 PATCH 稳定为一次成功、一次 `409`。跨商城 Header、令牌、SKU 和行 ID 不暴露资源存在性。

M3.7 新增两条前向完整性迁移：

- `20260722100000_m37_coupon_claim_integrity`：领取计数与事实一致，优惠券根不可删除，会员券事实只追加。
- `20260722103000_m37_inventory_reservation_integrity`：`assert_inventory_reservation_definition_for` 以不可变 `RESERVE` snapshot 核对预留定义，`assert_inventory_reservation_terminal_facts_for` 核对终态计数与守恒，deferred terminal/movement-binding trigger 在提交时拒绝不完整事实和跨预留流水；同时记录可公平重试的过期失败元数据。

两条 `down.sql` 都先调用安全检查函数；只要存在库存动作/流水/预留/非零余额、促销命令/发布版本、优惠券/会员券或购物车中的任一 M3 核心事实，就以 SQLSTATE `55000` 拒绝回滚并要求向前修复。

### 3.2 搜索重建与敏感信息

- `search:rebuild` 只接受目标商城中状态为 `ACTIVE` 且持有 `store.catalog.publish` 的管理员 ID；查询和审计都在目标商城 RLS 上下文中执行。
- 重建按稳定商品 ID 以每批 100 个商品迭代，但删除、全部批次写入和审计仍位于单个 `REPEATABLE READ` 事务。任何批次失败都会整体回滚，重试从该商城头部重新执行；它不是分批提交或断点续跑任务。
- HTTP 请求主 URL 与 `Referer`/`Location` 等 URL 型 Header 移除查询串和 fragment，`Link`/`Refresh` 及动态 token/key/session Header 整体遮盖；无效客户端 correlation ID 会替换为 UUID，`ApiExceptionFilter` 复用中间件已验证的 `request.id`，不会重新信任原始 Header。`Forwarded` 与其他 IP Header，以及请求 `ip`、`ips`、`remoteAddress`、`remotePort` 均遮盖；直接结构化 logger 和 Nest optional parameters 也递归遮盖认证、Cookie、Zalo/refresh token、手机号和其他敏感值。无效 JWT/MFA challenge 统一映射为脱敏 `401`。

### 3.3 浏览器验收矩阵

- 管理端 Chromium 覆盖双商城目录与库存隔离、真实可逆库存调整、原子导入 dry-run、两个独立会话的 `200/409` 冲突、只读管理员库存/促销写入 `403`、促销发布和真实报价。
- Pixel 7 Chromium 与 iPhone 13 WebKit 均覆盖双商城三语目录、搜索/筛选、Zalo 测试身份交换、加入购物车、数量/选择/SKU/删除、零库存失效和价格重算。
- E2E 不拦截 M3 业务 API。Zalo 宿主桥只在 Playwright 启动的 localhost Web 预览且显式设置 `VITE_ZALO_TEST_BRIDGE=true` 时启用；令牌仍通过 test provider、真实 API 和数据库交换。该桥不进入正常生产配置，也不能替代 Zalo Mini App 宿主真机验收。

## 4. 最终验证基线

- `corepack pnpm verify` 全部通过：格式、lint、类型检查、21 个单元测试文件共 138 项、全部生产构建和 Prisma schema 校验通过。
- `corepack pnpm test:integration` 全部通过：19 个文件、102 项；库存/数据库/购物车定向 24/24、M3.5 促销/报价定向 11/11 也分别通过。
- `corepack pnpm test:e2e`：15/15 通过，包括管理端 Chromium 5 项、Pixel 7 Chromium 5 项、iPhone 13 WebKit 5 项；此前管理端 5 项还连续两轮通过。
- logger 定向回归 13/13、logger 与 `ApiExceptionFilter` 联合定向回归 16/16 通过；logger package 的 build/typecheck/Prettier/ESLint 通过。
- `corepack pnpm audit --prod --audit-level high` 无已知漏洞；`docker compose config --quiet` 通过。
- 最终 fresh scratch I：9 条迁移全量 deploy 成功，重复 deploy 无待应用迁移；runtime 对 `assert_coupon_claim_count_for`、`assert_inventory_reservation_definition_for`、`assert_inventory_reservation_terminal_facts_for` 三个底层 helper 的 `EXECUTE` 均为 `false`，对应 trigger wrappers 均为 `true`；空事实前提下最新 inventory/coupon down 均成功，scratch 库已删除。

## 5. 迁移、兼容与回滚

- M3 只做向后兼容新增；不删除或重命名 M1/M2 接口与业务表。应用回滚到 M2 时保留 M3 schema 和事实，停止 M3 路由/worker。
- 搜索文档是可重建派生数据；库存流水、预留、促销命令、发布版本、优惠券领取和购物车事实不能用回滚脚本删除。产生事实后只允许向前修复；库存错误使用新的反向调整。
- 独立全新 scratch 库已人工演练 9 条迁移全量 deploy，重复 deploy 返回 `No pending migrations to apply`，两次 `NODE_ENV=test` seed 成功。授权管理员在仅有 seed 的 0 商品/0 文档基线上连续两次重建成功，未授权 UUID 被明确拒绝。
- 无 M3 事实时，两条 M3.7 `down.sql` 均成功并可重新前滚；插入一条专用 `inventory_operation` 事实后，两条 down 分别真实返回 SQLSTATE `55000`。清除该专用事实后，9 个 `down.sql` 按逆序全部成功。scratch 库随后已删除；这是 M3 收口时的人工历史证据。
- M3 收口时尚缺从只包含 M2 schema/数据的自动化升级 fixture。Post-M3 已新增 `corepack pnpm test:migration:m2-upgrade`，使用真实 M2 迁移前缀、代表性双商城 fixture、升级前后 fingerprint、重复部署、搜索回填、RLS/权限和自动清理；连续两轮升级及本地全量门禁已通过，该历史仓库内保留项已关闭。

## 6. 保留项与边界

| 保留项                               | 当前状态/影响                                                                     | 后续处理                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| M2-only 自动升级 fixture             | Post-M3 本地全量门禁及连续两轮升级已通过，仓库内缺失项关闭                        | 真实生产数据升级仍需独立受控演练                                  |
| secret-scan 与生产示例占位值         | gitleaks 正反向、production fail-fast 和全量门禁通过，仓库内缺失项关闭            | 远程 Quality workflow 待本变更提交/推送后归档                     |
| Zalo 宿主真机/真实生产凭据未验收     | 不能宣称真实宿主身份、设备交互、生产 Zalo 或真实秘密注入完成                      | 取得测试应用、Android/iPhone 和受控 HTTPS API 后按证据矩阵验收    |
| 真实 staging S3/CDN 与生产权限未验收 | 本地 MinIO、`HeadBucket` 和预检脚本不代表真实 bucket、CDN、IAM/KMS 或生命周期通过 | 由基础设施所有者准备 guard、临时最小权限凭据和 staging 域名后运行 |
| 近生产规模性能未验收                 | HTTP baseline 不代表越南 4G 首屏、生产容量、查询计划或扩缩容结论                  | 批准 SLO 和近生产拓扑后执行合成/负载/真机或 RUM 验收              |
| 越南专业合规复核                     | 自动门禁和空白模板不构成法律、税务、隐私或行业意见                                | 由越南律师、会计和适用行业专家逐商城签字                          |

M3 不实现地址、结算、订单、运费、COD、支付、物流、退款或售后，也不伪造销量、最终运费、优惠券核销或订单应付。进入 M4 仍需用户明确批准新的高风险状态机、数据模型、迁移和验收计划。

## 7. Post-M3 就绪收口补充

- 仓库内技术实现：M2-only 自动升级、精确 gitleaks allowlist、生产 JWT/PII/S3 示例占位值拒绝、目标 bucket `HeadBucket`、可选 STS session token、HTTP baseline、guard-first staging S3/CDN 预检，以及 Zalo/越南合规证据矩阵。
- 本地技术收口：`verify`（23 文件/173 项）、M2 升级连续两轮、19 文件/103 项集成、15/15 E2E、gitleaks 正反向、依赖审计、Compose 与 HTTP local smoke 已通过，关闭三个仓库内技术缺口；远程 workflow 尚未运行。
- 外部边界：readiness 工具默认拒绝 production；HTTP 远程运行需要短期 staging guard，存储写入需要精确 endpoint/bucket、可写前缀之外的 guard 和 `finally` 清理。未取得真实 staging、设备、SLO 或专业签字前，相应项目仍为 `NOT_RUN`/`BLOCKED`。
- 本补充不改变 M3 原始测试统计，不代表远程 CI、生产部署或 M4 获得批准。完整证据见 `docs/reports/post-m3-readiness-closeout-report.md`；运行和外部验收要求见 `docs/testing/readiness-runbook.md`、`docs/testing/zalo-real-device-evidence-matrix.md` 与 `docs/testing/vietnam-compliance-signoff-matrix.md`。
