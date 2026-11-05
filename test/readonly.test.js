import assert from "node:assert/strict";
import { readFileSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { apply } from "../index.js";
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

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function sourceFiles() {
  const files = [join(packageRoot, "index.js")];
  for (const entry of readdirSync(join(packageRoot, "lib"))) {
    if (entry.endsWith(".js")) files.push(join(packageRoot, "lib", entry));
  }
  return files;
}

test("runtime imports are read-only and there is no subprocess/network/write path", () => {
  const allowedFs = new Set([
    "existsSync",
    "lstatSync",
    "readFileSync",
    "readdirSync",
    "realpathSync",
    "statSync",
  ]);
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    const fsImports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]node:fs['"]/g)];
    assert.equal(fsImports.length <= 1, true, `${file}: unexpected multiple node:fs imports`);
    for (const match of fsImports) {
      for (const raw of match[1].split(",")) {
        const name = raw.trim();
        if (name === "") continue;
        assert.equal(allowedFs.has(name), true, `${file}: non-read-only fs import ${name}`);
      }
    }
    assert.doesNotMatch(source, /from\s*['"]node:fs\/promises['"]/, `${file}: promises fs import`);
    assert.doesNotMatch(
      source,
      /node:(?:child_process|http|https|net|dns|tls|dgram)/,
      `${file}: network/process import`,
    );
    assert.doesNotMatch(
      source,
      /\b(?:spawn|spawnSync|execSync|execFile|fork)\s*\(/,
      `${file}: subprocess call`,
    );
    assert.doesNotMatch(
      source,
      /\b(?:writeFile|appendFile|writeFileSync|appendFileSync|mkdir|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync|chmodSync|chownSync|utimesSync|truncateSync|createWriteStream|writeSync|openSync)\s*\(/,
      `${file}: write API call`,
    );
    assert.doesNotMatch(source, /\b(?:fetch|request)\s*\(/, `${file}: network call`);
  }
});

test("plugin operations create no files anywhere in the fixture tree", async () => {
  const temp = makeTemp();
  const home = join(temp, "home");
  const configDir = join(home, ".claude");
  const project = join(temp, "project");
  ensureDir(project);
  const memoryDir = memoryPath(configDir, project, {
    "MEMORY.md": "# Index\n- [A](a.md) — alpha\n",
    "a.md": "alpha body\n",
  });
  const before = treeSnapshot(temp);
  const fake = fakeCtx();
  apply(fake.ctx, { configDir });
  const agent = fakeAgent(project);
  const messages = [userMessage("普通任务")];
  const first = await fake.preStep(agent, messages, { kind: "enter", messages });
  for (const message of first.messages) agent.session.appendUserMessage(message);
  const tool = fake.tool("claude_code_memory");
  await tool.execute({ action: "status" }, { agent });
  await tool.execute({ action: "overview" }, { agent });
  await tool.execute({ action: "recall", query: "alpha" }, { agent });
  await tool.execute({ action: "load_all" }, { agent });
  const triggeredMessages = [userMessage("请加载 memory")];
  const triggered = await fake.preStep(agent, triggeredMessages, {
    kind: "enter",
    messages: triggeredMessages,
  });
  for (const message of triggered.messages) agent.session.appendUserMessage(message);
  const after = treeSnapshot(temp);
  assertSnapshotsEqual(assert, before, after);
  assert.equal(treeSnapshot(memoryDir).size, 2);
  cleanup(temp);
});

test("escaping symlink topic is rejected even when requested explicitly", () => {
  const temp = makeTemp();
  const home = join(temp, "home");
  const configDir = join(home, ".claude");
  const project = join(temp, "project");
  ensureDir(project);
  const outside = join(temp, "outside.md");
  writeFile(outside, "outside secret");
  const memoryDir = memoryPath(configDir, project, { "MEMORY.md": "# Index\n" });
  symlinkSync(outside, join(memoryDir, "escape.md"));
  const fake = fakeCtx();
  apply(fake.ctx, { configDir });
  const agent = fakeAgent(project);
  const tool = fake.tool("claude_code_memory");
  return tool.execute({ action: "recall", files: ["escape.md"] }, { agent }).then((result) => {
    assert.match(result.text, /Not loaded|outside|not found/i);
    assert.doesNotMatch(result.text, /outside secret/);
    cleanup(temp);
  });
});
