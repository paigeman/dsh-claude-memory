# Claude Code Memory Reader for DeepSeek Harness

[English guide](README.md)

这个插件让 DeepSeek Harness（DSH）读取当前仓库在 Claude Code 或 Claude Code Desktop 中积累的 Auto Memory。已有的项目偏好、历史决定和反馈可以继续用于 DSH 对话，无需手工复制记忆文件。

插件运行时只读。它先提供 `MEMORY.md` 索引，再让模型按任务调用 `claude_code_memory` 读取相关主题。你也可以直接说“请加载 memory”，要求加载当前项目的全部有效记忆。

当前版本为 0.1.3，验证环境为 macOS 上的 DSH Desktop 0.2.1-rc.5。安装、消息格式和离线请求调用链已经验证，真实模型对话的端到端验收仍待完成。CI 会在 Linux、macOS、Windows 上验证固定版本的 DSH 库。其他系统的 Desktop 安装和真实模型表现仍需另行验收。

## 安装前准备

需要已安装并能正常使用的 DSH，以及 Claude Code 为目标项目保存的 Memory。常见目录如下。

```text
~/.claude/projects/<project>/memory/
├── MEMORY.md
├── feedback_testing.md
└── project_release.md
```

`<project>` 由项目路径编码得到。插件会解析会话的有效工作目录、Git 根目录和 worktree 归属，无需手填这个名称。自定义配置目录可以在安装后设置。

插件包名为 `dsh-claude-memory-reader`。它只有 Host 端代码，没有前端构建步骤，运行时不需要额外安装第三方依赖。开发检查所用的 npm 工具与日常安装分开。

## 安装到 DSH Desktop

### 找到插件包目录

尚未下载源码时，先克隆公开仓库。仓库根目录就是插件包目录，已有该目录时直接进入即可。

```bash
git clone https://github.com/paigeman/dsh-claude-memory.git ~/repo/dsh-claude-memory
cd ~/repo/dsh-claude-memory
pwd
```

这个目录应当同时包含 `package.json`、`index.js` 和 `cordis.patch.yml`。复制 `pwd` 输出的绝对路径。

### 在界面中安装

1. 打开 DSH 的插件管理界面，进入本地插件安装入口。
2. 填入刚才复制的插件包绝对路径，完成安装。
3. 在插件列表中找到 **Claude Code 记忆（只读）**，检查版本为 0.1.3，组件状态为运行中。
4. 在目标项目目录中新开一个对话，继续下面的首次检查。

随包的 `cordis.patch.yml` 会把 `claude-memory` 组件加入当前 profile。安装会写入 DSH 的插件配置，插件运行时对 Claude Code Memory 保持只读。

本地目录安装会引用这份源码。保留该目录；后续改代码后，重新加载插件或在任务结束后正常重启 DSH。需要换安装位置时，通过插件管理器更新来源，并检查最终链接指向。

### 使用 DSH CLI 安装

如果你使用已提供 `dsh` 命令的 CLI 环境，可以把插件加入相应 profile。下面以 `tui` 为例，在插件包目录运行。

```bash
dsh plugin --profile tui add "link:$PWD"
dsh --profile tui --dump-config
```

在输出的组件配置中检查 `id: claude-memory` 和 `name: 'dsh-claude-memory-reader'`。Desktop 的 `desktop` profile 由应用保留管理，使用上面的 Desktop 安装流程；普通 CLI 发行版可能拒绝操作它。

## 第一次使用

在 Claude Code 已保存过项目记忆的目录中打开 DSH 对话，发送下面这段话。

```text
请加载当前项目的 memory。请调用 claude_code_memory 的 status 动作，报告识别到的仓库和 Memory 目录，再说明加载文件数及是否完整加载。
```

先核对返回的 `Project root` 和 `Memory directory`。它们应该指向你正在处理的项目。若目录不存在，确认 Claude Code 已为该项目保存记忆，或按下面的自定义目录示例指定位置。

全量加载回执包含文件数、文件名和完整性状态。`Complete: yes` 表示本次全量加载完整；`Complete: NO` 表示仍有内容未进入当前上下文。后者可能来自批次预算、累计上下文上限、文件过大或读取失败，要结合回执中的原因判断。

这段检查会调用当前对话配置的模型，正常产生模型请求。加载后的 Memory 会随该对话的模型请求发送。

## 日常按需召回

直接提出当前任务即可。插件首次激活时提供有上限的 `MEMORY.md` 索引，主题文件正文由模型判断是否需要读取。相关性选择使用模型判断和本地关键词评分，没有单独的检索模型请求。

