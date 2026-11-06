import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { satisfies } from "semver";
import { nativeRuntimes } from "../scripts/test-native.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const unverifiedVersions = [
  "0.2.0",
  "0.2.1-rc.4",
  "0.2.1-rc.6",
  "0.2.1",
  "0.2.2-rc.0",
  "0.2.2-rc.2",
  "0.2.2",
  "0.2.3-rc.1",
  "0.3.0",
];

test("DSH engine requirements match the tested runtime matrix and exclude unverified releases", () => {
  const versions = nativeRuntimes().map((runtime) => runtime.version);
  assert.ok(versions.length > 0);
  assert.equal(pkg.engines.dsh, versions.join(" || "));
  for (const version of versions) {
    assert.equal(satisfies(version, pkg.engines.dsh), true, version);
    assert.equal(satisfies(version, pkg.engines.dsh, { includePrerelease: true }), true, version);
  }
  for (const version of unverifiedVersions) {
    assert.equal(satisfies(version, pkg.engines.dsh, { includePrerelease: true }), false, version);
  }
});

test(
  "native DSH compatibility checks admit the plugin without exemptions and reject untested releases",
  { skip: process.env.DSH_APP_BOOT_MODULE ? false : "Requires the native DSH compatibility gate" },
  async () => {
    const { evaluatePluginCompatibility } = await import(
      pathToFileURL(process.env.DSH_APP_BOOT_MODULE).href
    );
    // Omitting the version exercises app-boot's actual installed runtime version.
    assert.equal(evaluatePluginCompatibility(pkg), undefined);
    for (const runtime of nativeRuntimes()) {
      assert.equal(evaluatePluginCompatibility(pkg, {}, runtime.version), undefined);
    }
    for (const version of unverifiedVersions) {
      const issue = evaluatePluginCompatibility(pkg, {}, version);
      assert.deepEqual(issue.requirements, { "engines.dsh": pkg.engines.dsh });
      assert.equal(issue.exempted, false);
    }
    const previous = { ...pkg, version: "0.1.4", engines: { ...pkg.engines, dsh: "0.2.1-rc.5" } };
    assert.equal(evaluatePluginCompatibility(previous, {}, "0.2.1-rc.5"), undefined);
    assert.equal(evaluatePluginCompatibility(previous, {}, "0.2.2-rc.1").exempted, false);
  },
);
