/**
 * DeepSeek Harness Host plugin: read-only recall of Claude Code project
 * Auto Memory.
 *
 * The plugin exposes one tool (`claude_code_memory`), injects the bounded
 * MEMORY.md index once per session, and deterministically handles explicit
 * "load memory" requests by injecting every valid file in budgeted batches.
 *
 * It is a reader. There is no write, sync, management, or persistence path.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolveMemoryLocation } from "./lib/paths.js";
import {
  DEFAULT_CONFIG,
  SessionMemoryState,
  buildFullRecall,
  buildOverview,
  buildRecall,
  buildStatus,
  formatManifest,
  normalizeConfig,
  readMemoryIndex,
  scanMemoryDir,
  wrapMemoryBlock,
} from "./lib/memory.js";

export const name = "claude-memory";
export const inject = ["tools", "llm"];

const TOOL_NAME = "claude_code_memory";

function getLogger(ctx) {
  try {
    if (typeof ctx.logger === "function") return ctx.logger(name);
  } catch {
    // fall through
  }
  return {
    info() {},
    warn() {},
    debug() {},
    error() {},
  };
}

function sessionCwd(ctx, agent) {
  try {
    const workingDirectory = ctx.get("workingDirectory");
    if (workingDirectory && agent?.session) {
      const cwd = workingDirectory.get(agent.session);
      if (typeof cwd === "string" && cwd.trim() !== "") return cwd;
    }
  } catch {
    // fall through
  }
  const headerCwd = agent?.session?.header?.cwd;
  if (typeof headerCwd === "string" && headerCwd.trim() !== "") return headerCwd;
  // The Host process cwd can be its profile directory, not the user's project.
  return undefined;
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function stripCodeFences(text) {
  return String(text).replace(/```[\s\S]*?```/g, " ");
}

/**
 * Explicit full-memory trigger detection.
 *
 * A trigger must be an imperative request that starts with a load/read verb
 * (optionally after a short polite prefix), not merely a sentence that happens
 * to contain "读取 ... Memory" while describing something else. Negated
 * requests, code examples, and "how do I load memory?" questions are rejected.
 */
export function detectFullRecall(rawText) {
  const text = stripCodeFences(rawText).trim();
  if (!text) return false;

  // A request for one file, an index, or documentation is not permission to
  // attach every project memory file. Leave selective requests to the tool.
  if (/\bmemory\.(?:md|js|ts|json)\b|[^\s]+\.md\b/i.test(text)) return false;
  if (/(?:除了|排除|except|excluding)/i.test(text)) return false;
  if (
    !/(?:全部|所有|\ball\b)/i.test(text) &&
    /(?:索引|主题|相关|某个|某些|仅|只(?:要|读|加载|读取)|源码|机制|配置|教程|\b(?:only|index|topic|selected|matching|documentation|implementation|usage)\b)/i.test(
      text,
    )
  )
    return false;

  const negative =
    /(?:不要|别|无需|不用|不必|禁止|忽略|ignore|don't|do not|never|without)(?!\s*(?:忘记|forget))[^。！？.!?\n]{0,12}(?:加载|读取|载入|load|read|recall)/i;
  if (negative.test(text)) return false;
  if (
    /^\s*(?:如何|怎么|怎样|怎么才能|how\s+(?:do|can|should|to|does))/i.test(text) &&
    /[?？]\s*$/.test(text)
  ) {
    return false;
  }

  const zhVerb = "(?:加载|读取|载入|导入|召回|回忆)";
  const zhRequestPrefix =
    /^(?:好的?[，,。.!！\s]*|嗯[，,。.!！\s]*|ok(?:ay)?[，,。.!！\s]*)?(?:请(?:你|您)?(?:帮我|帮忙|麻烦)?|帮我|帮忙|麻烦(?:你|您)?|劳驾|能否(?:帮我)?|可以(?:帮我)?|能不能(?:帮我)?|我要你|现在|立即|直接|先|不要忘记|别忘了)\s*/i;

  let chinese = text;
  for (let i = 0; i < 2; i++) {
    const stripped = chinese.replace(zhRequestPrefix, "");
    if (stripped === chinese) break;
    chinese = stripped;
  }
  if (new RegExp(`^${zhVerb}[^\n]{0,80}?(?:memory|memories|记忆|回忆)`, "i").test(chinese))
    return true;

  let en = text;
  for (let i = 0; i < 2; i++) {
    const stripped = en.replace(
      /^(?:please\s+|can you\s+|could you\s+|would you\s+|i want you to\s+|help me\s+|now\s+|go ahead and\s+|ok(?:ay)?[,]?\s+)/i,
      "",
    );
    if (stripped === en) break;
    en = stripped;
  }
  if (/^(?:load|read|recall|import|bring)\b[\s\S]{0,80}?\b(?:memory|memories)\b/i.test(en))
    return true;

  return false;
}

function makePluginMessage(text, form, location) {
  const content = [{ type: "text", text }];
  // Native Session Format V4 uses a producer-owned kind, as first-party
  // context producers do. The retired V3 { kind: 'plugin', plugin: ... }
  // wrapper is rejected by the V4 encoder.
  const source = { kind: name, form };
  if (location?.memoryDir) source.memoryDir = location.memoryDir;
  Object.freeze(content[0]);
  Object.freeze(content);
  Object.freeze(source);
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content,
    source,
  });
}

