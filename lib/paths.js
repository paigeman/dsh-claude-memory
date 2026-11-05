/**
 * Claude Code Auto Memory path resolution.
 *
 * The rules here follow the Claude Code 2.1.x implementation
 * (`src/memdir/paths.ts`, `src/utils/git.ts`,
 * `src/utils/sessionStoragePortable.ts`) rather than a basename guess:
 *
 *   memory dir = <memoryBase>/projects/<sanitizePath(canonicalGitRoot)>/memory
 *
 * where the canonical git root makes every worktree share the main repo's
 * memory, subdirectories map to the repository root, non-git projects map to
 * the project directory itself, and paths are realpath'ed before encoding.
 *
 * Read-only by construction: only lstat/stat/readFile/readdir/realpath.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  absolute,
  expandTilde,
  isEnvDefinedFalsy,
  isEnvTruthy,
  isSubpath,
  nfc,
  parseJsonc,
  pathKey,
  sanitizePath,
  sanitizedPrefix,
  validateMemoryPath,
  validateProjectDirName,
  MAX_SANITIZED_LENGTH,
} from "./util.js";

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const AUTO_MEMORY_DIRNAME = "memory";
const AUTO_MEMORY_ENTRYPOINT = "MEMORY.md";

// Windows native resolution expands 8.3 aliases consistently with Git.
// Keep the same project identity for the main checkout and its worktrees.
function realProjectPath(path) {
  return nfc(process.platform === "win32" ? realpathSync.native(path) : realpathSync(path));
}

/** Read a JSON/JSONC settings file without ever following a write path. */
export function readSettingsFile(filePath) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return { path: filePath, exists: false };
    }
    return { path: filePath, exists: false, error: `cannot stat settings: ${error.message}` };
  }
  if (!stat.isFile()) {
    return { path: filePath, exists: false, error: "settings path is not a regular file" };
  }
  if (stat.size > MAX_SETTINGS_BYTES) {
    return { path: filePath, exists: true, error: "settings file is too large to inspect safely" };
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    return { path: filePath, exists: true, value: parseJsonc(raw), rawBytes: stat.size };
  } catch (error) {
    return { path: filePath, exists: true, error: `cannot parse settings: ${error.message}` };
  }
}

