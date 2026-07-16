# M1 权限矩阵

状态：已实施（2026-07-17）

M1 默认拒绝访问。商城权限只能绑定商城角色；平台权限只能绑定平台角色。普通管理员的每个请求都在目标 `store_id` 的数据库事务和 RLS 上下文中执行。

| 权限                           | 范围 | M1 用途                                          |
| ------------------------------ | ---- | ------------------------------------------------ |
| `platform.stores.read`         | 平台 | 读取启用商城注册表                               |
| `platform.stores.manage`       | 平台 | 预留商城注册表管理；M1 无写接口                  |
| `platform.stores.cross_access` | 平台 | 携带至少 10 字符的访问原因逐店访问，并写审计     |
| `platform.rbac.manage`         | 平台 | 预留平台角色管理；M1 无写接口                    |
| `platform.audit.read`          | 平台 | 预留平台审计服务；不得绕过商城 RLS               |
| `store.config.read`            | 商城 | 读取当前商城配置和主题                           |
| `store.config.manage`          | 商城 | 使用乐观版本更新当前商城配置并审计               |
| `store.members.read`           | 商城 | 预留当前商城会员读取能力                         |
| `store.rbac.read`              | 商城 | 读取当前商城角色和权限                           |
| `store.rbac.manage`            | 商城 | 创建角色、授予/撤销商城权限、授予/撤销管理员角色 |
| `store.audit.read`             | 商城 | 读取当前商城审计事件                             |

平台跨店访问不继承目标商城角色，但必须同时满足 `platform.stores.cross_access` 和 `X-Access-Reason`；每次目标商城访问写入 `platform.cross_store.accessed`。平台权限不能绑定商城角色，该边界由领域校验和数据库外键共同保护。
