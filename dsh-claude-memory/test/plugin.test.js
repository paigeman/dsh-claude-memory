import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { apply, detectFullRecall } from "../index.js";
import { resolveMemoryLocation } from "../lib/paths.js";
import {
  assertSnapshotsEqual,
  cleanup,
  ensureDir,
  fakeAgent,
  fakeCtx,
  makeTemp,
  memoryPath,
  treeSnapshot,
  userMessage,
  writeFile,
} from "./helpers.js";

function pluginFixture() {
  const temp = makeTemp();
  const home = join(temp, "home");
  const configDir = join(home, ".claude");
  const project = join(temp, "project");
  ensureDir(project);
  const memoryDir = memoryPath(configDir, project, {
    "MEMORY.md": [
      "# Index",
      "- [Build](build.md) — build commands and CI notes",
      "- [Feedback](feedback.md) — response feedback",
      "",
    ].join("\n"),
    "build.md":
      "---\ndescription: build commands and CI notes\n---\nUse make build and GitHub Actions.\n",
    "feedback.md": "---\ndescription: response feedback\n---\nNever summarize diffs. Use pnpm.\n",
  });
  const config = { configDir, maxBatchChars: 48_000 };
  return { temp, home, configDir, project, memoryDir, config };
}

function execFor(agent) {
  return { agent, signal: new AbortController().signal };
}

async function runFirstStep(fake, agent, text) {
  const messages = [userMessage(text)];
  const result = await fake.preStep(agent, messages, { kind: "enter", messages });
  for (const message of result.messages) agent.session.appendUserMessage(message);
  const request = await fake.modelRequest(agent, result.messages);
  assert.equal(request.dispatches, 1);
  return { ...result, messages: request.messages, durableMessages: result.messages };
}

test("detectFullRecall recognizes documented triggers and rejects negatives/questions", () => {
  for (const text of [
    "请加载 memory",
    "加载当前项目的全部记忆",
    "读取 Claude Code 关于这个仓库的所有 memory",
    "load memory",
    "load all memories",
    "请读取全部记忆",
    "不要忘记加载 memory",
    "Please load all memories",
    "能否帮我加载 memory",
    "好的，请加载 memory",
    "Can you help me load memory?",
    "ok please load memory",
  ]) {
    assert.equal(detectFullRecall(text), true, text);
  }
  for (const text of [
    "不要加载 memory",
    "don't load memory",
    "never read memory",
    "如何加载 memory？",
    "How do I load memory?",
    "memory 文件在哪里？",
    "请读取 memory 的索引",
    "请加载 memory 中和部署相关的主题",
    "读取 memory.js 的源码",
    "read the memory documentation",
    "load only matching memory",
    "hello world",
    "```\nload memory\n```",
    "避免子会话读取父仓库的 Memory",
    "请说明为什么读取 Memory 会失败",
    "The plugin reads Memory on demand",
    "当用户要求读取所有 memory 时，插件会注入内容",
  ]) {
    assert.equal(detectFullRecall(text), false, text);
  }
});

