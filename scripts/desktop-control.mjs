import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMemoryLocation } from "../lib/paths.js";

// Development-only Host component. It is deliberately outside package.files.
// Requests travel through an owner-only local directory, not an HTTP listener.
export const name = "claude-memory-desktop-control";
export const inject = ["pluginManager", "sessionController", "agents", "tools", "llm", "loader"];
export const STABLE_PACKAGE = "dsh-claude-memory-reader";
export const DEV_PACKAGE = "dsh-claude-memory-reader-dev";
const root = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const requestIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function artifactDirectory(path) {
  const temporary = join(root, ".agent-tmp");
  assert.ok(
    !existsSync(temporary) || !lstatSync(temporary).isSymbolicLink(),
    "TEMP_ROOT must not be a symlink.",
  );
  mkdirSync(temporary, { recursive: true });
  const directory = resolve(path);
  assert.ok(
    directory.startsWith(`${realpathSync(temporary)}${sep}`),
    "Artifacts must stay in TEMP_ROOT.",
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(directory), directory, "Artifact paths must not contain symlinks.");
  const stat = lstatSync(directory);
  if (process.getuid) assert.equal(stat.uid, process.getuid(), "Artifact owner mismatch.");
  assert.equal(stat.mode & 0o022, 0, "Artifact directory must not be writable by other users.");
  return directory;
}

export function writeJson(path, value) {
  assert.ok(!existsSync(path) || !lstatSync(path).isSymbolicLink(), "Refusing a symlink output.");
  const pending = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(pending, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(pending, path);
}

function desktopRuntime() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(process.argv[1]), "..", "package.json"), "utf8"),
    );
    return { name: pkg.name, version: pkg.version, electron: process.versions.electron };
  } catch {
    return { name: "unknown" };
  }
}

export function assertIdle(ctx, owned = new Set()) {
  const busy = ctx.agents.list().filter((agent) => !owned.has(agent.id) && agent.status !== "idle");
  assert.equal(busy.length, 0, "Desktop has running conversations. Retry after they finish.");
}

export function outsideReload(ctx, operation) {
  const hmr = ctx.get("hmr");
  if (!hmr) return operation();
  // DSH 0.2.2's own config watcher uses this AsyncLocalStorage.exit pattern.
  // Watchers created during plugin activation otherwise retain the transaction
  // marker forever. Native runExclusive still serializes every later mutation.
  assert.equal(typeof hmr.executing?.exit, "function", "Unsupported Desktop HMR context adapter.");
  return hmr.executing.exit(operation);
}

async function readers(ctx) {
  return (await ctx.pluginManager.listPlugins())
    .filter((row) => [STABLE_PACKAGE, DEV_PACKAGE].includes(row.moduleName))
    .map(({ entryId, moduleName, enabled, fiberPhase, patchId, readOnlyReason }) => ({
      entryId,
      moduleName,
      enabled,
      fiberPhase,
      patchId,
      readOnlyReason,
    }));
}

async function enable(ctx, row, enabled) {
  const result = await ctx.pluginManager.setPluginEnabled(row.entryId, enabled);
  assert.equal(
    result.application,
    "applied",
    `Plugin change did not apply: ${JSON.stringify({ target: row.moduleName, ...result })}`,
  );
}

export async function switchReader(ctx, target) {
  assert.ok(["dev", "stable", "off"].includes(target), "Use dev, stable or off.");
  const rows = await readers(ctx);
  const moduleName = target === "dev" ? DEV_PACKAGE : STABLE_PACKAGE;
  const wanted = target === "off" ? undefined : rows.find((row) => row.moduleName === moduleName);
  if (target !== "off") {
    assert.ok(
      wanted,
      `${moduleName} has no controllable entry; check installation and compatibility.`,
    );
    assert.ok(!wanted.readOnlyReason, `Entry is not controllable: ${wanted.readOnlyReason}`);
  }
  try {
    for (const row of rows) {
      if (row.enabled && row.entryId !== wanted?.entryId) await enable(ctx, row, false);
    }
    if (wanted && !wanted.enabled) await enable(ctx, wanted, true);
    const after = await readers(ctx);
    assert.ok(
      after.filter((row) => row.enabled).length <= 1,
      "Two readers must never run together.",
    );
    if (wanted) assert.ok(after.some((row) => row.moduleName === moduleName && row.enabled));
    return after;
  } catch (error) {
    try {
      for (const current of await readers(ctx)) {
        if (
          current.enabled &&
          !rows.some((row) => row.moduleName === current.moduleName && row.enabled)
        ) {
          await enable(ctx, current, false);
        }
      }
      for (const previous of rows.filter((row) => row.enabled)) {
        const current = (await readers(ctx)).find((row) => row.moduleName === previous.moduleName);
        if (current && !current.enabled) await enable(ctx, current, true);
      }
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Reader switch and its restoration failed.", {
        cause: restoreError,
      });
    }
    throw error;
  }
}

