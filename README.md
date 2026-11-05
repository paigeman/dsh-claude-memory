# Claude Code Memory Reader for DeepSeek Harness

[中文安装与使用教程](README.zh-CN.md)

Read your project's existing Claude Code or Claude Code Desktop Auto Memory from DeepSeek Harness (DSH). The plugin supplies a bounded `MEMORY.md` index, then lets the model recall topic files when the task needs them. An explicit request such as “load all memories” starts a full, budgeted recall.

Version 0.1.2 has been installed and tested offline on macOS with DSH Desktop 0.2.1-rc.5. A real-model conversation has not yet been validated end to end. Other host versions, Windows, and Linux need separate verification.

## Requirements

You need DSH and existing project Auto Memory. Its usual layout is shown below.

```text
~/.claude/projects/<project>/memory/
├── MEMORY.md
├── feedback_testing.md
└── project_release.md
```

The plugin resolves the active session directory, canonical Git root, and worktree ownership. Custom Claude configuration directories can be set explicitly.

The package is `@local/dsh-claude-memory`. It runs on the Host, has no frontend build, and needs no extra third-party runtime dependencies. Installing development tools is optional for ordinary local plugin installation.

## Install in DSH Desktop

### Locate the package

The repository root is the plugin package directory. If the checkout is at `~/repo/dsh-claude-memory`, get its absolute path with the following commands.

```bash
cd ~/repo/dsh-claude-memory
pwd
```

Confirm that the directory contains `package.json`, `index.js`, and `cordis.patch.yml`.

The repository has two README files, English `README.md` and Chinese `README.zh-CN.md`. Source, tests, and development configuration live directly in the repository root.

### Install through the app

1. Open DSH's plugin manager and choose local plugin installation.
2. Enter the absolute package directory from the previous step and install it.
3. Find **Claude Code Memory (read-only)** in the plugin list. Confirm version 0.1.2 and a running component.
4. Open a new conversation in the project whose memory you want to use.

The bundle patch adds the `claude-memory` component to that profile. Installation updates DSH profile metadata; the plugin's runtime keeps Claude Code Memory read-only.

Keep the source directory after installing a local link. After editing code, reload the plugin or restart DSH once active tasks finish. If the directory changes, update the installed source and verify its resolved link.

### Install with the CLI

For a CLI environment that provides `dsh`, install into the profile you use. This example targets `tui` and runs from the package directory.

```bash
dsh plugin --profile tui add "link:$PWD"
dsh --profile tui --dump-config
```

Check for `id: claude-memory` and `name: '@local/dsh-claude-memory'` in the resulting configuration. Desktop reserves its `desktop` profile for application-managed installation. A standalone CLI distribution may reject access to that profile; use the Desktop workflow above.

## First check

Start a conversation inside a project with existing Claude Code Memory and send the following request.

```text
Load all memories for the current project. Call claude_code_memory with action="status", report the resolved project root and memory directory, then report the file count and whether the full load is complete.
```

Verify that `Project root` and `Memory directory` belong to your project. A missing directory is reported without creating memory. Check Claude Code's saved memory or configure a known directory explicitly.

For a full recall, `Complete: yes` means the load is complete. `Complete: NO` means some content is still absent. Read the accompanying reasons, which can include batch limits, the cumulative context cap, oversized files, and read failures.

This check sends a normal request to the conversation's configured model. Recalled memory is included in that model request.

## Everyday use

Ask your ordinary project question. On activation, the plugin supplies the bounded index. The model chooses whether to read topic files through `claude_code_memory`. Relevance selection combines model judgment with local keyword scoring; the plugin makes no separate model request for retrieval.

You can explicitly request a focused recall.

```text
Call claude_code_memory with action="recall" and query="release branch policy", then use the recalled context to review this release plan.
```

For a known file, ask the model to use these tool arguments.

```json
{ "action": "recall", "files": ["feedback_testing.md"] }
```

A `query` selects up to 3 files by default. `files` selects exact relative paths. Current instructions and repository state take precedence over historical notes.

### Full recall and continuation

“Load memory”, “load all memories”, and “请加载 memory” trigger full recall before the main-session model request. Valid files are loaded in budgeted batches.