test("first step injects only the bounded index; topic bodies stay out", async () => {
  const { temp, config, project } = pluginFixture();
  const fake = fakeCtx();
  apply(fake.ctx, config);
  const agent = fakeAgent(project);
  const result = await runFirstStep(fake, agent, "Please fix the build.");
  assert.equal(result.messages.length, 2);
  const injected = result.messages[1];
  assert.equal(injected.source.kind, "claude-memory");
  assert.equal(injected.source.plugin, undefined);
  assert.equal(injected.source.form, "index");
  assert.match(injected.content[0].text, /mode=index/);
  assert.match(injected.content[0].text, /# Index/);
  assert.match(injected.content[0].text, /build commands and CI notes/);
  assert.doesNotMatch(injected.content[0].text, /Use make build and GitHub Actions/);
  assert.doesNotMatch(injected.content[0].text, /Never summarize diffs/);
  assert.ok(fake.tools.has("claude_code_memory"));
  cleanup(temp);
});

test("index is injected once per session and a resumed session with the marker is not duplicated", async () => {
  const { temp, config, project } = pluginFixture();
  const fake = fakeCtx();
  apply(fake.ctx, config);
  const agent = fakeAgent(project);

  const first = await runFirstStep(fake, agent, "hello");
  assert.equal(first.messages.filter((m) => m.source?.form === "index").length, 1);
  const secondMessages = [userMessage("another turn")];
  const second = await fake.preStep(agent, secondMessages, {
    kind: "enter",
    messages: secondMessages,
  });
  assert.equal(second.messages.filter((m) => m.source?.form === "index").length, 0);

  // A fresh agent state whose session history already has a plugin index message.
  const resumed = fakeAgent(project);
  resumed.session.appendUserMessage(first.messages[1]);
  const resumedResult = await runFirstStep(fake, resumed, "resumed hello");
  assert.equal(resumedResult.messages.filter((m) => m.source?.form === "index").length, 1);
  cleanup(temp);
});

test('explicit "请加载 memory" injects complete memory content in the same step', async () => {
  const { temp, config, project } = pluginFixture();
  const fake = fakeCtx();
  apply(fake.ctx, config);
  const agent = fakeAgent(project);
  const result = await runFirstStep(fake, agent, "请加载 memory");
  const injected = result.messages.find((message) => message.source?.form === "full-recall");
  assert.ok(injected, "full recall message should be injected");
  assert.match(injected.content[0].text, /mode=full/);
  assert.match(injected.content[0].text, /Complete: yes/);
  assert.match(injected.content[0].text, /Use make build and GitHub Actions/);
  assert.match(injected.content[0].text, /Never summarize diffs/);
  assert.doesNotMatch(injected.content[0].text, /mode=index/);
  cleanup(temp);
});

test("repeated full recall is deduplicated, files are re-read after updates", async () => {
  const { temp, config, project, memoryDir } = pluginFixture();
  const fake = fakeCtx();
  apply(fake.ctx, config);
  const agent = fakeAgent(project);
  await runFirstStep(fake, agent, "请加载 memory");

  const again = await runFirstStep(fake, agent, "请加载当前项目的全部记忆");
  const second = again.messages.find((message) => message.source?.form === "full-recall");
  assert.ok(second);
  assert.match(second.content[0].text, /Use make build and GitHub Actions/);
  assert.equal(
    (second.content[0].text.match(/Use make build and GitHub Actions/g) ?? []).length,
    1,
  );
  assert.equal((second.content[0].text.match(/Never summarize diffs/g) ?? []).length, 1);

  writeFile(
    join(memoryDir, "feedback.md"),
    "---\ndescription: response feedback\n---\nUse pnpm. NEW: run tests twice.\n",
  );
  const updated = await runFirstStep(fake, agent, "读取 Claude Code 关于这个仓库的所有 memory");
  const third = updated.messages.find((message) => message.source?.form === "full-recall");
  assert.ok(third);
  assert.match(third.content[0].text, /NEW: run tests twice/);
  assert.doesNotMatch(third.content[0].text, /Never summarize diffs/);
  cleanup(temp);
});

test("switching projects never reuses the previous project memory", async () => {
  const { temp, configDir, config, project } = pluginFixture();
  const otherProject = join(temp, "other-project");
  ensureDir(otherProject);
  memoryPath(configDir, otherProject, {
    "MEMORY.md": "# Other Index\n- [Other](other.md) — other project topic\n",
    "other.md": "OTHER PROJECT BODY\n",
  });
  const fake = fakeCtx();
  apply(fake.ctx, config);
  const firstAgent = fakeAgent(project);
  await runFirstStep(fake, firstAgent, "hello");
  const secondAgent = fakeAgent(otherProject);
  const result = await runFirstStep(fake, secondAgent, "hello");
  const injected = result.messages.find((message) => message.source?.form === "index");
  assert.ok(injected);
  assert.match(injected.content[0].text, /Other Index/);
  assert.doesNotMatch(injected.content[0].text, /build commands and CI notes/);
  cleanup(temp);
});

test("missing memory produces a clear trigger message and no index noise", async () => {
  const temp = makeTemp();
  const home = join(temp, "home");
  const configDir = join(home, ".claude");
  const project = join(temp, "project");
  ensureDir(project);
  const fake = fakeCtx();
  apply(fake.ctx, { configDir });
  const agent = fakeAgent(project);
  const normal = await runFirstStep(fake, agent, "hello");
  assert.equal(normal.messages.length, 1);
  const triggered = await runFirstStep(fake, agent, "请加载 memory");
  const injected = triggered.messages.find((message) => message.source?.form === "full-recall");
  assert.ok(injected);
  assert.match(injected.content[0].text, /No Claude Code Auto Memory directory exists/);
  assert.match(injected.content[0].text, /Nothing was loaded/);
  cleanup(temp);
});

test("read-only tool supports status, overview, recall, and budgeted load_all", async () => {
  const { temp, config, project, memoryDir } = pluginFixture();
  const before = treeSnapshot(memoryDir);
  const fake = fakeCtx();
  apply(fake.ctx, config);
  const agent = fakeAgent(project);
  const tool = fake.tool("claude_code_memory");
  assert.ok(tool);
  assert.equal(tool.name, "claude_code_memory");

  const status = await tool.execute({ action: "status" }, execFor(agent));
  assert.match(status.text, /read-only/);
  assert.match(status.text, new RegExp(memoryDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const overview = await tool.execute({ action: "overview" }, execFor(agent));
  const overviewRequest = await fake.modelRequest(agent, [userMessage("continue")]);
  assert.match(
    overviewRequest.messages.map((message) => message.content[0]?.text).join("\n"),
    /# Index/,
  );
  assert.doesNotMatch(overview.text, /Use make build and GitHub Actions/);

  const recall = await tool.execute({ action: "recall", query: "pnpm feedback" }, execFor(agent));
  const recalledRequest = await fake.modelRequest(agent, [userMessage("continue")]);
  assert.match(
    recalledRequest.messages.map((message) => message.content[0]?.text).join("\n"),
    /Use pnpm/,
  );
  assert.doesNotMatch(recall.text, /Use pnpm/);
  assert.doesNotMatch(recall.text, /Use make build and GitHub Actions/);

  const full = await tool.execute({ action: "load_all" }, execFor(agent));
  assert.match(full.text, /mode=full/);
  assert.match(full.text, /Complete: yes/);
  const fullRequest = await fake.modelRequest(agent, [userMessage("continue")]);
  assert.match(
    fullRequest.messages.map((message) => message.content[0]?.text).join("\n"),
    /Use make build and GitHub Actions/,
  );
  assert.doesNotMatch(full.text, /Use make build and GitHub Actions/);

  const after = treeSnapshot(memoryDir);
  assertSnapshotsEqual(assert, before, after);
  cleanup(temp);
});

test("partial load_all never claims completeness and exposes a cursor", async () => {
  const { temp, configDir, project } = pluginFixture();
  const memoryDir = memoryPath(configDir, project, {});
  writeFile(join(memoryDir, "big1.md"), `big1\n${"q".repeat(3500)}`);
  writeFile(join(memoryDir, "big2.md"), `big2\n${"r".repeat(3500)}`);
  writeFile(join(memoryDir, "big3.md"), `big3\n${"s".repeat(3500)}`);
  const fake = fakeCtx();
  apply(fake.ctx, { configDir, maxBatchChars: 4000 });
  const agent = fakeAgent(project);
  const tool = fake.tool("claude_code_memory");
  let result = await tool.execute({ action: "load_all", cursor: 0 }, execFor(agent));
  assert.match(result.text, /Complete: NO/);
  assert.match(result.text, /NOT all files were loaded/);
  assert.match(result.text, /cursor=\d+/);
  assert.doesNotMatch(result.text, /Complete: yes/);
  cleanup(temp);
});

test("subagents skip delegated natural-language triggers but can explicitly call the tool", async () => {
  const { temp, config, project } = pluginFixture();
  const fake = fakeCtx();
  apply(fake.ctx, config);
  const agent = fakeAgent(project, { origin: "subagent" });
  const normal = await runFirstStep(fake, agent, "do a subtask");
  assert.equal(normal.messages.length, 1);
  const triggered = await runFirstStep(fake, agent, "请加载 memory");
  assert.equal(
    triggered.messages.some((message) => message.source?.form === "full-recall"),
    false,
  );
  await fake.tool("claude_code_memory").execute({ action: "load_all" }, execFor(agent));
  const requested = await fake.modelRequest(agent, [userMessage("continue")]);
  assert.ok(requested.messages.some((message) => message.source?.form === "full-recall"));
  cleanup(temp);
});

test("autoMemoryEnabled=false suppresses the automatic index but not explicit recall", async () => {
  const { temp, configDir, project } = pluginFixture();
  writeFile(join(configDir, "settings.json"), JSON.stringify({ autoMemoryEnabled: false }));
  const fake = fakeCtx();
  apply(fake.ctx, { configDir });
  const agent = fakeAgent(project);
  const normal = await runFirstStep(fake, agent, "hello");
  assert.equal(normal.messages.filter((message) => message.source?.form === "index").length, 0);
  const triggered = await runFirstStep(fake, agent, "请加载 memory");
  const full = triggered.messages.find((message) => message.source?.form === "full-recall");
  assert.ok(full);
  assert.match(full.content[0].text, /Use make build and GitHub Actions/);
  cleanup(temp);
});

test("unknown config keys warn without disabling the plugin", async () => {
  const { temp, config } = pluginFixture();
  const fake = fakeCtx();
  apply(fake.ctx, { ...config, bogusKey: true });
  assert.ok(fake.logs.some(([level, message]) => level === "warn" && message.includes("bogusKey")));
  assert.ok(fake.tool("claude_code_memory"));
  cleanup(temp);
});

test("resolution failure never breaks the turn", async () => {
  const temp = makeTemp();
  const fake = fakeCtx();
  apply(fake.ctx, { configDir: join(temp, "config") });
  const agent = fakeAgent(join(temp, "missing-project"));
  const messages = [userMessage("请加载 memory")];
  const result = await fake.preStep(agent, messages, { kind: "enter", messages });
  assert.equal(result.kind, "enter");
  assert.ok(result.messages.length >= 1);
  cleanup(temp);
});

test("plugin status diagnostics include cwd switching and settings visibility", async () => {
  const { temp, config, project } = pluginFixture();
  const fake = fakeCtx();
  apply(fake.ctx, config);
  const agent = fakeAgent(project);
  const tool = fake.tool("claude_code_memory");
  const status = await tool.execute({ action: "status" }, execFor(agent));
  assert.match(status.text, /Project root:/);
  assert.match(status.text, /Config home:/);
  assert.match(status.text, /Flag settings: not visible/);
  const location = resolveMemoryLocation({ cwd: project, config });
  assert.equal(location.ok, true);
  cleanup(temp);
});

test("effective working directory scopes recall and resumed index markers after a project switch", async (t) => {
  const { temp, configDir, config, project } = pluginFixture();
  t.after(() => cleanup(temp));
  const otherProject = join(temp, "other-project");
  ensureDir(otherProject);
  const otherMemoryDir = memoryPath(configDir, otherProject, {
    "MEMORY.md": "# Other Index\n- [Other](other.md) — other project topic\n",
    "other.md": "OTHER PROJECT BODY\n",
  });
  let effectiveCwd = project;
  const fake = fakeCtx({ workingDirectory: { get: () => effectiveCwd } });
  apply(fake.ctx, config);
  t.after(() => fake.dispose());
  const agent = fakeAgent(project);
  await runFirstStep(fake, agent, "hello");

  effectiveCwd = otherProject;
  const switched = await runFirstStep(fake, agent, "review this project");
  const index = switched.messages.find((message) => message.source?.form === "index");
  assert.ok(index, "an index from the old project must not suppress the current project index");
  assert.equal(index.source.memoryDir, otherMemoryDir);
  assert.match(index.content[0].text, /Other Index/);
  assert.doesNotMatch(index.content[0].text, /build commands and CI notes/);

  const status = await fake
    .tool("claude_code_memory")
    .execute({ action: "status" }, execFor(agent));
  assert.ok(status.text.includes(`Memory directory: ${otherMemoryDir}`));
  const recalled = await runFirstStep(fake, agent, "请加载 memory");
  const full = recalled.messages.find((message) => message.source?.form === "full-recall");
  assert.match(full.content[0].text, /OTHER PROJECT BODY/);
  assert.doesNotMatch(full.content[0].text, /Use make build and GitHub Actions/);

  const resumed = fakeAgent(project);
  resumed.session.appendUserMessage(index);
  const resumedResult = await runFirstStep(fake, resumed, "resume this project");
  assert.equal(
    resumedResult.messages.filter((message) => message.source?.form === "index").length,
    1,
  );
});

test("an unavailable working-directory service falls back to the session header", async (t) => {
  const { temp, config, project, memoryDir } = pluginFixture();
  t.after(() => cleanup(temp));
  const fake = fakeCtx({
    workingDirectory: {
      get() {
        throw new Error("service unavailable");
      },
    },
  });
  apply(fake.ctx, config);
  t.after(() => fake.dispose());
  const status = await fake
    .tool("claude_code_memory")
    .execute({ action: "status" }, execFor(fakeAgent(project)));
  assert.ok(status.text.includes(`Memory directory: ${realpathSync(memoryDir)}`));
});

test("a session without a project never borrows the Host process working directory", async (t) => {
  const { temp, config } = pluginFixture();
  t.after(() => cleanup(temp));
  const fake = fakeCtx();
  apply(fake.ctx, config);
  t.after(() => fake.dispose());
  const agent = fakeAgent(undefined);
  const normal = await runFirstStep(fake, agent, "hello");
  assert.equal(normal.messages.length, 1);
  const status = await fake
    .tool("claude_code_memory")
    .execute({ action: "status" }, execFor(agent));
  assert.match(status.text, /the session has no project directory/);
  const triggered = await runFirstStep(fake, agent, "请加载 memory");
  const notice = triggered.messages.find((message) => message.source?.form === "full-recall");
  assert.ok(notice);
  assert.equal(notice.source.kind, "claude-memory");
  assert.match(notice.content[0].text, /the session has no project directory/);
});
