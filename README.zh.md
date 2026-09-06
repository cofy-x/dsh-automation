# dsh-automation

DeepSeek Harness 的持久化后台自动化核心。

`dsh-automation` 接受来自本地命令、cron、webhook 或其他 DSH 插件的持久化 Run，并通过 canonical DSH Agent 与 Session 执行。它不同于 core `@deepseek-ai/dsh-jobs`：后者跟踪的是已在线 Agent 所拥有的进程内后台工具工作。

## 快速开始

从源码 checkout 直接运行：

```sh
pnpm install
pnpm automation init
pnpm automation doctor
pnpm automation start
```

未来发布到 npm 后，用户入口保持相同：

```sh
npm install --global dsh-automation-cli
dsh-automation init
dsh-automation doctor
dsh-automation service install
dsh-automation submit "检查当前项目的测试失败"
dsh-automation status
```

`init` 会幂等创建专用 DSH profile，并安装匹配版本的 service 与 application bundle。在源码 checkout 中它自动使用当前源码；发行包使用严格匹配的 registry 版本。`doctor` 同时检查 Node、pnpm、内置 DSH 启动器、profile 与持久化存储。`service install` 在 macOS 安装 launchd user agent，在 Linux 安装 systemd user unit；`service status|logs|restart|stop|uninstall` 提供一致的生命周期命令。

`start` 在前台长期运行 Worker，适合容器或已有 supervisor；`submit`、`status`、`list`、`show`、`cancel`、`retry`、`events`、`pause`、`drain`、`resume`、`consumers` 和 `purge` 会透传给专用 automation application。高级用户仍可直接使用 `dsh --profile automation ...`，但它不再是主要用户界面。

持久化层使用 SQLite WAL、Trigger 范围幂等键、带租约的 Attempt、fencing token、确定性 Session ID；当崩溃的 Agent turn 可能已经产生外部副作用时，恢复会明确进入 `indeterminate`，不会盲目重试。

仅有 inbox 的恢复完全使用已发布的 Agent 契约：插件自有的 steering item 唤醒恢复后的 loop，Agent 作用域内的 `agent/pre-step` 监听器会在提交 request material 前移除该控制项。原始的带标识任务消息仍是 canonical 消息且只投递一次；`turn/start` 之后发生的崩溃绝不会自动重放。

`dsh-automation` 是可组合的 service bundle；`dsh-automation-app` 只负责 automation profile 的命令解析与进程应用。Web、cron、webhook 和其他 host profile 只安装 `dsh-automation`，因此不会意外获得第二个命令行应用。第一阶段建议用 launchd、systemd 或其他 supervisor 运行一个 Worker slot；评估工作区隔离、工具副作用与 provider 配额后再增加 slots。管理命令是访问 `$DSH_HOME/automation/automation.db` 的短进程；Console 退出不会影响自动化。Cron 与 webhook 保持为独立 Trigger 插件：先持久化来源事实，通过 `ctx.automation` 幂等提交 fresh-Session Run，再从全局持久化事件流对账结果。

稳定退出契约、健康语义、升级步骤以及 launchd/systemd 模板见[运维指南](docs/operations.zh.md)。[架构指南](docs/architecture.zh.md)定义了模块边界与安全不变量，使持久化编排和 canonical DSH 执行保持分离。`status` 检查持久化存储和队列；Worker 进程是否存活仍以 supervisor 为准。

维护者应使用仓库自带的[联合发布流程](docs/releasing.zh.md)；三个 package 作为一个 release unit 统一版本、打包、发布并执行 registry 安装验收。

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
