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

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolveMemoryLocation } from './lib/paths.js'
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
} from './lib/memory.js'

export const name = 'claude-memory'
export const inject = ['tools']

const TOOL_NAME = 'claude_code_memory'
const states = new Map()

function getLogger(ctx) {
  try {
    if (typeof ctx.logger === 'function') return ctx.logger(name)
  } catch {
    // fall through
  }
  return {
    info() {},
    warn() {},
    debug() {},
    error() {},
  }
}

function stateFor(agent) {
  let state = states.get(agent.id)
  if (!state) {
    state = new SessionMemoryState()
    states.set(agent.id, state)
  }
  return state
}

function sessionCwd(ctx, agent) {
  try {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory && agent?.session) {
      const cwd = workingDirectory.get(agent.session)
      if (typeof cwd === 'string' && cwd.trim() !== '') return cwd
    }
  } catch {
    // fall through
  }
  const headerCwd = agent?.session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd.trim() !== '') return headerCwd
  // The Host process cwd can be its profile directory, not the user's project.
  return undefined
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function stripCodeFences(text) {
  return String(text).replace(/```[\s\S]*?```/g, ' ')
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
  const text = stripCodeFences(rawText).trim()
  if (!text) return false

  const negative = /(?:不要|别|无需|不用|不必|禁止|忽略|ignore|don't|do not|never|without)(?!\s*(?:忘记|forget))[^。！？.!?\n]{0,12}(?:加载|读取|载入|load|read|recall)/i
  if (negative.test(text)) return false
  if (/^\s*(?:如何|怎么|怎样|怎么才能|how\s+(?:do|can|should|to|does))/i.test(text) && /[?？]\s*$/.test(text)) {
    return false
  }

  const zhVerb = '(?:加载|读取|载入|导入|召回|回忆)'
  const zhRequestPrefix = /^(?:好的?[，,。.!！\s]*|嗯[，,。.!！\s]*|ok(?:ay)?[，,。.!！\s]*)?(?:请(?:你|您)?(?:帮我|帮忙|麻烦)?|帮我|帮忙|麻烦(?:你|您)?|劳驾|能否(?:帮我)?|可以(?:帮我)?|能不能(?:帮我)?|我要你|现在|立即|直接|先|不要忘记|别忘了)\s*/i

  let chinese = text
  for (let i = 0; i < 2; i++) {
    const stripped = chinese.replace(zhRequestPrefix, '')
    if (stripped === chinese) break
    chinese = stripped
  }
  if (new RegExp(`^${zhVerb}[^\n]{0,80}?(?:memory|memories|记忆|回忆)`, 'i').test(chinese)) return true

  let en = text
  for (let i = 0; i < 2; i++) {
    const stripped = en.replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+|i want you to\s+|help me\s+|now\s+|go ahead and\s+|ok(?:ay)?[,]?\s+)/i, '')
    if (stripped === en) break
    en = stripped
  }
  if (/^(?:load|read|recall|import|bring)\b[\s\S]{0,80}?\b(?:memory|memories)\b/i.test(en)) return true

  return false
}

function makePluginMessage(text, form, location) {
  const content = [{ type: 'text', text }]
  // Native Session Format V4 uses a producer-owned kind, as first-party
  // context producers do. The retired V3 { kind: 'plugin', plugin: ... }
  // wrapper is rejected by the V4 encoder.
  const source = { kind: name, form }
  if (location?.memoryDir) source.memoryDir = location.memoryDir
  Object.freeze(content[0])
  Object.freeze(content)
  Object.freeze(source)
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content,
    source,
  })
}

function sessionAlreadyHasIndex(session, memoryDir) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes) || typeof session.eventAt !== 'function') return false
  const limit = Math.min(nodes.length, 400)
  for (let i = 0; i < limit; i++) {
    const event = session.eventAt(nodes[i])
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind === name && source.form === 'index' && source.memoryDir === memoryDir) return true
  }
  return false
}