function buildIndexInjection(location, config) {
  const scan = scanMemoryDir(location, config);
  const index = readMemoryIndex(location, config);
  const hasIndex = Boolean(index && !index.error && index.content);
  if (!hasIndex && scan.topics.length === 0) return null;

  const sections = [];
  if (index && !index.error) {
    sections.push("## MEMORY.md index", index.content || "(MEMORY.md is empty)");
    if (index.warning) sections.push(`> ${index.warning}`);
  } else if (index?.error) {
    sections.push("## MEMORY.md index", `Could not read MEMORY.md: ${index.error}`);
  } else {
    sections.push("## MEMORY.md index", "(MEMORY.md does not exist)");
  }

  if (config.includeManifestInIndex || !hasIndex) {
    sections.push(
      `## Topic files (${scan.topics.length})`,
      formatManifest(scan.topics, { max: Math.min(config.maxManifestFiles, 80) }),
    );
  }

  sections.push(
    "## How to use this memory",
    [
      'Topic files are NOT loaded by default. If prior project decisions, feedback, conventions, incidents, or history could change the answer, call `claude_code_memory` with action="recall" and focused keywords, or with files=[...] from the index above.',
      "Do not call the tool for unrelated tasks. Treat memory as heuristic historical context; current instructions and repository state take precedence. Never write to these files.",
      'If the user asks to load memory / 加载 memory / 读取全部记忆, the plugin injects all valid files automatically in budgeted batches. Do not claim completeness when a block says "Complete: NO".',
    ].join("\n"),
  );

  const notes = scan.warnings.map((w) => w.message);
  if (scan.truncated) notes.push(`Only the first ${config.maxScanFiles} topic files were scanned.`);
  let body = sections.join("\n\n");
  let partial = false;
  if (body.length > config.maxBatchChars) {
    body = body.slice(0, config.maxBatchChars);
    partial = true;
    notes.push(
      `Index/manifest exceeds the ${config.maxBatchChars}-character budget; only a partial index is attached. Use focused file recall.`,
    );
  }
  return wrapMemoryBlock({
    mode: "index",
    location,
    complete: !index?.warning && !partial && !scan.incomplete,
    body,
    notes,
  });
}

function statusScan(location, config) {
  if (!location || location.ok === false || !location.memoryDirExists) return null;
  return scanMemoryDir(location, config);
}