You can combine the load with a following task. File names in the later task do not narrow the memory load.

```text
Please load memory, then review design.md.
```

An explicit inclusion list also works, such as “Load all memories, including MEMORY.md and topic files”. A request targeting a single memory file still uses selective recall.

If the receipt supplies `Complete: NO` and a continuation `cursor`, ask the model to use that actual cursor.

```text
Continue calling claude_code_memory with action="load_all" and the cursor from the previous receipt. Report skipped files and stop when loading is complete or a reported limit prevents progress.
```

Reaching the last cursor does not establish completeness on its own. Earlier skipped entries, changed files, and the cumulative context cap also matter. If capacity is insufficient, raise `maxContextChars`, reload the plugin, and recall again from the beginning. Unreadable or oversized files are reported explicitly.

Negations, “how do I load memory?” questions, and requests for a selected `.md` file or topic do not trigger a full load. Delegated subagent prompts also do not trigger natural-language full recall.

### Tool actions

The tool name is `claude_code_memory`.

| Action     | Purpose                                            | Added to transient model context |
| ---------- | -------------------------------------------------- | -------------------------------- |
| `status`   | Inspect paths, settings, warnings, and cache state | No new source bodies             |
| `overview` | Inspect available memory                           | Index and topic manifest         |
| `recall`   | Select by `query` or `files`                       | Selected file bodies             |
| `load_all` | Load every valid file in batches                   | Bodies loaded in this batch      |

`recall` and `load_all` accept `force: true` to refresh active files. Later recall re-reads the source. Each request contains one current copy of each recalled file.

## Configure a custom directory

Most installations can use the bundle defaults. To override them, add a row for the component to the profile's `cordis.patch.yml`, preserving its existing entries. The default Desktop profile is `~/.dsh/profiles/desktop/`; a configured `DSH_HOME` changes its location.

```yaml
- id: claude-memory
  config:
    memoryDir: /absolute/path/to/project/memory
    maxBatchChars: 48000
    maxContextChars: 200000
```

Replace the example with the absolute memory directory, reload the plugin, then inspect `status`. If only the Claude configuration root differs, use `configDir` and let the plugin derive the project directory.

```yaml
- id: claude-memory
  config:
    configDir: /absolute/path/to/claude-config
```

Directory overrides are selected in this order.

