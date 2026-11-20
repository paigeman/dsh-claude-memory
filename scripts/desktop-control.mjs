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
  unlinkSync,
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
const readerPackages = { stable: STABLE_PACKAGE, dev: DEV_PACKAGE };
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

async function readerState(ctx) {
  const bundles = (await ctx.pluginManager.listBundles())
    .filter((bundle) => [STABLE_PACKAGE, DEV_PACKAGE].includes(bundle.name))
    .map(({ name, enabled, installed, version, source, error }) => ({
      name,
      enabled,
      installed,
      version,
      source,
      error: error?.code,
    }));
  return { bundles, readers: await readers(ctx) };
}

export function readerSelection(state, targets = ["stable", "dev"]) {
  for (const target of targets) {
    const name = readerPackages[target];
    const bundle = state.bundles.find((bundle) => bundle.name === name);
    if (bundle?.enabled && bundle.installed && !bundle.error) {
      return {
        target,
        componentEnabled: state.readers.some((row) => row.moduleName === name && row.enabled),
      };
    }
  }
  return { target: "off" };
}

async function enable(ctx, row, enabled) {
  const result = await ctx.pluginManager.setPluginEnabled(row.entryId, enabled);
  assert.equal(
    result.application,
    "applied",
    `Plugin change did not apply: ${JSON.stringify({ target: row.moduleName, ...result })}`,
  );
}

async function enableBundle(ctx, packageName, enabled) {
  const result = await ctx.pluginManager.setBundleEnabled(packageName, enabled);
  assert.equal(result.application, "applied", `Bundle change did not apply: ${packageName}.`);
}

async function stopReader(ctx, packageName) {
  const before = await readerState(ctx);
  try {
    for (const row of before.readers) {
      if (row.moduleName === packageName && row.enabled) await enable(ctx, row, false);
    }
  } finally {
    if (before.bundles.some((bundle) => bundle.name === packageName && bundle.enabled)) {
      await enableBundle(ctx, packageName, false);
    }
  }
  const after = await readerState(ctx);
  assert.ok(!after.bundles.some((bundle) => bundle.name === packageName && bundle.enabled));
  assert.ok(
    !after.readers.some(
      (row) => row.moduleName === packageName && (row.enabled || row.fiberPhase === "active"),
    ),
    `${packageName} component did not stop.`,
  );
}

async function applyReaderSelection(ctx, { target, componentEnabled = true }) {
  const packageName = target === "off" ? undefined : readerPackages[target];
  const before = await readerState(ctx);
  const wanted = before.bundles.find((bundle) => bundle.name === packageName);
  if (packageName) {
    assert.ok(
      wanted?.installed && !wanted.error,
      `${packageName} is unavailable; check installation and compatibility.`,
    );
  }
  for (const name of [DEV_PACKAGE, STABLE_PACKAGE]) {
    if (name !== packageName) await stopReader(ctx, name);
  }
  if (wanted) {
    if (!wanted.enabled) await enableBundle(ctx, packageName, true);
    const row = (await readers(ctx)).find((row) => row.moduleName === packageName);
    assert.ok(row && !row.readOnlyReason, `${packageName} has no controllable entry.`);
    if (row.enabled !== componentEnabled) await enable(ctx, row, componentEnabled);
  }
  const after = await readerState(ctx);
  const selected = wanted ? [packageName] : [];
  const active = componentEnabled ? selected : [];
  assert.deepEqual(
    after.bundles.filter((row) => row.enabled).map((row) => row.name),
    selected,
  );
  assert.deepEqual(
    after.readers.filter((row) => row.enabled).map((row) => row.moduleName),
    active,
  );
  assert.deepEqual(
    after.readers.filter((row) => row.fiberPhase === "active").map((row) => row.moduleName),
    active,
  );
  return after;
}

