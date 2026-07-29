# P0 分阶段开发计划

> 状态：已批准，M0 已完成，M1 实施完成但验收有保留；M2.1-M2.8.4、M3.1-M3.7、M4 与 M5.1-M5.4 已完成自动化收口；
> M5.5-M5.7 仓库自动化已实施但外部验收仍阻塞；M6.1、M6.2、M6.3-A、M6.3-B0、B1、B2a、B2b-D0
> 与 B2b-D1 repository + local/test storage validation 已完成且 D1 适用仓库门禁通过；B2/B2b、B3-B7、
> M6.3、UI 与生产启用未完成或未授权并保持失败关闭；P0 整体未完成
>
> 版本：0.12
>
> 日期：2026-07-29
>
> 依赖：`REQUIREMENTS.md`、`AGENTS.md`、`docs/architecture/system-architecture.md`

批准记录：用户于 2026-07-17 批准本计划并授权实施 M0；同日批准 M1 专项设计与实施计划，授权按 M1.1 至 M1.6 顺序实施。

M0 完成记录（2026-07-17）：单仓库、四个应用、共享配置/日志/基础设施检查、Prisma 迁移入口、本地 Compose、CI 和项目命令已交付；格式、Lint、类型、7 个单元测试、1 个基础设施集成测试、生产构建、Prisma 校验和生产依赖审计通过。

M1 实施记录（2026-07-17）：商城/RLS、身份会话、RBAC、三语与越南本地化、审计、API 契约及 Mini App/管理端基础界面已交付；33 个单元测试和 18 个集成测试通过。Chrome 已完成未认证页面的桌面/移动、三语、错误/降级与键盘焦点回归，并修复旧版 ZMP/Vite 下 Mini App 缺少 React 运行时导致的空白页；认证后管理端状态和真实 Zalo provider/真机流程仍未验收，因此 M1 记录为“实施完成、验收有保留”。用户已明确接受这些项目作为结转风险并另行批准 M2；该批准不等同于 M1 保留项验收通过。

M2 批准与实施记录（2026-07-18 至 2026-07-20）：用户明确接受 Zalo Mini App 真机验收作为结转风险并批准 `docs/plans/m2-implementation-plan.md`。M2.1-M2.7 已交付商品领域数据库、API、媒体、合规、装修、买家目录、CSV 导入、版本与批量运营能力；M2.8.1-M2.8.3 已补齐商品属性编辑、三语目录/合规管理端工作台及受限 XLSX/商品导出；M2.8.4 已建立真实 API/基础设施上的 Chromium/WebKit 可重复浏览器 E2E 与 CI 证据归档。最新 5 项 E2E、80 项单元测试、59 项全量集成测试及生产依赖审计通过。Zalo 真机、生产对象存储/CDN 和越南专业合规复核仍是外部上线前置条件；不得自动进入 M3。

M3 规划记录（2026-07-20）：已依据总需求、架构和 M2 完成基线形成 `docs/plans/m3-implementation-plan.md`，冻结库存、搜索、购物车、促销与服务端商品金额报价的目标、非目标、核心不变量、预计数据/API、迁移回滚、分阶段顺序和验收门禁。P0 原批准不自动推进 M3，因此计划批准前不创建 M3 业务代码、schema 或迁移。

M3 批准记录（2026-07-20）：用户明确批准 `docs/plans/m3-implementation-plan.md`，授权按 M3.1-M3.7 顺序实施；当前先执行 M3.1 契约冻结，不自动进入 M4，也不授权生产凭据、推送、发布或部署。

M3.1 完成记录（2026-07-20）：库存、搜索、促销/优惠券、报价和购物车的数据字典、权限、OpenAPI、严格 DTO 与纯领域规则已冻结；定向 29 项测试及仓库级 `verify`（109 项单元测试）通过。M3.2 数据库迁移尚未开始，详见 `docs/reports/m3.1-completion-report.md`。

M3.2 完成记录（2026-07-20）：M3 数据表、复合外键、约束/索引、强制 RLS、不可变保护、搜索扩展/初始回填、生产最小授权迁移和 local/test 基础种子已完成，并通过迁移及回滚演练。详见 `docs/reports/m3.2-completion-report.md`。

M3.3 完成记录（2026-07-20）：仓库、余额、流水、受审调整、原子初始库存导入、预留终态原语、数据库轮询过期 worker 和三语管理工作台已完成；`verify`、73 项集成测试、6 项 E2E、生产依赖审计与 Compose 检查通过。下一阶段按批准顺序进入 M3.4，不自动进入 M4。详见 `docs/reports/m3.3-completion-report.md`。

M3.4 完成记录（2026-07-20）：三语/去变音搜索、真实筛选与排序、商品联想、会员历史/清空、商城热门词、发布投影同事务同步、逐商城受审重建命令和移动端搜索页已完成；`verify`、79 项集成测试、8 项 E2E、生产依赖审计与 Compose 检查通过。下一阶段按批准顺序进入 M3.5，不自动进入 M4。详见 `docs/reports/m3.4-completion-report.md`。