需要明确指定读取范围时，可以这样说。

```text
请调用 claude_code_memory 的 recall 动作，查询“发布分支规则”，结合召回内容检查这次发布计划。
```

也可以给出 Memory 目录中的相对文件名，让模型传入以下参数。

```json
{ "action": "recall", "files": ["feedback_testing.md"] }
```

`query` 单次默认最多选择 3 个相关文件，`files` 可以直接指定文件。当前任务和现有仓库状态优先，过时的记忆需要核对后再采用。

### 全量加载与继续加载

“请加载 memory”“加载当前项目的全部记忆”和“load all memories”会触发全量加载。插件在主会话的模型请求前处理这些明确请求，内容按预算分批。

加载指令也可以和其他任务放在同一条消息中。后续任务提到的文件名不会限制 Memory 的读取范围。

```text
请加载 memory，然后评审 design.md。
```

明确列出包含内容同样有效，例如“请加载当前项目的全部 memory，包括 MEMORY.md 和所有主题文件”。只要求读取某个 Memory 文件的消息仍走按需召回。

若回执返回 `Complete: NO` 和下一批 `cursor`，让模型使用回执中实际给出的数值继续调用工具。

```text
请按上一条回执给出的 cursor 继续调用 claude_code_memory，action 使用 load_all。报告未加载原因，直到完整加载或明确遇到上限。
```

仅到达最后一个 cursor 还不足以说明完整。此前被跳过的文件、后来变化的内容，以及累计上下文容量都要满足要求。累计上限不足时，在插件配置中调大 `maxContextChars`，重新加载插件后从头召回；无法读取或过大的文件也会明确报告。

“不要加载 memory”和“如何加载 memory？”不会触发全量读取。指定某个 `.md` 文件、索引或相关主题的请求交给按需工具处理。子 Agent 的内部委派提示也不会触发自然语言全量加载。

### 工具动作速查

工具名为 `claude_code_memory`。下表中的参数由模型调用工具时使用。

| action     | 用途                           | 进入临时模型上下文的内容 |
| ---------- | ------------------------------ | ------------------------ |
| `status`   | 检查路径、设置、警告和缓存状态 | 无新增记忆正文           |
| `overview` | 查看可读范围                   | 索引与主题清单           |
| `recall`   | 按 `query` 或 `files` 选择内容 | 选中文件正文             |
| `load_all` | 分批加载全部有效文件           | 本批已加载正文           |

`recall` 和 `load_all` 支持 `force: true` 刷新已加载文件。后续召回会重新读取源文件，每个模型请求只带每个已召回文件的一份当前正文。

## 配置自定义目录

通常可以保持随包配置。需要指定路径时，在当前 profile 的 `cordis.patch.yml` 为插件添加覆盖。默认 Desktop profile 位于 `~/.dsh/profiles/desktop/`；配置过 `DSH_HOME` 时使用对应目录。保留文件中的已有配置，在同一 YAML 列表内添加下面的条目。

```yaml
- id: claude-memory
  config:
    memoryDir: /absolute/path/to/project/memory
    maxBatchChars: 48000
    maxContextChars: 200000
```

用目标 Memory 目录的绝对路径替换示例，保存后重新加载插件，再调用 `status` 检查。`memoryDir` 直接指定完整目录；如果只是 Claude 配置根目录不同，改用 `configDir`，由插件继续按项目推导 Memory 路径。

```yaml
- id: claude-memory
  config:
    configDir: /absolute/path/to/claude-config
```

路径覆盖按以下顺序选择。

