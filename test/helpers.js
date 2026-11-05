import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

export function makeTemp(prefix = "dsh-claude-memory-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function writeFile(path, content) {
  ensureDir(dirname(path));
  writeFileSync(path, content);
  return path;
}

export function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${join(cwd, ".disabled-test-hooks")}`,
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

export function makeGitRepo(root) {
  ensureDir(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  return root;
}

export function makeWorktree(mainRoot, worktreeRoot) {
  git(
    mainRoot,
    "worktree",
    "add",
    "-q",
    "-b",
    `feature-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    worktreeRoot,
  );
  return worktreeRoot;
}

export function memoryPath(configHome, projectRoot, files = {}) {
  let root = projectRoot;
  try {
    root = realpathSync(projectRoot);
  } catch {
    // keep the supplied path when it does not exist yet
  }
  const name = root.replace(/[^a-zA-Z0-9]/g, "-");
  let base = configHome;
  try {
    base = realpathSync(configHome);
  } catch {
    // the projects directory will be created below
  }
  const dir = join(base, "projects", name, "memory");
  ensureDir(dir);
  for (const [rel, content] of Object.entries(files)) {
    writeFile(join(dir, rel), content);
  }
  return dir;
}

export function treeSnapshot(root) {
  const result = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSync(full);
      result.set(relative(root, full), {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        hash: createHash("sha256").update(readFileSync(full)).digest("hex"),
      });
    }
  };
  walk(root);
  return result;
}

export function assertSnapshotsEqual(assert, before, after) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [path, value] of before) {
    assert.deepEqual(after.get(path), value, `memory file changed: ${path}`);
  }
}

export function userMessage(text, id = randomUUID()) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

export function fakeAgent(cwd, { id = randomUUID(), origin, surfaceNodes = [] } = {}) {
  const events = new Map();
  return {
    id,
    session: {
      id,
      header: { cwd, ...(origin ? { origin } : {}) },
      surface: { nodes: surfaceNodes },
      eventAt(seq) {
        return events.get(seq);
      },
      appendUserMessage(message) {
        const seq = events.size + 1;
        events.set(seq, { type: "user/message", seq, data: message });
        this.surface.nodes.push(seq);
        return seq;
      },
    },
  };
}

export function fakeCtx({ workingDirectory } = {}) {
  const handlers = new Map();
  const tools = new Map();
  const logs = [];
  const logger = {
    info: (message) => logs.push(["info", message]),
    warn: (message) => logs.push(["warn", message]),
    debug: (message) => logs.push(["debug", message]),
    error: (message) => logs.push(["error", message]),
  };
  const disposers = [];
  const modelCalls = [];
  const llm = {
    stream(options) {
      const list = [...(handlers.get("llm/stream") ?? [])];
      let index = 0;
      const next = () => {
        if (index < list.length) return list[index++](options, next);
        modelCalls.push(options);
        return (async function* () {
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      };
      return next();
    },
  };
  const ctx = {
    logger: () => logger,
    get: (key) => (key === "workingDirectory" ? workingDirectory : key === "llm" ? llm : undefined),
    llm,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      const dispose = () => {
        const list = handlers.get(event);
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
      disposers.push(dispose);
      return dispose;
    },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  return {
    ctx,
    handlers,
    tools,
    logs,
    modelCalls,
    async modelRequest(agent, messages, { signal = new AbortController().signal } = {}) {
      const list = [...(handlers.get("agent/request") ?? [])];
      let index = 0;
      const config = { provider: "diagnostic", model: "diagnostic" };
      const next = async () =>
        index < list.length ? list[index++]({ agent, signal }, next) : config;
      await next();
      const options = Object.freeze({
        ...config,
        sessionId: agent.session.id,
        signal,
        messages: Object.freeze([...messages]),
      });
      const before = modelCalls.length;
      const chunks = [];
      for await (const chunk of llm.stream(options)) chunks.push(chunk);
      return {
        chunks,
        messages: modelCalls.at(-1).messages,
        dispatches: modelCalls.length - before,
        original: options,
      };
    },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose();
    },
    async preStep(agent, messages, decision = { kind: "enter", messages }) {
      const list = handlers.get("agent/pre-step") ?? [];
      let index = 0;
      const next = async () => decision;
      const run = async () => {
        if (index >= list.length) return next();
        const handler = list[index++];
        return handler(
          { agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
          () => run(),
        );
      };
      return run();
    },
    tool(name) {
      return tools.get(name);
    },
  };
}

export function cleanup(...roots) {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