function makeTool(ctx, config, stateFor) {
  return {
    name: TOOL_NAME,
    description: [
      "Read-only recall of this project's Claude Code Auto Memory (Claude Code / Claude Code Desktop).",
      "The bounded MEMORY.md index is injected once at session start; topic files are never loaded by default.",
      'Use action="recall" when prior design decisions, user feedback, conventions, incidents, or project history could change the answer. Prefer files=[...] named in the index, or query="focused keywords". Do not call it for unrelated tasks.',
      'Use action="load_all" only when the user explicitly asks for all memory or comprehensive coverage. It returns budgeted batches with a cursor and never silently truncates.',
      'action="overview" attaches the index and topic manifest to process-local model context; action="status" returns path/config diagnostics without memory bodies.',
      "Memory bodies are attached only to the next model request, never returned in durable tool results. Tool results contain receipts and file names only. Reloading the plugin clears recalled content; recall again if needed.",
      "This tool only reads. It never creates, edits, deletes, syncs, or persists memory.",
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["overview", "recall", "load_all", "status"],
          description:
            "overview: stage index + manifest; recall: stage selected topics; load_all: stage all files in budgeted batches; status: path/config diagnostics. Read actions return body-free receipts.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            'Relative memory file paths from the index, e.g. ["feedback_testing.md"]; may include "MEMORY.md". Only for action="recall".',
        },
        query: {
          type: "string",
          description:
            'Focused keywords used for local, read-only relevance selection when exact file names are unknown. Only for action="recall".',
        },
        cursor: {
          type: "integer",
          description:
            'Continuation offset returned by a partial action="load_all" result. Omit to start at the beginning.',
        },
        force: {
          type: "boolean",
          description:
            "Refresh already-active files. The process-local request still carries only one current copy of each file.",
        },
      },
      required: ["action"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
      render(_args, value) {
        return [{ type: "text", text: value.text }];
      },
    },
    isConcurrencySafe() {
      return true;
    },
    presentCall(args) {
      const action = typeof args?.action === "string" ? args.action : "memory";
      return {
        card: "generic",
        title: `Claude Code memory: ${action}`,
        kind: "read",
        rawInput: args,
      };
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error("claude_code_memory requires an owning agent session");
      const action = args?.action;
      if (!["overview", "recall", "load_all", "status"].includes(action)) {
        throw new Error(`invalid action ${JSON.stringify(action)}`);
      }
      if (args.files !== undefined && !Array.isArray(args.files)) {
        throw new Error("files must be an array of relative .md paths");
      }
      if (args.query !== undefined && typeof args.query !== "string") {
        throw new Error("query must be a string");
      }
      if (args.cursor !== undefined && (!Number.isInteger(args.cursor) || args.cursor < 0)) {
        throw new Error("cursor must be a non-negative integer");
      }
      const cwd = sessionCwd(ctx, exec.agent);
      let location;
      try {
        location = resolveMemoryLocation({ cwd, config });
      } catch (error) {
        return {
          text: `Claude Code memory could not be resolved safely. Reason: ${error.message}`,
        };
      }
      const state = stateFor(exec.agent);
      state.resetLocation(location);

      if (action === "status") {
        return { text: buildStatus(location, statusScan(location, config), config, state) };
      }
      if (action === "overview") {
        const overview = buildOverview(location, config);
        state.indexText = overview.text;
        state.rendered = null;
        const scan = statusScan(location, config);
        return {
          text: `Overview attached to process-local model context. Complete: ${overview.complete ? "yes" : "NO"}.\nTopic files: ${(scan?.topics ?? []).map((file) => file.relPath).join(", ") || "(none)"}`,
        };
      }
      state.indexText = buildIndexInjection(location, config);
      state.rendered = null;
      if (action === "load_all") {
        const result = buildFullRecall(location, state, config, {
          cursor: args.cursor ?? 0,
          force: args.force === true,
        });
        return { text: recallReceipt(state, result, "full") };
      }
      const result = buildRecall(location, state, config, {
        files: args.files ?? [],
        query: args.query ?? "",
        force: args.force === true,
      });
      return { text: recallReceipt(state, result, "recall") };
    },
  };
}

