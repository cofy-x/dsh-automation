# dsh-automation-cli

User-facing command line and operating-system service manager for [dsh-automation](https://github.com/cofy-x/dsh-automation).

```sh
npm install --global dsh-automation-cli
dsh-automation init
dsh-automation doctor
dsh-automation service install
dsh-automation submit "Run the repository checks"
```

The CLI owns installation and process supervision only. Durable queueing and execution remain in the `dsh-automation` DSH service plugin.
