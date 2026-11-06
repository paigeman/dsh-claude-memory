import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { artifactDirectory, DEV_PACKAGE, writeJson } from "./desktop-control.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = join(root, ".agent-tmp", "desktop-control");
const begin = "# BEGIN dsh-claude-memory desktop control";
const end = "# END dsh-claude-memory desktop control";
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function profileDirectory() {
  return join(resolve(process.env.DSH_HOME || join(homedir(), ".dsh")), "profiles", "desktop");
}

function runtimeFiles() {
  return [
    "index.js",
    ...readdirSync(join(root, "lib"))
      .filter((file) => file.endsWith(".js"))
      .map((file) => `lib/${file}`),
  ];
}

function candidateCurrent() {
  try {
    const candidate = JSON.parse(readFileSync(join(directory, "candidate.json"), "utf8"));
    const installed = join(profileDirectory(), "node_modules", DEV_PACKAGE);
    const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    return (
      pkg.version === candidate.version &&
      candidate.baseVersion === current.version &&
      JSON.stringify(pkg.engines) === JSON.stringify(current.engines) &&
      readFileSync(join(installed, "cordis.patch.yml"), "utf8") ===
        readFileSync(join(root, "cordis.patch.yml"), "utf8")
          .replace("id: claude-memory\n", "id: claude-memory-dev\n      disabled: true\n")
          .replace('name: "dsh-claude-memory-reader"', `name: "${DEV_PACKAGE}"`) &&
      runtimeFiles().every((file) => hash(join(installed, file)) === hash(join(root, file)))
    );
  } catch {
    return false;
  }
}

function readyCurrent(revision = hash(join(root, "scripts", "desktop-control.mjs"))) {
  try {
    const ready = JSON.parse(readFileSync(join(directory, "ready.json"), "utf8"));
    process.kill(ready.pid, 0);
    return ready.revision === revision;
  } catch {
    return false;
  }
}

export function controlPatch(previous, component, controlDirectory) {
  assert.equal(
    previous.split(begin).length,
    previous.split(end).length,
    "Incomplete owned control block.",
  );
  assert.ok(previous.split(begin).length <= 2, "Duplicate owned control blocks.");
  const block = `${begin}\n- insert:\n    - id: claude-memory-desktop-control\n      name: ${JSON.stringify(component)}\n      config:\n        directory: ${JSON.stringify(controlDirectory)}\n${end}`;
  if (!previous.includes(begin))
    return `${previous}${previous.endsWith("\n") ? "" : "\n"}${block}\n`;
  const start = previous.indexOf(begin);
  const finish = previous.indexOf(end, start) + end.length;
  assert.ok(finish > start);
  return previous.slice(0, start) + block + previous.slice(finish);
}

