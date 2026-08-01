# P0-M6-009 会员互动与隐私运行时实施计划

> 状态：已完成；repository implementation + local/test validation `COMPLETE`
>
> 日期：2026-08-01
>
> 任务来源：`TASKS.md` 的 `P0-M6-009`
>
> 批准边界：用户要求按 Task Tree 持续开发至 Production Ready；本计划只实施既有 M6.5
> repository/local-test 纵向切片，不授权生产部署、真实外部调用或法律结论。
>
> 完成证据：`docs/reports/p0-m6-009-member-runtime-completion-report.md`

## 1. 目标与非目标

### 1.1 目标

- 复用 M6.1/M6.2 已冻结的 `member_favorites`、`member_product_views`、`privacy_requests`、
  `privacy_request_transitions` 与 M1 `consents`，交付商城/会员隔离的运行时 API。
- 提供收藏、最近 100 个商品浏览历史、轻量会员交易汇总、当前同意事实投影，以及结构化隐私请求
  创建、列表、详情和受限取消。
- 在商品详情、会员中心、收藏、历史和隐私页面交付越南语默认、中文/英文完整、移动优先、可访问的
  加载、空、错误、成功、重试和确认状态。
- 保留真实事实边界：隐私请求提交只产生 `SUBMITTED`，不声称访问、更正、删除、匿名化或注销已经履约。

### 1.2 非目标

- 不实现隐私请求的管理员审核、数据导出、自动删除/匿名化、账户关闭执行器或法律保留判断。
- 不删除或改写 consent 历史；撤回继续通过 M1 既有追加式 `REVOKED` 事件保存。
- 不实现 M6.4 返件验收/库存/换货、M6.6 分享、M6.7 完整售后 UI 或任何真实 Zalo/provider 能力。
- 不新增会员积分、等级、推荐、营销画像或跨商城聚合。

## 2. 涉及模块与文件

- `apps/api/src/member-runtime/`：controller、service、HMAC cursor 和单元测试。
- `apps/api/src/app.module.ts`：注册 M6.5 controller/service/cursor。
- `apps/mini-app/src/member-runtime-api.ts`：严格的会员运行时客户端和响应类型。
- `apps/mini-app/src/member-center-view.tsx`：会员首页、收藏、历史、同意和隐私请求页面。
- `apps/mini-app/src/catalog-app.tsx`：路由、商品收藏按钮和成功渲染后的历史 touch。
- `apps/mini-app/src/styles.css`、`packages/i18n/src/index.ts`：三语和移动端交互。
- `docs/api/openapi.m6.yaml`：同步当前 consent 投影与适用错误响应；既有 M6.5 路径保持兼容。
- `tests/integration/m65-member-runtime.test.ts`、`tests/e2e/mini-app.e2e.spec.ts`：真实数据库与浏览器验收。

## 3. 数据模型与接口变化

### 3.1 数据与事务

- 不改 Prisma schema，不新增迁移。所有查询和写入在 member `StoreContext` 事务中执行，并显式包含
  `store_id` 与 `member_id`；FORCE RLS 继续作为第二层保护。
- 收藏按 `(store_id, member_id, product_id)` 幂等创建/删除，只允许当前商城可公开商品被新增。
- 商品历史在会员范围 advisory lock 下 upsert `last_viewed_at`，随后删除排序第 101 项以后的记录；
  匿名浏览不调用写接口，重复渲染只更新时间而不制造次数。
- 隐私说明使用现有 `PII_ENCRYPTION_KEY` 加密；创建按商城、会员和幂等键锁定并核对 request hash，生成
  至少 128-bit 的公开 `PRV-` 编号。取消只追加 `CANCEL` transition，由数据库 trigger 投影 header；
  服务端只持久化规范化的非敏感会员取消原因，不保存客户端自由文本，原始请求仅参与幂等 hash。
- consent 当前状态按 `(purpose, occurred_at DESC, id DESC)` 读取最新只追加事实；撤回仍调用现有严格
  consent API 追加 `REVOKED`，不删除历史或伪造外部授权撤销。

### 3.2 API

- 实现既有 `GET/PUT/DELETE /v1/members/me/favorites`、product history、commerce summary 和
  privacy request 契约。
- 加法式新增 `GET /v1/members/me/consents`，仅返回当前会员/商城每个 purpose 最新的
  `purpose/status/policy_version/source/occurred_at`，不返回 evidence、内部 ID 或其他会员事实。
- 列表使用签名 `c1_` opaque cursor，绑定商城、会员、资源、locale、微秒排序键和 ID；游标不能跨商城、
  会员、资源或 locale 重放。
- 会员读取限制 60 次/60 秒，写入限制 10 次/60 秒；Redis 不可用时隐私/写路径失败关闭。

## 4. 兼容、回滚与迁移

- 现有 API 和表保持兼容；新路由与 consent GET 为加法式变化，旧客户端不受影响。
- 应用回滚可移除 M6.5 controller、页面和客户端。收藏/历史可由会员 API 删除；已创建隐私请求与 consent
  是审计/隐私事实，不得通过回滚脚本删除或改写，只允许后续受审状态转换或向前修复。
- M6.2 `down.sql` 在任一收藏、历史或隐私事实存在时继续以 SQLSTATE `55000` 失败关闭。

## 5. 风险、未决问题与外部依赖

- 商品在收藏/历史后可能下架或停用；响应只返回受限摘要并标记 `available=false`，不泄露草稿、合规或
  内部字段。
- 浏览历史是功能数据而非推荐画像；保持最多 100 项并提供单项/全部删除，不跨商城聚合。
- consent `REVOKED` 只证明本系统收到撤回事实；Zalo 宿主权限、法定保留、订单/财务记录和账户关闭
  仍需独立流程，UI 不得承诺即时物理删除。
- 越南隐私政策文本、处理时限与履约操作仍依赖 `EXT-LEGAL-001`；本任务只交付真实受理和查询入口。
- 本任务不调用 Zalo SDK/API 或其他第三方能力，因此不产生新的官方 provider 文档依赖。

## 6. 测试与验收

- 单元：cursor 签发/篡改/过期/跨 scope、隐私 request hash/公开编号、状态和响应脱敏。
- 集成/API：双商城/双会员 IDOR、严格 DTO、收藏幂等、历史最多 100、清除、不可用商品摘要、汇总计数、
  consent 最新事实、隐私加密、创建 replay/异参、取消 replay/version/state 冲突和限流。
- E2E：商品收藏与历史、会员汇总、三语收藏/历史/隐私页面、创建/查询/取消、同意撤回、加载/空/错误
  和 Android/iPhone 视口无横向溢出。
- 门禁：定向 unit/integration/E2E、完整 integration、`corepack pnpm verify`、完整浏览器 E2E、OpenAPI
  重复键/本地引用、生产依赖审计、Gitleaks、Compose、`git diff --check` 和高风险差异复审。
- 生产法律履约、Zalo 真机、部署和 rollout 明确为 `NOT_AUTHORIZED / NOT_RUN`，不能以本地测试替代。