export async function switchReader(ctx, target, componentEnabled = true) {
  assert.ok(["dev", "stable", "off"].includes(target), "Use dev, stable or off.");
  const previous = readerSelection(await readerState(ctx));
  try {
    return await applyReaderSelection(ctx, { target, componentEnabled });
  } catch (error) {
    try {
      await applyReaderSelection(ctx, previous);
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
  const previous = readerSelection(await readerState(ctx), ["stable"]);
  let value;
  const errors = [];
  try {
    await applyReaderSelection(ctx, { target: "dev" });
    value = await operation();
  } catch (error) {
    errors.push(error);
  }
  try {
    await stopReader(ctx, DEV_PACKAGE);
    restored(await applyReaderSelection(ctx, previous));
  } catch (error) {
    throw new AggregateError([...errors, error], "Desktop reader restoration failed.", {
      cause: error,
    });
  }
  if (errors.length) throw errors[0];
  return value;
}

export async function disposeTestSession(ctx, { sessionId, project, handle }) {
  assert.equal(handle.agent.id, sessionId, "Test Agent identity changed.");
  const persistence = handle.agent.ctx.get("sessionPersistence") ?? ctx.get("sessionPersistence");
  await handle.dispose();
  assert.equal(ctx.agents.get(sessionId), undefined, "Test Agent did not stop.");
  // DSH exposes the stored artifact through stat(), but has no Session delete API.
  const snapshot = await persistence.stat(sessionId);
  if (snapshot) {
    assert.equal(snapshot.header.id, sessionId, "Stored test session identity changed.");
    assert.equal(snapshot.header.cwd, project, "Stored session belongs to another project.");
    assert.equal(snapshot.location?.kind, "jsonl", "Unsupported test session storage backend.");
    const path = snapshot.location.path;
    assert.ok(lstatSync(path).isFile(), "Test session storage must be a regular file.");
    assert.equal(ctx.agents.get(sessionId), undefined, "Test Agent is active again.");
    unlinkSync(path);
    assert.equal(await persistence.stat(sessionId), undefined, "Test session remains in storage.");
  }
  ctx.emit("api-session/removed", sessionId);
  const { items } = await ctx.sessionController.list({}, AbortSignal.timeout(15000));
  assert.ok(
    !items.some((item) => item.sessionId === sessionId),
    "Test session remains in the DSH conversation list.",
  );
  return { sessionId, deleted: true };
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
  const cleanup = [];
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
    const composer = ctx.sessionController.agents;
    assert.equal(typeof composer?.composeAgent, "function", "Unsupported DSH agent composer.");
    assert.equal(typeof composer.agentOptions, "function", "Unsupported DSH model adapter.");
    const composition = await composer.composeAgent();
    const sessionId = `session-${randomUUID()}`;
    const handle = await ctx.agents.create({
      sessionId,
      meta: {
        cwd: spec.project,
        ...(composition.agentPreset && { agentPreset: composition.agentPreset }),
      },
      agentOptions: composer.agentOptions(),
      setup: composition.setup,
      signal,
    });
    const evidence = {
      sessionId,
      project: spec.project,
      handle,
      answer: "",
      forms: new Set(),
      probes: new Set(),
      calls: [],
      persistedMemory: false,
      receiptLeak: false,
      complete: false,
    };
    sessions.set(sessionId, evidence);
    progress({ phase: spec.name, sessionId });
    handle.agent.ctx.tools.restrict({ allow: ["claude_code_memory"] });
    await ctx.sessionController.rename({
      sessionId,
      title: `Memory E2E: ${spec.name}`,
    });
    await ctx.sessionController.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: spec.prompt }],
        clientTimeZone: "Asia/Shanghai",
      },
      signal,
    );
    for (;;) {
      signal.throwIfAborted();
      const state = await ctx.sessionController.wait(
        { sessionId, timeoutMs: 10000, maxMessages: 10 },
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
        const errors = [];
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
        } catch (error) {
          errors.push(error);
        }
        for (const owned of sessions.values()) {
          try {
            cleanup.push(await disposeTestSession(ctx, owned));
          } catch (error) {
            cleanup.push({ sessionId: owned.sessionId, deleted: false, error: error.message });
            errors.push(error);
          }
        }
        progress({ cleanup, cases });
        if (cleanup.some((session) => !session.deleted)) {
          throw new AggregateError(errors, "Desktop test session cleanup failed.");
        }
        if (errors.length) throw errors[0];
      },
      (state) => progress({ restored: true, ...state }),
    );
    return { runtime, cases, cleanup, restored: true, ...(await readerState(ctx)) };
  } finally {
    stopEvents();
    stopLlm();
  }
}

function reportError(error) {
  return {
    message: error.message,
    stack: error.stack,
    ...(error instanceof AggregateError && { errors: error.errors.map(reportError) }),
  };
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
            value = { runtime: desktopRuntime(), ...(await readerState(ctx)) };
          } else if (request.op === "switch") {
            assertIdle(ctx);
            value = await switchReader(ctx, request.target, request.componentEnabled);
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
            error: reportError(error),
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
