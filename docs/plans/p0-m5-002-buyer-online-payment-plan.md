# P0-M5-002 买家端在线支付体验实施计划

> 状态：已完成；最终证据见
> `docs/reports/p0-m5-002-buyer-online-payment-completion-report.md`
>
> 日期：2026-08-01
>
> 任务来源：`TASKS.md` 的 `P0-M5-002`
>
> 批准边界：用户要求按迁移后的 Task Tree 持续开发；本计划只授权仓库与本地测试实现，不授权真实商户调用、生产渠道启用、部署、推送或发布。

## 1. 目标与非目标

### 1.1 目标

- 在现有 COD 结算之外提供可选择的 `ONLINE` 报价和下单路径，继续由服务端计算整数 VND 应付金额。
- 使用官方 `zmp-sdk` Checkout `createOrder` 拉起 ZaloPay，并在调用前验证服务端返回的短期载荷。
- 将 SDK 返回的 Checkout `orderId` 绑定到内部订单和支付尝试，再通过服务端查询、验签回调和补偿事实恢复最终状态。
- 提供三语、移动端优先的准备中、拉起中、待确认、成功、失败、取消/过期、人工复核、超时和重试界面。
- 支持从订单详情重新进入最新支付尝试，避免页面刷新或 Mini App 重开后丢失恢复入口。
- 保留 COD 浏览器 E2E，并为在线支付增加明确的 localhost 测试桥；测试桥不得在非测试构建或非本机域名启用。

### 1.2 非目标

- 不启用生产或 sandbox 商户渠道，不调用真实 ZaloPay、VNPay、GHN 或 OA。
- 不把 `PaymentDone`、`checkTransaction`、客户端路由状态、SDK Promise 或客户端金额作为支付成功事实。
- 不修改支付、订单、库存或退款状态机，不新增数据库表或迁移。
- 不完成 `P0-M5-003` 的双商城真实 sandbox/真机/回调验收，也不完成财务对账。
- 不新增第二家支付供应商或支付方式选择器；P0 仍使用已批准的 Zalo Checkout + ZaloPay。

## 2. 官方契约与信任边界

2026-08-01 已复核以下 Zalo 官方文档和仓库锁定的 `zmp-sdk@2.51.8` 类型：

- `https://docs.zaloplatforms.com/docs/MA/checkoutSdk/intro`
- `https://docs.zaloplatforms.com/docs/MA/checkoutSdk/apis/createOrder`
- `https://docs.zaloplatforms.com/docs/MA/checkoutSdk/apis/checkTransaction`
- `https://docs.zaloplatforms.com/docs/MA/checkoutSdk/integration-process/overview/maResult`

`PaymentDone` 表示用户完成或取消 Checkout 流程，并不证明支付成功。Mini App 可在该事件后调用
`checkTransaction` 辅助用户提示，但最终 UI 状态必须再次读取本项目服务端；服务端只接受供应商验签回调或主动查单事实，并继续核对商城、订单、支付尝试、VND 金额和状态。

## 3. 涉及模块与文件

- `apps/mini-app/src/commerce-api.ts`：ONLINE 报价/下单和支付详情、launch、绑定、查询、重试客户端。
- `apps/mini-app/src/payment-runtime.ts`：官方 SDK 与 localhost 测试桥的隔离封装、载荷校验、事件订阅和超时清理。
- `apps/mini-app/src/payment-runtime.spec.ts`：SDK 结果不可信、事件/超时/中止/清理的单元回归。
- `apps/mini-app/src/checkout-view.tsx`：支付方式选择和 ONLINE 下单路由。
- `apps/mini-app/src/payment-view.tsx`：权威状态加载、拉起、绑定、查询、轮询和重试页面。
- `apps/mini-app/src/orders-view.tsx`、`catalog-app.tsx`：订单恢复入口和支付路由。
- `apps/mini-app/src/styles.css`、`packages/i18n/src/index.ts`：三语移动端状态和交互样式。
- `apps/api/src/orders/orders.service.ts`：订单详情加法式返回最新支付尝试 ID。
- `docs/api/openapi.m4.yaml`、`openapi.m5.yaml`：同步加法式订单详情字段和买家支付响应契约。
- `tests/e2e/mini-app.e2e.spec.ts`：双击幂等 COD 无回归，以及测试桥下的 ONLINE 成功、待确认、失败恢复和三语/移动端证据。

## 4. 数据模型与接口变化