M3.5 完成记录（2026-07-21）：版本化促销/优惠券、精确目标候选、整数 VND 可信报价、命令幂等与发布完整性保护、三语管理端工作台和无副作用管理员预览已完成；`verify`（124 项单元测试）、87 项集成测试、9 项浏览器 E2E、scratch 迁移回滚/重新前滚、生产依赖审计与 Compose 检查通过。下一阶段按批准顺序进入 M3.6，不自动进入 M4。详见 `docs/reports/m3.5-completion-report.md`。

M3.6 完成记录（2026-07-22）：会员购物车 API、服务端可售/促销重算、行乐观锁与同商品 SKU 替换、目录/搜索可售与活动投影，以及 Mini App 三语购物车体验已完成；`verify`（128 项单元测试）、92 项集成测试、11 项浏览器 E2E、生产依赖审计、Compose 与 OpenAPI 检查通过。下一阶段 M3.7 继续负责认证后完整购物车浏览器矩阵、并发/安全和 M3 收口，不自动进入 M4。详见 `docs/reports/m3.6-completion-report.md`。

M3.7 完成记录（2026-07-22）：库存/预留、促销发布、优惠券领取和购物车并发边界，跨商城/会员限流，凭据、correlation ID 与网络身份日志安全，以及管理端 RBAC/冲突和认证后双商城三语购物车浏览器矩阵已补齐；新增优惠券领取与库存预留完整性迁移。搜索重建要求目标商城活动管理员具备 `store.catalog.publish`，以 100 商品批次在单个 `REPEATABLE READ` 事务内重建，失败整体回滚。最终 `verify`（21 个文件/138 项单元测试）、19 个文件/102 项集成测试、15/15 Playwright、生产依赖审计、Compose 与 fresh scratch 迁移/权限/down 门禁通过。Zalo 测试桥仅限 localhost Web E2E，不能替代宿主真机；仓库尚缺 M2-only 自动化升级 fixture。详见 `docs/reports/m3-completion-report.md`；不自动进入 M4。

M4 批准与实施记录（2026-07-23）：用户明确批准 `docs/plans/m4-implementation-plan.md`。已实现按商城/会员隔离的加密地址、服务端最终 VND 报价、COD 幂等下单、订单/行/不可变快照/状态转换、购物车转换与会员券原子核销、库存预留绑定/消费/释放/恢复、过期补偿 worker、买家端交易页面及订单/配送管理工作台。M4 只启用 COD，不接真实线上支付、物流、退款或售后；越南权威行政区主数据、Zalo 宿主真机和 M5 供应商沙箱仍是外部前置条件。最终门禁与限制见 `docs/reports/m4-completion-report.md`。

M5 批准记录（2026-07-24）：用户批准 `docs/plans/m5-implementation-plan.md`，确认支付采用 ZaloPay、物流采用 GHN，两个商城使用独立渠道配置，并授权按 M5.1-M5.7 顺序实施；当前进入 M5.1 契约冻结。真实凭据、外部商户调用、部署、推送和发布不在授权范围，供应商沙箱材料仍是 M5.2 及运行时集成门槛。

M5.1 完成记录（2026-07-24）：支付/退款/物流/回调/outbox-inbox 数据与权限契约、19 路径 OpenAPI、严格 DTO、纯状态机、Zalo Checkout ZaloPay MAC/状态契约和 GHN 状态映射已冻结；GHN 未签名 webhook 只作为主动查单提示。`verify`（32 个文件/236 项单元测试）与生产依赖高危审计通过。M5.2 等待两个商城的 Zalo Checkout/ZaloPay sandbox 与 GHN sandbox 配置、secret reference 和 HTTPS 回调条件，不以假凭据继续。

M5 受限继续批准记录（2026-07-25）：用户确认主体尚未核验且部分真实测试不能进行，并批准将 Zalo 主体核验、真实 sandbox 账户、secret reference 与 HTTPS 回调作为 M5.5/M5.7 外部验收门槛。M5.2-M5.4 可按顺序实施，但渠道默认禁用、不得创建虚构业务事实、测试适配器必须在非 test 环境硬失败；当时结论是未补齐真实证据前不标记 M5 完成且不进入 M6，后者已被 2026-07-27 的受限双轨批准替代。

M5.2 完成记录（2026-07-25）：商城隔离的支付/退款/物流渠道、支付尝试/转换、回调、退款/转换、报价、运单/行/轨迹/operation 与 outbox/inbox 共 14 张表已实施；12 项权限只登记不自动赋予生产角色。四条前向迁移提供强制 RLS、复合外键、活动单唯一约束、订单金额/币种绑定、退款容量锁、GHN 未验证提示门禁、只追加保护和运行角色列级最小授权。local/test seed 不创建渠道或业务事实；20 份迁移的升级、重复部署、down/重新前滚和 `55000` 门禁通过。下一步按批准顺序进入 M5.3，不标记 M5 完成。

