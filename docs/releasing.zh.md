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

## Registry 认证

发布认证使用 GitHub OIDC 和 npm trusted publishing。三个 npm package 的设置分别登记 organization `cofy-x`、repository `dsh-automation`、workflow `release.yml`、environment `npm`，并允许执行 `npm publish`。工作流在 GitHub-hosted Node 24 runner 上固定安装支持 OIDC 的 npm CLI，不保存 registry token。

首次使用 token 的引导发布已经完成。继续保留 GitHub `npm` environment 的人工审批，但不得恢复 `NPM_TOKEN`；发布只使用短期凭据，npm 会自动生成 provenance。

首发前，npm 账号必须拥有三个包名的发布权限。`dsh-automation` 在 registry 中存在曾被 unpublished 的历史，因此必须显式确认所有权；`npm view` 返回 404 并不能证明该名称可以认领。

## Tag 驱动发布

在完成验证的精确 `main` commit 上创建 annotated `v<version>` tag，并通过仓库允许的 Git 传输方式推送。无发布权限的 `.github/workflows/release-check.yml` 会拒绝 lightweight tag、版本不匹配、dirty source，以及无法从 `origin/main` 到达的 commit。只有成功的 tag 检查才能触发同一 commit 上受保护的 `.github/workflows/release.yml` 发布器。

发布器会再次运行完整 release gate，每次发布尝试只打包一次，然后顺序发布 core、app 和 CLI，并在每一步验证 registry metadata。最后从 npm 安装 `dsh-automation-cli@<version>`，在全新 `DSH_HOME` 中执行 `init --registry` 与 `doctor`；只有全部成功后才创建 GitHub Release。

预发布版本发布到 `next`，稳定版本发布到 `latest`。即使指定了其他 tag，npm 也可能为包的首个预发布版本自动创建 `latest`。在不存在稳定版本时，验证器接受这个引导状态；首个稳定版本发布后，则要求 `latest` 始终指向稳定版本。正常发布路径不会在 `npm publish` 之外修改 dist-tag，因此可以完全使用 OIDC。

部分发布失败后可以安全重跑。脚本会验证并跳过 registry 中已经存在的精确版本，然后从第一个缺失包继续。npm version 和已经推送的 tag 都不可变：不得删除、覆盖或移动；失败候选必须用新版本和新 tag 修复。
