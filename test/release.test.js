import assert from "node:assert/strict";
import { test } from "node:test";
import { digest, publishedState, releaseInfo, verifyArtifact } from "../scripts/release.mjs";
import { cleanup, makeTemp, writeFile } from "./helpers.js";
import { join } from "node:path";

const pkg = {
  name: "dsh-example",
  version: "0.1.3",
  repository: { url: "git+https://github.com/example/dsh-example.git" },
};

test("publishing requires matching immutable tag and repository identities", () => {
  const input = {
    tag: "v0.1.3",
    ref: "refs/tags/v0.1.3",
    dryRun: false,
    repository: "example/dsh-example",
  };
  assert.equal(releaseInfo(pkg, input).distTag, "latest");
  assert.throws(() => releaseInfo(pkg, { ...input, tag: "v0.1.4" }), /tag/);
  assert.throws(
    () => releaseInfo(pkg, { ...input, ref: "refs/heads/main" }),
    /existing version tag/,
  );
  assert.throws(() => releaseInfo(pkg, { ...input, repository: "other/project" }), /identity/);
  assert.throws(() => releaseInfo({ ...pkg, private: true }, input), /local\/private/);
});

test("prereleases use next while branch dry runs cannot authorize publication", () => {
  assert.equal(releaseInfo({ ...pkg, version: "0.2.0-rc.1" }).distTag, "next");
  assert.equal(releaseInfo(pkg, { ref: "refs/heads/main", dryRun: true }).dryRun, true);
  assert.throws(() => releaseInfo({ ...pkg, version: "0.1.3+build" }), /version/);
  assert.throws(() => releaseInfo({ ...pkg, version: "v0.1.3" }), /version/);
});

test("registry errors and conflicting published versions fail instead of publishing again", () => {
  const artifact = { name: pkg.name, version: pkg.version, integrity: "sha512-fixture" };
  assert.equal(publishedState(404, {}, artifact), "missing");
  assert.equal(
    publishedState(200, { ...pkg, dist: { integrity: artifact.integrity } }, artifact),
    "identical",
  );
  assert.throws(() => publishedState(503, {}, artifact), /503/);
  assert.throws(
    () => publishedState(200, { ...pkg, dist: { integrity: "other" } }, artifact),
    /different content/,
  );
});

test("downloaded release artifacts reject identity and checksum mismatches", (t) => {
  const directory = makeTemp("dsh-release-");
  t.after(() => cleanup(directory));
  const bytes = Buffer.from("synthetic archive bytes");
  const filename = "dsh-example-0.1.3.tgz";
  const record = {
    name: pkg.name,
    version: pkg.version,
    filename,
    sha256: digest(bytes, "sha256"),
    integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
  };
  writeFile(join(directory, filename), bytes);
  writeFile(join(directory, "release.json"), JSON.stringify(record));
  writeFile(join(directory, "SHA256SUMS"), `${record.sha256}  ${filename}\n`);
  assert.equal(verifyArtifact(directory, pkg).filename, filename);
  assert.throws(() => verifyArtifact(directory, { ...pkg, version: "9.9.9" }), /identity/);
  writeFile(join(directory, filename), "tampered");
  assert.throws(() => verifyArtifact(directory, pkg), /checksum/);
});