M5.3 完成记录（2026-07-25）：已实现商城事务内版本化 outbox、`FOR UPDATE SKIP LOCKED` 短租约领取、租约恢复、有限指数退避/抖动、分类死信、inbox 并发去重和受权限/MFA/确认/原因/expected version 保护的审计重放；消息 payload 的商城身份和状态字段组合由第 21 条前向迁移加固。集成套件在自动创建并销毁的专用数据库中验证双连接并发与跨商城边界，不在开发库留下假事实。当前只有 `NODE_ENV=test` 探针 handler，未调用供应商；下一步只进入受限 M5.4，不标记 M5 完成。

M5.4 完成记录（2026-07-26）：已实现 ONLINE 原子下单、首个/重试支付尝试、异步 launch、确定性 test-only provider、统一支付事实命令、支付成功一次性库存消费、取消/过期协调和迟到成功复核。完整证据见 `docs/reports/m5.4-completion-report.md`；真实 Checkout 尚未据此验收。

M5.5 进度记录（2026-07-26）：仓库内 Zalo Checkout/ZaloPay 适配器、商城渠道/secret resolver、provider-order 绑定、原始 body webhook、callback/inbox 去重和定时丢回调补偿 worker 已实现；HTTP/PostgreSQL 测试覆盖有效期内补偿成功一次性扣库存、迟到成功复核、pending 有限重试和商城隔离。真实 merchant credentials、HTTPS callback、Zalo sandbox 查单/丢回调演练和 Testing 真机仍为 `BLOCKED/NOT_RUN`，因此 M5.5 与 M5 不标记完成；详见 `docs/reports/m5.5-progress-report.md`。

M5.6 进度记录（2026-07-26）：仓库内 GHN 适配器、商城渠道/secret resolver、仓库履约资料、订单物理快照、可靠建单/取消/查单、未签名 webhook hint、短期面单代理和双端三语轨迹工作台已实现；报价费用分解、成功 operation 单调性、状态推进、ShopId 碰撞与商城隔离已补强，310 项单元、155 项集成、20 项 E2E 和 23 迁移演练全部通过。真实 GHN ShopId/Token、测试仓库/订单、面单/webhook/COD 与 Zalo 宿主均为 `BLOCKED/NOT_RUN`，因此 M5.6 与 M5 不标记完成；详见 `docs/reports/m5.6-progress-report.md`。

M5.7 进度记录（2026-07-26）：仓库内 Zalo Checkout 退款创建/查询、商城隔离的部分/全额退款、
支付聚合投影、主动查询、脱敏集成任务列表与受审 dead-letter 重放，以及管理端/买家端三语工作台
已实现。退款创建因官方无供应商幂等键而最多调用一次，网络结果不确定转人工复核并继续占用容量；
脱敏任务元数据按领域 read 权限过滤。最终 318 项单元、162 项集成、21 项 E2E 和 24 个迁移演练
通过。当前对账仅为逐笔权威查询和本地异常视图。真实两商城退款、商户结算文件/手续费、GHN COD
回款与 Zalo 宿主仍为 `BLOCKED/NOT_RUN`，因此 M5.7、M5 和 P0 均不标记完成；原“不进入 M6”的
顺序结论已由 2026-07-27 的受限双轨批准替代；详见
`docs/reports/m5.7-progress-report.md`。

M6 受限继续批准记录（2026-07-27）：用户明确批准采用双轨方案，允许在 M5 外部验收继续阻塞且
M5/M5.7/P0 均不标记完成的前提下推进仓库内 M6，并先完成 M6.1 契约冻结。该批准只替代上述
“不进入 M6”的实施顺序限制，不放宽真实 ZaloPay/GHN、HTTPS 回调、结算、COD 回款和 Zalo 宿主
上线门禁，也不授权 M6.2 schema/迁移、真实供应商调用、生产凭据、部署、推送或发布。

M6.1 完成记录（2026-07-27）：已冻结售后、会员收藏/历史、最小隐私请求受理和主动分享的数据、
权限、OpenAPI、严格 DTO 与纯领域规则；定向 34 项测试及仓库级 `verify`（352 项单元测试）通过。
M6.1 完成时 M6.2 尚未获授权；M5/M5.7/P0 未完成状态及全部外部上线门禁保持不变。详见
`docs/reports/m6.1-completion-report.md`。