function buildIndexInjection(location, config) {
  const scan = scanMemoryDir(location, config)
  const index = readMemoryIndex(location, config)
  const hasIndex = Boolean(index && !index.error && index.content)
  if (!hasIndex && scan.topics.length === 0) return null

  const sections = []
  if (index && !index.error) {
    sections.push('## MEMORY.md index', index.content || '(MEMORY.md is empty)')
    if (index.warning) sections.push(`> ${index.warning}`)
  } else if (index?.error) {
    sections.push('## MEMORY.md index', `Could not read MEMORY.md: ${index.error}`)
  } else {
    sections.push('## MEMORY.md index', '(MEMORY.md does not exist)')
  }

  if (config.includeManifestInIndex || !hasIndex) {
    sections.push(`## Topic files (${scan.topics.length})`, formatManifest(scan.topics, { max: Math.min(config.maxManifestFiles, 80) }))
  }

  sections.push(
    '## How to use this memory',
    [
      'Topic files are NOT loaded by default. If prior project decisions, feedback, conventions, incidents, or history could change the answer, call `claude_code_memory` with action="recall" and focused keywords, or with files=[...] from the index above.',
      'Do not call the tool for unrelated tasks. Treat memory as heuristic historical context; current instructions and repository state take precedence. Never write to these files.',
      'If the user asks to load memory / 加载 memory / 读取全部记忆, the plugin injects all valid files automatically in budgeted batches. Do not claim completeness when a block says "Complete: NO".',
    ].join('\n'),
  )

  const notes = scan.warnings.map(w => w.message)
  if (scan.truncated) notes.push(`Only the first ${config.maxScanFiles} topic files were scanned.`)
  return wrapMemoryBlock({
    mode: 'index',
    location,
    complete: !(index?.warning),
    body: sections.join('\n\n'),
    notes,
  })
}

function compactAlreadyLoadedNotice(location, state, total) {
  const names = [...state.loaded.keys()].sort()
  return wrapMemoryBlock({
    mode: 'full',
    location,
    complete: true,
    body: [
      `All ${total} memory file(s) were already injected earlier in this session with identical content.`,
      'No duplicate bodies were added; the earlier content remains in this session.',
      '',
      `Files: ${names.join(', ') || '(none)'}`,
    ].join('\n'),
  })
}

function statusScan(location, config) {
  if (!location || location.ok === false || !location.memoryDirExists) return null
  return scanMemoryDir(location, config)
}

function buildFailureMessage(location, error) {
  return wrapMemoryBlock({
    mode: 'full',
    location,
    complete: false,
    body: `Claude Code memory could not be loaded safely.\nReason: ${error instanceof Error ? error.message : String(error)}`,
  })
}

function makeTool(ctx, config) {
  return {
    name: TOOL_NAME,
    description: [
      'Read-only recall of this project\'s Claude Code Auto Memory (Claude Code / Claude Code Desktop).',
      'The bounded MEMORY.md index is injected once at session start; topic files are never loaded by default.',
      'Use action="recall" when prior design decisions, user feedback, conventions, incidents, or project history could change the answer. Prefer files=[...] named in the index, or query="focused keywords". Do not call it for unrelated tasks.',
      'Use action="load_all" only when the user explicitly asks for all memory or comprehensive coverage. It returns budgeted batches with a cursor and never silently truncates.',
      'action="overview" returns the index and topic manifest without bodies; action="status" explains path resolution and reads nothing into context.',
      'This tool only reads. It never creates, edits, deletes, syncs, or persists memory.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['overview', 'recall', 'load_all', 'status'],
          description: 'overview: index + topic manifest; recall: selected topic bodies; load_all: every file in budgeted batches; status: path/config diagnostics.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relative memory file paths from the index, e.g. ["feedback_testing.md"]; may include "MEMORY.md". Only for action="recall".',
        },
        query: {
          type: 'string',
          description: 'Focused keywords used for local, read-only relevance selection when exact file names are unknown. Only for action="recall".',
        },
        cursor: {
          type: 'integer',
          description: 'Continuation offset returned by a partial action="load_all" result. Omit to start at the beginning.',
        },
        force: {
          type: 'boolean',
          description: 'Repeat bodies already injected unchanged in this session. Default false to avoid duplicate context.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    isConcurrencySafe() {
      return true
    },
    presentCall(args) {
      const action = typeof args?.action === 'string' ? args.action : 'memory'
      return {
        card: 'generic',
        title: `Claude Code memory: ${action}`,
        kind: 'read',
        rawInput: args,
      }
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('claude_code_memory requires an owning agent session')
      const action = args?.action
      if (!['overview', 'recall', 'load_all', 'status'].includes(action)) {
        throw new Error(`invalid action ${JSON.stringify(action)}`)
      }
      if (args.files !== undefined && !Array.isArray(args.files)) {
        throw new Error('files must be an array of relative .md paths')
      }
      if (args.query !== undefined && typeof args.query !== 'string') {
        throw new Error('query must be a string')
      }
      if (args.cursor !== undefined && (!Number.isInteger(args.cursor) || args.cursor < 0)) {
        throw new Error('cursor must be a non-negative integer')
      }
      const cwd = sessionCwd(ctx, exec.agent)
      let location
      try {
        location = resolveMemoryLocation({ cwd, config })
      } catch (error) {
        return { text: buildFailureMessage(null, error) }
      }
      const state = stateFor(exec.agent)
      state.resetLocation(location)

      if (action === 'status') {
        return { text: buildStatus(location, statusScan(location, config), config, state) }
      }
      if (action === 'overview') {
        return { text: buildOverview(location, config).text }
      }
      if (action === 'load_all') {
        const result = buildFullRecall(location, state, config, {
          cursor: args.cursor ?? 0,
          force: args.force === true,
        })
        return { text: result.text }
      }
      const result = buildRecall(location, state, config, {
        files: args.files ?? [],
        query: args.query ?? '',
        force: args.force === true,
      })
      return { text: result.text }
    },
  }
}

