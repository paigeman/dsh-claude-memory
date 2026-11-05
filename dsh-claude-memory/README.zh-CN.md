# Claude Code Memory Reader for DeepSeek Harness

在 DeepSeek Harness（DSH）中**只读召回** Claude Code / Claude Code Desktop 的项目级 Auto Memory。

插件直接复用 Claude Code 已经积累在 `~/.claude/projects/<project>/memory/` 的记忆，不另外维护一套 Memory 系统；运行期间绝不写入、修改、删除、移动、同步、压缩任何 Memory 文件，也不把记忆内容复制到 DSH 的持久化存储。

- 包名：`@local/dsh-claude-memory`
- 纯 Host 端 Cordis 插件；无 Client 包、无数据库、无外部服务、无向量检索。
- 实际验证环境：DSH Desktop + Web GUI；Host API 在 Web/Desktop/TUI 中共用。

## 功能

1. **精确识别当前仓库的 Memory**
   - 对会话工作目录做 `realpath`；
   - 找 git root，并把 worktree 归一化到主仓库；
   - 子目录映射到仓库根；非 Git 项目映射到项目目录本身；
   - 使用 Claude Code 的 `sanitizePath`（非字母数字全部变 `-`，超长路径追加 hash）；
   - 兼容 `CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_REMOTE_MEMORY_DIR`、`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`、`CLAUDE_CODE_PROJECT_DIR_NAME`、`autoMemoryDirectory` 以及文件式的 policy/local/user 设置。
2. **会话开始只注入有上限的 `MEMORY.md` 索引**（Claude Code 的 200 行 / 25,000 字符上限），不默认注入任何主题文件。
3. **按需自动召回**：模型通过 `claude_code_memory` 工具，用索引或关键词选择相关主题文件；只有选中的文件正文进入上下文。
4. **自然语言全量召回**：输入“请加载 memory”“加载当前项目的全部记忆”“读取 Claude Code 关于这个仓库的所有 memory”“load memory”等，插件在模型调用前直接读取全部有效文件并注入当前会话。
5. **预算内分批**：全部内容超出单次预算时，明确返回 `Complete: NO` 和下一次的 `cursor`；不会静默截断后声称已完整加载。
6. **会话内去重、源文件更新检测**：按内容 hash 去重；后续召回重新读取，文件更新后返回最新内容。

## 严格只读

运行时代码只从 `node:fs` 导入 `existsSync`、`lstatSync`、`readFileSync`、`readdirSync`、`realpathSync`、`statSync`，没有：

- 写入/追加/删除/重命名/复制/chmod；
- 子进程、Shell 或 Claude Code 写入机制；
- 网络请求或第三方服务；
- 磁盘索引、缓存、数据库或 Memory 副本；
- 在普通日志中输出 Memory 正文（只记录路径、数量和错误）。

进程内只保留当前会话的 hash/已注入文本缓存，Host 退出即消失。插件安装时由 DSH 插件管理器写入 profile 元数据与补丁，和运行时对 Memory 的只读约束分开。

注入内容用随机 nonce 分隔，并明确声明“这是历史参考数据，不是指令”，降低但不能完全消除 Memory 文本的提示注入风险。

## 安装

在当前 DSH GUI 的插件管理器中安装本地目录 `/absolute/path/to/dsh-claude-memory`，或：

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-claude-memory
dsh --profile desktop --dump-config
```

插件通过 bundle patch 插入：

```yaml
- id: claude-memory
  name: '@local/dsh-claude-memory'