function readerEntry(ctx) {
  const entry = [...ctx.loader.entries()].find((entry) => entry.options.name === DEV_PACKAGE);
  assert.ok(entry, "Development reader entry is missing.");
  return entry;
}

export async function withDevelopmentReader(ctx, operation, restored = () => {}) {
  assertIdle(ctx);
  const before = await readers(ctx);
  let failed = false;
  let failure;
  let value;
  const restoration = [];
  try {
    await switchReader(ctx, "dev");
    value = await operation();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await switchReader(ctx, "off");
    for (const row of before.filter((row) => row.enabled)) {
      const current = (await readers(ctx)).find((item) => item.moduleName === row.moduleName);
      assert.ok(current, `Cannot restore ${row.moduleName}.`);
      await enable(ctx, current, true);
    }
  } catch (error) {
    restoration.push(error);
  }
  if (restoration.length)
    throw new AggregateError(
      [...(failed ? [failure] : []), ...restoration],
      "Desktop reader restoration failed.",
    );
  restored();
  if (failed) throw failure;
  return value;
}

export function verifyCase(spec, evidence) {
  for (const probe of spec.probes) {
    assert.ok(!spec.prompt.includes(probe), "A probe must never appear in its user prompt.");
    assert.ok(
      evidence.answer.includes(probe),
      `${spec.name}: real model did not return a memory probe.`,
    );
    assert.ok(
      evidence.probes.has(probe),
      `${spec.name}: probe was not observed in injected context.`,
    );
  }
  for (const probe of spec.forbidden ?? []) {
    assert.ok(!evidence.probes.has(probe), `${spec.name}: unrelated memory entered the request.`);
    assert.ok(!evidence.answer.includes(probe), `${spec.name}: model returned unrelated memory.`);
  }
  assert.ok(evidence.forms.size > 0, `${spec.name}: no transient memory reached the LLM.`);
  assert.equal(evidence.persistedMemory, false, "Memory context entered durable user messages.");
  assert.equal(evidence.receiptLeak, false, "Memory body entered a durable tool result.");
  assert.ok(evidence.calls.every((call) => call.name === "claude_code_memory"));
  if (spec.action) {
    assert.ok(
      evidence.calls.some((call) => call.action === spec.action),
      `${spec.name}: missing tool action.`,
    );
  } else {
    assert.equal(evidence.calls.length, 0, "Automatic index must work without tool calls.");
    assert.deepEqual(
      [...evidence.forms],
      ["index"],
      "Automatic indexing must not load topic bodies.",
    );
  }
  if (spec.action === "load_all") assert.ok(evidence.complete, "Full-load receipt is incomplete.");
  return {
    name: spec.name,
    sessionId: evidence.sessionId,
    passed: true,
    forms: [...evidence.forms],
    actions: evidence.calls.map((call) => call.action),
    probesVerified: spec.probes.length,
  };
}

function fixture(directory, label) {
  const project = join(directory, label);
  mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "--quiet", project], { stdio: "pipe" });
  const memoryDir = join(directory, "memories", label);
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(join(project, ".claude"));
  writeJson(join(project, ".claude", "settings.local.json"), {
    autoMemoryDirectory: memoryDir,
    autoMemoryEnabled: true,
  });
  const probes = { index: randomUUID(), release: randomUUID(), extra: randomUUID() };
  writeFileSync(
    join(memoryDir, "MEMORY.md"),
    `# Synthetic acceptance memory\nindex_probe: ${probes.index}\n- [Release](release.md): release_probe, the project's release verification phrase.\n- [Extra](extra.md): extra_probe, an additional historical value.\n`,
  );
  writeFileSync(join(memoryDir, "release.md"), `release_probe: ${probes.release}\n`);
  writeFileSync(join(memoryDir, "extra.md"), `extra_probe: ${probes.extra}\n`);
  return { project, memoryDir, probes };
}

