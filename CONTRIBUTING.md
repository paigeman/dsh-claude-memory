# Contributing

Contributions can improve memory recall, compatibility, tests, or documentation. Installation and everyday use are covered in the [English README](README.md) and [Chinese README](README.zh-CN.md).

## Report a problem

Include the DSH version, operating system, steps to reproduce, and the expected and actual results. For path resolution problems, include the output of the `claude_code_memory` tool's `status` action after removing personal paths and other private information. Keep Memory contents and model credentials out of public reports.

## Set up a development checkout

Fork the repository and create a branch for your change. Use Node.js 24.16.0 to match CI, then install the locked development dependencies from the repository root.

```bash
npm ci --ignore-scripts
```

This installs the root development tools and private test workspaces for each supported DSH version. Each workspace pins its matching DSH and Cordis versions; the lockfile records both dependency trees. It does not change the user's installed DSH or add dependencies to the distributed plugin.

Runtime code supports Node.js 20 and later. Development tools have newer requirements, so use the CI version when running repository checks.

## Make and check a change

Keep the change focused. Format the files you edit with the repository's Prettier configuration. For example, after editing the English README, run the following command.

```bash
npx --no-install prettier --write README.md
```

For code changes, run the full check before opening a pull request.

```bash
npm run check
```

This checks formatting, JavaScript, and Markdown, runs the full test suite against every supported native DSH runtime, and verifies the packed plugin. CI tests every supported DSH version on Linux, macOS, and Windows before the release workflow can publish.

For documentation-only changes, format the affected Markdown files and run `npm run lint:markdown`.

Individual checks are available while developing.

| Command                  | What it checks                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `npm run format:check`   | Formatting against the repository's Prettier configuration                                        |
| `npm run lint`           | JavaScript and Markdown rules                                                                     |
| `npm test`               | A quick test run that can skip native DSH checks                                                  |
| `npm run test:native`    | Every supported DSH compatibility gate, registry, codec, and request path; zero skips per runtime |
| `npm run verify:package` | The packed file list, bundle entry, and recall through the extracted package                      |

Native tests use each workspace's pinned DSH libraries and an offline model adapter. The runner checks actual package versions and verifies that each library resolves the matching Cordis instance before testing. They run without an installed Desktop app or model credentials. Passing them verifies the tested integration paths; it does not measure recall quality in a real-model conversation.

To inspect the matrix or run one supported version while developing, use the following commands. The full check still runs every version.

```bash
node scripts/test-native.mjs --list
npm run test:native -- --version 0.2.2-rc.1
```

When changing behavior, add a regression test that exercises the affected case. Use synthetic Memory fixtures. Preserve the plugin's read-only behavior, project isolation, and exclusion of Memory bodies from durable plugin messages and tool results. If a change affects installation or configuration, update both READMEs.

## Maintain DSH compatibility

Use one plugin implementation and release line while the supported DSH versions share the public APIs it needs. Start support at DSH 0.2.1-rc.5 and keep the current and previous tested generations when practical. Adding a DSH version does not require a separate plugin branch. If an incompatible API makes shared maintenance impractical, keep the last compatible plugin release documented for the older runtime and use a separate branch only when it needs ongoing fixes.

To add a supported DSH version:

1. Compare the native compatibility check, tool registry, agent hooks, LLM request envelope, and V4 codec with the existing supported versions.
2. Add a private workspace under `test/runtimes/<DSH version>/package.json`. Pin the same five packages as the existing workspaces, using the matching Cordis version and exact DSH versions.
3. Add that exact DSH version to `engines.dsh` using `||`, then update the lockfile with `npm install --ignore-scripts`. Do not replace the old workspace when adding support.
4. Run `npm run check`, update the support tables in both READMEs, and bump the plugin version for publication. CI derives its OS-by-DSH matrix from these workspaces automatically.

The compatibility regression tests require the engine declaration and test matrix to agree. They also reproduce the 0.1.4 rejection on DSH 0.2.2-rc.1 using DSH's own compatibility checker. Keep release candidates explicit: broad ranges can admit untested builds, especially when a caller enables [prerelease matching](https://github.com/npm/node-semver#prerelease-tags).

Removing a supported version must be an explicit release decision. Update its workspace, engine declaration, and support table together, and identify the last compatible plugin release. Do not drop the baseline silently just because a newer DSH version appears.

## Validate in DSH Desktop

Keep DSH Desktop open, signed in, and idle, then run this from the checkout:

```bash
npm run test:desktop
```

The command prepares and installs a local private `dsh-claude-memory-reader-dev` package when its runtime files, bundle settings, or compatibility declaration are stale. It also connects a development-only control component to the existing Desktop Host. Both packages can remain installed; the development reader starts disabled, and the controller enables at most one reader at a time. The formal package is not replaced or published by this command.

The control component is referenced by an owned block in the Desktop profile's `cordis.patch.yml`; the rest of that file is preserved and backed up. It accepts requests through an owner-only directory under `.agent-tmp/desktop-control`, and uses DSH's own plugin manager and Session controller. It opens no HTTP listener and does not copy account credentials. Keep this checkout in place while using the control component.

Acceptance uses the Desktop's real configured model and normal model quota. It creates synthetic Git projects, project-local memory settings, and random probe values, then checks automatic indexing, focused recall, full recall, recall after plugin reload, and project isolation. Probes are absent from user prompts; success requires both the model's correct answer and an observed transient memory block. Test Agents can call only `claude_code_memory`. The original reader selection is restored after success or an ordinary failure. Running unrelated conversations cause the test to refuse before switching readers.

Reports, synthetic fixtures, candidate packages, and profile backups remain under `.agent-tmp/desktop-control`. Test conversations remain in DSH history. The command exits with a failure when a model answer, tool receipt, transient-context check, or restoration check fails. It does not replace `npm run check`, which remains the offline CI path.

The Desktop control adapter has been exercised on macOS with DSH 0.2.2-rc.1. Its HMR callback boundary is checked explicitly and refuses an unsupported implementation. Other Desktop versions and operating systems still require their own real acceptance run. macOS finds the bundled Desktop CLI automatically; set `DSH_DESKTOP_CLI` to the bundled launcher if the installation is elsewhere.

For ordinary development, these commands switch readers or inspect the connection without uninstalling either package:

```bash
npm run desktop -- status
npm run desktop -- use dev
npm run desktop -- use stable
npm run desktop -- use off
```

`stable` means the installed `dsh-claude-memory-reader`, which must support the running DSH. An incompatible installed release has no activatable entry and is refused; no compatibility exemption is granted. If activation fails, the switch attempts to restore the previous reader. Updating the formal npm release remains a separate release operation.

`npm run desktop -- install` explicitly rebuilds the development package and connects the component; `npm run desktop -- connect` refreshes just the control component. The normal `test:desktop` command performs these steps when needed. If a Host is stopped or interrupted during a test, inspect the retained report and reader state before retrying; interrupted operations are not replayed automatically.

## Open a pull request

Target `main`. Describe the problem, the resulting behavior, and the checks you ran. Include reproduction steps for a bug fix and explain any compatibility limit the change introduces.

Write commit messages in English. Use `type(scope): short summary` for the subject and a bullet list for the body. For example, a project isolation fix could use this message.

```text
fix(claude-memory): scope recall to the active project

- resolve the session project before selecting memory files
- cover project isolation with a regression test
```

Use the module as the scope when possible. Supported types are `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, and `revert`.
