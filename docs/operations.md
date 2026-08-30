# Operating dsh-automation

Run one `dsh --profile automation worker` process independently of DSH Console. The operating system owns process lifetime; SQLite owns Run and Attempt state; canonical DSH Sessions remain the execution fact source.

## Before installing a service

1. Install `dsh-automation` into the dedicated `automation` profile.
2. Run `dsh --profile automation status` as the same operating-system user that will run the service.
3. Run `dsh --profile automation worker --once --json`. An empty queue returns `{"recovered":0}` and exit code 0.
4. Resolve the real `dsh` executable with `command -v dsh`. Supervisor definitions must use its absolute path and the same `DSH_HOME` as management commands.

The examples under `examples/` are templates. Replace every `__...__` token before installing them.

## Process and exit contract

| Invocation | Success | Failure | Meaning |
|:---|:---|:---|:---|
| `worker` | stays resident; SIGTERM exits 0; SIGINT exits 130 | profile boot failures exit nonzero | Long-lived queue consumer. A transient cycle error is logged and retried on a later poll. |
| `worker --once` | exits 0 after recovery plus at most one new claim | exits 1 on an operational error | Bounded smoke test or scheduler integration. `--json` is valid only here. |
| `status` | exits 0 | exits 1 when the store cannot open or its schema is unsupported | Bounded data-plane check; it does not assert that a Worker process is alive. |

`status --json` reports state counts, queue age inputs, and expired undispatched/dispatched leases. Expired counts are evidence for recovery work, not by themselves a failed health check. Check Worker liveness with `launchctl print` or `systemctl --user is-active`.

On SIGTERM, the DSH launcher disposes the Worker, stops polling, cancels an active Agent, waits for the current pump, and then exits. Set a stop timeout long enough for that flush. A second signal or supervisor timeout may force termination; the next Worker then applies the same crash-recovery rules as an unplanned process loss.

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
dsh --profile automation list --json
dsh --profile automation show <run-id> --json
```

Never delete or edit the SQLite database to retry an `indeterminate` Run. That state means a canonical turn may have produced external side effects and requires operator review.