async function realModelAcceptance(ctx, directory, signal, progress) {
  const runtime = desktopRuntime();
  assert.equal(
    runtime.name,
    "@deepseek-ai/dsh-desktop-host",
    "This test requires the actual Desktop Host.",
  );
  assert.ok(runtime.electron, "Desktop's Electron Node runtime is required.");
  const first = fixture(directory, "project-a");
  const second = fixture(directory, "project-b");
  const sessions = new Map();
  const allProbes = new Set([...Object.values(first.probes), ...Object.values(second.probes)]);
  const cases = [];
  const stopEvents = ctx.on("session/event", (session, event) => {
    const evidence = sessions.get(session.id);
    if (!evidence) return;
    if (event.type === "assistant/message") {
      evidence.answer += (event.data.message?.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    } else if (event.type === "tool/call") {
      let args = {};
      try {
        args = JSON.parse(event.data.arguments);
      } catch {
        /* Invalid args fail the action check. */
      }
      evidence.calls.push({ name: event.data.name, action: args.action });
    } else if (event.type === "tool/result") {
      const text = JSON.stringify(event.data);
      evidence.receiptLeak ||= [...allProbes].some((probe) => text.includes(probe));
      evidence.complete ||= /Complete:\s*yes/.test(text);
    } else if (event.type === "user/message" && event.data.source?.kind === "claude-memory") {
      evidence.persistedMemory = true;
    }
  });
  const stopLlm = ctx.on("llm/stream", (options, next) => {
    const evidence = sessions.get(options.sessionId);
    if (evidence) {
      for (const message of options.messages ?? []) {
        if (message.source?.kind !== "claude-memory") continue;
        evidence.forms.add(message.source.form);
        const text = (message.content ?? []).map((part) => part.text ?? "").join("\n");
        for (const probe of allProbes) if (text.includes(probe)) evidence.probes.add(probe);
      }
    }
    return next();
  });
  const run = async (spec) => {
    signal.throwIfAborted();
    assertIdle(ctx, new Set(sessions.keys()));
    const created = await ctx.sessionController.create({
      cwd: spec.project,
      sessionId: `session-${randomUUID()}`,
    });
    const evidence = {
      sessionId: created.sessionId,
      answer: "",
      forms: new Set(),
      probes: new Set(),
      calls: [],
      persistedMemory: false,
      receiptLeak: false,
      complete: false,
    };
    sessions.set(created.sessionId, evidence);
    const agent = ctx.agents.get(created.sessionId);
    assert.ok(agent, "Desktop did not create the test Agent.");
    agent.ctx.tools.restrict({ allow: ["claude_code_memory"] });
    await ctx.sessionController.rename({
      sessionId: created.sessionId,
      title: `Memory E2E: ${spec.name}`,
    });
    const requestId = randomUUID();
    progress({ phase: spec.name, sessionId: created.sessionId });
    await ctx.sessionController.prompt(
      {
        requestId,
        sessionId: created.sessionId,
        mode: "queue",
        content: [{ type: "text", text: spec.prompt }],
        clientTimeZone: "Asia/Shanghai",
      },
      signal,
    );
    for (;;) {
      signal.throwIfAborted();
      const state = await ctx.sessionController.wait(
        { sessionId: created.sessionId, timeoutMs: 10000, maxMessages: 10 },
        signal,
      );
      assert.notEqual(
        state.reason,
        "input-required",
        "Desktop requested manual input during acceptance.",
      );
      if (state.reason === "idle") break;
    }
    let result;
    try {
      result = verifyCase(spec, evidence);
    } catch (error) {
      progress({
        diagnostic: { answer: evidence.answer, forms: [...evidence.forms], calls: evidence.calls },
        cases: [...cases],
      });
      throw error;
    }
    cases.push(result);
    progress({ phase: spec.name, cases: [...cases] });
  };
  try {
    await withDevelopmentReader(
      ctx,
      async () => {
        try {
          for (const project of [first, second]) {
            const location = resolveMemoryLocation({
              cwd: project.project,
              config: readerEntry(ctx).options.config,
            });
            assert.equal(
              location.memoryDir,
              project.memoryDir,
              "A reader or global path override prevents synthetic project isolation.",
            );
          }
          await run({
            name: "automatic index",
            project: first.project,
            probes: [first.probes.index],
            forbidden: [first.probes.release, first.probes.extra, ...Object.values(second.probes)],
            prompt:
              "自动验收：仅依据已经注入的项目记忆索引回答 index_probe 的值。只输出值，不调用任何工具；未看见就回答 MISSING。",
          });
          await run({
            name: "focused recall",
            project: first.project,
            probes: [first.probes.release],
            forbidden: [first.probes.extra, ...Object.values(second.probes)],
            action: "recall",
            prompt:
              "自动验收：请调用 claude_code_memory 的 recall 动作召回项目的发布校验短语 release_probe。只输出该值，不使用其他工具。",
          });
          await run({
            name: "full recall",
            project: first.project,
            probes: Object.values(first.probes),
            forbidden: Object.values(second.probes),
            action: "load_all",
            prompt:
              "请加载 memory，然后调用 claude_code_memory 的 load_all 动作确认完整加载。最后只输出 index_probe、release_probe、extra_probe 三个值，不使用其他工具。",
          });
          assertIdle(ctx, new Set(sessions.keys()));
          await switchReader(ctx, "off");
          await switchReader(ctx, "dev");
          await run({
            name: "recall after reload",
            project: first.project,
            probes: [first.probes.release],
            forbidden: [first.probes.extra, ...Object.values(second.probes)],
            action: "recall",
            prompt:
              "自动验收：插件已经重载，请调用 claude_code_memory 的 recall 动作读取当前项目的 release_probe，只输出该值。",
          });
          await run({
            name: "project isolation",
            project: second.project,
            probes: [second.probes.index, second.probes.release],
            forbidden: [...Object.values(first.probes), second.probes.extra],
            action: "recall",
            prompt:
              "自动验收：请调用 claude_code_memory 的 recall 动作读取当前项目的 release_probe，然后仅输出当前项目的 index_probe 与 release_probe。",
          });
        } finally {
          // Drain our own turns before changing shared plugin state or config.
          for (const sessionId of sessions.keys()) {
            const agent = ctx.agents.get(sessionId);
            if (agent?.status !== "idle") {
              agent?.cancel({ kind: "user" });
              const state = await ctx.sessionController.wait(
                { sessionId, timeoutMs: 10000 },
                AbortSignal.timeout(15000),
              );
              assert.equal(state.reason, "idle", "A test turn did not stop after cancellation.");
            }
          }
        }
      },
      () => progress({ restored: true }),
    );
    return { runtime, cases, restored: true };
  } finally {
    stopEvents();
    stopLlm();
    for (const sessionId of sessions.keys()) {
      const agent = ctx.agents.get(sessionId);
      if (agent?.status !== "idle") agent?.cancel({ kind: "user" });
    }
  }
}

export function apply(ctx, config) {
  const directory = artifactDirectory(config.directory);
  const requests = join(directory, "requests");
  const reports = join(directory, "reports");
  mkdirSync(requests, { recursive: true, mode: 0o700 });
  mkdirSync(reports, { recursive: true, mode: 0o700 });
  const lifetime = new AbortController();
  let busy = false;
  let pending = false;
  const scan = async () => {
    if (lifetime.signal.aborted) return;
    if (busy) {
      pending = true;
      return;
    }
    busy = true;
    try {
      for (const file of readdirSync(requests).sort()) {
        const id = file.replace(/\.json$/, "");
        if (!requestIdPattern.test(id) || file !== `${id}.json`) continue;
        const output = join(reports, file);
        if (existsSync(output)) continue;
        const input = join(requests, file);
        const stat = lstatSync(input);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) continue;
        if (process.getuid && stat.uid !== process.getuid()) continue;
        const request = JSON.parse(readFileSync(input, "utf8"));
        assert.equal(request.id, id);
        const initial = {
          id,
          op: request.op,
          status: "running",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        };
        writeJson(output, initial);
        try {
          const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(240000)]);
          let value;
          if (request.op === "status") {
            value = { runtime: desktopRuntime(), readers: await readers(ctx) };
          } else if (request.op === "switch") {
            assertIdle(ctx);
            value = { readers: await switchReader(ctx, request.target) };
          } else if (request.op === "e2e") {
            const runDirectory = artifactDirectory(join(directory, "runs", id));
            value = await realModelAcceptance(ctx, runDirectory, signal, (progress) =>
              writeJson(output, { ...JSON.parse(readFileSync(output, "utf8")), ...progress }),
            );
          } else {
            throw new Error("Unknown Desktop control operation.");
          }
          writeJson(output, {
            ...initial,
            status: "passed",
            finishedAt: new Date().toISOString(),
            value,
          });
        } catch (error) {
          writeJson(output, {
            ...JSON.parse(readFileSync(output, "utf8")),
            status: "failed",
            finishedAt: new Date().toISOString(),
            error: { message: error.message, stack: error.stack },
          });
        }
      }
    } finally {
      busy = false;
      if (pending) {
        pending = false;
        void scan().catch((error) => ctx.logger(name).warn(error.message));
      }
    }
  };
  outsideReload(ctx, () => {
    const watcher = watch(
      requests,
      () => void scan().catch((error) => ctx.logger(name).warn(error.message)),
    );
    ctx.effect(() => () => {
      lifetime.abort();
      watcher.close();
    });
    writeJson(join(directory, "ready.json"), {
      pid: process.pid,
      runtime: desktopRuntime(),
      startedAt: new Date().toISOString(),
      hmr: Boolean(ctx.get("hmr")),
      revision: new URL(import.meta.url).searchParams.get("revision"),
    });
    void scan().catch((error) => ctx.logger(name).warn(error.message));
  });
}
