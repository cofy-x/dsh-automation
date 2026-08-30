# dsh-automation

DeepSeek Harness 的持久化后台自动化核心。

`dsh-automation` 接受来自本地命令、cron、webhook 或其他 DSH 插件的持久化 Run，并通过 canonical DSH Agent 与 Session 执行。它不同于 core `@deepseek-ai/dsh-jobs`：后者跟踪的是已在线 Agent 所拥有的进程内后台工具工作。

当前 alpha 命令面如下：

```sh
dsh --profile automation worker
dsh --profile automation submit "检查当前项目的测试失败"
dsh --profile automation list
dsh --profile automation show <run-id>
dsh --profile automation cancel <run-id>
```

持久化层使用 SQLite WAL、Trigger 范围幂等键、带租约的 Attempt、fencing token、确定性 Session ID；当崩溃的 Agent turn 可能已经产生外部副作用时，恢复会明确进入 `indeterminate`，不会盲目重试。

把 checkout 安装到专用 profile，再交给操作系统长期托管 Worker：

```sh
dsh plugin --profile automation add /path/to/dsh-automation
dsh --profile automation worker
```

第一阶段建议用 launchd、systemd 或其他 supervisor 运行单个 Worker。管理命令是访问 `$DSH_HOME/automation/automation.db` 的短进程；Console 退出不会影响自动化。Cron 与 webhook 应保持为独立 Trigger 插件，通过 `ctx.automation` 提交 Run。

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
