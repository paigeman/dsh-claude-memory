import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEV_PACKAGE,
  STABLE_PACKAGE,
  assertIdle,
  disposeTestSession,
  outsideReload,
  switchReader,
  verifyCase,
  withDevelopmentReader,
} from "../scripts/desktop-control.mjs";
import { controlPatch } from "../scripts/desktop.mjs";
import { cleanup, makeTemp, writeFile } from "./helpers.js";

function context() {
  const rows = [
    { entryId: "stable", moduleName: STABLE_PACKAGE, enabled: true },
    { entryId: "dev", moduleName: DEV_PACKAGE, enabled: false },
  ];
  const bundles = [
    { name: STABLE_PACKAGE, enabled: true, installed: true },
    { name: DEV_PACKAGE, enabled: false, installed: true },
  ];
  const entry = {
    id: "dev",
    options: { name: DEV_PACKAGE, config: { maxBatchChars: 48000, memoryDir: "/original" } },
  };
  const persistedConfig = structuredClone(entry.options.config);
  const changes = [];
  return {
    rows,
    bundles,
    entry,
    changes,
    agents: { list: () => [] },
    loader: {
      entries: () => [entry],
    },
    pluginManager: {
      async listBundles() {
        return structuredClone(bundles);
      },
      async listPlugins() {
        return rows
          .filter((row) =>
            bundles.some(
              (bundle) => bundle.name === row.moduleName && bundle.enabled && !bundle.error,
            ),
          )
          .map((row) => ({ ...row, fiberPhase: row.enabled ? "active" : "disabled" }));
      },
      async setBundleEnabled(name, enabled) {
        bundles.find((bundle) => bundle.name === name).enabled = enabled;
        changes.push([`bundle:${name}`, enabled]);
        if (enabled) assert.equal(bundles.filter((bundle) => bundle.enabled).length, 1);
        return { application: "applied" };
      },
      async setPluginEnabled(id, enabled) {
        rows.find((row) => row.entryId === id).enabled = enabled;
        changes.push([id, enabled]);
        entry.options.config = structuredClone(persistedConfig);
        assert.ok((await this.listPlugins()).filter((row) => row.enabled).length <= 1);
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
    [`bundle:${STABLE_PACKAGE}`, false],
    [`bundle:${DEV_PACKAGE}`, true],
    ["dev", true],
  ]);
  await switchReader(ctx, "stable");
  assert.deepEqual(ctx.changes.slice(-4), [
    ["dev", false],
    [`bundle:${DEV_PACKAGE}`, false],
    [`bundle:${STABLE_PACKAGE}`, true],
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
  assert.deepEqual(
    ctx.bundles.map((bundle) => bundle.enabled),
    [true, false],
  );
});

test("Desktop acceptance leaves development off and clears an incompatible stable selection", async () => {
  const ctx = context();
  ctx.bundles[0].error = { code: "incompatible-version" };
  ctx.bundles[1].enabled = true;
  ctx.rows[1].enabled = true;
  let final;
  await withDevelopmentReader(
    ctx,
    async () => {
      assert.deepEqual(
        ctx.bundles.map((bundle) => bundle.enabled),
        [false, true],
      );
    },
    (state) => (final = state),
  );
  assert.deepEqual(
    final.bundles.map((bundle) => bundle.enabled),
    [false, false],
  );
  assert.deepEqual(final.readers, []);
  assert.equal(ctx.rows[1].enabled, false);
});

test("a failed Desktop activation restores the previous reader", async () => {
  const ctx = context();
  const change = ctx.pluginManager.setPluginEnabled.bind(ctx.pluginManager);
  ctx.pluginManager.setPluginEnabled = async (id, enabled) => {
    if (id === "dev" && enabled) return { application: "failed" };
    return change(id, enabled);
  };
  await assert.rejects(switchReader(ctx, "dev"), /did not apply/);
  assert.equal(ctx.rows[0].enabled, true);
  assert.equal(ctx.rows[1].enabled, false);
  assert.deepEqual(
    ctx.bundles.map((bundle) => bundle.enabled),
    [true, false],
  );
});

test("Desktop session cleanup drains the owned Agent and deletes only its verified log", async (t) => {
  const project = makeTemp();
  t.after(() => cleanup(project));
  const sessionId = "owned";
  const path = writeFile(join(project, "owned.jsonl"), "test session");
  const otherPath = writeFile(join(project, "other.jsonl"), "a different session");
  const notices = [];
  let active = true;
  const persistence = {
    async stat(id) {
      assert.equal(active, false);
      assert.equal(id, sessionId);
      if (existsSync(path))
        return { header: { id, cwd: project }, location: { kind: "jsonl", path } };
    },
  };
  const agent = { id: sessionId, ctx: { get: () => persistence } };
  const ctx = {
    agents: { get: () => (active ? agent : undefined) },
    emit: (...args) => notices.push(args),
    sessionController: {
      async list() {
        return { items: [{ sessionId: "other" }] };
      },
    },
  };
  const handle = {
    agent,
    dispose: async () => {
      active = false;
    },
  };
  await assert.rejects(
    disposeTestSession(ctx, { sessionId, project: join(project, "different"), handle }),
    /belongs to another project/,
  );
  assert.equal(existsSync(path), true);
  assert.deepEqual(notices, []);
  active = true;
  assert.deepEqual(await disposeTestSession(ctx, { sessionId, project, handle }), {
    sessionId,
    deleted: true,
  });
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(otherPath), true);
  assert.deepEqual(notices, [["api-session/removed", sessionId]]);
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