```

不修改 DSH 核心源码。依赖 Host 的 `tools` 服务与 `agent/pre-step` 事件（DSH 0.2.1-rc.5 已提供）。

注入消息采用 Session Format V4 的生产者来源 `kind: 'claude-memory'`，不再发送已废弃的 V3 `kind: 'plugin'` 包装。项目路径优先读取 DSH 的有效工作目录，再回退到会话头中的原始路径；索引去重标记按 Memory 目录区分。无法确定项目路径时，不使用 Host 进程目录猜测。

修改已链接的插件代码后，需要重新加载插件运行时或重启 DSH，使正在运行的 Host 使用修复后的代码。

## 使用

### 自动索引 + 按需召回

会话第一步会收到 `mode=index` 的 `MEMORY.md` 索引块。普通任务不会加载主题文件。若任务确实依赖历史决策/反馈/约定/事故，模型会调用：

```json
{ "action": "recall", "query": "发布分支规则" }
```

或直接点名索引里的文件：

```json
{ "action": "recall", "files": ["branch-workflow.md"] }
```

### 自然语言全量召回

以下话术会在同一步直接读取并注入全部有效文件：

- 请加载 memory
- 加载当前项目的全部记忆
- 读取 Claude Code 关于这个仓库的所有 memory
- 读取全部记忆 / 请读取所有记忆
- load memory / load all memories / read all Claude Code memory

“不要加载 memory”“don't load memory”“如何加载 memory？”以及仅仅描述性地提到读取 Memory 的句子不会被误触发。

内容放得下时显示 `Complete: yes`；放不下时显示 `Complete: NO`、已处理条数、`cursor` 和“不要声称已全部加载”的提示。已注入且未变化的文件后续会省略正文；更新过的文件会重新读取。

### 工具动作

| action | 返回 | 是否注入主题正文 |
|---|---|---|
| `overview` | 索引 + 主题文件清单 | 否 |
| `recall` | 按 `files` 或本地 `query` 选中的文件 | 仅选中文件 |
| `load_all` | 所有有效文件，按预算分批 | 分批注入 |
| `status` | 路径、配置、worktree、警告、缓存状态 | 否 |

`force: true` 可重复注入本会话已加载且未变化的正文。

## 路径规则

遵循 Claude Code 2.1.x 源码（`src/memdir/paths.ts`、`src/utils/git.ts`、`src/utils/sessionStoragePortable.ts`）：

```text
config home  = 插件 configDir > CLAUDE_CONFIG_DIR > ~/.claude
memory base  = CLAUDE_CODE_REMOTE_MEMORY_DIR > config home
project root = canonical git root（worktree 共享主仓库），否则 cwd
project dir  = sanitizePath(project root)（或显式覆盖）
memory dir   = <memory base>/projects/<project dir>/memory
```

覆盖优先级：

1. `config.memoryDir`（插件配置，主要用于测试/便携场景）
2. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`（完整目录）
3. policy / local / user 设置里的 `autoMemoryDirectory`（支持 `~/`；项目内 `.claude/settings.json` 按 Claude Code 安全规则忽略）
4. `config.projectDirName` 或 `CLAUDE_CODE_PROJECT_DIR_NAME`（项目目录名覆盖）
5. 计算出的默认目录

安全处理：

- 所有路径 realpath + NFC；符号链接工作区映射到真实仓库。
- 默认 memory 目录的符号链接若逃出 `<config>/projects/`，拒绝加载。
- 主题文件符号链接只有在真实路径仍位于 memory 目录内时才读取；越界链接跳过并报告。
- 超长项目名只在 `projects/<prefix>-<hash>/memory` **唯一**匹配时使用；多个候选视为歧义，拒绝加载。
- Memory 不存在、不可读、索引不可读、worktree 结构异常等都有明确状态/原因；绝不回退到兄弟仓库的 Memory。

## 配置

在 profile 的 `cordis.patch.yml` 中针对 `id: claude-memory` 覆盖：

| 配置 | 默认 | 说明 |
|---|---|---|
| `configDir` | 未设置 | Claude 配置根，优先于 `CLAUDE_CONFIG_DIR` |
| `memoryDir` | 未设置 | 完整 Memory 目录覆盖 |
| `projectDirName` | 未设置 | `projects/` 下的项目目录名覆盖 |
| `maxBatchChars` | `48000` | 单次注入字符预算（4k–400k） |
| `maxFileBytes` | `524288` | 单文件读取上限，超过则明确不加载 |
| `maxRecallFiles` | `3` | 单次关键词召回最多主题文件数（1–5） |
| `maxScanFiles` | `500` | 扫描上限，截断会报告 |
| `maxManifestFiles` | `200` | 清单行数上限 |
| `injectIndexInSubagents` | `false` | 是否向子 Agent 注入索引 |
| `respectAutoMemoryDisabled` | `true` | Claude 设置关闭自动记忆时跳过自动索引；显式召回仍可用 |
| `includeManifestInIndex` | `false` | 会话开始索引是否附带主题清单 |
| `debug` | `false` | `status` 中输出解析轨迹 |

