# Automation Control Plane v0.2

本文冻结 v0.2 的跨插件契约。`dsh-automation` 是持久化执行的唯一所有者，cron 与 webhook 保持为独立、可验证 occurrence 的生产者。

## 投递契约

Trigger adapter 先持久化自身的来源事实，再提交一个不可变 Automation Run。提交身份为 `(trigger.kind, trigger.sourceId, trigger.idempotencyKey)`；重复提交同一身份必须返回已有 Run。`occurrenceId` 是 adapter 的人类可读/审计标识，不能替代幂等键。

| 生产者 | `kind` | `sourceId` | `occurrenceId` | `idempotencyKey` |
|:---|:---|:---|:---|:---|
| CLI | `manual` | `cli` | 命令生成的 occurrence | 可选调用方键 |
| dsh-cron | `cron` | 稳定 job ID | 计划触发的 RFC 3339 时刻 | 带版本的 job ID 与计划时刻 |
| dsh-webhook | `webhook` | 稳定 hook ID | 已验证的外部 delivery ID | hook ID 与已验证 delivery ID |

Adapter 绝不调用 `Agent.followup()`、`steer()` 或 `inject()`。Run 只面向 fresh canonical Session。会话内提醒继续由 DSH 自带的 schedule 能力负责；系统级自动化不得并发修改交互式 Session。

## 执行与恢复

每次 claim 创建一个带 fencing 的 Attempt 和确定性的 fresh Session ID。只有在 durable dispatch 前丢失的 claim 才能自动重试。canonical 证据一旦含有 `turn/start`，中断或无法判定的结果必须终结为 `indeterminate`；只有操作员显式 retry 才能创建通过 `retryOf` 关联的新 Run。重试 `indeterminate` 必须显式确认，因为外部副作用可能已经发生。

并发属于准入控制，不是执行捷径。Run 可以携带有界的 `concurrencyKey` 与正整数 `concurrencyLimit`；数据库 claim 事务在准入前统计同 key 的活跃 Run。Worker slots 提供进程内并行，跨进程权威仍在数据库。

## 持久化事件流

`run_events.seq` 是全局单调递增游标。消费者按 cursor 读取有界页面，并只在应用页面后保存返回游标。重复读取页面是安全的：adapter 以 Run ID 与事件序号对账。进程内通知只能降低延迟，绝不能成为唯一结算路径。

Cron 保存计划定义和 occurrence 到 Run 的关联；Webhook 保存验证收据、有界 replay 数据、callback 规则和 delivery 到 Run 的关联。两者在重启后都从持久化事件流恢复 Run 结算对账；都不得复制 Session 历史或实现 Agent outcome tracking。

## 控制与保留

持久化 `pause` 和 `drain` 都会让所有进程停止新 claim，但不中断活跃 Attempt。`drain` 命令进入 draining 模式并等待活跃数归零；之后必须显式 `resume`。Worker 进程退出时独立停止各 slot，先等待配置的 grace，超时后才取消仍活跃的 turn。Purge 必须确认、有界、只处理终态，且不得超过最慢 consumer checkpoint；它只删除 Automation bookkeeping，不删除 canonical Session。持久化 prune watermark 使过期 cursor 即使在历史事件全部删除后仍会显式失败。

## Schema 演进

Schema v2 从 v1 原地事务迁移，增加 trigger occurrence、concurrency 字段、配套索引、queue control、持久化 event consumer 与 retention watermark。测试会结构性比较迁移后 v2 与全新 v2 数据库。后续每个版本必须提供逐版本 migration、紧邻旧版本升级测试和 fresh schema 等价测试；未知未来版本 fail closed。
