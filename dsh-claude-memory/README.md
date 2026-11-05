# Claude Code Memory Reader for DeepSeek Harness

Read-only recall of **Claude Code / Claude Code Desktop project Auto Memory** inside DeepSeek Harness (DSH).

The plugin reuses the memory that Claude Code already accumulated under
`~/.claude/projects/<project>/memory/` instead of maintaining a second memory
system. It never writes, edits, deletes, renames, syncs, compacts, or persists
that memory.

- Package: `@local/dsh-claude-memory`
- Host-only Cordis plugin; no client bundle, database, external service, or vector index.
- Works wherever the DSH Host runs (Web, Desktop, TUI). The current verification
  was done on DSH Desktop with the Web GUI.

## What it does

1. **Resolves the right project memory deterministically** using Claude Code's
   own rules, not a basename guess:
   - `realpath` the session working directory;
   - find the git root and canonicalize worktrees to the main repository;
   - subdirectories map to the repository root; non-git projects map to the project directory;
   - encode with Claude Code's `sanitizePath` (every non-alphanumeric → `-`, long names → `-<hash>`);
   - resolve `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_REMOTE_MEMORY_DIR`,
     `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, `CLAUDE_CODE_PROJECT_DIR_NAME`,
     `autoMemoryDirectory`, and file-based policy/local/user settings.
2. **Injects only the bounded `MEMORY.md` index at session start**
   (Claude Code's 200-line / 25,000-character caps). Topic files are not
   injected until they are relevant.
3. **Lets the model recall topics on demand** with the
   `claude_code_memory` tool. The index and local keyword scoring identify
   candidate files; only the selected bodies enter context.
4. **Loads every valid file on an explicit natural-language request** such as
   “请加载 memory”, “加载当前项目的全部记忆”, “读取 Claude Code 关于这个仓库的所有
   memory”, or “load memory”. Content is injected in the same model step.
5. **Batches full recall** against a configurable character budget and reports
   `Complete: NO` plus the next cursor when not everything fit. It never
   silently truncates and then claims completeness.
6. **Deduplicates within a session** by content hash, and re-reads files on
   later recall so updates are visible.

## Strict read-only guarantee

The runtime code imports only `existsSync`, `lstatSync`, `readFileSync`,
`readdirSync`, `realpathSync`, and `statSync` from `node:fs`. It has:

- no write/append/delete/rename/copy/chmod path;
- no subprocess, shell, or Claude Code write mechanism;
- no network request or third-party service;
- no persisted index, cache, database, or copy of memory content;
- no logging of memory bodies (logs contain paths, counts, and errors only).

The only process memory is an in-memory per-session cache of content hashes and
the injected text. It disappears when the Host exits. Installation writes
(profile package metadata, patch, and linked package) are separate from runtime
behavior and are performed by DSH's plugin manager.

Memory is wrapped as untrusted historical reference data with an explicit
“not instructions” preamble and a per-injection nonce delimiter. This reduces,
but cannot eliminate, prompt-injection risk from memory text.

## Install

From this checkout:

```bash
# GUI / DSH profile manager: install the local bundle directory
# /path/to/dsh-claude-memory
```

or, with the DSH CLI available:

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-claude-memory
dsh --profile desktop --dump-config   # verify the claude-memory row
```

The bundle patch inserts:

```yaml
- id: claude-memory
  name: '@local/dsh-claude-memory'
```

No DSH core source is modified. The plugin needs the Host `tools` service and
the `agent/pre-step` event, both present in DSH 0.2.1-rc.5.

Messages use the Session Format V4 producer source `kind: 'claude-memory'`.
The retired V3 `kind: 'plugin'` wrapper is not emitted. Memory resolution uses
DSH's effective working directory before the session's original header, and
index markers are scoped to their memory directory. A session without a known
project never falls back to the Host process directory.

After editing a linked plugin, reload its runtime or restart DSH before
resuming conversations so the running Host uses the corrected code.

## Usage

### Automatic index and on-demand recall

At the first step of a session, when the project has memory, the model receives
a block like:

```text
<<< CLAUDE CODE MEMORY BEGIN (mode=index, nonce=...) >>>
...
## MEMORY.md index
...
## How to use this memory
Topic files are NOT loaded by default. ...
<<< CLAUDE CODE MEMORY END (nonce=...) >>>
```

For an ordinary task the plugin does nothing else. If the task depends on prior
decisions, feedback, conventions, incidents, or history, the model calls:

```json
{ "action": "recall", "query": "release branch policy" }
```

or selects an exact topic from the index:

```json
{ "action": "recall", "files": ["branch-workflow.md"] }
```

