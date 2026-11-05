import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { fakeAgent, fakeCtx, treeSnapshot, userMessage } from "../test/helpers.js";
import { digest, readPackage, releaseInfo, root } from "./release.mjs";

const pkg = readPackage();
releaseInfo(pkg);
const tempRoot = join(root, ".agent-tmp");
if (existsSync(tempRoot) && lstatSync(tempRoot).isSymbolicLink())
  throw new Error("Unsafe TEMP_ROOT.");
mkdirSync(tempRoot, { recursive: true });
const output = resolve(process.env.PACKAGE_OUTPUT_DIR ?? join(tempRoot, "package"));
mkdirSync(output, { recursive: true });
const outputRelative = relative(realpathSync(tempRoot), realpathSync(output));
if (outputRelative.startsWith(`..${sep}`) || outputRelative === "..")
  throw new Error("Package output must stay inside TEMP_ROOT.");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = JSON.parse(
  execFileSync(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", output], {
    cwd: root,
    encoding: "utf8",
  }),
)[0];
assert.equal(basename(packed.filename), packed.filename);
const files = packed.files.map((file) => file.path);
for (const file of [
  "package.json",
  "index.js",
  "cordis.patch.yml",
  "locale/en.json",
  "locale/zh.json",
  "icon.svg",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
])
  assert.ok(files.includes(file), `Missing package file ${file}`);
for (const file of files)
  assert.match(
    file,
    /^(?:package\.json|index\.js|cordis\.patch\.yml|icon\.svg|LICENSE|README(?:\.zh-CN)?\.md|lib\/[\w/-]+\.js|locale\/[\w-]+\.json)$/,
  );

const archive = join(output, packed.filename);
const temporary = mkdtempSync(join(tempRoot, "package-smoke-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", temporary]);
  const directory = join(temporary, "package");
  const published = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  assert.equal(published.name, pkg.name);
  assert.equal(published.version, pkg.version);
  const patch = readFileSync(join(directory, "cordis.patch.yml"), "utf8");
  assert.ok(patch.includes(pkg.name), "Bundle patch must reference the published package name.");
  const { apply } = await import(pathToFileURL(join(directory, "index.js")).href);
  const project = join(temporary, "project");
  const configDir = join(temporary, "claude");
  const memoryDir = join(configDir, "memory");
  mkdirSync(project, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, "MEMORY.md"), "# Package smoke index\n- [Build](build.md)\n");
  const marker = "PACKED_TOPIC_BODY_184fc9";
  writeFileSync(join(memoryDir, "build.md"), marker);
  const before = treeSnapshot(memoryDir);
  const fake = fakeCtx();
  try {
    apply(fake.ctx, { configDir, memoryDir });
    const agent = fakeAgent(project);
    const messages = [userMessage("请加载 memory，然后评审 design.md")];
    const decision = await fake.preStep(agent, messages);
    assert.equal(decision.messages, messages);
    const model = await fake.modelRequest(agent, decision.messages);
    assert.equal(model.dispatches, 1);
    assert.ok(JSON.stringify(model.messages).includes(marker));
    const receipt = await fake
      .tool("claude_code_memory")
      .execute({ action: "load_all" }, { agent });
    assert.ok(!receipt.text.includes(marker));
    assert.deepEqual(treeSnapshot(memoryDir), before);
  } finally {
    fake.dispose();
  }
} finally {
  if (relative(realpathSync(tempRoot), realpathSync(temporary)).startsWith("..")) {
    console.error("Unsafe smoke cleanup; fixture preserved.");
    process.exitCode = 1;
  } else {
    rmSync(temporary, { recursive: true });
  }
}
const bytes = readFileSync(archive);
const metadata = {
  name: pkg.name,
  version: pkg.version,
  filename: packed.filename,
  sha256: digest(bytes, "sha256"),
  integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
};
writeFileSync(join(output, "SHA256SUMS"), `${metadata.sha256}  ${metadata.filename}\n`);
writeFileSync(join(output, "release.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(
  `Verified ${pkg.name}@${pkg.version}: ${files.length} files; packed recall and read-only smoke passed.`,
);