/** A durable tool receipt contains no source index, descriptions, or topic bodies. */
function recallReceipt(state, result, mode) {
  const files = result.loadedFiles ?? result.files ?? [];
  const problems = [...(result.skipped ?? []), ...(result.missing ?? [])];
  const lines = [
    "Claude Code memory is attached only to process-local model context; source bodies are not stored in this receipt.",
    `Complete: ${result.complete ? "yes" : "NO"}`,
    `mode=${mode}`,
    `Files loaded or already active: ${files.length}.`,
    `Files: ${files.join(", ") || "(none)"}`,
  ];
  if (typeof result.totalFiles === "number")
    lines.push(`Total files discovered: ${result.totalFiles}.`);
  if (!result.complete && Number.isInteger(result.nextCursor)) {
    lines.push("NOT all files were loaded into the active context.");
    lines.push(
      `Continue with action="load_all", cursor=${result.nextCursor}; reaching the last cursor alone does not establish completeness.`,
    );
  }
  if (state.location?.ok === false) lines.push(`Reason: ${state.location.reason}`);
  else if (!state.location?.memoryDirExists)
    lines.push("No Claude Code Auto Memory directory exists for this project. Nothing was loaded.");
  for (const problem of problems) lines.push(`Not loaded: ${problem.relPath}: ${problem.reason}`);
  if (!result.complete && problems.length === 0)
    lines.push(
      "Some entries are not active or could not be enumerated; restart with cursor=0 after resolving scan/context limits.",
    );
  state.receipt = lines.join("\n");
  state.recallMode = mode;
  state.recallComplete = result.complete;
  state.rendered = null;
  return state.receipt;
}

function requestContext(state) {
  if (state.rendered) return state.rendered;
  const messages = [];
  if (state.indexText && !state.bodies.has("MEMORY.md")) {
    messages.push(makePluginMessage(state.indexText, "index", state.location));
  }
  if (state.bodies.size > 0) {
    const text = wrapMemoryBlock({
      mode: state.recallMode,
      location: state.location,
      complete: state.recallComplete,
      body: [...state.bodies.values()]
        .map((file) => `### ${file.relPath}\n${file.content}`)
        .join("\n\n"),
      notes: [
        "This block is process-local request context. Prior durable receipts do not retain memory bodies after a reload.",
      ],
    });
    messages.push(
      makePluginMessage(
        text,
        state.recallMode === "full" ? "full-recall" : "recall",
        state.location,
      ),
    );
  }
  if (state.receipt)
    messages.push(
      makePluginMessage(
        state.receipt,
        state.bodies.size ? "receipt" : state.recallMode === "full" ? "full-recall" : "recall",
        state.location,
      ),
    );
  state.rendered = Object.freeze(messages);
  return state.rendered;
}

function withoutLegacyMemory(messages) {
  const memoryCalls = new Set(
    messages.flatMap((message) =>
      (message.content ?? [])
        .filter((block) => block.type === "tool-call" && block.name === TOOL_NAME)
        .map((block) => block.id),
    ),
  );
  return messages.flatMap((message) => {
    const source = message.source;
    if (source?.kind === name || (source?.kind === "plugin" && source.plugin === name)) return [];
    if (
      message.role === "tool" &&
      memoryCalls.has(message.toolCallId) &&
      message.content?.some(
        (block) => block.type === "text" && block.text.includes("<<< CLAUDE CODE MEMORY BEGIN"),
      )
    ) {
      return [
        Object.freeze({
          ...message,
          content: Object.freeze([
            Object.freeze({
              type: "text",
              text: "Legacy persisted memory content is omitted from this request. Recall again for the current project; only process-local memory context is authoritative.",
            }),
          ]),
        }),
      ];
    }
    return [message];
  });
}