function prepare() {
  artifactDirectory(directory);
  const build = artifactDirectory(join(directory, "builds", randomUUID()));
  const source = join(build, "package");
  mkdirSync(source, { mode: 0o700 });
  for (const file of [
    "index.js",
    "lib",
    "locale",
    "icon.svg",
    "README.md",
    "README.zh-CN.md",
    "LICENSE",
  ]) {
    cpSync(join(root, file), join(source, file), { recursive: true });
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const baseVersion = pkg.version;
  pkg.name = DEV_PACKAGE;
  pkg.version = `${baseVersion}-dev.${Date.now()}`;
  pkg.private = true;
  for (const key of ["scripts", "devDependencies", "workspaces", "publishConfig"]) delete pkg[key];
  writeJson(join(source, "package.json"), pkg);
  const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
  assert.equal((patch.match(/id: claude-memory\b/g) ?? []).length, 1);
  writeFileSync(
    join(source, "cordis.patch.yml"),
    patch
      .replace("id: claude-memory\n", "id: claude-memory-dev\n      disabled: true\n")
      .replace('name: "dsh-claude-memory-reader"', `name: "${DEV_PACKAGE}"`),
  );
  for (const locale of ["en", "zh"]) {
    const path = join(source, "locale", `${locale}.json`);
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.meta.title += " [DEV]";
    writeJson(path, value);
  }
  assert.ok(process.env.npm_execpath, "Run with npm run desktop -- prepare or install.");
  const packed = spawnSync(
    process.execPath,
    [process.env.npm_execpath, "pack", "--json", "--ignore-scripts", "--pack-destination", build],
    { cwd: source, encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const metadata = JSON.parse(packed.stdout)[0];
  const artifact = join(build, metadata.filename);
  const result = {
    name: pkg.name,
    version: pkg.version,
    baseVersion,
    artifact,
    sha256: hash(artifact),
    runtime: Object.fromEntries(runtimeFiles().map((file) => [file, hash(join(root, file))])),
  };
  writeJson(join(directory, "candidate.json"), result);
  return result;
}

async function request(op, target) {
  artifactDirectory(directory);
  assert.ok(
    existsSync(join(directory, "ready.json")),
    "Install the Desktop development tools first: npm run desktop -- install",
  );
  assert.equal(
    JSON.parse(readFileSync(join(directory, "ready.json"), "utf8")).revision,
    hash(join(root, "scripts", "desktop-control.mjs")),
    "The control component changed; run desktop -- connect.",
  );
  assert.ok(readyCurrent(), "Start DSH Desktop and run desktop -- connect.");
  if (op === "e2e") {
    const candidate = JSON.parse(readFileSync(join(directory, "candidate.json"), "utf8"));
    const installed = join(profileDirectory(), "node_modules", DEV_PACKAGE);
    const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(
      pkg.version,
      candidate.version,
      "The installed candidate is stale; run desktop -- install.",
    );
    for (const file of runtimeFiles()) {
      assert.equal(
        hash(join(installed, file)),
        hash(join(root, file)),
        `${file} changed; install the candidate again.`,
      );
    }
  }
  const id = randomUUID();
  const path = join(directory, "requests", `${id}.json`);
  writeJson(path, { id, op, ...(target ? { target } : {}) });
  const output = join(directory, "reports", `${id}.json`);
  const deadline = Date.now() + (op === "e2e" ? 270000 : 30000);
  let lastPhase;
  while (Date.now() < deadline) {
    if (existsSync(output)) {
      const report = JSON.parse(readFileSync(output, "utf8"));
      if (report.phase && report.phase !== lastPhase) {
        lastPhase = report.phase;
        console.log(`${report.phase}${report.sessionId ? `: ${report.sessionId}` : ""}`);
      }
      if (report.status !== "running") {
        console.log(JSON.stringify({ ...report, report: output }, null, 2));
        assert.equal(report.status, "passed", report.error?.message ?? "Desktop operation failed.");
        return report;
      }
    }
    await setTimeout(500);
  }
  throw new Error(`Desktop operation did not settle. Inspect ${output}; it has not been replayed.`);
}

async function install() {
  const candidate = prepare();
  const cli =
    process.env.DSH_DESKTOP_CLI ??
    (process.platform === "darwin"
      ? "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
      : undefined);
  assert.ok(
    cli && existsSync(cli),
    "Set DSH_DESKTOP_CLI to the Desktop installation's bundled dsh launcher.",
  );
  const installed = spawnSync(
    cli,
    ["plugin", "--profile", "desktop", "add", `file:${candidate.artifact}`, "--ignore-scripts"],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  writeJson(join(directory, "install.json"), {
    candidate,
    exitCode: installed.status,
    stdout: installed.stdout,
    stderr: installed.stderr,
  });
  assert.equal(installed.status, 0, installed.stderr);
  return connect();
}

async function connect() {
  artifactDirectory(directory);
  const profile = profileDirectory();
  const patchPath = join(profile, "cordis.patch.yml");
  assert.ok(!lstatSync(patchPath).isSymbolicLink(), "Refusing a symlink profile patch.");
  const previous = readFileSync(patchPath, "utf8");
  const backups = artifactDirectory(join(directory, "profile-backups"));
  writeFileSync(join(backups, `${randomUUID()}.yml`), previous, { mode: 0o600 });
  const component = join(root, "scripts", "desktop-control.mjs");
  const revision = hash(component);
  const next = controlPatch(
    previous,
    `${pathToFileURL(component).href}?revision=${revision}`,
    directory,
  );
  if (next !== previous) writeFileSync(patchPath, next);
  const deadline = Date.now() + 20000;
  while (!readyCurrent(revision) && Date.now() < deadline) await setTimeout(500);
  assert.ok(
    readyCurrent(revision),
    "Development tools are installed but the Desktop has not loaded the control component. Restart Desktop once, then run desktop -- status.",
  );
  return request("status");
}

async function main() {
  const [command, target] = process.argv.slice(2);
  if (command === "prepare") console.log(JSON.stringify(prepare(), null, 2));
  else if (command === "install") await install();
  else if (command === "connect") await connect();
  else if (command === "status") await request("status");
  else if (command === "use") await request("switch", target);
  else if (command === "test") {
    if (!candidateCurrent()) await install();
    else if (!readyCurrent()) await connect();
    await request("e2e");
  } else
    throw new Error(
      "Use npm run desktop -- prepare | install | connect | status | use dev | use stable | use off | test",
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
