import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import {
  DEV_PACKAGE,
  STABLE_PACKAGE,
  assertIdle,
  outsideReload,
  switchReader,
  verifyCase,
  withDevelopmentReader,
} from "../scripts/desktop-control.mjs";
import { controlPatch } from "../scripts/desktop.mjs";

function context() {
  const rows = [
    { entryId: "stable", moduleName: STABLE_PACKAGE, enabled: true },
    { entryId: "dev", moduleName: DEV_PACKAGE, enabled: false },
  ];
  const entry = {
    id: "dev",
    options: { name: DEV_PACKAGE, config: { maxBatchChars: 48000, memoryDir: "/original" } },
  };
  const persistedConfig = structuredClone(entry.options.config);
  const changes = [];
  return {
    rows,
    entry,
    changes,
    agents: { list: () => [] },
    loader: {
      entries: () => [entry],
    },
    pluginManager: {
      async listPlugins() {
        return structuredClone(rows);
      },
      async setPluginEnabled(id, enabled) {
        rows.find((row) => row.entryId === id).enabled = enabled;
        changes.push([id, enabled]);
        entry.options.config = structuredClone(persistedConfig);
        assert.ok(rows.filter((row) => row.enabled).length <= 1);
        return { application: "applied" };
      },
    },
  };
}

test("Desktop reader switching disables the old reader before enabling the other", async () => {
  const ctx = context();
  await switchReader(ctx, "dev");
  assert.deepEqual(ctx.changes, [
    ["stable", false],
    ["dev", true],
  ]);
  await switchReader(ctx, "stable");
  assert.deepEqual(ctx.changes.slice(-2), [
    ["dev", false],
    ["stable", true],
  ]);
  await assert.rejects(switchReader(ctx, "unknown"));
  assert.throws(
    () => assertIdle({ agents: { list: () => [{ id: "other", status: "running" }] } }),
    /running conversations/,
  );
});

test("Desktop acceptance restores reader state after failure without changing its configuration", async () => {
  const ctx = context();
  const config = structuredClone(ctx.entry.options.config);
  await assert.rejects(
    withDevelopmentReader(ctx, async () => {
      assert.equal(ctx.rows[1].enabled, true);
      assert.deepEqual(ctx.entry.options.config, config);
      await switchReader(ctx, "off");
      await switchReader(ctx, "dev");
      assert.deepEqual(ctx.entry.options.config, config);
      throw new Error("model failed");
    }),
    /model failed/,
  );
  assert.deepEqual(ctx.entry.options.config, config);
  assert.equal(ctx.rows[0].enabled, true);
  assert.equal(ctx.rows[1].enabled, false);
});

test("a failed Desktop activation restores the previous reader", async () => {
  const ctx = context();
  const change = ctx.pluginManager.setPluginEnabled;
  ctx.pluginManager.setPluginEnabled = async (id, enabled) => {
    if (id === "dev" && enabled) return { application: "failed" };
    return change(id, enabled);
  };
  await assert.rejects(switchReader(ctx, "dev"), /did not apply/);
  assert.equal(ctx.rows[0].enabled, true);
  assert.equal(ctx.rows[1].enabled, false);
});

test("Desktop acceptance requires both a hidden model answer and observed transient context", () => {
  const spec = {
    name: "recall",
    prompt: "Recall the historical phrase",
    probes: ["HIDDEN_PROBE"],
    action: "recall",
  };
  const evidence = {
    sessionId: "test",
    answer: "HIDDEN_PROBE",
    probes: new Set(["HIDDEN_PROBE"]),
    forms: new Set(["recall"]),
    calls: [{ name: "claude_code_memory", action: "recall" }],
    persistedMemory: false,
    receiptLeak: false,
  };
  assert.equal(verifyCase(spec, evidence).passed, true);
  assert.throws(
    () => verifyCase(spec, { ...evidence, answer: "I successfully recalled memory" }),
    /real model/,
  );
  assert.throws(() => verifyCase(spec, { ...evidence, probes: new Set() }), /injected context/);
  assert.throws(() => verifyCase(spec, { ...evidence, receiptLeak: true }), /durable tool result/);
  assert.throws(
    () =>
      verifyCase(
        { ...spec, forbidden: ["OTHER_PROJECT"] },
        { ...evidence, probes: new Set(["HIDDEN_PROBE", "OTHER_PROJECT"]) },
      ),
    /unrelated memory/,
  );
  assert.throws(() => verifyCase({ ...spec, prompt: "HIDDEN_PROBE" }, evidence), /user prompt/);
});

test("Desktop setup only appends or replaces its own profile patch block", () => {
  const original = "# user settings\n- id: existing\n  config:\n    note: keep-me\n";
  const first = controlPatch(
    original,
    "/repo/scripts/desktop-control.mjs",
    "/repo/.agent-tmp/control",
  );
  assert.ok(first.startsWith(original));
  assert.equal(
    controlPatch(first, "/repo/scripts/desktop-control.mjs", "/repo/.agent-tmp/control"),
    first,
  );
  assert.ok(
    controlPatch(first, "/other/control.mjs", "/repo/.agent-tmp/control").startsWith(original),
  );
  assert.throws(
    () =>
      controlPatch(first.replace("# END dsh-claude-memory desktop control", ""), "/new", "/tmp"),
    /Incomplete/,
  );
});

test("Desktop background control leaves the activation transaction before registering callbacks", () => {
  const executing = new AsyncLocalStorage();
  const ctx = { get: () => ({ executing }) };
  executing.run(true, () => {
    outsideReload(ctx, () => assert.equal(executing.getStore(), undefined));
    assert.equal(executing.getStore(), true);
  });
  assert.throws(() => outsideReload({ get: () => ({}) }, () => {}), /Unsupported/);
});
