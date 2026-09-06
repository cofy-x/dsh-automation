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

## Registry authentication

Publication uses npm trusted publishing through GitHub OIDC. Each of the three package settings names organization `cofy-x`, repository `dsh-automation`, workflow `release.yml`, environment `npm`, and permission to run `npm publish`. The workflow pins an OIDC-capable npm CLI on a GitHub-hosted Node 24 runner and stores no registry token.

The initial token-authenticated bootstrap is complete. Keep the `npm` GitHub environment reviewer gate, but do not restore `NPM_TOKEN`; successful publishes use short-lived credentials and npm emits provenance automatically.

Before the bootstrap release, the npm account must have publish rights to all three names. `dsh-automation` has prior unpublished registry history, so its ownership must be confirmed explicitly; a 404 from `npm view` does not prove that the name is claimable.

## Tag-driven publication

Create an annotated `v<version>` tag on the exact verified `main` commit and push it using the repository's authorized Git transport. The unprivileged `.github/workflows/release-check.yml` rejects lightweight tags, mismatched versions, dirty sources, and commits not reachable from `origin/main`. Only its successful tag run can trigger the protected `.github/workflows/release.yml` publisher for the same commit.

The publisher repeats the complete release gate, packs once per attempt, then publishes core, app, and CLI sequentially. After every publish it verifies registry metadata. Finally it installs `dsh-automation-cli@<version>` from npm, runs `init --registry` and `doctor` in a fresh `DSH_HOME`, and only then creates the GitHub Release.

Prereleases publish under `next`; stable releases publish under `latest`. npm may also create `latest` for a package's first prerelease even when another tag is requested. The verifier accepts that bootstrap state while no stable version exists, and requires `latest` to remain stable after the first stable release. It never mutates dist-tags outside `npm publish`, so the normal release path remains OIDC-only.

Publication is retry-safe across partial failures. A rerun verifies and skips an already-published exact version, then continues with the first missing package. npm versions and pushed tags are immutable: never delete, replace, or retarget either one; fix a failed candidate with a new version and tag.
