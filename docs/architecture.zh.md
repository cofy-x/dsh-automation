# dsh-automation 架构

`dsh-automation` 是持久化编排插件，不是 Agent 实现。DSH 负责 canonical Session、Agent 执行、模型、工具、权限与凭据；本包只负责 Run 调度状态、带租约的 Attempt、恢复分类和运维命令面。

## 模块边界

| 模块 | 职责 | 允许依赖 |
|:---|:---|:---|
| `domain.ts` | 品牌化标识、请求、Run 状态与校验 | 不依赖持久化或运行时模块 |
| `store/database.ts` / `store/schema.ts` | 私有 SQLite 生命周期、顺序 schema migration、行解码和事务原语 | Domain 与 store 类型 |
| `store/runs.ts` / `store/attempts.ts` | Run 提交、Attempt fencing、claim、heartbeat、结算与取消 | Store database |
| `store/query.ts` / `store/retention.ts` | cursor 分页、持久化 consumer、prune watermark 与终态 purge | Store database |
| `store/control.ts` | 持久化 running、paused 与 draining 准入模式 | Store database |
| `store/recovery.ts` | 过期租约分类、接管 fencing 与恢复结算 | Store database |
| `store.ts` | 稳定的公开持久化 facade 与在线 Attempt 转换 | 内部 store 模块 |
| `worker/recovery.ts` | canonical Session 证据与仅 inbox 恢复唤醒过滤 | 已发布的 DSH 事件契约 |
| `worker/agent-runtime.ts` | 仅通过公开 DSH 服务组装新建/恢复 Agent | 已发布的 DSH Agent 服务 |
| `worker.ts` / `worker/pool.ts` | 单 slot 执行顺序、多 slot 独立身份、优雅停机与 supervisor 生命周期 | Automation service 与 worker 模块 |
| `startup.ts` / `startup/management.ts` / `app.ts` | 管理命令、确认门和有界进程退出契约 | 公开 Automation service |
| `packages/cli` | 用户安装、诊断、命令转发与操作系统 user service 生命周期 | 已发布 DSH CLI 与两个 automation bundle |

依赖方向向内指向 domain 契约和小型持久化/运行时接缝。内部模块不得导入 `app.ts`，Trigger adapter 只依赖公开 `AutomationService` 的提交面。

源码规模检查把 core 与 CLI 的每个 `src/**/*.ts` 模块限制在 300 个物理行以内。它只是回归信号，不是架构规则本身；只要一个文件开始拥有多个生命周期或状态机职责，就应当更早拆分。

## 安全不变量

- Automation 数据库只保存 Session ID 和有界结果摘要，不复制 Session 历史。
- 每个租约所有权转换都由 Run、Attempt 和 lease token 共同 fencing。
- 只有持久化证据证明尚未 dispatch 的过期 Attempt 才允许重新排队。
- 仅 inbox 恢复必须继续同一个 canonical Session，并在提交 request material 前只删除插件自有的唤醒控制项。
- `turn/start` 之后的崩溃，或任何无法确定的模型/工具副作用，必须结算为 `indeterminate`，绝不自动重试。
- 公开导入路径保持为 `dsh-automation`、`dsh-automation/store`、`dsh-automation/startup` 和 `dsh-automation/app`；内部模块布局不属于兼容性表面。
- 全局事件 cursor 只能前进；purge 不得越过已注册 consumer checkpoint，低于 prune watermark 的读取必须返回 `EVENT_CURSOR_EXPIRED`。

## 变更纪律

Schema 变更只进入 `store/database.ts`，且必须明确迁移与版本策略。Run 或 Attempt 状态机变更进入对应 store 模块，并增加转换测试。Agent 恢复变更必须为受影响的持久化边界增加进程级 SIGKILL 覆盖。Supervisor 或 CLI 变更必须增加退出契约测试并同步运维文档。
