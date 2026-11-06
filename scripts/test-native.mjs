import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, valid } from "semver";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nativePackages = {
  "@deepseek-ai/cordis": "DSH_CORDIS_MODULE",
  "@deepseek-ai/dsh-app-boot": "DSH_APP_BOOT_MODULE",
  "@deepseek-ai/dsh-llm": "DSH_LLM_MODULE",
  "@deepseek-ai/dsh-session-format-v3-to-v4": "DSH_SESSION_FORMAT_MODULE",
  "@deepseek-ai/dsh-tools": "DSH_TOOLS_MODULE",
};

export function nativeRuntimes() {
  const directory = join(root, "test", "runtimes");
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifest = join(directory, entry.name, "package.json");
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      assert.equal(pkg.private, true, "Native test workspaces must remain private.");
      for (const name of Object.keys(nativePackages)) {
        const version = pkg.devDependencies?.[name];
        assert.equal(valid(version), version, `${name} must have an exact test version.`);
        if (name !== "@deepseek-ai/cordis") assert.equal(version, entry.name);
      }
      return { version: entry.name, manifest, dependencies: pkg.devDependencies };
    })
    .sort((a, b) => compare(a.version, b.version));
}

export function nativeModules(runtime) {
  const require = createRequire(runtime.manifest);
  const modules = {};
  for (const [name, variable] of Object.entries(nativePackages)) {
    const entry = process.env[variable] ? resolve(process.env[variable]) : require.resolve(name);
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, runtime.dependencies[name], `${name} resolved to the wrong runtime.`);
    modules[variable] = entry;
  }
  // Each DSH library must resolve the same Cordis as its test context. This
  // catches accidental workspace hoisting across the two incompatible peers.
  for (const entry of Object.values(modules)) {
    assert.equal(createRequire(entry).resolve("@deepseek-ai/cordis"), modules.DSH_CORDIS_MODULE);
  }
  return modules;
}

function main() {
  const runtimes = nativeRuntimes();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.engines.dsh, runtimes.map((runtime) => runtime.version).join(" || "));
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--list") {
    console.log(JSON.stringify(runtimes.map((runtime) => runtime.version)));
    return;
  }
  assert.ok(
    args.length === 0 || (args.length === 2 && args[0] === "--version"),
    "Use test:native [--version <DSH version>] or --list.",
  );
  const version = args[1] ?? process.env.DSH_TEST_VERSION;
  const selected = version ? runtimes.filter((runtime) => runtime.version === version) : runtimes;
  assert.ok(selected.length > 0, `No native test workspace for DSH ${version}.`);
  const tests = readdirSync(join(root, "test"))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join(root, "test", name));
  for (const runtime of selected) {
    console.log(`Native integration: DSH ${runtime.version}`);
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...tests], {
      cwd: root,
      env: { ...process.env, ...nativeModules(runtime), DSH_TEST_VERSION: runtime.version },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    const skipped = result.stdout.match(/^# skipped (\d+)$/m);
    if (!skipped || Number(skipped[1]) !== 0) {
      throw new Error("Each native runtime suite must finish with zero skipped tests.");
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
