# P0-M5-002 买家端在线支付体验完成报告

> 状态：repository implementation + local/test validation `COMPLETE`；适用仓库门禁 `PASS`；
> Zalo Testing 真机、真实 Zalo Checkout/ZaloPay sandbox 与生产渠道验收 `BLOCKED / NOT_RUN`
>
> 日期：2026-08-01
>
> 依据：`docs/plans/p0-m5-002-buyer-online-payment-plan.md`、`REQUIREMENTS.md`、
> `AGENTS.md`、`TASKS.md`

## 1. 阶段结论

`P0-M5-002` 已完成 Mini App 买家端 ONLINE 报价、下单、Zalo Checkout 拉起、provider order 绑定、
服务端权威查询、失败重试和刷新/重开恢复入口。COD 路径保持兼容，ONLINE 仍由商城独立渠道配置和
服务端 provider 配置控制；本任务没有启用真实商户、sandbox 或 production 渠道。

客户端只把 `PaymentDone` 解释为 Checkout 流程完成或取消，把 `checkTransaction` 解释为非权威提示。
页面仅在服务端支付详情返回 `SUCCEEDED` 时显示支付成功。金额、币种、商城、订单、支付状态和库存动作
均继续由服务端事实与既有 M5 状态机控制。

## 2. 已实现范围

### 2.1 买家结算与恢复

- 结算页提供 COD/ONLINE 选择；地址、优惠券、商品或支付方式变化立即使旧报价失效并重新向服务端报价。
- ONLINE 下单沿用服务端整数 VND 计价、幂等订单创建和库存预留，成功后进入
  `/payments/{paymentId}`，不会在下单响应中伪造支付成功。
- 支付页覆盖准备、可拉起、拉起中、待确认、成功、失败、取消、过期、人工复核、超时和重试状态。
- 订单详情返回并展示本订单最新 `payment_attempt_id`，支持刷新或 Mini App 重开后恢复；ONLINE
  待支付订单也可按既有原子取消路径终止活动支付尝试并释放库存预留。

### 2.2 Zalo Checkout 信任边界

- `payment-runtime.ts` 在 `createOrder` 前注册 `PaymentDone`，校验短期 launch 载荷，绑定合法
  provider order，并在超时、路由卸载或错误时移除同一监听器。
- SDK Promise、`PaymentDone`、`checkTransaction`、客户端路由和客户端金额均不能产生成功事实；
  provider order 绑定后只通过服务端回调/主动查询事实收敛状态。
- launch 只由明确用户点击触发。已绑定尝试不会再次显示拉起操作，服务端 launch 完整性门禁也会失败关闭。
- localhost 测试桥同时要求 `VITE_ZALO_TEST_BRIDGE=true`、`localhost`/`127.0.0.1` 和显式注入对象；
  普通 Web 预览与生产路径不会回退到测试支付。

### 2.3 API、隔离与兼容

- Mini App 客户端接入既有支付详情、launch、provider-order 绑定、权威查询和新尝试 API。
- `GET /v1/orders/{orderId}` 加法式返回可空 `payment_attempt_id`；
  `GET /v1/payments/{paymentId}` 加法式返回 `provider_order_bound`。
- 支付与订单读取继续同时绑定 Bearer 会员、Store-Code、服务端解析的 `store_id`、会员 ID 和订单归属；
  另一会员或另一商城统一不可见。
- 没有数据库 schema、迁移、订单/支付/库存/退款状态机或供应商契约破坏性变化。

## 3. 验证证据

| 检查项                                                        | 状态                       | 证据与边界                                                                                      |
| ------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| 支付 runtime 单元测试                                         | `PASS`                     | 6/6；载荷、监听顺序、非权威 SDK 结果、超时、中止和清理                                          |
| 支付 runtime + Zalo session 定向单元测试                      | `PASS`                     | 19/19                                                                                           |
| M5.4 在线支付集成                                             | `PASS_LOCAL_TEST`          | 17/17；含本人/商城隔离、绑定、查询、重试和成功事实                                              |
| 完整 integration                                              | `PASS`                     | 37 个文件、331/331；真实本地 PostgreSQL、Redis、MinIO 与 ClamAV                                 |
| 完整浏览器 E2E                                                | `PASS_LOCAL_TEST`          | 23/23；Admin Chromium、Pixel 7 Chromium、iPhone 13 WebKit；含三语 ONLINE 与 COD 回归            |
| `NODE_OPTIONS=--max-old-space-size=4096 corepack pnpm verify` | `PASS`                     | format、lint、typecheck、75 个文件/624 项 unit、production build、Prisma validate               |
| 生产依赖 high 审计                                            | `PASS_WITH_DISCLOSURE`     | 退出码 0；3 项 moderate，0 high/critical                                                        |
| OpenAPI 严格 YAML/本地引用                                    | `PASS_WITH_LIMITATION`     | 6 份文档无重复键、外部引用或缺失引用；仓库仍无专用 OpenAPI 3.1 语义 linter                      |
| Gitleaks 8.30.1                                               | `PASS`                     | 36 个可达提交、tracked patch 与 20 个非忽略 untracked 交付候选无泄漏                            |
| Compose、差异与高风险复审                                     | `PASS`                     | `docker compose config --quiet`、`git diff --check`；成功信任、重复拉起、隔离和测试桥边界已复核 |
| Zalo Testing/真实 sandbox/回调/资金                           | `BLOCKED / NOT_RUN`        | 缺少双商城商户配置、测试账号/设备和可达 HTTPS 回调环境；浏览器测试桥不能替代                    |
| deployment/production rollout                                 | `NOT_AUTHORIZED / NOT_RUN` | 未部署、未启用生产渠道、未调用真实 provider                                                     |

首次默认堆 `verify` 在 ESLint 阶段因本机 Node 堆不足退出；随后单独 lint 暴露并修复 5 项样式问题，
最终使用临时 4096 MiB 堆从头运行全量 `verify` 通过。仓库命令和生产配置未因此放宽。

## 4. 已知限制与生产阻断项

1. **真实支付未验收**：`EXT-PAY-001`、`EXT-ZALO-001` 和 `EXT-NET-001` 仍阻塞双商城
   Zalo Checkout/ZaloPay sandbox、真实回调、查单、退款、对账与 Android/iPhone 宿主证据。
2. **财务与物流闭环未完成**：GHN sandbox、COD 回款、支付/退款差异和财务对账仍由
   `P0-M5-004`、`P0-M5-005` 跟踪。
3. **完整售后和会员体验未完成**：COD settlement、返件验收、库存恢复、换货、会员隐私运行时、
   分享和完整售后 UI 仍在 M6 后续任务中。
4. **依赖与工具债仍开放**：React Router 保留 3 项 moderate 公告；OpenAPI 尚无专用 3.1 语义 linter。

## 5. 回滚与后续

- 应用回滚可移除新增支付路由、组件、API 客户端方法和两个加法式响应字段；没有需要回滚的数据迁移。
- 已产生的订单、库存预留和支付事实继续由 M4/M5 状态机收敛，不得通过脚本删除或伪造。
- `P0-M5-002` 可标记 `Done`；`P0-M5-003` 保持外部阻塞，不能用 localhost 测试桥替代。
- 下一项依赖已满足的内部任务为 `P0-M6-009`；其后的 P0 路径当前均有未满足依赖。