- 数据库模型和迁移：无变化。
- `POST /v1/checkout/quote` 与 `POST /v1/checkout/orders`：沿用已存在的 `payment_method=ONLINE`；订单响应已有可选 `payment_attempt_id`。
- `GET /v1/orders/{orderId}`：加法式返回 `payment_attempt_id: string | null`，值来自该订单按尝试序号排序的最新支付尝试；查询继续受会员认证、商城上下文和订单归属限制。
- Mini App 使用现有：
  - `GET /v1/payments/{paymentId}`
  - `GET /v1/payments/{paymentId}/launch`
  - `POST /v1/orders/{orderId}/payments/{paymentId}/provider-order`
  - `POST /v1/payments/{paymentId}/query`
  - `POST /v1/orders/{orderId}/payments`
- 所有写请求继续使用独立的 16-128 字符幂等键；客户端不得提交或改写支付金额、币种、商城或支付状态。

## 5. 执行与恢复流程

1. 用户在结算页选择 COD 或 ONLINE，每次切换均向服务端重新报价并得到对应 `quote_hash`。
2. ONLINE 下单原子创建待支付订单、库存预留和首个支付尝试，随后进入 `/payments/{paymentId}`。
3. 支付页轮询短时间内尚未准备好的 launch；只有用户点击后才获取短期载荷并调用官方 `createOrder`。
4. SDK 返回 Checkout `orderId` 后立即调用服务端绑定接口；任何客户端/SDK 返回都不能直接显示支付成功。
5. `PaymentDone` 到达后调用 `checkTransaction` 仅作提示，并调用服务端主动查询；随后以有限轮询读取内部支付事实。
6. `SUCCEEDED` 显示成功；`FAILED`、`CANCELLED` 在订单仍可支付时创建新尝试；`EXPIRED`、`REVIEW_REQUIRED` 停止重试并给出订单/人工处理入口。
7. SDK 缺失、取消、事件丢失、网络失败、服务端待确认或轮询超时均保留订单与支付入口，不伪造失败或成功。

## 6. 兼容、回滚与发布边界

- 订单详情字段是可选消费方兼容的加法式变更；旧客户端忽略该字段。
- ONLINE 渠道仍由现有商城隔离配置和 `PAYMENT_PROVIDER` 控制；配置缺失时服务端失败关闭，COD 不受影响。
- localhost 测试桥同时要求构建时 `VITE_ZALO_TEST_BRIDGE=true`、本机 hostname 和显式注入对象；生产构建不会自动降级为假支付。
- 回滚可移除新增前端路由/组件和订单详情字段，无数据迁移或业务事实回滚。
- 真实渠道、回调域名、测试成员和 Zalo 宿主真机证据继续记录为 `P0-M5-003` 外部阻塞项。

## 7. 风险与外部依赖

- Checkout 事件可能丢失、重复或先于 Promise 返回；监听必须在拉起前注册，按相同函数解除，并设置可中止超时。
- `createOrder` 可能返回空/异常 `orderId`；不得调用绑定接口或泄露原始 SDK 错误。
- 支付创建 worker 可能尚未准备 launch；页面需有限轮询且支持手动重试。
- 绑定/查询可能限流、超时或返回未决状态；页面必须保留“尚未确认”而非错误推断。
- 支付成功与订单状态投影存在短暂时差；支付详情是该页面的直接权威读模型，订单详情通过刷新最终收敛。
- 真实验收依赖 `EXT-PAY-001`、`EXT-ZALO-001` 和 `EXT-NET-001`，本任务不能替代这些证据。

## 8. 测试与验收

- 单元：载荷校验、监听先于 launch、provider order 绑定、`PaymentDone` 不映射成功、`checkTransaction` 失败不覆盖服务端恢复、超时/中止/监听清理。
- API/集成：会员只能读取本商城本人订单的最新支付尝试 ID；另一会员和另一商城不可见；无支付尝试返回 `null`。
- 浏览器：COD 双击幂等无回归；ONLINE 报价/下单、明确用户点击、SDK 测试桥、绑定、服务端成功/未决/失败、重试和刷新恢复；越南语、中文、英文及 Chromium/WebKit 移动视口无横向溢出。
- 静态和构建：`format:check`、`lint`、`typecheck`、`test:unit`、`build`、`db:validate`。
- 仓库门禁：相关集成测试、全量 `verify`、浏览器 E2E、`git diff --check`、生产依赖审计和敏感信息扫描。
- Zalo Testing 真机和真实 sandbox：本任务结束时必须明确标记 `NOT_RUN/BLOCKED`，不得以浏览器测试桥代替。