M6.2 批准与完成记录（2026-07-27）：用户随后明确授权继续 M6.2 数据层。30 个商城模型/表、11 段
前向迁移、12 项只登记不自动赋予生产角色的 STORE 权限、FORCE RLS、复合租户关系、会员 owner
scope、只追加/列级授权以及政策快照、售后结算、库存/换货、凭证、隐私和分享完整性 guard 已实施；
初始第六段 `20260727115000_m62_integrity_closeout` 关闭 legacy 初态/决定、settlement 聚合锁、返件/
凭证/COD、库存、换货、共享 shipment 并发和 definer ACL 旁路；后续五段前向修复补齐容量占用、
immutable order allocation、M5/M6 退款锁序和 fail-closed actor scope。定向数据库 38/38、完整
integration 26 个文件/202 项、35 段迁移演练及 `verify` 51 个文件/352 项单元测试通过。所有商城政策快照
enforcement 保持 OFF，未创建生产政策，checkout writer/readiness、买家/管理员运行时、worker、UI
和真实外部调用均未交付；M6.2 完成当时尚未进入 M6.3。
M5.5-M5.7、整个 M5 与 P0 仍不标记完成，原有外部上线门禁保持不变。

M6.3 授权记录（2026-07-28）：用户要求按严谨工作流继续下一阶段，授权进入 M6.3。按
`docs/plans/m6.3-implementation-plan.md`，先实施 checkout 政策快照/readiness/enforcement 与物流
purpose 分流的 M6.3-A，再进入售后申请、审核、返件和结算协调的 M6.3-B；A 完成不等于 M6.3、M6、
M5 或 P0 完成，也不放宽真实供应商与 Zalo 宿主门禁。

M6.3-A 实现与门禁进度（2026-07-28）：checkout 政策解析/同事务快照 writer、绑定活动投影与
runtime capability 的 readiness、受审逐商城 enforcement API、新增商城自动 OFF provisioning，以及
既有 M5 物流全链路 purpose 分流已实现；创建/取消 provider reference 竞态已改为可靠重试，两类非订单
purpose 不修改原订单的真实数据库证据已补齐。四段前向迁移、定向 unit 55/55、M6.2 数据库 39/39、
M4 15/15、M5.6 13/13、完整 integration 26 个文件/206 项和 39 段迁移演练已通过；`verify`（54 个
文件/381 项单元测试）、21/21 E2E、交付候选 Gitleaks、`git diff --check` 与生产依赖 high 门禁均通过；
审计另有 3 项 React Router moderate 公告并已明确结转。M6.3-A 完成当时 B1-B7 运行时均未开始。
所有商城继续默认 OFF，没有生产政策、返件/换货运单或真实外部调用；详见
`docs/reports/m6.3-a-completion-report.md`。
M6.3-B 的契约/状态机前置差异与修复顺序已另记
`docs/plans/m6.3-b0-decision-plan.md`。用户于 2026-07-28 接受其中推荐默认值并只授权 B0 契约与前向
修复。B0 已完成：domain/contracts 35/35、数据库 44/44、M5.7 9/9、完整 integration 211/211、40 段
迁移演练和 `verify`（54 个文件/388 项单元测试）通过；生产依赖 high 门禁、交付候选 Gitleaks、差异检查
与独立高风险复审通过。B0 无新 UI/运行时，因此 E2E 为 `NOT_APPLICABLE`；B0 完成当时 B1-B7
仍未开始、未授权。详见 `docs/reports/m6.3-b0-completion-report.md`。

M6.3-B1 授权与实现记录（授权 2026-07-28，实施收口 2026-07-29）：用户在了解跨商城泄漏、敏感
字段过度投影、游标精度/轮换和 Redis 失败关闭风险后明确“按照建议执行”，只授权会员/管理员售后
列表与详情四个 GET。现已实现显式 store/owner/RBAC + FORCE RLS、严格 Prisma `select`/响应 allowlist、
`REPEATABLE READ` 两阶段 `limit + 1` 分页、PostgreSQL 六位微秒 `(timestamp,id)` tuple seek、1–3 把
HMAC key ring 游标、商城+主体 60/120 读限流、`Retry-After`、correlation ID 与
`Cache-Control: private, no-store`。管理员无 status 查询新增专用前向索引，Prisma 同步数据库既有
售后退款链接唯一约束以消除 schema drift。B1 没有 UI 或写 handler；B1 收口时 B2-B7、生产政策/启用、供应商调用、部署和发布仍未授权，
该历史边界随后仅由下述 B2a 授权扩展。M6.3、M6、M5 与 P0 均不因 B1 标记完成。

M6.3-B2a 授权与仓库实施完成记录（2026-07-29）：用户再次要求按严谨工作流程继续下一阶段，本轮只实施 B2a 政策控制面。
政策 heads 列表/详情、草稿 `PUT`、versions 列表/详情、publish 和 disable 七个管理员接口已落地，并实现独立 RBAC、近期 MFA、
规范三语 payload/hash、24 小时商城幂等、商城锁/head 行锁、不可变发布/活动投影、enforcement readiness 同事务回滚、微秒签名游标、
严格响应复验和完整审计。B2a 收口还修复既有 settings GET/PUT 的严格输入、成功 correlation/no-store、管理员 READ/WRITE 分级限流与 Redis
`503`。迁移只增加 heads/versions 两个分页索引，没有 RLS 改写，保留 B1 会员对售后已绑定历史政策版本的读取。

