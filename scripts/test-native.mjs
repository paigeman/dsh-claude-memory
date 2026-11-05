import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const codec = process.env.DSH_SESSION_FORMAT_MODULE
  ? resolve(process.env.DSH_SESSION_FORMAT_MODULE)
  : require.resolve("@deepseek-ai/dsh-session-format-v3-to-v4");
const tests = readdirSync(join(root, "test"))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(root, "test", name));
const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...tests], {
  cwd: root,
  env: { ...process.env, DSH_SESSION_FORMAT_MODULE: codec },
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const skipped = result.stdout.match(/^# skipped (\d+)$/m);
if (!skipped || Number(skipped[1]) !== 0) {
  throw new Error("The native suite must finish with zero skipped tests.");
}