1. Plugin `memoryDir`.
2. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`.
3. `autoMemoryDirectory` from file-based policy, local, or user settings.
4. Plugin `projectDirName` or compatibility variable `CLAUDE_CODE_PROJECT_DIR_NAME`.
5. The computed default.

The configuration root comes from plugin `configDir`, `CLAUDE_CONFIG_DIR`, or `~/.claude`, in that order. `CLAUDE_CODE_REMOTE_MEMORY_DIR` can override the default memory base. Project `.claude/settings.json` does not provide the directory override. CLI `--settings`, MDM, and remote policy APIs are not read.

### Bundle defaults

These defaults describe installation through the supplied bundle patch. The patch explicitly sets `includeManifestInIndex` to `false`.

| Key                         | Default  | Meaning                                                                               |
| --------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `configDir`                 | unset    | Claude configuration root                                                             |
| `memoryDir`                 | unset    | Full memory directory override                                                        |
| `projectDirName`            | unset    | Project directory name under `projects/`                                              |
| `maxBatchChars`             | `48000`  | Source characters per batch, from 4000 to 400000                                      |
| `maxContextChars`           | `200000` | Cumulative source-body character cap; at least the batch size, at most 2000000        |
| `maxFileBytes`              | `524288` | Maximum bytes per file; larger files are skipped                                      |
| `maxRecallFiles`            | `3`      | Files selected by a query, from 1 to 5                                                |
| `maxScanFiles`              | `500`    | Scan ceiling                                                                          |
| `maxManifestFiles`          | `200`    | Manifest entry ceiling                                                                |
| `injectIndexInSubagents`    | `false`  | Supply an automatic index to subagents                                                |
| `respectAutoMemoryDisabled` | `true`   | Skip automatic indexing when Claude disables auto memory; explicit recall still works |
| `includeManifestInIndex`    | `false`  | Add a topic manifest; a missing usable index still gets a manifest                    |
| `debug`                     | `false`  | Add a resolution trace to `status`                                                    |

Character budgets exclude small wrapper headers and approximate context cost. They do not count model tokens precisely.

## Message roles and read-only scope

The plugin uses DSH's `tools` and `llm` services with the `agent/pre-step`, `agent/request`, and `llm/stream` lifecycle hooks. It does not modify DSH core source.

Index and topic bodies are attached to the current model request as `role: "user"` context, with `source.kind: "claude-memory"`. The source identifies the producer and does not elevate instruction priority. Memory can guide project conventions; enforced restrictions need permission checks or tool hooks.

The plugin's injection, durable tool results, and own logs do not store source bodies. It creates no persistent memory copy or index. Tool receipts contain file names, counts, completeness, and errors. Recalled bodies stay in the session's process-local cache until reload, disposal, or session release, after which they must be recalled again.

Memory is sent to the current conversation's model. Generated answers can quote it, and independent logging plugins may retain outgoing requests. The guarantee covers this plugin's transport paths. Previously saved history is not deleted.

File symlinks escaping the memory directory are rejected. Symlinked subdirectories are skipped. Long project paths require an exact known hash or an explicit directory override; a similar prefix is insufficient project identity.

## Troubleshooting

### Memory cannot be found

Call `status` and inspect the effective working directory. A common parent of several repositories is treated as its own non-Git project. Start the conversation inside the intended repository, or set a verified `memoryDir`.

Ensure custom Claude environment variables reach the DSH Host, or configure `configDir` explicitly. Use an explicit directory if a Desktop build isolates its storage.

### The receipt has no memory text

The receipt records the load outcome. Source bodies are added to the subsequent model request. Reloading clears the body cache while old receipts remain, so recall again after a reload.

### An old session still reports a V4 format error

The plugin uses a producer source accepted by the current V4 codec and no longer emits the retired `kind: "plugin"` wrapper. A previously failed session may retain an in-memory write batch. Wait for active tasks to finish, quit DSH normally, reopen it, and resume the saved session. Keep the session files.

`DeepSeek Messages stream ended before message_stop` is a separate stream error. These plugin fixes and offline tests do not establish or resolve all of its causes.

### Saving new memories

This version reads existing memory. Use Claude Code or edit its files yourself to create, update, or remove notes.

## Development and verification

Run these commands from the package directory. Runtime code uses Node.js 20 or later APIs. Development tools require Node.js `^22.22.0 || >=24.8.0`, matching the reference toolchain.

```bash
npm ci --ignore-scripts
npm run format
npm run lint
npm test
```

`npm run format` uses Prettier. `npm run lint` runs ESLint recommended rules and Markdownlint, following `AI-demo`. These checks cover plugin source, tests, configuration, and README files. `npm run check` checks formatting, lint, and tests in order.

The default suite uses Node's built-in test runner and needs no model credentials. Installed-runtime checks are skipped unless a DSH module is provided. On macOS, run the complete native suite against the installed app with this command. It uses real codec and request-envelope code with an offline model adapter.

```bash
DSH_HOME="$PWD/.agent-tmp/native-dsh-home" \
DSH_SESSION_FORMAT_MODULE='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js' \
ELECTRON_RUN_AS_NODE=1 \
'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --test test/*.test.js
```

Tests cover project isolation, worktrees, directory overrides, symlink containment, full recall, batch completeness, unchanged source bytes and mtimes, and body-free durable messages. Real-model recall quality needs a separate acceptance check.

## Compatibility and sources

Path handling references locally available reverse-engineered Claude Code 2.1.x source and repository fixtures. It has not been verified against every official release. The index limit is 200 lines or 25000 JavaScript characters, which differs from the official documentation's 25KB byte limit. Nested `.md` files are included in this plugin's explicit full recall.

See the [official Auto Memory documentation](https://code.claude.com/docs/en/memory) for Claude Code's index loading and on-demand topic reads. This plugin adds no independent retrieval-model call and does not manage Claude Code's writes.

MIT licensed. Claude Code is an Anthropic product. This plugin is an independent project.