仓库只读兼容性预检已在本地测试库通过（`policies=0, versions=0`）。最终 `verify`（60 个文件/427 项单元测试和完整静态/构建/Prisma 门禁）、
完整 integration 29 个文件/234 项、M2→current 42 段迁移演练、生产依赖 high、OpenAPI 结构检查、tracked+13 个 untracked Gitleaks、
`git diff --check` 与独立高风险复审均通过，因此 B2a 仓库实施标记 `COMPLETE`。首次全仓 ESLint 在本机默认约 2 GiB 堆下 OOM，
只以临时 `NODE_OPTIONS=--max-old-space-size=4096` 重跑通过，未更改运行配置；OpenAPI 无专用 3.1 语义 linter 是已知限制。生产依赖 high
命令退出码为 0，但仍保留 3 项 moderate；Gitleaks pathless stdin 仅精确 allowlist 固定非密钥 `M63_IDEMPOTENCY_KEY_SECRET`，未放宽规则。
但每个目标库 rollout 前仍必须逐库执行 preflight 并留证；B2/B2b、B3-B7、M6.3、UI、生产政策与 enforcement、供应商/部署仍未完成或未授权且失败关闭。
M6.3、M6、M5 与 P0 均未因此完成。

M6.3-B2b-D0 授权与仓库实施完成记录（2026-07-29）：用户在 B2a 后再次要求按严谨工作流继续，
本轮只实施售后凭证数据库生命周期与可靠排队底座。新迁移/Prisma 增加 upload/confirm/scan/access/
exhaustion 字段和规范对象 ledger；runtime 增加专用 evidence SYSTEM scope/actor、商城+会员配额锁、
初始化/确认/SYSTEM 重扫/scan 结果/transaction-scoped claim/expire/delete/dead-letter reconciliation 原语，并修复 B1
已 claim READY 的 ordinary access 投影。严格 outbox payload 仅为
`store_id/evidence_id/expected_version`，删除固定第 5 次告警条件、第 8 次耗尽。

D0 owner preflight 的本地四类事实均为 0，runtime RLS 连接以 `42501` 失败关闭；D0 专项、M6.2/B1
回归、完整 integration 和第 43 段 M2→current 迁移演练通过，最终证据见
`docs/reports/m6.3-b2b-d0-completion-report.md`。只有 D0 repository implementation 标记
`COMPLETE`。没有 HTTP、worker、对象存储、真实 scanner、保护 URL、外部告警、生产配置或目标库
rollout；这些外部能力为 `NOT_RUN/BLOCKED`。B2/B2b、B3-B7、M6.3、M6、M5 与 P0 均未完成。

M6.3-B2b-D1 授权与当前收口记录（2026-07-29）：D0 后用户再次要求按严谨工作流继续，本轮只实施
专用 evidence storage adapter、失败关闭配置和 local/test MinIO bucket/IAM/真实 bytes 校验。D1 新增
`AfterSaleEvidenceObjectStorageProvider`，以三组独立身份提供 create-only 上传、HEAD + 有界流式
长度/SHA-256/magic 校验、内部短期 no-store GET 和幂等 provider 删除；不复用 catalog/content。

定向 config/integrations 65/65、真实 MinIO 7/7、完整 integration 31 文件/250 项与 M2→current 43 段
迁移演练通过；MinIO 初始化连续两次成功并要求固定 evidence bucket 版本控制从未启用。生产依赖 high
退出码 0，并保留 3 moderate；OpenAPI 文件 diff=0，引用检查 556/112/0/0，且 runtime status 不变。最终
`verify`（62 个单元文件/482 项）、Gitleaks、`git diff --check` 与独立高风险复审均通过，证据见
`docs/reports/m6.3-b2b-d1-evidence-storage-completion-report.md`。

只有 D1 repository implementation + local/test storage validation 标记 `COMPLETE`。没有 HTTP、worker、
scanner、B3 claim、管理员读取审计或 production KMS/lifecycle/versioning/Object Lock/rollout；版本化
bucket 物理删除和 AWS 最小 read IAM 不存在对象 `403` 仍是生产阻断。B2b/B2、B3-B7、M6.3、M6、M5
与 P0 均未完成。

## 1. 总体范围

本计划覆盖 `REQUIREMENTS.md` 第 22.1 节的 P0 能力及其安全、合规和验收前置条件。P1/P2 只保留架构扩展点，不进入实现范围。所有阶段使用同一套代码，通过商城配置、主题令牌和行业属性模板表达美妆/服装差异。

