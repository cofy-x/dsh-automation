# Operating dsh-automation

Run one `dsh --profile automation worker` process independently of DSH Console. The operating system owns process lifetime; SQLite owns Run and Attempt state; canonical DSH Sessions remain the execution fact source.

## Before installing a service

1. Install `dsh-automation` into the dedicated `automation` profile.
2. Run `dsh --profile automation status` as the same operating-system user that will run the service.
3. Run `dsh --profile automation worker --once --json`. An empty queue returns a result with `recovered: 0` and an empty `claimedRunIds` array, with exit code 0.
4. Resolve the real `dsh` executable with `command -v dsh`. Supervisor definitions must use its absolute path and the same `DSH_HOME` as management commands.

The examples under `examples/` are templates. Replace every `__...__` token before installing them.

## Process and exit contract

| Invocation | Success | Failure | Meaning |
|:---|:---|:---|:---|
| `worker` | stays resident; SIGTERM exits 0; SIGINT exits 130 | profile boot failures exit nonzero | Long-lived queue consumer. A transient cycle error is logged and retried on a later poll. |
| `worker --once` | exits 0 after recovery plus at most one new claim per slot | exits 1 on an operational error | Bounded smoke test or scheduler integration. `--json` is valid only here. |
| `status` | exits 0 | exits 1 when the store cannot open or its schema is unsupported | Bounded data-plane check; it does not assert that a Worker process is alive. |

`status --json` reports state counts, queue age inputs, active Worker identities, event retention/consumer watermarks, and expired undispatched/dispatched leases. Any expired lease makes the data-plane projection `degraded`; the supervisor remains the authority for process liveness.

On SIGTERM, the DSH launcher disposes every Worker slot and stops polling. Each slot waits up to `--shutdown-grace-ms` for its active canonical turn before cancellation; cancellation after delivery settles conservatively and a forced process loss is recovered under the same SIGKILL rules. Set the supervisor stop timeout above the configured grace.

Use `--slots N` for local parallelism. Each slot has an independent Worker identity and fenced lease; SQLite enforces global claims and per-Run concurrency keys across slots and processes. Start with one slot, then increase only after provider quotas, workspace isolation, and tool side effects have been reviewed.

For a planned upgrade, run `dsh --profile automation drain --reason upgrade --json`, wait for success, stop the supervisor, upgrade, start it, and finally run `dsh --profile automation resume`. Drain state is durable: a timeout does not silently resume admission.

## macOS launchd

Copy `examples/launchd/com.cofy-x.dsh-automation.plist`, replace its executable, home, and log-directory tokens, and create the log directory. Then install it as the logged-in user:

```sh
plutil -lint ~/Library/LaunchAgents/com.cofy-x.dsh-automation.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.cofy-x.dsh-automation.plist
launchctl kickstart -k "gui/$(id -u)/com.cofy-x.dsh-automation"
launchctl print "gui/$(id -u)/com.cofy-x.dsh-automation"
```

Stop and unload it before changing the definition:

```sh
launchctl bootout "gui/$(id -u)/com.cofy-x.dsh-automation"
```

`KeepAlive` makes an unexpected exit restart after launchd throttling. `bootout` is the intentional stop operation.

## Linux systemd user service

Copy `examples/systemd/dsh-automation.service` to `~/.config/systemd/user/`, replace its executable token, then load and enable it:

```sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-automation.service
systemctl --user status dsh-automation.service
journalctl --user -u dsh-automation.service -f
```

To keep the user service running after logout, an administrator can enable lingering for that account with `loginctl enable-linger <user>`. Use a drop-in if `DSH_HOME` is not `%h/.dsh`.

## Upgrades and incident checks

Stop the service gracefully, upgrade the profile, run `status` and `worker --once`, then start the long-lived service again. Do not run `worker --once` concurrently merely as a liveness probe: it is an actual consumer and may claim a Run.

For an incident, capture these before changing the database:

```sh
dsh --profile automation status --json
dsh --profile automation list --limit 50 --json
dsh --profile automation events --after-seq 0 --limit 50 --json
dsh --profile automation show <run-id> --json
```

Never delete or edit the SQLite database to retry an `indeterminate` Run. Use `retry --confirm-indeterminate` only after reviewing possible side effects. Register adapter event consumers before enabling retention; `purge` requires `--confirm`, deletes only terminal automation bookkeeping, and never deletes canonical Sessions.
