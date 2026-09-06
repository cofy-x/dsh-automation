# dsh-automation 运维指南

应当把一个 `dsh-automation start` 进程独立于 DSH Console 长期运行。操作系统负责进程生命周期，SQLite 负责 Run 与 Attempt 状态，canonical DSH Session 始终是执行事实源。

## 安装服务前

1. 执行 `dsh-automation init`，幂等创建或修复专用的 `automation` profile。
2. 以将要运行服务的同一系统用户执行 `dsh-automation doctor`。
3. 执行 `dsh-automation worker --once --json`；空队列应返回 `{"recovered":0}` 并以 0 退出。
4. 执行 `dsh-automation service install`；CLI 会生成绝对可执行路径，并保持管理命令与服务使用同一个 `DSH_HOME`。

`examples/` 中的文件仅供使用其他配置管理系统的高级用户参考；普通安装不需要手工替换模板。

## 进程和退出契约

| 调用 | 成功 | 失败 | 含义 |
|:---|:---|:---|:---|
| `worker` | 持续驻留；SIGTERM 以 0 退出；SIGINT 以 130 退出 | profile 启动错误以非零退出 | 长期队列消费者。单次循环的瞬时错误会记录日志，并在后续轮询重试。 |
| `worker --once` | 完成恢复并最多领取一个新 Run 后以 0 退出 | 运维错误以 1 退出 | 有界 smoke test 或调度器入口；只有此模式允许 `--json`。 |
| `status` | 以 0 退出 | 存储无法打开或 schema 不兼容时以 1 退出 | 有界数据面检查；不证明 Worker 进程存活。 |

`status --json` 返回各状态计数、队列年龄、活跃 Worker 身份、event retention/consumer watermark，以及过期的未 dispatch/已 dispatch 租约数。任一过期租约会让数据面状态变为 `degraded`；进程存活仍应由 `launchctl print` 或 `systemctl --user is-active` 判断。

使用 `--slots N` 提供进程内并行；每个 slot 都有独立 Worker 身份和 fencing lease，SQLite 在所有 slot/进程之间执行全局 claim 和 concurrency-key 限制。评估 provider quota、工作区隔离和工具副作用后再从 1 开始增加。

收到 SIGTERM 后，Worker 先停止新 claim，等待 `--shutdown-grace-ms` 内的活跃 turn 自然结束；只有超过 grace 才取消剩余 turn。第二次信号或 supervisor 超时可能强制终止；下一 Worker 按意外崩溃规则恢复。

计划升级时先执行 `dsh-automation drain --reason upgrade --json`，等活跃数归零后停止 supervisor、升级并启动，最后显式执行 `dsh-automation resume`。drain 状态持久化，等待超时不会暗中恢复准入。

## 统一的 user service 命令面

```sh
dsh-automation service install
dsh-automation service status
dsh-automation service logs
dsh-automation service restart
dsh-automation service stop
dsh-automation service uninstall
```

`install` 默认立即启动；使用 `--no-start` 只写入并验证定义。可通过 `--dsh-home`、`--profile`、`--slots` 和 `--shutdown-grace-ms` 固化服务参数。定义属于当前用户，不需要 root。

## macOS launchd

CLI 将定义写入 `~/Library/LaunchAgents/com.cofy-x.dsh-automation.plist`，日志写入 `~/.dsh/automation/logs/`。等价的底层检查命令是：

```sh
plutil -lint ~/Library/LaunchAgents/com.cofy-x.dsh-automation.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.cofy-x.dsh-automation.plist
launchctl kickstart -k "gui/$(id -u)/com.cofy-x.dsh-automation"
launchctl print "gui/$(id -u)/com.cofy-x.dsh-automation"
```

修改定义前先停止并卸载：

```sh
launchctl bootout "gui/$(id -u)/com.cofy-x.dsh-automation"
```

`KeepAlive` 会在异常退出后按 launchd 节流规则重启；`bootout` 是有意停止服务的方式。

## Linux systemd 用户服务

CLI 将定义写入 `~/.config/systemd/user/dsh-automation.service`，加载并启用。等价的底层检查命令是：

```sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-automation.service
systemctl --user status dsh-automation.service
journalctl --user -u dsh-automation.service -f
```

如需在退出登录后继续运行，管理员可执行 `loginctl enable-linger <user>`。如果 `DSH_HOME` 不是 `%h/.dsh`，请用 systemd drop-in 覆盖它。

## 升级与故障检查

先优雅停止服务，升级 profile，依次运行 `status` 和 `worker --once`，最后重新启动长期 Worker。不要把 `worker --once` 与长期 Worker 并发运行来充当存活探针：它是真实消费者，可能领取 Run。

发生故障时，应先保存以下证据，再考虑数据库操作：

```sh
dsh-automation status --json
dsh-automation list --json
dsh-automation show <run-id> --json
```

不得通过删除或编辑 SQLite 数据库来重试 `indeterminate` Run。审查可能的外部副作用后，只能使用 `retry --confirm-indeterminate`。启用 retention 前应先注册 adapter consumer；`purge` 要求 `--confirm`，只删除终态 Automation bookkeeping，绝不删除 canonical Session。