每个里程碑结束时必须独立完成测试、构建、差异审查和需求验收；上一里程碑未达到完成定义时，
默认不进入下一里程碑。2026-07-27 的 M6 双轨批准是有边界的顺序例外，不改变未完成里程碑及其
外部上线门禁状态。

## 2. 里程碑

### M0：工程基础与本地开发平台

目标：建立可重复、可验证、无业务假实现的单仓库基础。

交付：

- pnpm workspace，`mini-app`、`admin-web`、`api`、`worker` 和共享 packages 骨架。
- Node/包管理器版本锁定，统一 TypeScript strict、格式化、Lint、测试和构建配置。
- PostgreSQL、Redis 和对象存储的本地 Compose 环境及健康检查。
- 环境变量 schema、无密钥 `.env.example`、结构化日志和 correlation ID 基础。
- CI：安装、格式、Lint、类型、单元测试、集成测试、构建和敏感信息扫描。
- 更新 `AGENTS.md` 的真实项目命令；新增贡献与本地启动说明。

测试与验收：

- 全新检出后仅凭文档命令可安装、启动依赖并构建全部应用。
- API/worker 健康检查通过；测试可连接隔离的测试数据库与 Redis。
- 三个应用最小页面可启动，但不得以占位页面宣称业务功能完成。
- CI 与本地同命令；`git diff --check` 和生产构建通过。

回滚：删除新脚手架文件即可回到文档基线；不触碰生产资源。

### M1：商城、身份、RBAC、国际化与审计基础

目标：先建立所有后续模块依赖的安全上下文。

交付：

- 商城、商城配置、语言、主题、管理员、角色、权限、会员身份和授权同意模型。
- `StoreContext`、复合约束、首批 RLS 策略与跨商城专用授权路径。
- Zalo 登录适配器契约和可验证测试环境实现；手机号拒绝授权的手动流程契约。
- 越南语默认、中英回退越南语、VND/日期/手机号/地址格式化。
- 管理操作审计日志与敏感字段脱敏。

测试与验收：

- 单元：权限判定、语言回退、VND、手机号和地址。
- 集成/API：RLS、复合外键、Token/Header、RBAC、跨商城读写与审计。
- UI：三语切换、常见手机尺寸、加载/空/错误状态。
- 明确验证普通管理员不能访问未授权商城，超级管理员跨商城行为可追踪。

迁移/回滚：首批 schema 使用可逆创建迁移；种子仅创建可识别的本地/测试商城配置。

### M2：品牌、类目、商品、SKU、合规与装修

目标：交付双商城可独立运营的商品内容基础和真实买家浏览链路。

交付：

- 品牌、类目树、行业属性模板、SPU、SKU、媒体、翻译、合规资料和版本记录。
- 美妆/美瞳/服装属性模板；合规或越南语缺失时禁止上架。
- Logo、图标、主题、Banner、首页模块的后台配置、排序、定时和多语言内容。
- 管理端 CRUD/审核/停用；买家端首页、分类、品牌馆、列表和商品详情。
- 历史引用实体只能停用/软删除，业务编码在商城内唯一。

测试与验收：

- 集成：跨商城关联失败、上架门禁、复合唯一、软删除与版本记录。
- API：输入、权限、媒体归属、批量操作和错误响应。
- UI/E2E：两套主题、三语、品牌/类目/商品浏览、SKU 选择及响应式布局。
- 快照准备：后续订单引用的商品字段具备稳定版本来源。

迁移/回滚：新增表和索引；批量导入留到字段字典和校验规则稳定后在本里程碑末实现。

### M3：库存、搜索、购物车、促销与价格计算

目标：建立下单前的可信商品可售性和服务端计价能力。

交付：

- 仓库、库存余额、锁定、可售量、流水、预警和调整审计。
- 三语搜索、越南语规范化、联想、筛选、排序、历史和热门词。
- 购物车失效/下架/价格变化提示。
- 商品折扣、限时促销、优惠券、新客券、满减和满额包邮规则。
- 服务端价格引擎返回逐项可解释分解，前端只展示服务端结果。
- M3.5 设计澄清按 `REQUIREMENTS.md:300` 的总需求公式固定 `ITEM -> COUPON -> ORDER`，整单折扣按当前行应付比例 floor 后以最大余数、SKU ID 稳定分摊；新客券使用 `new_customer_only` 和 M3 零订单基线。
- 促销高风险命令使用商城范围追加写幂等记录；`CATEGORY` 仅精确匹配主/辅助类目，管理员只读预览无副作用且券资格为假设值，M4 必须重算。
- M3.7 收口增加领取计数/事实与库存预留事实保护、并发/RBAC/敏感日志回归及三端 Playwright 矩阵；localhost Zalo 测试桥不属于生产身份能力。