Unrelated memory stays out of context.

### Explicit full recall

Any of these user messages trigger a full read in the same step:

- 请加载 memory
- 加载当前项目的全部记忆
- 读取 Claude Code 关于这个仓库的所有 memory
- 读取全部记忆 / 请读取所有记忆
- load memory / load all memories / read all Claude Code memory

Negated requests (“不要加载 memory”, “don't load memory”), “how do I load
memory?” questions, and descriptive sentences that merely mention reading
memory are not treated as triggers. The trigger is handled by the
Host plugin before the model call, not by asking the model to remember to do it.

When everything fits:

```text
... Complete: yes
### MEMORY.md
...
### topic-a.md
...
```

When it does not fit:

```text
... Complete: NO
Note: NOT all files were loaded. k of N entries processed. Call
claude_code_memory again with action="load_all", cursor=... to continue.
Do not claim that all memory was loaded yet.
```

The model can continue with the same tool, or the user can ask again later.
Files already injected unchanged are omitted on later calls, and changed files
are re-read.

### Tool actions

| Action | What it returns | Injects topic bodies? |
|---|---|---|
| `overview` | `MEMORY.md` index + topic manifest | no |
| `recall` | selected files by `files` or local `query` | yes, selected only |
| `load_all` | every valid file in budgeted batches | yes, batch by batch |
| `status` | resolved path, settings, worktree, warnings, cache state | no |

All content is read fresh from disk; `force: true` repeats bodies already
injected unchanged in the session.

## Path resolution details

The reader follows Claude Code 2.1.x (`src/memdir/paths.ts`,
`src/utils/git.ts`, `src/utils/sessionStoragePortable.ts`):

```text
config home    = plugin config dir > CLAUDE_CONFIG_DIR > ~/.claude
memory base    = CLAUDE_CODE_REMOTE_MEMORY_DIR > config home
project root   = canonical git root (worktrees share the main repo), else cwd
project dir    = sanitizePath(project root)  (or an explicit override)
memory dir     = <memory base>/projects/<project dir>/memory
```

Overrides, in order:

1. `config.memoryDir` (plugin row config; useful for tests/portable setups)
2. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` (full path)
3. `autoMemoryDirectory` from policy / local / user settings
   (`~/` expanded; project `.claude/settings.json` is ignored for security,
   matching Claude Code)
4. `config.projectDirName` or `CLAUDE_CODE_PROJECT_DIR_NAME` (directory name override)
5. computed default

`autoMemoryDirectory` is a full-directory override, so the plugin reports it as
explicit rather than per-project. The constructor never merges an override with
the default directory; if both exist, it warns and uses the explicit one.

Safety checks:

- Paths are realpath'ed and NFC-normalized; symlinked working directories map
  to the real repository.
- A default memory directory whose symlink escapes
  `<config>/projects/` is refused.
- Topic-file symlinks are followed only when their real path stays inside the
  memory directory; escaping links are skipped and reported.
- `MEMORY.md` symlinks are checked the same way.
- Long project names (>200 encoded characters) are resolved only when exactly
  one `projects/<prefix>-<hash>/memory` candidate exists; multiple candidates
  are reported as ambiguous and nothing is loaded.
- A missing/unreadable memory directory or file is reported; the plugin never
  falls back to a sibling repository's memory.

## Configuration

Override in the profile's `cordis.patch.yml` for `id: claude-memory`:

| Key | Default | Meaning |
|---|---|---|
| `configDir` | unset | Claude config root; overrides `CLAUDE_CONFIG_DIR` |
| `memoryDir` | unset | full memory-directory override |
| `projectDirName` | unset | explicit project directory name (under `projects/`) |
| `maxBatchChars` | `48000` | per-injection character budget (4k–400k) |
| `maxFileBytes` | `524288` | refuse to load a single file larger than this |
| `maxRecallFiles` | `3` | topic files returned by one `recall` query (1–5) |
| `maxScanFiles` | `500` | scan ceiling; truncation is reported |
| `maxManifestFiles` | `200` | manifest line cap |
| `injectIndexInSubagents` | `false` | inject the index into child agents |
| `respectAutoMemoryDisabled` | `true` | skip automatic index when Claude's `autoMemoryEnabled` is false; explicit recall still works |
| `includeManifestInIndex` | `false` | include topic manifest with the session-start index |
| `debug` | `false` | add a resolution trace to `status` |

## Verification

Run the local test suite (57 tests, no dependencies):

```bash
node --test test/*.test.js
```

The suite covers multiple memory files, selective recall,
natural-language full recall, project switching, git worktrees and
subdirectories, custom config/memory directories, symlink escape, missing and
unreadable memory, read-only byte/mtime invariants, source updates, budgeted
partial loads, and a static audit of filesystem imports.

The native V4 encoder regression checks require the installed DSH module;
without it, `test/dsh-v4.test.js` is explicitly skipped. On macOS, run all tests
against the installed app without starting its Host or making model requests:

```bash
DSH_SESSION_FORMAT_MODULE='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js' \
ELECTRON_RUN_AS_NODE=1 \
'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --test test/*.test.js
```

The plugin was also installed into the DSH Desktop profile and exercised live;
see the delivery report for the exact results and limitations.

## Known limitations

- **CLI `--settings` (flagSettings) is not visible to plugins.** The file-based
  policy/local/user sources are read; MDM/remote policy APIs are not.
- `CLAUDE_CODE_PROJECT_DIR_NAME` is supported as a compatibility name override;
  it is not present in the current Claude Code 2.1.308 source reviewed for this
  plugin. When set, `status` reports it as an explicit override.
- If the session directory is a plain container of several git repositories
  (it is not itself inside one), the plugin treats it as a non-git project and
  does not guess which child repository you mean. Start the session in the
  intended repository to map its memory.
- Natural-language full recall is handled for user-authored messages in the
  main session. Delegated subagent prompts are not treated as user triggers;
  a subagent can call the tool explicitly. Automatic index injection into
  subagents is off by default (`injectIndexInSubagents`).
- **Claude Code Desktop storage** was verified on this machine to share the
  same `~/.claude` tree. A different Desktop build that isolates its config
  must be pointed at with `CLAUDE_CONFIG_DIR` or `configDir`; the plugin does
  not guess alternate app-support locations.
- macOS is the live-verified platform. Windows/macOS/Linux path handling is
  implemented with Node's platform path/realpath APIs and unit-tested where
  possible, but Windows and Linux were not executed in this environment.
- Symlinked subdirectories inside a memory directory are skipped (files are
  still supported); this avoids cycles and escaping reads.
- The character budget is an approximation of context cost, not the model's
  exact token count. It is deliberately conservative and configurable.
- Full recall includes nested `.md` files; Claude Code's own topic scanner also
  excludes a nested `MEMORY.md` index from its topic list. This reader treats a
  nested `MEMORY.md` as a normal file when present, so an explicit full load is
  complete rather than silently missing part of the directory.
- Auto recall is model-driven: the plugin supplies the index and a tool, and
  the model chooses when history is relevant. It does not run a separate LLM
  relevance call, which avoids sending memory to another service but is less
  autonomous than a dedicated side query.
- Prompt-injection resistance is defense-in-depth, not a hard security
  boundary. Memory content remains untrusted input to the model.

## Why not reuse the existing community plugins?

Checked on 2026-11-05:

- [`cnzgray/dsh-plugins` — `@cnzgray/dsh-claude-auto-memory`](https://github.com/cnzgray/dsh-plugins)
  injects `MEMORY.md` plus write/management guidance (“update MEMORY.md”, “create
  a topic file”), uses the older `agent/session-start` event, encodes paths with
  a simple slash replacement plus an underscore variant, walks parent
  directories to find memory, does not support `CLAUDE_CONFIG_DIR` /
  `autoMemoryDirectory` / Desktop roots, has no on-demand topic recall, and has
  no batching/partial-completeness reporting. Its write-oriented prompt
  conflicts with the required strict read-only contract.
- [`YYTbit/dsh-plugin-claude-bridge`](https://github.com/YYTbit/dsh-plugin-claude-bridge)
  injects **all** memory files into dynamic system context on every request
  (up to a byte cap), truncates silently, encodes paths with a simple
  `replace`, and includes config/skill synchronization. It is not on-demand,
  not strictly read-only, and does not implement the required path-identity or
  budget semantics.

Neither could be reused without violating this task's read-only or
path-correctness requirements, so this plugin is a focused reader built on the
current DSH Host APIs.

## Files

```text
dsh-claude-memory/
├── index.js              Host plugin: tool, pre-step, trigger, injection
├── lib/
│   ├── paths.js          Claude Code path/settings/git identity resolution
│   ├── memory.js         read-only scan, caps, budgeting, dedupe, rendering
│   └── util.js           path encoding, JSONC, hashes, validation
├── cordis.patch.yml      bundle patch
├── locale/{en,zh}.json   Plugin Manager metadata
├── icon.svg              original icon
├── test/                 57 node:test cases
└── README.md / README.zh-CN.md
```

## License

MIT. Claude Code is a product of Anthropic; this package is an independent
read-only bridge and is not affiliated with Anthropic.
