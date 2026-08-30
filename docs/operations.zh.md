# dsh-automation 运维指南

应当把一个 `dsh --profile automation worker` 进程独立于 DSH Console 长期运行。操作系统负责进程生命周期，SQLite 负责 Run 与 Attempt 状态，canonical DSH Session 始终是执行事实源。

## 安装服务前

1. 把 `dsh-automation` 安装到专用的 `automation` profile。
2. 以将要运行服务的同一系统用户执行 `dsh --profile automation status`。
3. 执行 `dsh --profile automation worker --once --json`；空队列应返回 `{"recovered":0}` 并以 0 退出。
4. 用 `command -v dsh` 找到真实可执行文件。supervisor 配置必须使用绝对路径，并与管理命令使用同一个 `DSH_HOME`。

`examples/` 中的文件是模板；安装前必须替换所有 `__...__` 标记。

## 进程和退出契约

| 调用 | 成功 | 失败 | 含义 |
|:---|:---|:---|:---|
| `worker` | 持续驻留；SIGTERM 以 0 退出；SIGINT 以 130 退出 | profile 启动错误以非零退出 | 长期队列消费者。单次循环的瞬时错误会记录日志，并在后续轮询重试。 |
| `worker --once` | 完成恢复并最多领取一个新 Run 后以 0 退出 | 运维错误以 1 退出 | 有界 smoke test 或调度器入口；只有此模式允许 `--json`。 |
| `status` | 以 0 退出 | 存储无法打开或 schema 不兼容时以 1 退出 | 有界数据面检查；不证明 Worker 进程存活。 |

`status --json` 返回各状态计数、队列时间信息，以及过期的未 dispatch/已 dispatch 租约数。过期计数表示存在恢复工作，本身不令健康检查失败。Worker 存活应使用 `launchctl print` 或 `systemctl --user is-active` 判断。

收到 SIGTERM 后，DSH launcher 会 dispose Worker：停止轮询、取消活跃 Agent、等待当前 pump，再退出。停止超时必须为持久化 flush 留出空间。第二次信号或 supervisor 超时可能强制终止；下一个 Worker 会按意外崩溃的相同规则恢复。

## macOS launchd

复制 `examples/launchd/com.cofy-x.dsh-automation.plist`，替换可执行文件、home 和日志目录标记，并先创建日志目录。然后以登录用户安装：

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

把 `examples/systemd/dsh-automation.service` 复制到 `~/.config/systemd/user/`，替换可执行文件标记，然后加载并启用：

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
dsh --profile automation status --json
dsh --profile automation list --json
dsh --profile automation show <run-id> --json
```

不得通过删除或编辑 SQLite 数据库来重试 `indeterminate` Run。该状态表示 canonical turn 可能已经产生外部副作用，必须由操作员审查。