测试与验收：

- 单元：促销叠加/互斥、`ITEM -> COUPON -> ORDER`、整数 VND、比例分摊、金额/数量门槛、边界和无效券。
- 并发集成：锁定、释放、重复请求、超卖防护和跨商城库存隔离。
- 搜索：三语、越南语变音符号、有/无变音符号策略和无结果推荐。
- E2E：列表筛选、加入购物车、数量变化、失效与价格重算。

迁移/回滚：库存初始余额和流水在同一受审迁移/导入事务中建立；不可直接回滚已发生的库存流水，使用反向调整。M3.5 新增的 `promotion_operations` 强制 RLS 且只追加，产生命令记录后只允许向前修复。M3.7 的会员券和库存预留完整性迁移在任一 M3 核心事实存在时都以 `55000` 拒绝 down；M2-only 自动升级 fixture 仍需补入可重复迁移门禁。

### M4：地址、结算、订单与 COD

目标：先用 COD 打通完整且真实的下单和履约前状态机。

交付：

- 越南三级地址、配送地址和隐私脱敏。
- 结算重算、运费/偏远附加费契约、订单号、订单与政策快照。
- 在线支付与 COD 分支的订单状态机；本阶段实际启用 COD。
- 下单幂等、库存锁、超时释放、取消/关闭和 COD 确认。
- 买家端确认订单、结果、订单列表/详情；后台订单查询、备注、标签和 COD 确认。

测试与验收：

- 状态机单元测试覆盖合法/非法转换。
- API 安全测试覆盖金额篡改、重复下单、跨商城订单号、地址越权。
- 集成测试覆盖锁库存、超时释放、COD 确认扣减和取消恢复。
- E2E 从首页到 COD 下单、确认、取消；重复点击不生成重复订单。

迁移/回滚：订单与快照为不可随意回滚的业务记录；错误迁移采用向前修复，状态修复需审计命令。

### M5：Zalo Checkout、线上支付与首家物流

目标：接入至少一种真实线上支付测试流程和一家真实物流测试环境。

前置：Zalo Mini App 测试应用、Checkout SDK 条件、支付商户沙箱、物流测试账户和回调域名已提供。

交付：

- Checkout SDK 买家端流程与服务端支付单、回调、主动查单、退款和对账基础。
- 签名、时间戳、重放、金额、币种、商城和状态校验；原始流水脱敏保存。
- 首家物流报价、创建/取消、面单、轨迹、签收/拒收/退回和人工补偿。
- transactional outbox、回调/任务 inbox 去重、失败重试与告警。
- 支付、物流与订单内部状态映射，不暴露供应商状态为领域状态。

测试与验收：

- 契约测试：供应商成功、失败、超时、乱序、重复和未知状态。
- 安全测试：伪签名、过期时间戳、重放、金额/商城篡改。
- 集成：支付重复回调只确认和扣减一次；查单补偿可恢复丢失回调。
- E2E：Zalo 测试版本线上支付、退款、物流建单、轨迹和异常人工处理。
- 没有真实沙箱证据时，本里程碑只能标为“适配器完成，集成未验收”。

回滚：渠道按商城配置关闭；新版本应用回滚，已创建支付/物流单继续由兼容 worker 处理至终态。

### M6：售后、会员、内容、分享与基础营销完善

目标：补齐 P0 交易后流程和 Zalo 主动分享体验。

当前局部状态：M6.3-B1 交付商城/主体隔离的售后列表与详情读取；B2a 政策列表/详情、草稿、版本列表/
详情、发布和停用七接口已完成仓库实施；B2b-D0 只交付凭证 schema/RLS/ledger/数据库生命周期与可靠
排队原语，B2b-D1 只交付独立 storage adapter/config 与 local/test MinIO IAM/真实 bytes 校验。B2a 不
改写政策 RLS，保留会员历史政策读取；D0/D1 合计仍没有凭证 HTTP/worker/scanner，也不
交付下列完整 M6 产品范围。只读摘要、政策控制面或数据库原语存在，不能据此解释为凭证上传/读取、
售后申请、审核、返件、退款、结算或 UI 可用。完整 B2b/B3-B7/生产政策与 enforcement/部署仍未授权
并失败关闭。

交付：

- 仅退款、退货退款、换货、商家退款状态机和凭证。
- 美妆卫生限制、服装尺码换货、期限与运费承担配置。
- 会员中心、收藏、浏览历史、优惠券和隐私请求入口。
- 商城/品牌/类目/商品/活动/优惠券 Deep Link、三语分享卡与兜底页。
- 用户主动调用官方分享界面，不强制、不自动、不奖励诱导。

测试与验收：

- 单元/集成：售后状态、退款幂等、库存恢复条件和政策版本。
- 安全：凭证文件授权、会员数据隔离、隐私请求审计。
- E2E：退款、退货、换货、收藏、优惠券和分享目标解析。
- 真机验证分享链接打开正确商城、语言和对象。