1. 插件配置的 `memoryDir`。
2. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`。
3. 文件式 policy、local、user 设置中的 `autoMemoryDirectory`。
4. 插件的 `projectDirName` 或兼容变量 `CLAUDE_CODE_PROJECT_DIR_NAME`。
5. 根据仓库根目录计算的默认路径。

默认配置根目录依次取插件的 `configDir`、`CLAUDE_CONFIG_DIR`、`~/.claude`。`CLAUDE_CODE_REMOTE_MEMORY_DIR` 可以覆盖默认 Memory 基目录。项目内 `.claude/settings.json` 的 `autoMemoryDirectory` 不用于覆盖，CLI `--settings` 和 MDM、远程 policy API 暂不读取。

### 随包配置

下表描述通过本地 bundle 安装后的配置。`includeManifestInIndex` 由随包补丁明确设为 `false`。

| 配置                        | 默认值   | 作用                                              |
| --------------------------- | -------- | ------------------------------------------------- |
| `configDir`                 | 未设置   | Claude 配置根目录                                 |
| `memoryDir`                 | 未设置   | 完整 Memory 目录覆盖                              |
| `projectDirName`            | 未设置   | `projects/` 下的目录名覆盖                        |
| `maxBatchChars`             | `48000`  | 单次源字符预算，范围为 4000 到 400000             |
| `maxContextChars`           | `200000` | 累计正文字符上限，至少等于单次预算，最多 200 万   |
| `maxFileBytes`              | `524288` | 单文件字节上限，超过明确跳过                      |
| `maxRecallFiles`            | `3`      | 单次关键词召回文件数，范围为 1 到 5               |
| `maxScanFiles`              | `500`    | 扫描文件数上限                                    |
| `maxManifestFiles`          | `200`    | 清单条目上限                                      |
| `injectIndexInSubagents`    | `false`  | 是否自动向子 Agent 提供索引                       |
| `respectAutoMemoryDisabled` | `true`   | Claude 关闭自动记忆时跳过自动索引，显式召回仍可用 |
| `includeManifestInIndex`    | `false`  | 索引是否附带主题清单；缺少有效索引时仍提供清单    |
| `debug`                     | `false`  | 在 `status` 中增加路径解析轨迹                    |

字符预算包含源内容，少量包装文本另计。它只是上下文成本的近似，不能当作精确 token 数。

## 记忆怎样进入对话

插件使用 DSH 的 `tools`、`llm` 服务以及 `agent/pre-step`、`agent/request`、`llm/stream` 生命周期钩子，不修改 DSH 核心源码。

记忆索引与正文以 `role: "user"` 附加到当前模型请求，来源标记为 `source.kind: "claude-memory"`。这个标记用于识别生产者，不会提高消息权限。记忆可以指导项目约定，必须强制执行的限制仍需权限检查或工具钩子。

插件不会通过持久化会话消息、工具结果或自身日志保存源正文，也不在磁盘建立 Memory 副本或索引。工具结果只保留文件名、数量、完整性和错误。已召回正文仅在当前进程的会话缓存中存在，重载、卸载或释放会话后清空，需要再次召回。

正文会发送给当前 DSH 对话使用的模型。模型回答可能引用这些内容，其他请求日志插件也可能保存出站请求，因此保证范围限于本插件自身的注入与工具结果路径。旧版本已经写入的历史不会自动删除。

读取只接受范围内的文件。越过 Memory 根目录的文件符号链接会被拒绝，符号链接子目录会跳过。超长项目路径若无法核对精确 hash，插件会要求显式指定目录，避免借用相似路径的其他项目记忆。

## 常见问题

### 找不到当前项目的 Memory

先调用 `status` 检查 DSH 的有效工作目录。多个仓库的公共父目录会被当作独立的非 Git 项目，不会猜测你想使用哪个子仓库。在目标仓库中新建对话，或明确配置已经核对过的 `memoryDir`。

自定义 Claude 配置需要让 DSH Host 获得对应环境变量，或直接设置插件的 `configDir`。不同 Desktop 版本若隔离存储，也采用显式目录配置。

### 工具回执没有正文，模型还能看到吗

能。回执用于记录加载结果，正文在随后发给模型的临时请求中。重载插件后正文缓存消失，旧回执仍然存在，此时再次召回即可。

### 会话仍报 V4 消息格式错误

插件使用当前 V4 编码器接受的生产者来源，不再产生旧版 `kind: "plugin"` 包装。此前失败的旧会话可能仍留着内存写入队列。等待活动任务结束，正常退出并重新打开 DSH，再恢复会话。保留原会话文件。

`DeepSeek Messages stream ended before message_stop` 是另一项流式传输错误。本插件的修复与离线测试没有确认或解决它的所有成因。

### 能让插件保存新记忆吗

当前版本专注读取已有 Memory。创建、修改与删除记忆继续由 Claude Code 或你自己完成。

## 参与开发

开发检查和版本发布步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。日常安装使用无需执行这些操作。

## 兼容范围与来源

路径处理参考本机可读的 Claude Code 2.1.x 逆向重建源码，并用本仓库测试验证；这不等于所有官方发行版都已验证。索引读取上限为 200 行或 25000 个 JavaScript 字符，字符计量与官方文档所述的 25KB 并不完全相同。嵌套 `.md` 文件也会纳入本插件的显式全量召回。

Claude Code 自身的索引启动加载、主题按需读取机制可见 [Auto Memory 官方文档](https://code.claude.com/docs/en/memory)。本插件不会额外调用模型筛选记忆，也不接管 Claude Code 的写入功能。

本项目采用 MIT 许可。Claude Code 属于 Anthropic，本插件是独立项目。
