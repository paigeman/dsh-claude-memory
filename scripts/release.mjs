import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { valid, prerelease } from "semver";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const registry = "https://registry.npmjs.org";
export const readPackage = () => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
export const digest = (bytes, algorithm, encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);

export function releaseInfo(
  pkg,
  { tag = `v${pkg.version}`, ref = "", dryRun = true, repository } = {},
) {
  if (valid(pkg.version) !== pkg.version || pkg.version.includes("+"))
    throw new Error("Invalid release version.");
  if (pkg.private || pkg.name.startsWith("@local/"))
    throw new Error("Package is still local/private.");
  if (tag !== `v${pkg.version}`) throw new Error("Release tag must exactly match package.json.");
  const url = pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "");
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(url ?? "");
  if (!match || (repository && repository !== match[1]))
    throw new Error("Repository identity mismatch.");
  if (!dryRun && ref !== `refs/tags/${tag}`)
    throw new Error("Publishing requires an existing version tag.");
  return {
    name: pkg.name,
    version: pkg.version,
    tag,
    ref,
    dryRun,
    repository: match[1],
    distTag: prerelease(pkg.version) ? "next" : "latest",
    prerelease: Boolean(prerelease(pkg.version)),
  };
}

export function verifyArtifact(directory, pkg = readPackage()) {
  const metadata = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
  if (metadata.name !== pkg.name || metadata.version !== pkg.version)
    throw new Error("Artifact identity differs from the checked-out package.");
  if (!/^[A-Za-z0-9_.-]+\.tgz$/.test(metadata.filename))
    throw new Error("Invalid artifact filename.");
  const bytes = readFileSync(join(directory, metadata.filename));
  if (
    metadata.sha256 !== digest(bytes, "sha256") ||
    metadata.integrity !== `sha512-${digest(bytes, "sha512", "base64")}`
  )
    throw new Error("Artifact checksum mismatch.");
  const sums = `${metadata.sha256}  ${metadata.filename}\n`;
  if (readFileSync(join(directory, "SHA256SUMS"), "utf8") !== sums)
    throw new Error("SHA256SUMS differs from the verified artifact.");
  return metadata;
}

export function publishedState(status, value, artifact) {
  if (status === 404) return "missing";
  if (status !== 200) throw new Error(`npm registry lookup failed with HTTP ${status}.`);
  if (
    value.name !== artifact.name ||
    value.version !== artifact.version ||
    value.dist?.integrity !== artifact.integrity
  )
    throw new Error("This npm version already exists with different content.");
  return "identical";
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}

async function main() {
  const pkg = readPackage();
  const command = process.argv[2];
  if (command === "plan") {
    const dryRun = process.env.RELEASE_DRY_RUN === "true";
    const ref = process.env.RELEASE_REF ?? "";
    const tag =
      process.env.RELEASE_TAG || (ref.startsWith("refs/tags/") ? ref.slice(10) : `v${pkg.version}`);
    const info = releaseInfo(pkg, { tag, ref, dryRun, repository: process.env.GITHUB_REPOSITORY });
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    if (sha.status !== 0 || !/^[a-f0-9]{40}$/.test(sha.stdout.trim()))
      throw new Error("Cannot resolve source commit.");
    if (process.env.GITHUB_OUTPUT) {
      for (const [key, value] of Object.entries({
        tag: info.tag,
        ref,
        sha: sha.stdout.trim(),
        dry_run: dryRun,
        dist_tag: info.distTag,
        prerelease: info.prerelease,
      }))
        appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  const directory = resolve(process.env.PACKAGE_OUTPUT_DIR ?? join(root, ".agent-tmp/package"));
  const artifact = verifyArtifact(directory, pkg);
  const info = releaseInfo(pkg, {
    tag: process.env.RELEASE_TAG,
    ref: process.env.RELEASE_REF,
    dryRun: command === "dry-run" || command === "verify",
    repository: process.env.GITHUB_REPOSITORY,
  });
  if (command === "verify") return console.log(JSON.stringify(artifact, null, 2));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = [
    "publish",
    join(directory, artifact.filename),
    "--ignore-scripts",
    "--access",
    "public",
    "--registry",
    registry,
    "--tag",
    info.distTag,
  ];
  if (command === "dry-run") return run(npm, [...args, "--dry-run"]);
  if (command !== "publish") throw new Error("Use plan, verify, dry-run, or publish.");
  const response = await fetch(`${registry}/${encodeURIComponent(pkg.name)}/${pkg.version}`, {
    signal: AbortSignal.timeout(30000),
  });
  const value = response.status === 200 ? await response.json() : {};
  if (publishedState(response.status, value, artifact) === "identical") {
    console.log("The identical artifact is already published; skipping npm publish.");
    return;
  }
  run(npm, [...args, "--provenance"]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