export function apply(ctx, rawConfig = {}) {
  const log = getLogger(ctx)
  const config = normalizeConfig(rawConfig)
  if (rawConfig && typeof rawConfig === 'object') {
    for (const key of Object.keys(rawConfig)) {
      if (!(key in DEFAULT_CONFIG)) log.warn(`[${name}] unknown config key "${key}" ignored`)
    }
  }
  if (config.debug) {
    log.info(`[${name}] config: ${JSON.stringify(config)}`)
    log.info(`[${name}] home: ${homedir()}`)
  }

  ctx.effect(() => ctx.tools.register(makeTool(ctx, config)))

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id) states.delete(agent.id)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (!decision || decision.kind === 'reject') return decision
      if (payload.signal?.aborted) return decision
      const { agent, messages } = payload
      if (!agent || !Array.isArray(messages) || messages.length === 0) return decision

      const userMessages = messages.filter(message => message?.source?.kind === 'user')
      if (userMessages.length === 0) return decision

      const cwd = sessionCwd(ctx, agent)
      let location
      try {
        location = resolveMemoryLocation({ cwd, config })
      } catch (error) {
        log.warn(`[${name}] path resolution failed: ${error.message}`)
        return decision
      }
      const state = stateFor(agent)
      state.resetLocation(location)

      const trigger = userMessages.find((message) => {
        if (!message.id || state.triggeredMessageIds?.has?.(message.id)) return false
        return detectFullRecall(messageText(message))
      })

      const additions = []

      if (!trigger && !state.indexChecked && location.ok) {
        state.indexChecked = true
        const isSubagent = agent.session?.header?.origin === 'subagent'
        const skipForSubagent = isSubagent && !config.injectIndexInSubagents
        const skipForDisabled = config.respectAutoMemoryDisabled && location.ok && !location.autoMemoryEnabled.enabled
        if (!skipForSubagent && !skipForDisabled && location.ok && location.memoryDirExists) {
          try {
            const alreadyInHistory = sessionAlreadyHasIndex(agent.session, location.memoryDir)
            if (alreadyInHistory) {
              state.indexInjected = true
            } else {
              const text = buildIndexInjection(location, config)
              if (text) {
                additions.push(makePluginMessage(text, 'index', location))
                state.indexInjected = true
                const scan = scanMemoryDir(location, config)
                log.info(`[${name}] injected MEMORY.md index from ${location.memoryDir} (${scan.topics.length} topic files)`)
              }
            }
          } catch (error) {
            log.warn(`[${name}] index injection failed: ${error.message}`)
          }
        } else if (skipForSubagent) {
          log.debug?.(`[${name}] skipped index injection for subagent`)
        } else if (skipForDisabled) {
          log.info(`[${name}] Claude Code auto memory is disabled (${location.autoMemoryEnabled.source}); index not injected`)
        }
      }

      if (trigger) {
        try {
          state.triggeredMessageIds ??= new Set()
          state.triggeredMessageIds.add(trigger.id)
          state.indexChecked = true
          const hadComplete = state.fullComplete
          const result = buildFullRecall(location, state, config, { cursor: 0 })
          let text = result.text
          if (result.complete && hadComplete && (result.changedFiles?.length ?? 0) === 0 && state.loaded.size > 0) {
            text = compactAlreadyLoadedNotice(location, state, result.totalFiles)
          }
          additions.push(makePluginMessage(text, 'full-recall', location))
          log.info(
            `[${name}] explicit full recall: ${result.complete ? 'complete' : `partial (next cursor ${result.nextCursor})`}, ` +
            `${result.loadedFiles.length} file(s), source ${location.ok ? location.memoryDir : location.reason}`,
          )
        } catch (error) {
          additions.push(makePluginMessage(buildFailureMessage(location, error), 'error', location))
          log.warn(`[${name}] explicit full recall failed: ${error.message}`)
        }
      }

      if (additions.length === 0) return decision
      return { ...decision, messages: [...decision.messages, ...additions] }
    } catch (error) {
      // Memory recall must never break the user's turn.
      log.warn(`[${name}] pre-step handler failed: ${error.message}`)
      return decision
    }
  })

  log.info(`[${name}] read-only Claude Code memory reader active`)
}
