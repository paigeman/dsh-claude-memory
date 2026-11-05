# Development and releases

This guide is for contributors and release maintainers. Installation and everyday use are documented in [English](README.md) and [Chinese](README.zh-CN.md).

## Development and verification

Run these commands from the repository root. Runtime code uses Node.js 20 or later APIs. CI uses Node.js 24.16.0; development tools require `^22.22.0 || >=24.8.0`.

```bash
npm ci --ignore-scripts
npm run format
npm run check
```

`npm run check` runs the Prettier format check, ESLint, Markdownlint, the native DSH suite, and the packed-package smoke test. Native tests use pinned DSH 0.2.1-rc.5 codec and LLM libraries with an offline model adapter. Any skipped native test fails the check. No model credentials are needed.

`npm test` is a lighter run that skips native checks unless `DSH_SESSION_FORMAT_MODULE` is set. To verify an installed macOS app instead of the npm libraries, use this command.

```bash
DSH_HOME="$PWD/.agent-tmp/native-dsh-home" \
DSH_SESSION_FORMAT_MODULE='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js' \
ELECTRON_RUN_AS_NODE=1 \
'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --test test/*.test.js
```

Tests cover project isolation, worktrees, path overrides, symlink containment, full recall, batch completeness, unchanged source bytes and mtimes, and body-free durable messages. The package smoke test extracts the actual tarball, checks its file list and bundle entry, then verifies recall through the packed code. Real-model recall quality needs a separate acceptance check.

## CI and releases

The [CI workflow](https://github.com/paigeman/dsh-claude-memory/actions/workflows/ci.yml) checks formatting, JavaScript, Markdown, and workflow syntax. Native tests and packed-plugin smoke checks run on Linux, macOS, and Windows. A successful run retains the tested `.tgz`, `SHA256SUMS`, and `release.json` as the `package-<run-id>` artifact for seven days. Source files remain in Git; the package excludes development tools, tests, workflow files, and local data.

The [Release workflow](https://github.com/paigeman/dsh-claude-memory/actions/workflows/release.yml) reuses those checks. Manual runs default to a dry run and can validate `main` without a version tag or registry writes.

```bash
gh workflow run release.yml --repo paigeman/dsh-claude-memory --ref main -f dry_run=true
```

For a real release, update `package.json` and `package-lock.json` to the same version, commit the changes, and push a matching tag. For example, version `0.1.3` requires tag `v0.1.3`. Publishing from a branch or a mismatched tag fails. A prerelease such as `0.2.0-rc.1` uses npm tag `next` and a GitHub prerelease; stable versions use npm tag `latest`.

```bash
git tag v0.1.3
git push origin v0.1.3
```

The release publishes the verified tarball, rather than packing a second copy. GitHub Release assets contain the tarball and its SHA-256 checksum. Reruns accept identical existing content and reject conflicting bytes. An npm registry error stops publication. When npm publishing is enabled, its failure also prevents the GitHub Release job.

### Enable npm publishing

The public package name is `dsh-claude-memory-reader`. Its initial npm publication still requires a maintainer account. Until that setup is complete, install from the local checkout and keep the repository variable `NPM_PUBLISH_ENABLED` set to `false`. Version tags can still create downloadable GitHub releases.

1. [Create an npm account](https://www.npmjs.com/signup), verify its email, and enable two-factor authentication. The account name can differ from the unscoped package name.
2. Run a Release dry run, then download its verified artifact. Replace `<run-id>` with that successful run's ID.

   ```bash
   gh run list --repo paigeman/dsh-claude-memory --workflow release.yml
   gh run download <run-id> --repo paigeman/dsh-claude-memory --name package-<run-id> --dir .agent-tmp/bootstrap
   cd .agent-tmp/bootstrap
   shasum -a 256 -c SHA256SUMS
   npm login --registry https://registry.npmjs.org
   npm publish ./dsh-claude-memory-reader-0.1.3.tgz --ignore-scripts --access public --tag latest --registry https://registry.npmjs.org
   ```

   Publish that exact archive with an account that can claim the package name. Availability is not reserved by this repository. Local bootstrap does not request CI provenance.

3. In the npm package's settings, add a GitHub Actions [trusted publisher](https://docs.npmjs.com/trusted-publishers/) with the following values.

   | Setting                 | Value                |
   | ----------------------- | -------------------- |
   | Organization or user    | `paigeman`           |
   | Repository              | `dsh-claude-memory`  |
   | Workflow filename       | `release.yml`        |
   | Environment             | `npm`                |
   | Allowed publish command | Enable `npm publish` |

   The workflow uses direct `npm publish`; a configuration allowing only `npm stage publish` will reject it. No long-lived npm token is stored in GitHub. The hosted runner supplies OIDC credentials and generates provenance.

4. Enable automatic npm publishing only after saving the trusted publisher.

   ```bash
   gh variable set NPM_PUBLISH_ENABLED --body true --repo paigeman/dsh-claude-memory
   ```

Future version tags then publish through that identity. To complete the initial version's GitHub release, tag the same commit used for bootstrap. Its identical npm archive is recognized on rerun; if content differs, use a new version instead of replacing an existing release.

After the first npm publication, CLI users can install the registry package into their chosen profile.

```bash
dsh plugin --profile tui add dsh-claude-memory-reader
```
