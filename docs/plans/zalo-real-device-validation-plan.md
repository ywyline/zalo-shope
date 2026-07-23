# Zalo 真实身份与真机联调专项计划

> 状态：实施中
>
> 日期：2026-07-19
>
> 依赖：`REQUIREMENTS.md`、`AGENTS.md`、`docs/architecture/m1-security-and-data-design.md`、Zalo Mini App 官方登录、手机号与 CLI 文档

## 1. 目标与非目标

目标：

- 为现有身份适配层增加真实 Zalo Open API provider；App Secret 只存在于服务端本地/部署环境，前端、日志、测试快照和版本库均不得出现。
- 保持商城与 Zalo App 配置双重校验：运行时 provider 固定父 App/Mini App，数据库 `StoreZaloApp` 仍按商城和 TEST 环境确定允许的身份边界。
- 支持真实 `getAccessToken` 登录交换、用户主动请求手机号、拒绝授权后手工输入以及一次性手机号 token 解码。
- 会员联系方式与 Zalo 取号支持越南 `+84` 和中国大陆 `+86` 移动号码；商城目标市场、VND、越南地址和配送范围保持不变。
- 把现有 Vite 买家端初始化为 ZMP deploy-only 项目，完成真机 Device 模式和一个 Testing 版本；不提交审核、不公开发布。
- 对自动化门禁、手机交互和 Zalo 开发者后台状态形成可审查证据，并清理一次性进程、token 与测试数据。

非目标：

- 不提交 Mini App 审核、不发布正式版本，也不绕过经营主体或美妆资质验证。
- 不实现 Zalo OA、Checkout SDK、分享、生产支付、生产域名或生产部署。
- 不把短期公网隧道当作生产 API；Testing 版本只有在构建时配置了受控 HTTPS API 后才用于端到端身份验证。
- 不改变商城、会员、同意记录、会话或手机号数据模型，不放宽跨商城、RBAC、隐私与日志边界。
- 不增加中国地址、人民币结算、中国短信或跨境配送能力。

## 2. 涉及模块与文件

- `packages/integrations/src/index.ts`：真实 Graph API provider、HMAC `appsecret_proof`、响应校验、超时和脱敏错误。
- `packages/integrations/src/index.spec.ts`：请求头、签名、成功映射、Mini App 不匹配、上游错误、手机号解码和敏感信息不泄露。
- `packages/config/src/index.ts`、`.env.example`：真实 provider 的父 App ID、Mini App ID、App Secret、超时和 token 元数据 TTL 配置；示例不含真实密钥。
- `apps/api/src/app.module.ts`、`apps/api/src/auth/auth.service.ts`：provider 装配及可预期的无效凭据/上游不可用 HTTP 映射。
- `apps/mini-app/`：deploy-only 元数据、Testing 构建命令和必要的 ZMP 配置；继续使用 `zmp-sdk`，不在前端添加密钥。
- `README.md`、专项完成报告：记录安全配置、Device/Testing 操作、验证证据与保留项。

## 3. 接口与数据边界

- 客户端仍调用既有 `POST /v1/auth/zalo/exchange` 和 `PUT /v1/members/me/phone/zalo`，不新增公开 API，不改变请求/响应契约。
- 服务端身份验证调用 `GET https://graph.zalo.me/v2.0/me`，传递 `access_token` 与以 App Secret 对 access token 计算的 HMAC-SHA256 `appsecret_proof`。
- 服务端手机号解码调用 `GET https://graph.zalo.me/v2.0/me/info`，传递 `access_token`、一次性 `code` 与服务端 `secret_key`。token 的一次性和约两分钟时限由 Zalo 可信端执行，应用不得缓存后重放。
- 官方身份响应未提供本项目所需的明确 token 过期时间；provider 只保存一个保守、可配置的元数据 TTL。每次敏感操作仍实时向 Zalo 验证，不能以该时间替代上游校验。
- 数据库只在 local/test 将美妆商城 TEST 配置指向父 App `1364144247280182439` 与 Mini App `1054942727582608082`；不修改生产配置，不产生迁移。
- 手机号继续以 E.164 密文和按商城 HMAC 保存；现有 `+84` 数据无需迁移，新增 `+86` 不改变 API 请求/响应或数据库约束。