function mergeSettings(base, overlay) {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return base;
  const result = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(overlay)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = mergeSettings(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Claude Code's managed-settings directory for the current platform. */
export function managedSettingsDir(platform = process.platform) {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

/**
 * Load policy settings including `managed-settings.d/*.json` drop-ins.
 * Drop-ins are merged in lexical order on top of the base file, matching
 * Claude Code's managed-settings loader.
 */
function loadPolicySettings(platform, env) {
  const dir = env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
    ? absolute(env.CLAUDE_CODE_MANAGED_SETTINGS_PATH)
    : managedSettingsDir(platform);
  const base = readSettingsFile(join(dir, "managed-settings.json"));
  let value = base.value;
  const parts = [];
  if (base.exists) parts.push({ path: base.path, error: base.error });
  let dropInError;
  try {
    const names = readdirSync(join(dir, "managed-settings.d"))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of names) {
      const part = readSettingsFile(join(dir, "managed-settings.d", name));
      if (part.value) value = mergeSettings(value, part.value);
      if (part.error)
        dropInError = dropInError
          ? `${dropInError}; ${name}: ${part.error}`
          : `${name}: ${part.error}`;
    }
  } catch (error) {
    if (error && error.code !== "ENOENT" && error.code !== "ENOTDIR") {
      dropInError = `cannot read managed-settings.d: ${error.message}`;
    }
  }
  return {
    path: base.path,
    exists: Boolean(base.exists || parts.length > 0 || dropInError),
    value,
    error: base.error ?? dropInError,
    dropIns: parts.length,
  };
}

function coworkUserSettingsFile(env) {
  return isEnvTruthy(env.CLAUDE_CODE_USE_COWORK_PLUGINS) ? "cowork_settings.json" : "settings.json";
}

/** Read every settings source relevant to project identity. */
export function collectSettings({ configHome, cwd, platform, env }) {
  const sources = {};
  sources.userSettings = readSettingsFile(join(configHome, coworkUserSettingsFile(env)));
  sources.localSettings = readSettingsFile(join(cwd, ".claude", "settings.local.json"));
  sources.projectSettings = readSettingsFile(join(cwd, ".claude", "settings.json"));
  sources.policySettings = loadPolicySettings(platform, env);
  // CLI --settings (flagSettings) is process state, not a file this plugin can
  // see. It is deliberately reported as unavailable instead of guessed.
  return sources;
}

function autoMemoryEnabledFromSettings(settings) {
  const order = ["policySettings", "localSettings", "projectSettings", "userSettings"];
  for (const source of order) {
    const value = settings[source]?.value?.autoMemoryEnabled;
    if (typeof value === "boolean") return { enabled: value, source };
  }
  return undefined;
}

/** Return the safe path of the git root containing `start`. */
export function findGitRoot(start) {
  let current = resolve(start);
  for (;;) {
    try {
      lstatSync(join(current, ".git"));
      return nfc(current);
    } catch (error) {
      if (error && error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        // An unreadable .git must not silently fall through to a parent repo.
        return null;
      }
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Resolve a git root to its canonical main-repository root.
 * Worktrees (a `.git` file with `gitdir:` and `commondir`) map back to the
 * main worktree; submodules (no commondir) remain their own repository.
 *
 * The structure validation is copied from Claude Code: a cloned repo must not
 * be able to point `commondir` at an arbitrary trusted location.
 */
export function resolveCanonicalGitRoot(gitRoot) {
  const normalizedRoot = nfc(gitRoot);
  const gitPath = join(gitRoot, ".git");
  let isDirectory;
  try {
    isDirectory = lstatSync(gitPath).isDirectory();
  } catch {
    return { root: normalizedRoot, canonicalized: false };
  }
  if (isDirectory) {
    try {
      return { root: realProjectPath(gitRoot), canonicalized: false };
    } catch {
      return { root: normalizedRoot, canonicalized: false };
    }
  }

  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (!content.startsWith("gitdir:")) {
      return { root: normalizedRoot, canonicalized: false };
    }
    const worktreeGitDir = resolve(gitRoot, content.slice("gitdir:".length).trim());
    let commonDir;
    try {
      commonDir = resolve(
        worktreeGitDir,
        readFileSync(join(worktreeGitDir, "commondir"), "utf8").trim(),
      );
    } catch {
      // Submodules have a .git file but no commondir; they are separate repos.
      return { root: normalizedRoot, canonicalized: false };
    }

    if (pathKey(resolve(dirname(worktreeGitDir))) !== pathKey(join(commonDir, "worktrees"))) {
      return {
        root: normalizedRoot,
        canonicalized: false,
        warning:
          "worktree .git does not point at a valid worktrees/<name> directory; using the worktree path",
      };
    }
    {
      const backlinkRaw = readFileSync(join(worktreeGitDir, "gitdir"), "utf8").trim();
      // Git for Windows can expand an 8.3 alias in its backlink.
      // Compare native real paths on both sides before accepting ownership.
      const backlink = realpathSync.native(backlinkRaw);
      const expected = realpathSync.native(gitPath);
      if (pathKey(backlink) !== pathKey(expected)) {
        return {
          root: normalizedRoot,
          canonicalized: false,
          warning: "worktree .git backlink mismatch; using the worktree path",
        };
      }
    }

    if (basename(commonDir) !== ".git") {
      // Bare-repository worktree: the common dir is the stable identity.
      return { root: realProjectPath(commonDir), canonicalized: true };
    }
    const mainRoot = dirname(commonDir);
    try {
      return { root: realProjectPath(mainRoot), canonicalized: true };
    } catch {
      return { root: nfc(mainRoot), canonicalized: true };
    }
  } catch (error) {
    return {
      root: normalizedRoot,
      canonicalized: false,
      warning: `cannot resolve worktree identity: ${error.message}`,
    };
  }
}

/**
 * Find a uniquely matching long project directory name.
 * Claude Code may hash with Bun or djb2 depending on its build; rather than
 * guessing a hash, enumerate candidates for diagnostics. A matching prefix
 * alone does not establish ownership of a different hash suffix.
 */
export function findLongProjectDir(projectsDir, projectRoot) {
  const rawEncoded = projectRoot.replace(/[^a-zA-Z0-9]/g, "-");
  if (rawEncoded.length <= MAX_SANITIZED_LENGTH) return { names: [] };
  const prefix = sanitizedPrefix(projectRoot);
  let names = [];
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(`${prefix}-`)) continue;
      const suffix = entry.name.slice(prefix.length + 1);
      if (!/^[a-z0-9]+$/.test(suffix)) continue;
      if (!existsSync(join(projectsDir, entry.name, AUTO_MEMORY_DIRNAME))) continue;
      names.push(entry.name);
    }
  } catch {
    return { names: [], error: "projects directory is not readable" };
  }
  names = [...new Set(names)].sort();
  return { names };
}

function resolveProjectDirName({ projectRoot, projectsDir, requestedName }) {
  if (requestedName !== undefined) {
    const valid = validateProjectDirName(requestedName);
    if (valid.error) return { error: valid.error };
    return { name: valid.value, source: "explicit", override: true };
  }

  const sanitized = sanitizePath(projectRoot);
  const needsLongResolution =
    projectRoot.replace(/[^a-zA-Z0-9]/g, "-").length > MAX_SANITIZED_LENGTH;
  if (!needsLongResolution) {
    return { name: sanitized, source: "sanitizePath" };
  }

  if (existsSync(join(projectsDir, sanitized, AUTO_MEMORY_DIRNAME))) {
    return { name: sanitized, source: "sanitizePath" };
  }

  const found = findLongProjectDir(projectsDir, projectRoot);
  if (found.error) {
    return { name: sanitized, source: "sanitizePath", warning: found.error };
  }
  if (found.names.length === 1) {
    return {
      error: `cannot verify ownership of long-path candidate ${found.names[0]}; a shared prefix is insufficient. Set projectDirName or memoryDir explicitly after checking the project identity`,
      code: "UNVERIFIED_PROJECT_DIR",
    };
  }
  if (found.names.length > 1) {
    return {
      error: `ambiguous long project path: ${found.names.length} candidate memory directories share the encoded prefix (${found.names.join(", ")})`,
      code: "AMBIGUOUS_PROJECT_DIR",
    };
  }
  return { name: sanitized, source: "sanitizePath" };
}

/**
 * Resolve the Auto Memory location for one session directory.
 *
 * @param {object} input
 * @param {string} input.cwd session's project/working directory
 * @param {object} [input.config] plugin config
 * @param {object} [input.env] environment (defaults to process.env)
 * @param {string} [input.home] home directory (defaults to os.homedir())
 * @param {string} [input.platform] platform name (defaults to process.platform)
 * @returns {object} location description or `{ ok: false, code, reason, ... }`
 */
export function resolveMemoryLocation({
  cwd,
  config = {},
  env = process.env,
  home = homedir(),
  platform = process.platform,
} = {}) {
  const warnings = [];
  const traces = [];
  const conflict = [];

  if (typeof cwd !== "string" || cwd.trim() === "") {
    return { ok: false, code: "NO_CWD", reason: "the session has no project directory" };
  }

  let cwdReal;
  try {
    const stat = statSync(cwd);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        code: "CWD_NOT_DIRECTORY",
        reason: `project directory is not a directory: ${cwd}`,
      };
    }
    cwdReal = realProjectPath(cwd);
  } catch (error) {
    return {
      ok: false,
      code: "CWD_UNAVAILABLE",
      reason: `project directory is unavailable: ${cwd}`,
      detail: error.message,
    };
  }
  traces.push(`session cwd (realpath): ${cwdReal}`);

  let configHome;
  if (config.configDir !== undefined) {
    const expanded = expandTilde(String(config.configDir), home);
    configHome = absolute(expanded);
    traces.push(`config home: ${configHome} (plugin config)`);
  } else if (env.CLAUDE_CONFIG_DIR) {
    configHome = absolute(env.CLAUDE_CONFIG_DIR);
    traces.push(`config home: ${configHome} (CLAUDE_CONFIG_DIR)`);
  } else {
    configHome = join(home, ".claude");
    traces.push(`config home: ${configHome} (default)`);
  }

  const settings = collectSettings({ configHome, cwd: cwdReal, platform, env });
  for (const [source, value] of Object.entries(settings)) {
    if (value?.error) {
      warnings.push({ code: "SETTINGS_ERROR", message: `${source}: ${value.error}` });
    }
  }

  const gitRoot = findGitRoot(cwdReal);
  let projectRoot = cwdReal;
  let repositoryRoot = null;
  let isWorktree = false;
  let canonicalWarning;
  if (gitRoot) {
    const canonical = resolveCanonicalGitRoot(gitRoot);
    projectRoot = canonical.root;
    repositoryRoot = canonical.root;
    isWorktree = canonical.canonicalized && canonical.root !== gitRoot;
    canonicalWarning = canonical.warning;
    traces.push(`git root: ${gitRoot}`);
    traces.push(`canonical project root: ${projectRoot}${isWorktree ? " (worktree)" : ""}`);
  } else {
    traces.push(`no git repository; using session cwd as project root`);
  }
  if (canonicalWarning) {
    warnings.push({ code: "WORKTREE_IDENTITY", message: canonicalWarning });
  }

  let memoryBase;
  if (env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    const valid = validateMemoryPath(env.CLAUDE_CODE_REMOTE_MEMORY_DIR, {
      expandHome: false,
      home,
    });
    if (valid.error) {
      return {
        ok: false,
        code: "INVALID_MEMORY_BASE",
        reason: `CLAUDE_CODE_REMOTE_MEMORY_DIR is invalid: ${valid.error}`,
        cwd: cwdReal,
        warnings,
        traces,
      };
    }
    memoryBase = valid.value;
    traces.push(`memory base: ${memoryBase} (CLAUDE_CODE_REMOTE_MEMORY_DIR)`);
  } else {
    memoryBase = configHome;
    traces.push(`memory base: ${memoryBase}`);
  }
  const projectsDir = join(memoryBase, "projects");

  // autoMemoryDirectory follows Claude Code's precedence and security rule:
  // policy/local/user settings only; project .claude/settings.json is ignored.
  const settingCandidates = [];
  let selectedSetting;
  for (const source of ["policySettings", "localSettings", "userSettings"]) {
    const raw = settings[source]?.value?.autoMemoryDirectory;
    if (raw === undefined) continue;
    selectedSetting ??= { source };
    if (typeof raw !== "string") {
      warnings.push({
        code: "INVALID_AUTO_MEMORY_DIRECTORY",
        message: `${source}: autoMemoryDirectory must be a string; value ignored`,
      });
      continue;
    }
    const valid = validateMemoryPath(raw, { expandHome: true, home });
    if (valid.error) {
      warnings.push({
        code: "INVALID_AUTO_MEMORY_DIRECTORY",
        message: `${source}: ${valid.error}; value ignored`,
      });
      continue;
    }
    settingCandidates.push({ source, path: valid.value });
    if (selectedSetting.source === source) selectedSetting.path = valid.value;
  }
  if (selectedSetting && !selectedSetting.path) {
    warnings.push({
      code: "INVALID_AUTO_MEMORY_PRECEDENCE",
      message: `${selectedSetting.source} supplies an invalid autoMemoryDirectory; lower-priority settings are not substituted, matching Claude Code`,
    });
  }
  if (settingCandidates.length > 1 && selectedSetting?.path) {
    const distinct = new Set(settingCandidates.map((candidate) => pathKey(candidate.path)));
    if (distinct.size > 1) {
      warnings.push({
        code: "CONFIG_CONFLICT",
        message: `autoMemoryDirectory is defined differently in ${settingCandidates.map((c) => c.source).join(", ")}; using ${settingCandidates[0].source}`,
      });
    }
  }

  const projectSettingsAuto = settings.projectSettings?.value?.autoMemoryDirectory;
  if (projectSettingsAuto !== undefined) {
    warnings.push({
      code: "PROJECT_SETTING_IGNORED",
      message:
        "autoMemoryDirectory in .claude/settings.json is ignored, matching Claude Code security behavior",
    });
  }

  let explicitOverride;
  let source;
  if (config.memoryDir !== undefined) {
    const valid = validateMemoryPath(String(config.memoryDir), { expandHome: true, home });
    if (valid.error) {
      return {
        ok: false,
        code: "INVALID_MEMORY_OVERRIDE",
        reason: `plugin memoryDir is invalid: ${valid.error}`,
        cwd: cwdReal,
        warnings,
        traces,
      };
    }
    explicitOverride = valid.value;
    source = "plugin-config:memoryDir";
  } else if (env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE) {
    const valid = validateMemoryPath(env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE, {
      expandHome: false,
      home,
    });
    if (valid.error) {
      return {
        ok: false,
        code: "INVALID_MEMORY_OVERRIDE",
        reason: `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE is invalid: ${valid.error}`,
        cwd: cwdReal,
        warnings,
        traces,
      };
    }
    explicitOverride = valid.value;
    source = "env:CLAUDE_COWORK_MEMORY_PATH_OVERRIDE";
  } else if (selectedSetting?.path) {
    explicitOverride = selectedSetting.path;
    source = `settings:${selectedSetting.source}`;
  }

  let projectDirName;
  let projectDirSource;
  let projectDirWarning;
  if (explicitOverride) {
    projectDirName = null;
    projectDirSource = source;
    if (gitRoot) {
      const defaultName = sanitizePath(projectRoot);
      const defaultDir = join(projectsDir, defaultName, AUTO_MEMORY_DIRNAME);
      if (existsSync(defaultDir) && pathKey(defaultDir) !== pathKey(explicitOverride)) {
        warnings.push({
          code: "CONFIG_CONFLICT",
          message: `an auto-memory directory for this repository also exists at ${defaultDir}; using the explicit override ${explicitOverride} and not merging`,
        });
      }
    }
  } else {
    const requestedName =
      config.projectDirName !== undefined
        ? String(config.projectDirName)
        : env.CLAUDE_CODE_PROJECT_DIR_NAME;
    if (requestedName !== undefined && requestedName !== "") {
      const resolved = resolveProjectDirName({
        projectRoot,
        projectsDir,
        requestedName,
      });
      if (resolved.error) {
        return {
          ok: false,
          code: resolved.code ?? "INVALID_PROJECT_DIR_NAME",
          reason: resolved.error,
          cwd: cwdReal,
          projectRoot,
          projectsDir,
          warnings,
          traces,
        };
      }
      projectDirName = resolved.name;
      projectDirSource =
        config.projectDirName !== undefined
          ? "plugin-config:projectDirName"
          : "env:CLAUDE_CODE_PROJECT_DIR_NAME";
      if (projectDirName !== sanitizePath(projectRoot)) {
        warnings.push({
          code: "CUSTOM_PROJECT_DIR_NAME",
          message: `using explicit project directory name "${projectDirName}" instead of "${sanitizePath(projectRoot)}"`,
        });
      }
    } else {
      const resolved = resolveProjectDirName({
        projectRoot,
        projectsDir,
        requestedName: undefined,
      });
      if (resolved.error) {
        return {
          ok: false,
          code: resolved.code ?? "INVALID_PROJECT_DIR_NAME",
          reason: resolved.error,
          cwd: cwdReal,
          projectRoot,
          projectsDir,
          warnings,
          traces,
        };
      }
      projectDirName = resolved.name;
      projectDirSource = resolved.source;
      projectDirWarning = resolved.warning;
      if (projectDirWarning)
        warnings.push({ code: "PROJECT_DIR_NAME", message: projectDirWarning });
    }
  }

  const memoryDir = explicitOverride ?? join(projectsDir, projectDirName, AUTO_MEMORY_DIRNAME);
  traces.push(`memory directory (candidate): ${memoryDir}`);

  let memoryDirReal = null;
  let memoryDirExists = false;
  let memoryDirStat;
  try {
    memoryDirStat = lstatSync(memoryDir);
    if (memoryDirStat.isSymbolicLink()) {
      try {
        memoryDirReal = nfc(realpathSync(memoryDir));
      } catch (error) {
        return {
          ok: false,
          code: "SYMLINK_BROKEN",
          reason: `memory directory is a broken symlink: ${memoryDir}`,
          detail: error.message,
          cwd: cwdReal,
          projectRoot,
          memoryDir,
          warnings,
          traces,
        };
      }
      if (!explicitOverride) {
        let projectsDirReal;
        try {
          projectsDirReal = nfc(realpathSync(projectsDir));
        } catch {
          projectsDirReal = null;
        }
        if (!projectsDirReal || !isSubpath(projectsDirReal, memoryDirReal)) {
          return {
            ok: false,
            code: "SYMLINK_ESCAPE",
            reason: `memory directory symlink escapes the Claude config projects directory: ${memoryDir} -> ${memoryDirReal}`,
            cwd: cwdReal,
            projectRoot,
            memoryDir,
            memoryDirReal,
            warnings,
            traces,
          };
        }
        warnings.push({
          code: "SYMLINKED_MEMORY_DIR",
          message: `memory directory is a symlink inside the projects directory: ${memoryDir} -> ${memoryDirReal}`,
        });
      } else {
        warnings.push({
          code: "SYMLINKED_EXPLICIT_MEMORY_DIR",
          message: `explicit memory directory is a symlink: ${memoryDir} -> ${memoryDirReal}`,
        });
      }
    } else if (memoryDirStat.isDirectory()) {
      memoryDirReal = nfc(realpathSync(memoryDir));
    } else {
      return {
        ok: false,
        code: "MEMORY_NOT_DIRECTORY",
        reason: `memory path exists but is not a directory: ${memoryDir}`,
        cwd: cwdReal,
        projectRoot,
        memoryDir,
        warnings,
        traces,
      };
    }
    memoryDirExists = true;
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
      return {
        ok: false,
        code: "MEMORY_UNAVAILABLE",
        reason: `cannot inspect memory directory: ${memoryDir}`,
        detail: error.message,
        cwd: cwdReal,
        projectRoot,
        memoryDir,
        warnings,
        traces,
      };
    }
  }

  if (memoryDirExists && !explicitOverride) {
    let projectsReal;
    try {
      projectsReal = nfc(realpathSync(projectsDir));
    } catch {
      // An unresolvable parent is not a verified project memory root.
    }
    if (!projectsReal || !isSubpath(projectsReal, memoryDirReal)) {
      return {
        ok: false,
        code: "SYMLINK_ESCAPE",
        reason:
          "the resolved memory directory escapes the Claude projects directory through a parent symlink",
        cwd: cwdReal,
        projectRoot,
        memoryDir,
        memoryDirReal,
        warnings,
        traces,
      };
    }
  }

  const effectiveMemoryDir = memoryDirReal ?? memoryDir;
  const entrypoint = join(effectiveMemoryDir, AUTO_MEMORY_ENTRYPOINT);
  let entrypointExists = false;
  let entrypointReal = null;
  if (memoryDirExists) {
    try {
      const entryStat = lstatSync(entrypoint);
      if (entryStat.isSymbolicLink()) {
        entrypointReal = nfc(realpathSync(entrypoint));
        if (!isSubpath(memoryDirReal, entrypointReal)) {
          return {
            ok: false,
            code: "SYMLINK_ESCAPE",
            reason: `MEMORY.md symlink escapes the memory directory: ${entrypoint} -> ${entrypointReal}`,
            cwd: cwdReal,
            projectRoot,
            memoryDir,
            memoryDirReal,
            warnings,
            traces,
          };
        }
        warnings.push({
          code: "SYMLINKED_ENTRYPOINT",
          message: `MEMORY.md is a symlink inside the memory directory: ${entrypoint} -> ${entrypointReal}`,
        });
      } else if (entryStat.isFile()) {
        entrypointExists = true;
      } else {
        warnings.push({
          code: "ENTRYPOINT_NOT_FILE",
          message: `MEMORY.md is not a regular file: ${entrypoint}`,
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        warnings.push({
          code: "ENTRYPOINT_UNAVAILABLE",
          message: `cannot inspect MEMORY.md: ${error.message}`,
        });
      }
    }
    if (entrypointReal) {
      try {
        entrypointExists = statSync(entrypointReal).isFile();
      } catch {
        entrypointExists = false;
      }
    }
  }

  // autoMemoryEnabled is a write/auto-injection switch in Claude Code, not a
  // read permission. It is reported, and callers can choose to respect it.
  let enabled = { enabled: true, source: "default" };
  if (isEnvTruthy(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY)) {
    enabled = { enabled: false, source: "env:CLAUDE_CODE_DISABLE_AUTO_MEMORY" };
  } else if (isEnvDefinedFalsy(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY)) {
    enabled = { enabled: true, source: "env:CLAUDE_CODE_DISABLE_AUTO_MEMORY" };
  } else if (isEnvTruthy(env.CLAUDE_CODE_SIMPLE)) {
    enabled = { enabled: false, source: "env:CLAUDE_CODE_SIMPLE" };
  } else {
    const fromSettings = autoMemoryEnabledFromSettings(settings);
    if (fromSettings)
      enabled = { enabled: fromSettings.enabled, source: `settings:${fromSettings.source}` };
  }

  return {
    ok: true,
    cwd: cwdReal,
    projectRoot,
    repositoryRoot,
    gitRoot,
    isWorktree,
    configHome,
    memoryBase,
    projectsDir,
    projectDirName,
    projectDirSource,
    memoryDir: effectiveMemoryDir,
    memoryDirExists,
    memoryDirReal,
    entrypoint,
    entrypointExists,
    entrypointReal,
    exists: memoryDirExists,
    source: explicitOverride
      ? source
      : projectDirSource === "env:CLAUDE_CODE_PROJECT_DIR_NAME"
        ? "env:CLAUDE_CODE_PROJECT_DIR_NAME"
        : projectDirSource === "plugin-config:projectDirName"
          ? "plugin-config:projectDirName"
          : projectDirSource === "unique-long-path-candidate"
            ? "long-path-candidate"
            : "computed",
    explicitOverride: Boolean(explicitOverride),
    autoMemoryEnabled: enabled,
    settings: {
      user: {
        path: settings.userSettings.path,
        exists: settings.userSettings.exists,
        error: settings.userSettings.error,
      },
      local: {
        path: settings.localSettings.path,
        exists: settings.localSettings.exists,
        error: settings.localSettings.error,
      },
      project: {
        path: settings.projectSettings.path,
        exists: settings.projectSettings.exists,
        error: settings.projectSettings.error,
      },
      policy: {
        path: settings.policySettings.path,
        exists: settings.policySettings.exists,
        error: settings.policySettings.error,
        dropIns: settings.policySettings.dropIns ?? 0,
      },
      flag: {
        available: false,
        reason: "CLI --settings is process state and is not visible to plugins",
      },
    },
    warnings,
    conflicts: conflict,
    traces,
  };
}

/** Short reason describing why no memory can be shown. */
export function describeMissingMemory(location) {
  if (!location || location.ok === false)
    return location?.reason ?? "memory location could not be resolved";
  if (!location.memoryDirExists) {
    return `no Claude Code Auto Memory directory exists at ${location.memoryDir}`;
  }
  if (!location.entrypointExists) {
    return `Claude Code Auto Memory directory exists at ${location.memoryDir} but has no MEMORY.md index`;
  }
  return null;
}
