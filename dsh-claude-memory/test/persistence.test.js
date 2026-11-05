import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { apply } from "../index.js";
import {
  cleanup,
  ensureDir,
  fakeAgent,
  fakeCtx,
  makeTemp,
  memoryPath,
  treeSnapshot,
  userMessage,
} from "./helpers.js";

const indexSecret = "INDEX_BODY_ONLY_6f4c2a";
const topicSecret = "TOPIC_BODY_ONLY_742e9d";

function fixture(t) {
  const temp = makeTemp();
  t.after(() => cleanup(temp));
  const project = join(temp, "project");
  const configDir = join(temp, "config");
  ensureDir(project);
  const memoryDir = memoryPath(configDir, project, {
    "MEMORY.md": `${indexSecret}\n- [Build](build.md) — build instructions\n`,
    "build.md": `${topicSecret}\n`,
  });
  return { temp, project, configDir, memoryDir };
}

test("index and all tool actions keep source bodies out of durable inputs and receipts", async (t) => {
  const { project, configDir, memoryDir } = fixture(t);
  const before = treeSnapshot(memoryDir);
  const fake = fakeCtx();
  apply(fake.ctx, { configDir });
  t.after(() => fake.dispose());
  const agent = fakeAgent(project);
  const messages = [userMessage("review this build")];
  const decision = await fake.preStep(agent, messages);
  assert.equal(decision.messages, messages);
  const durable = [...decision.messages];
  const first = await fake.modelRequest(agent, decision.messages);
  assert.equal(first.dispatches, 1);
  assert.deepEqual(first.chunks, [{ type: "finish", reason: { kind: "stop" } }]);
  assert.ok(JSON.stringify(first.messages).includes(indexSecret));
  assert.ok(!JSON.stringify(first.messages).includes(topicSecret));

  for (const args of [
    { action: "status" },
    { action: "overview" },
    { action: "recall", files: ["build.md"] },
    { action: "load_all" },
  ]) {
    const receipt = await fake.tool("claude_code_memory").execute(args, { agent });
    durable.push({
      role: "tool",
      source: { kind: "tool", callId: args.action },
      content: [{ type: "text", text: receipt.text }],
    });
    assert.ok(!receipt.text.includes(indexSecret));
    assert.ok(!receipt.text.includes(topicSecret));
    const request = await fake.modelRequest(agent, durable);
    assert.equal(request.dispatches, 1);
    assert.ok(!JSON.stringify(request.original).includes(indexSecret));
    if (args.action === "status")
      assert.ok(JSON.stringify(request.messages).includes("Project root:"));
    if (["recall", "load_all"].includes(args.action))
      assert.ok(JSON.stringify(request.messages).includes(topicSecret));
  }
  assert.ok(!JSON.stringify(durable).includes(indexSecret));
  assert.ok(!JSON.stringify(durable).includes(topicSecret));
  assert.deepEqual(treeSnapshot(memoryDir), before);
});

test("auxiliary requests, other sessions and disposed plugin instances receive no cached bodies", async (t) => {
  const { project, configDir } = fixture(t);
  const fake = fakeCtx();
  apply(fake.ctx, { configDir });
  const agent = fakeAgent(project);
  await fake.tool("claude_code_memory").execute({ action: "load_all" }, { agent });
  const first = await fake.modelRequest(agent, [userMessage("continue")]);
  assert.ok(JSON.stringify(first.messages).includes(topicSecret));
  const auxiliary = Object.freeze({ ...first.original, messages: [userMessage("auxiliary")] });
  const auxiliaryChunks = [];
  for await (const chunk of fake.ctx.llm.stream(auxiliary)) auxiliaryChunks.push(chunk);
  assert.deepEqual(auxiliaryChunks, [{ type: "finish", reason: { kind: "stop" } }]);
  assert.ok(!JSON.stringify(fake.modelCalls.at(-1)).includes(topicSecret));
  const other = await fake.modelRequest(fakeAgent(project), [userMessage("other session")]);
  assert.ok(!JSON.stringify(other.messages).includes(topicSecret));
  fake.dispose();
  apply(fake.ctx, { configDir });
  t.after(() => fake.dispose());
  const resumed = await fake.modelRequest(agent, [userMessage("resumed")]);
  assert.ok(!JSON.stringify(resumed.messages).includes(topicSecret));
});

