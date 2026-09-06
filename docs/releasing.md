# Releasing dsh-automation

One immutable version covers `dsh-automation`, `dsh-automation-app`, and `dsh-automation-cli`. The packages publish in that dependency order; prereleases receive the npm `next` dist-tag and stable versions receive `latest`.

## Release contract

`pnpm run release:check` validates the complete peer graph, source size, types, tests, build, synchronized manifests, packed contents, and a clean-room installation of all three tarballs. The artifact smoke installs the packed CLI, uses it to create a fresh automation profile from the packed core and app, and requires `doctor` to report healthy.

Prepare a version only on a release branch:

```sh
pnpm release:version -- 0.2.0-alpha.1
pnpm run release:check
pnpm run release:publish -- --dry-run
```

The version command updates all three manifests, the app's exact core peer, the CLI's exact workspace dependencies, and the lockfile. Review and merge that single-purpose change before tagging.

## Registry authentication bootstrap

The long-term authentication mechanism is npm trusted publishing through GitHub OIDC. Configure each of the three package settings with organization `cofy-x`, repository `dsh-automation`, workflow `release.yml`, environment `npm`, and permission to run `npm publish`. The workflow requires npm CLI 11.5.1 or newer and a GitHub-hosted runner; Node 24 satisfies the runtime requirement.

An npm package must exist before its trusted publisher can be configured. For the first release only, create the protected GitHub environment `npm`, add a granular `NPM_TOKEN` environment secret with publish access and 2FA bypass, and require reviewer approval. After all package pages exist, configure trusted publishing for every package and remove `NPM_TOKEN`; the unchanged workflow then authenticates only with short-lived OIDC credentials and npm emits provenance automatically.

Before the bootstrap release, the npm account must have publish rights to all three names. `dsh-automation` has prior unpublished registry history, so its ownership must be confirmed explicitly; a 404 from `npm view` does not prove that the name is claimable.

## Tag-driven publication

Create an annotated `v<version>` tag on the exact verified `main` commit and push it using the repository's authorized Git transport. `.github/workflows/release.yml` rejects lightweight tags, mismatched versions, dirty sources, and commits not reachable from `origin/main`.

The workflow packs once per publish attempt, then publishes core, app, and CLI sequentially. After every publish it verifies registry metadata. Finally it installs `dsh-automation-cli@<version>` from npm, runs `init --registry` and `doctor` in a fresh `DSH_HOME`, and only then creates the GitHub Release.

Publication is retry-safe across partial failures. A rerun verifies and skips an already-published exact version, then continues with the first missing package. npm versions and pushed tags are immutable: never delete, replace, or retarget either one; fix a failed candidate with a new version and tag.
