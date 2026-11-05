# DSH Claude Memory

让 DeepSeek Harness（DSH）读取当前项目在 Claude Code 中积累的 Auto Memory。插件会先提供有上限的记忆索引，具体任务需要历史信息时，再由模型调用工具读取相关文件。输入“请加载 memory”可以明确要求全量加载。

当前版本为 0.1.1，已在 DSH Desktop 0.2.1-rc.5 上安装并通过离线集成测试。真实模型对话的端到端验收仍待完成。

## 安装到 DSH Desktop

先准备好这个仓库。插件包在内层的 `dsh-claude-memory/` 目录，其中有 `package.json`、`index.js` 和 `cordis.patch.yml`。

如果仓库放在 `~/repo/dsh-claude-memory`，运行下面的命令，取得安装时要填写的绝对路径。

```bash
cd ~/repo/dsh-claude-memory/dsh-claude-memory
pwd
```

在 DSH 的插件管理界面安装本地插件，填写刚才得到的路径。安装完成后，检查插件列表中是否出现 **Claude Code 记忆（只读）**，并确认组件正在运行。

本地安装不需要先运行 `npm install`，插件运行时没有额外的第三方依赖。保留源码目录，开发依赖只在修改代码、运行检查时需要安装。

## 第一次使用

在已有 Claude Code Memory 的项目目录中新开一个 DSH 对话，发送下面这段话。

```text
请加载当前项目的 memory。请调用 claude_code_memory 的 status 动作，报告识别到的仓库和 Memory 目录，再说明加载文件数及是否完整加载。
```

检查返回路径是否属于当前项目。看到 `Complete: yes` 才说明本次全量加载完整；若返回 `Complete: NO`，让模型按回执中的 `cursor` 继续，并检查未加载原因。没有 Memory 时，插件会报告目录不存在，不会替 Claude Code 创建记忆。

日常任务可以直接提问。模型会根据索引判断是否需要调用 `claude_code_memory` 读取主题文件。记忆会以临时 `user` 角色上下文进入模型请求，插件自身的会话消息与工具回执只保留加载状态。

## 接着看哪里

- [中文安装与使用教程](dsh-claude-memory/README.zh-CN.md) 包含自定义目录、工具动作、分批加载和故障排查。
- [English guide](dsh-claude-memory/README.md) covers the same installation and usage workflow.
- [实现评审](dsh-claude-memory/REVIEW-2026-11-05.md) 记录只读边界与兼容性修复。

Memory 会发送给当前 DSH 对话所使用的模型。插件不会改动 Claude Code Memory，也不建立持久化副本或索引。模型的回答可能引用记忆，其他日志插件也可能保存请求。需要强制执行的限制，应交给 DSH 的权限检查或工具钩子。

## 开发与检查

在内层插件目录运行。开发工具要求 Node.js `^22.22.0 || >=24.8.0` 和 npm，规则参考 `AI-demo` 的 Prettier、ESLint 与 Markdownlint 配置。

```bash
cd ~/repo/dsh-claude-memory/dsh-claude-memory
npm ci --ignore-scripts
npm run format
npm run lint
npm test
```

`npm run check` 会依次检查格式、执行 lint 和运行测试。安装包内真实 DSH 模块的测试方式见[中文教程](dsh-claude-memory/README.zh-CN.md#开发与验证)。
