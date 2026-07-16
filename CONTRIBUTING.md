# 开发与审查约定

1. 开始任务前阅读 `REQUIREMENTS.md`、`AGENTS.md` 和当前里程碑计划。
2. 保留用户已有修改，阶段改动不得混入无关文件。
3. 所有商城业务入口都必须从可信服务端上下文取得 `store_id`；禁止仅依赖前端过滤。
4. 金额使用整数 VND；库存、订单、支付、退款与物流采用显式状态机和幂等处理。
5. 新增依赖前确认必要性、许可证、维护状态和 Node.js/Zalo 运行兼容性。
6. 提交前运行 `corepack pnpm verify`；涉及基础设施时再运行 `corepack pnpm test:integration`。
7. 使用 `git diff --check`、`git diff --stat` 和逐文件差异审查，确认无密钥、调试代码或跨商城风险。
8. 不能运行的检查必须在阶段报告中记录原因和影响。

提交信息建议使用 `type(scope): intent`，例如 `feat(tenancy): enforce store-scoped access`。