export function apply(ctx, rawConfig = {}) {
  const log = getLogger(ctx);
  const config = normalizeConfig(rawConfig);
  const states = new Map();
  const forwarded = new WeakSet();
  const stateFor = (agent) => {
    const id = agent.session?.id ?? agent.id;
    let state = states.get(id);
    if (!state) {
      state = new SessionMemoryState(config.maxContextChars);
      states.set(id, state);
    }
    return state;
  };
  for (const key of Object.keys(rawConfig ?? {})) {
    if (!(key in DEFAULT_CONFIG)) log.warn(`[${name}] unknown config key "${key}" ignored`);
  }
  if (config.debug) log.info(`[${name}] configuration active; home: ${homedir()}`);

  ctx.effect(() => ctx.tools.register(makeTool(ctx, config, stateFor)));
  ctx.effect(() => () => states.clear());
  ctx.on("agent/disposed", ({ agent }) => {
    if (agent) states.delete(agent.session?.id ?? agent.id);
  });

  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    try {
      if (!decision || decision.kind === "reject" || payload.signal?.aborted) return decision;
      const { agent, messages } = payload;
      if (!agent) return decision;
      const state = stateFor(agent);
      const location = resolveMemoryLocation({ cwd: sessionCwd(ctx, agent), config });
      state.resetLocation(location);
      const isSubagent = agent.session?.header?.origin === "subagent";
      const userMessages = (messages ?? []).filter((message) => message?.source?.kind === "user");
      // Delegated prompts carry kind=user too, but are not human full-recall requests.
      const trigger =
        !isSubagent &&
        userMessages.find(
          (message) =>
            message.id &&
            !state.triggeredMessageIds.has(message.id) &&
            detectFullRecall(messageText(message)),
        );
      if (trigger) {
        state.triggeredMessageIds.add(trigger.id);
        state.indexChecked = true;
        state.indexText = buildIndexInjection(location, config);
        recallReceipt(state, buildFullRecall(location, state, config), "full");
      } else if (userMessages.length > 0 && !state.indexChecked && location.ok) {
        state.indexChecked = true;
        const skip =
          (isSubagent && !config.injectIndexInSubagents) ||
          (config.respectAutoMemoryDisabled && !location.autoMemoryEnabled.enabled);
        if (!skip && location.memoryDirExists) {
          state.indexText = buildIndexInjection(location, config);
          state.indexInjected = Boolean(state.indexText);
          state.rendered = null;
        }
      }
    } catch (error) {
      log.warn(`[${name}] recall preparation failed: ${error.message}`);
    }
    // Returning a memory-bearing message here would persist it in the Session.
    return decision;
  });

  ctx.on("agent/request", async (payload, next) => {
    const resolved = await next();
    const state = payload.agent && states.get(payload.agent.session?.id ?? payload.agent.id);
    if (state) {
      state.requestPermit = {
        signal: payload.signal,
        provider: resolved.provider,
        model: resolved.model,
      };
    }
    return resolved;
  });

  ctx.on("llm/stream", (options, next) => {
    if (forwarded.has(options)) return next();
    const state = states.get(options.sessionId);
    const permit = state?.requestPermit;
    if (
      !permit ||
      options.signal !== permit.signal ||
      options.provider !== permit.provider ||
      options.model !== permit.model
    )
      return next();
    state.requestPermit = null;
    const context = requestContext(state);
    const history = withoutLegacyMemory(options.messages);
    const unchanged =
      history.length === options.messages.length &&
      history.every((message, index) => message === options.messages[index]);
    if (context.length === 0 && unchanged) return next();
    const projected = Object.freeze({
      ...options,
      messages: Object.freeze([...history, ...context]),
    });
    // Cordis next() cannot replace its frozen input. Redispatch through the
    // public LLM API once, retaining every provider/model/signal/tool option.
    // The guard prevents recursion; only the inner call reaches the adapter.
    // The new envelope is deliberately not marked as an agent-loop request,
    // so first-party title logging does not snapshot transient memory bodies.
    forwarded.add(projected);
    return (async function* () {
      try {
        yield* ctx.llm.stream(projected);
      } finally {
        forwarded.delete(projected);
      }
    })();
  });
  log.info(`[${name}] read-only, process-local Claude Code memory reader active`);
}