### M7：报表、合规、可观测性与发布验收

目标：完成 P0 运营闭环和上线前技术验收。

交付：

- 销售、品牌、类目、商品、支付、COD、物流和转化基础报表及 Excel/CSV 导出。
- 经营主体、隐私、购买条款、退换货、投诉和合规资料页面。
- 监控、告警、备份、恢复演练、部署、回滚和运行手册。
- 性能、容量、安全、隐私、依赖和敏感信息审查。
- Zalo 审核材料、真机测试清单和供应商联调证据索引。

测试与验收：

- 报表与业务流水对账，跨商城导出越权测试。
- 常见 Android/iPhone 三语 UI 回归和无障碍基础检查。
- 越南正常 4G 环境首屏目标不超过 3 秒，记录测试设备、网络和数据量。
- 备份恢复、应用回滚、队列积压与第三方故障演练。
- 对 `REQUIREMENTS.md` 第 23 节逐项提供通过、失败或受外部条件阻塞的证据。

上线门禁：越南本地法律、税务和行业合规复核未完成时，不标记生产上线完成。

## 3. 预计数据模型与 API 演进

| 里程碑 | 主要数据模型变化                                                                                                                                                                    | 主要接口面                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| M0     | 仅迁移框架和连接健康检查，不创建业务表                                                                                                                                              | `/health/live`、`/health/ready`，其余不开放                                                  |
| M1     | stores、store_configs、members、admin_users、roles、permissions、consents、audit_logs                                                                                               | `/v1/auth`、`/v1/stores`、`/v1/admin/rbac`、`/v1/admin/audit-logs`                           |
| M2     | brands、categories、attribute_templates、products、skus、translations、compliance_records、page_modules、media                                                                      | `/v1/catalog`、`/v1/admin/catalog`、`/v1/admin/content`                                      |
| M3     | warehouses、inventory_balances、inventory_reservations、inventory_movements、carts、promotions、coupons                                                                             | `/v1/search`、`/v1/cart`、`/v1/pricing/quote`、`/v1/admin/inventory`、`/v1/admin/promotions` |
| M4     | addresses、orders、order_items、order_snapshots、order_transitions、idempotency_records                                                                                             | `/v1/checkout`、`/v1/orders`、`/v1/admin/orders`                                             |
| M5     | payment_attempts、provider_callbacks、refunds、shipments、tracking_events、outbox、inbox                                                                                            | `/v1/payments`、`/v1/webhooks/{provider}`、`/v1/shipments`、后台补偿接口                     |
| M6     | after_sale_policies/versions、after_sales、after_sale_items/inspections/evidence/evidence_objects/settlements、member_favorites/member_product_views、privacy_requests、share_links | `/v1/after-sales`、`/v1/admin/after-sale-policies`、`/v1/members/me`、`/v1/shares`           |
| M7     | report_exports、privacy_request_fulfillment、operational_alerts、合规发布记录                                                                                                       | `/v1/admin/reports`、`/v1/admin/privacy-requests`、内部运维接口                              |

具体表、字段、索引、RLS 策略、状态转换和 OpenAPI 契约必须在对应里程碑编码前形成专项设计并通过审查。公开接口从 `/v1` 起步；兼容期内只做向后兼容新增，破坏性变化使用新版本或明确弃用窗口。

## 4. 跨阶段工程规则

- 缺陷优先先写回归测试，再做最小安全修复。
- 数据库、API、事件、环境变量变化必须同步更新文档和调用方。
- 每个 PR/阶段只包含当前范围；不自动实现下一里程碑。
- 任何商城业务查询都必须证明 `store_id` 来源可信并在服务端校验。
- 金额、库存、状态机、权限和回调变更需要至少一名审查者按高风险清单复核。
- 真实凭据只进入批准的密钥管理渠道；示例、日志、测试和 Git 中禁止出现。

## 5. 阶段完成报告模板

每个里程碑报告必须包含：

1. 已完成范围与涉及文件。
2. 数据库、API、配置和兼容性变化。
3. 实际运行的命令及结果。
4. 多商城、RBAC、金额、库存、状态机、三语和移动端中受影响项的验证证据。
5. `git diff --stat`、关键差异审查结论和敏感信息检查。
6. 未通过/未运行项、原因、影响和人工验证方式。
7. 已知限制、外部依赖、回滚方法和下一阶段前置条件。

## 6. 当前批准请求

批准本计划即表示同意先实施 M0，仅建立工程基础和本地开发平台。批准不代表授权：

- 自动推进 M1-M7；
- 使用生产凭据或连接生产系统；
- 购买云资源、开通商户/物流服务；
- 推送、发布 Zalo Mini App 或部署生产；
- 静默更改 `REQUIREMENTS.md` 的商业规则。
