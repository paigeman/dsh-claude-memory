/**
 * Small, dependency-free helpers shared by the Claude Code memory reader.
 *
 * Everything here is pure or read-only. This package never imports a
 * write-capable filesystem API.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export const NAME = "claude-memory";

/** Expand `~/` and `~\` the way Claude Code settings paths do. */
export function expandTilde(value, home = homedir()) {
  if (typeof value !== "string") return undefined;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(home, value.slice(2));
  }
  return value;
}

/** Normalize a path to NFC; Claude Code stores NFC project identities. */
export function nfc(value) {
  return value.normalize("NFC");
}

/** Resolve to an absolute, normalized, NFC path. */
export function absolute(value, base = process.cwd()) {
  return nfc(normalize(isAbsolute(value) ? value : resolve(base, value)));
}

/** True when `child` is `parent` or lives inside `parent`. */
export function isSubpath(parent, child) {
  if (!parent || !child) return false;
  const rel = relative(parent, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Filesystem comparison key (Windows drive letters are case-insensitive). */
export function pathKey(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/**
 * Claude Code's project-directory encoding, copied from
 * `src/utils/sessionStoragePortable.ts` (`sanitizePath`):
 * every non-alphanumeric character becomes `-`, and names longer than 200
 * characters get a `-<hash>` suffix.
 *
 * Claude Code uses Bun.hash when built with Bun and djb2 otherwise. The
 * reader therefore never guesses a long name: it scans the projects directory
 * for the unique matching candidate (see paths.js).
 */
export const MAX_SANITIZED_LENGTH = 200;

export function djb2Hash(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash;
}

export function simpleHash(value) {
  return Math.abs(djb2Hash(value)).toString(36);
}

export function sanitizePath(value) {
  const sanitized = value.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${simpleHash(value)}`;
}

/** The 200-character prefix used to discover a long project directory name. */
export function sanitizedPrefix(value) {
  return value.replace(/[^a-zA-Z0-9]/g, "-").slice(0, MAX_SANITIZED_LENGTH);
}

export function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

/** Truthiness used by Claude Code's environment switches. */
export function isEnvTruthy(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isEnvDefinedFalsy(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return (
    normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off"
  );
}

/**
 * Strip `//` and block comments plus trailing commas while preserving string
 * contents. Claude Code settings files are JSONC-like in practice.
 */
export function parseJsonc(text) {
  if (typeof text !== "string") throw new TypeError("JSONC input must be a string");
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        withoutComments += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      withoutComments += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutComments += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    withoutComments += char;
  }

  let cleaned = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const char = withoutComments[i];
    if (inString) {
      cleaned += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      cleaned += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < withoutComments.length && /\s/.test(withoutComments[j])) j++;
      if (withoutComments[j] === "}" || withoutComments[j] === "]") continue;
    }
    cleaned += char;
  }

  return JSON.parse(cleaned);
}

/**
 * Validate a full memory-directory override.
 *
 * Mirrors Claude Code's `validateMemoryPath`: rejects relative paths, roots,
 * near-roots, Windows drive roots, UNC paths, and NUL bytes; expands `~/`
 * only for settings values. Returns the normalized path (no trailing
 * separator) or `{ error }` for diagnostics.
 */
export function validateMemoryPath(raw, { expandHome = false, home = homedir() } = {}) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { error: "memory directory is empty" };
  }
  let candidate = raw.trim();
  if (expandHome && (candidate.startsWith("~/") || candidate.startsWith("~\\"))) {
    const rest = normalize(candidate.slice(2) || ".");
    if (rest === "." || rest === "..") {
      return { error: "memory directory may not expand to the home directory or an ancestor" };
    }
    candidate = join(home, candidate.slice(2));
  }
  const normalized = normalize(candidate).replace(/[/\\]+$/, "");
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith("\\\\") ||
    normalized.startsWith("//") ||
    normalized.includes("\0")
  ) {
    return { error: `unsafe or non-absolute memory directory: ${JSON.stringify(raw)}` };
  }
  return { value: nfc(normalized) };
}

/** A single directory component, safe to join under `projects/`. */
export function validateProjectDirName(raw) {
  if (typeof raw !== "string" || raw === "") return { error: "project directory name is empty" };
  if (raw === "." || raw === "..") return { error: "project directory name may not be . or .." };
  if (raw.length > 255) return { error: "project directory name exceeds 255 characters" };
  if (raw.includes("\0") || raw.includes("/") || raw.includes("\\")) {
    return { error: "project directory name must be a single path component" };
  }
  if (basename(raw) !== raw || dirname(raw) !== ".") {
    return { error: "project directory name must be a single path component" };
  }
  return { value: raw };
}
