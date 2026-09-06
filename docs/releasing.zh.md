# dsh-automation 联合发布

`dsh-automation`、`dsh-automation-app` 和 `dsh-automation-cli` 共享一个不可变版本。发布顺序固定为 core、app、CLI；预发布版本使用 npm `next` dist-tag，稳定版本使用 `latest`。

## 发布契约

`pnpm run release:check` 会检查完整 peer graph、源码规模、类型、测试、构建、三份 manifest 的版本关系、打包内容，以及三个 tarball 的干净环境安装。产物 smoke 会安装打包后的 CLI，用打包后的 core 和 app 创建全新 automation profile，并要求 `doctor` 返回健康。

只在专用 release 分支准备版本：

```sh
pnpm release:version -- 0.2.0-alpha.1
pnpm run release:check
pnpm run release:publish -- --dry-run
```

版本命令会同步更新三份 manifest、app 对 core 的精确 peer、CLI 的精确 workspace 依赖和 lockfile。该单一目的变更必须 review、合并后才能打 tag。

## Registry 认证引导

终态认证方式是 GitHub OIDC 和 npm trusted publishing。需要在三个 npm package 的设置中分别登记 organization `cofy-x`、repository `dsh-automation`、workflow `release.yml`、environment `npm`，并允许执行 `npm publish`。工作流要求 npm CLI 11.5.1 或更新版本以及 GitHub-hosted runner；Node 24 满足运行时要求。

npm package 存在后才能登记 trusted publisher。仅第一次发布时，在 GitHub 创建受保护的 `npm` environment，添加具备 publish 权限并允许绕过 2FA 的 granular `NPM_TOKEN` environment secret，同时设置人工审批。三个包页面建立后，为每个包配置 trusted publishing 并删除 `NPM_TOKEN`；工作流无需修改，之后只使用短期 OIDC 凭据，npm 会自动生成 provenance。

首发前，npm 账号必须拥有三个包名的发布权限。`dsh-automation` 在 registry 中存在曾被 unpublished 的历史，因此必须显式确认所有权；`npm view` 返回 404 并不能证明该名称可以认领。

## Tag 驱动发布

在完成验证的精确 `main` commit 上创建 annotated `v<version>` tag，并通过仓库允许的 Git 传输方式推送。`.github/workflows/release.yml` 会拒绝 lightweight tag、版本不匹配、dirty source，以及无法从 `origin/main` 到达的 commit。

工作流在每次发布尝试中打包一次，然后顺序发布 core、app 和 CLI，并在每一步验证 registry metadata。最后从 npm 安装 `dsh-automation-cli@<version>`，在全新 `DSH_HOME` 中执行 `init --registry` 与 `doctor`；只有全部成功后才创建 GitHub Release。

发布完成后，工作流还会对账 npm dist-tag。当某个包的首个版本是预发布版本时，npm 可能自动创建 `latest`；对账会移除这个错误的默认通道，同时保留已有的稳定版 `latest`。如果发布成功但 dist-tag 对账失败，应在引导期 `NPM_TOKEN` 仍已配置时，对精确发布版本运行受保护的 `registry maintenance` 工作流。Trusted publishing 只认证 `npm publish`；dist-tag 维护需要临时 granular token，并且必须继续经过 `npm` environment 的人工审批。

部分发布失败后可以安全重跑。脚本会验证并跳过 registry 中已经存在的精确版本，然后从第一个缺失包继续。npm version 和已经推送的 tag 都不可变：不得删除、覆盖或移动；失败候选必须用新版本和新 tag 修复。