test("legacy memory bodies are removed from requests while tool-call/result pairing is retained", async (t) => {
  const { project, configDir } = fixture(t);
  const fake = fakeCtx();
  apply(fake.ctx, { configDir });
  t.after(() => fake.dispose());
  const agent = fakeAgent(project);
  await fake.preStep(agent, [userMessage("hello")]);
  const oldBody = "LEGACY_OTHER_PROJECT_BODY_82c4";
  const messages = [
    {
      role: "user",
      source: { kind: "claude-memory", form: "full-recall" },
      content: [{ type: "text", text: oldBody }],
    },
    {
      role: "assistant",
      source: { kind: "model" },
      content: [{ type: "tool-call", name: "claude_code_memory", id: "old-call", arguments: "{}" }],
    },
    {
      role: "tool",
      source: { kind: "tool", callId: "old-call" },
      toolCallId: "old-call",
      content: [{ type: "text", text: `<<< CLAUDE CODE MEMORY BEGIN ${oldBody}` }],
    },
    userMessage("continue"),
  ];
  const before = JSON.stringify(messages);
  const request = await fake.modelRequest(agent, messages);
  assert.ok(!JSON.stringify(request.messages).includes(oldBody));
  assert.ok(
    request.messages.some(
      (message) => message.role === "tool" && message.toolCallId === "old-call",
    ),
  );
  assert.equal(JSON.stringify(messages), before, "the saved history must not be edited");
});

test(
  "transient redispatch uses the installed Cordis waterfall and native LLM envelope rules",
  {
    skip: process.env.DSH_SESSION_FORMAT_MODULE ? false : "Requires the installed DSH runtime",
  },
  async (t) => {
    const { project, configDir } = fixture(t);
    const modules = resolve(dirname(process.env.DSH_SESSION_FORMAT_MODULE), "../..");
    const { Context } = await import(pathToFileURL(join(modules, "cordis/lib/index.js")).href);
    const { LlmRuntime, markAgentLoopRequest, isAgentLoopRequest } = await import(
      pathToFileURL(join(modules, "dsh-llm/lib/index.js")).href
    );
    const events = new Context();
    const dispatched = [];
    const titleSnapshots = [];
    const llm = Object.create(LlmRuntime.prototype);
    llm.ctx = events;
    llm.adapterStream = (options) =>
      (async function* () {
        dispatched.push(options);
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    const fake = fakeCtx();
    const ctx = { ...fake.ctx, llm, on: events.on.bind(events) };
    apply(ctx, { configDir });
    t.after(() => fake.dispose());
    events.on(
      "llm/stream",
      (options, next) => {
        if (isAgentLoopRequest(options)) titleSnapshots.push(options.messages);
        return next();
      },
      { prepend: true },
    );
    const agent = fakeAgent(project);
    const signal = new AbortController().signal;
    const messages = Object.freeze([userMessage("请加载 memory")]);
    const decision = await events.waterfall(
      "agent/pre-step",
      { agent, messages, signal },
      async () => ({ kind: "enter", messages }),
    );
    const config = { provider: "diagnostic", model: "diagnostic" };
    await events.waterfall("agent/request", { agent, signal }, async () => config);
    const original = markAgentLoopRequest(
      Object.freeze({
        ...config,
        signal,
        sessionId: agent.session.id,
        messages: decision.messages,
        toolHistory: [],
      }),
    );
    const chunks = [];
    for await (const chunk of llm.stream(original)) chunks.push(chunk);
    assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "stop" } }]);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].signal, signal);
    assert.equal(dispatched[0].toolHistory, original.toolHistory);
    assert.ok(JSON.stringify(dispatched[0]).includes(topicSecret));
    assert.equal(titleSnapshots.length, 1);
    assert.ok(!JSON.stringify(titleSnapshots).includes(indexSecret));
    assert.ok(!JSON.stringify(titleSnapshots).includes(topicSecret));
    assert.ok(!JSON.stringify(original).includes(topicSecret));
  },
);
