# dsh-automation

DeepSeek Harness 的持久化后台自动化核心。

`dsh-automation` 接受来自本地命令、cron、webhook 或其他 DSH 插件的持久化 Run，并通过 canonical DSH Agent 与 Session 执行。它不同于 core `@deepseek-ai/dsh-jobs`：后者跟踪的是已在线 Agent 所拥有的进程内后台工具工作。

当前 alpha 命令面如下：

```sh
dsh --profile automation worker
dsh --profile automation worker --slots 4 --shutdown-grace-ms 60000
dsh --profile automation worker --once --json
dsh --profile automation submit "检查当前项目的测试失败"
dsh --profile automation status
dsh --profile automation list
dsh --profile automation show <run-id>
dsh --profile automation cancel <run-id>
dsh --profile automation retry <run-id>
dsh --profile automation events --after-seq 0 --json
dsh --profile automation pause --reason maintenance
dsh --profile automation drain --reason upgrade
dsh --profile automation resume
dsh --profile automation consumers --json
dsh --profile automation purge --before 2026-08-01T00:00:00Z --confirm
```

持久化层使用 SQLite WAL、Trigger 范围幂等键、带租约的 Attempt、fencing token、确定性 Session ID；当崩溃的 Agent turn 可能已经产生外部副作用时，恢复会明确进入 `indeterminate`，不会盲目重试。

仅有 inbox 的恢复完全使用已发布的 Agent 契约：插件自有的 steering item 唤醒恢复后的 loop，Agent 作用域内的 `agent/pre-step` 监听器会在提交 request material 前移除该控制项。原始的带标识任务消息仍是 canonical 消息且只投递一次；`turn/start` 之后发生的崩溃绝不会自动重放。

把 service 与专用 application bundle 一起安装到 automation profile，再交给操作系统长期托管 Worker：

```sh
dsh plugin --profile automation add /path/to/dsh-automation /path/to/dsh-automation/packages/app-bundle
dsh --profile automation worker
```

`dsh-automation` 是可组合的 service bundle；`dsh-automation-app` 只负责 automation profile 的命令解析与进程应用。Web、cron、webhook 和其他 host profile 只安装 `dsh-automation`，因此不会意外获得第二个命令行应用。第一阶段建议用 launchd、systemd 或其他 supervisor 运行一个 Worker slot；评估工作区隔离、工具副作用与 provider 配额后再增加 slots。管理命令是访问 `$DSH_HOME/automation/automation.db` 的短进程；Console 退出不会影响自动化。Cron 与 webhook 保持为独立 Trigger 插件：先持久化来源事实，通过 `ctx.automation` 幂等提交 fresh-Session Run，再从全局持久化事件流对账结果。

稳定退出契约、健康语义、升级步骤以及 launchd/systemd 模板见[运维指南](docs/operations.zh.md)。[架构指南](docs/architecture.zh.md)定义了模块边界与安全不变量，使持久化编排和 canonical DSH 执行保持分离。`status` 检查持久化存储和队列；Worker 进程是否存活仍以 supervisor 为准。

## 开发

需要 Node.js 24 或更新版本和 pnpm 11。

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --dry-run
```

MIT 许可证。