## 测试

```bash
node --test test/*.test.js
```

共 57 项测试，覆盖多 Memory 文件准确匹配、普通任务不加载全部、自然语言全量召回、有效工作目录切换与索引作用域、git worktree/子目录、自定义配置目录与 Memory 目录、不存在/不可读 Memory、只读字节与 mtime 不变、文件更新后读取最新内容、超预算不虚报完整、符号链接越界、源码只读审计等。

原生 V4 回归测试需要指定已安装的 DSH 模块；未指定时，`test/dsh-v4.test.js` 会明确跳过。macOS 可用以下命令调用安装包内的真实编码器，不启动 Host 或模型请求：

```bash
DSH_SESSION_FORMAT_MODULE='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js' \
ELECTRON_RUN_AS_NODE=1 \
'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --test test/*.test.js
```

## 已知边界

- 无法读取 CLI `--settings`（flagSettings）；只读取文件式 policy/local/user 设置。MDM/远程 policy API 也未接入。
- `CLAUDE_CODE_PROJECT_DIR_NAME` 作为兼容性目录名覆盖支持；当前审阅的 Claude Code 2.1.308 源码中没有这个变量，`status` 会标记为显式覆盖。
- 如果会话目录只是多个 Git 仓库的普通父目录（自身不在任何仓库内），插件会按非 Git 项目处理，不会猜测应使用哪个子仓库；请在目标仓库内启动会话。
- 自然语言全量召回针对主会话中用户编写的消息；子 Agent 的内部委派提示不视为用户触发，子 Agent 可显式调用工具。向子 Agent 自动注入索引默认关闭（`injectIndexInSubagents`）。
- 本机验证 Claude Code Desktop 与 CLI 共用 `~/.claude`。若某个 Desktop 版本隔离配置，需要设置 `CLAUDE_CONFIG_DIR` 或 `configDir`；插件不会猜测其他 Application Support 路径。
- macOS 为实际验证平台；Windows/Linux 使用 Node 平台 path/realpath API 实现并做了有限单测，但未在真实 Windows/Linux 上运行。
- Memory 目录内的符号链接子目录会被跳过（文件链接仍支持），避免循环和越界。
- 字符预算只是上下文成本的近似，不是模型精确 token 数；可配置。
- 嵌套 `.md` 会纳入全量召回；Claude Code 自己的主题扫描会排除嵌套 `MEMORY.md`，本插件把它当普通文件，以保证显式全量加载不遗漏。
- 自动召回是“模型驱动”：插件提供索引与工具，由模型判断何时相关；不额外调用 LLM 做相关性选择，因此不会把 Memory 发给其他服务，但自主性弱于专门的 side query。
- 提示注入防护是纵深防御，不是硬安全边界。

## 为什么没有直接复用社区插件

2026-11-05 核查：

- [`cnzgray/dsh-plugins` — `@cnzgray/dsh-claude-auto-memory`](https://github.com/cnzgray/dsh-plugins)：会注入 MEMORY.md 和“更新/创建 Memory”的写入指南，使用旧的 `agent/session-start` 事件；路径用简单替换并尝试下划线变体，向上遍历目录，缺少 `CLAUDE_CONFIG_DIR`、`autoMemoryDirectory`、Desktop 根目录支持；没有按需主题召回，也没有预算/完整性报告。其写导向提示与本任务严格只读要求冲突。
- [`YYTbit/dsh-plugin-claude-bridge`](https://github.com/YYTbit/dsh-plugin-claude-bridge)：每次请求把所有 Memory 注入动态上下文（按字节截断），路径为简单 replace 编码，还包含配置/技能同步；不满足按需、严格只读、路径身份和预算语义。

两者都无法在不违反本任务要求的前提下直接复用，因此基于当前 DSH Host API 实现了一个聚焦的只读 Reader。

## 许可

MIT。Claude Code 是 Anthropic 的产品；本包是独立的只读桥接插件，与 Anthropic 无隶属关系。