## 4. 安全、兼容与回滚

- `ZALO_APP_SECRET` 只能由用户在忽略版本控制的环境文件或受控部署密钥中录入；终端、浏览器自动化、补丁、日志和报告均不得读取或回显其值。
- provider 错误仅暴露稳定类别：无效凭据映射为 401，上游超时/不可用映射为 503；不透传 token、secret、Zalo 原始响应或请求头。
- 请求使用短超时与有界 JSON 响应；Mini App ID 在发起网络请求前验证。父 App ID 使用服务端配置返回，并由 AuthService 与商城数据库配置再次比对。
- 代码回滚为恢复 `ZALO_IDENTITY_PROVIDER=disabled` 并撤销 provider/ZMP 元数据；数据库回滚仅在 local/test 禁用 TEST `StoreZaloApp`。会员、同意与审计数据不做破坏性回滚，测试 fixture 仅按明确标识清理。
- 号码范围回滚只恢复服务端允许列表；已保存的 `+86` 联系方式不做破坏性删除，需通过向前修复、用户更正/删除或合规流程处理。
- ZMP 登录 token 只保存在 CLI 的忽略文件中；Testing 版本可从 Zalo 版本管理中删除或覆盖，但本轮不执行审核/发布操作。

## 5. 风险与外部依赖

| 风险                         | 处理                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| App Secret 泄露              | 由用户在本机忽略文件中录入；自动化只检查是否存在，不读取值                                      |
| token 或 Graph 错误进入日志  | provider 使用固定错误消息；测试扫描错误文本与请求记录                                           |
| Testing 版本调用不到本地 API | Device 模式优先；Testing E2E 仅使用受控 HTTPS 临时地址，并在验证后关闭                          |
| 手机号 token 过期或重复使用  | 授权后立即提交；验证第二次使用失败；拒绝时自动打开手工输入                                      |
| 中越手机号规则或合规变化     | 号码按 `+84`/`+86` 分支测试；上线前更新权威号段并完成越南及中国个人信息处理专业复核             |
| 商城/App 串用                | provider 固定 App ID + 数据库商城配置 + 现有外部身份复合键三层校验，并保留回归测试              |
| 未完成美妆资质验证           | 只保留 DEV/Testing，不提交审核或公开发布，并在报告中列为上线阻塞项                              |
| 手机需要人工交互             | CLI 登录二维码、授权允许/拒绝和实际手机号输入由用户在手机端完成，Codex 继续执行其余可自动化步骤 |

## 6. 测试与验收

- 单元测试：HMAC 签名、请求目标/头、响应结构、Mini App 串用、超时、Graph 业务错误、手机号成功/失败、错误脱敏和配置必填规则。
- API 回归：现有 deterministic provider 测试继续通过；真实 provider 错误正确映射，不影响手工手机号、同意、会话和商城隔离。
- 静态门禁：`corepack pnpm verify`、`corepack pnpm test:integration`、`corepack pnpm audit --prod --audit-level high`、`git diff --check` 和敏感信息扫描。
- 真机 Device：在 Zalo 内完成登录成功；有效越南或中国大陆手机号允许后保存掩码；再次使用同一 token 失败；拒绝授权后出现手工表单；同意后手工 `+84`/`+86` 手机号可保存；未同意、其他国家或非法号码不能提交。
- ZMP Testing：CLI 登录 Mini App `1054942727582608082`，上传一个明确说明用途的 Testing 版本；版本管理可见，审核/发布状态不改变。
- 收尾：关闭公网隧道和本地进程，移除一次性数据库测试数据，确认 App Secret、ZMP token、手机号和 access token 未进入 Git 差异或报告。
