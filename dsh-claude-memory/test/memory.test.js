import assert from 'node:assert/strict'
import { readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveMemoryLocation } from '../lib/paths.js'
import {
  MAX_INDEX_CHARS,
  MAX_INDEX_LINES,
  SessionMemoryState,
  buildFullRecall,
  buildOverview,
  buildRecall,
  buildStatus,
  normalizeConfig,
  readMemoryIndex,
  resolveMemoryFile,
  scanMemoryDir,
  selectRelevantTopics,
  truncateIndex,
} from '../lib/memory.js'
import {
  assertSnapshotsEqual,
  cleanup,
  ensureDir,
  makeTemp,
  memoryPath,
  treeSnapshot,
  writeFile,
} from './helpers.js'

function fixture({ extraFiles = {} } = {}) {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'project')
  ensureDir(project)
  const configHome = join(home, '.claude')
  const memoryDir = memoryPath(configHome, project, {
    'MEMORY.md': [
      '# Memory Index',
      '',
      '- [Build Workflow](build.md) — build commands and CI notes',
      '- [Response Feedback](feedback.md) — user feedback about responses',
      '- [Deployment](nested/topic.md) — nested deployment notes',
      '- [Empty](empty.md) — empty topic',
      '',
    ].join('\n'),
    'build.md': [
      '---',
      'name: Build Workflow',
      'description: build commands and CI notes',
      'type: project',
      '---',
      '# Build',
      'Use `make build`. CI runs on GitHub Actions.',
      '',
    ].join('\n'),
    'feedback.md': [
      '---',
      'name: Response Feedback',
      'description: user feedback about response style',
      'type: feedback',
      '---',
      '# Feedback',
      'Never summarize diffs. Use pnpm, not npm.',
      '',
    ].join('\n'),
    'nested/topic.md': [
      '---',
      'description: nested deployment notes',
      'type: reference',
      '---',
      'Deployment uses blue-green in production.',
      '',
    ].join('\n'),
    'empty.md': '',
    ...extraFiles,
  })
  const location = resolveMemoryLocation({ cwd: project, env: {}, home })
  return { temp, home, project, configHome, memoryDir, location }
}

test('scan finds topic files, parses frontmatter, excludes the root index', () => {
  const { temp, location } = fixture()
  const config = normalizeConfig({})
  const scan = scanMemoryDir(location, config)
  assert.equal(scan.exists, true)
  const names = scan.topics.map(topic => topic.relPath)
  assert.deepEqual(names, ['build.md', 'empty.md', 'feedback.md', 'nested/topic.md'])
  const build = scan.topics.find(topic => topic.relPath === 'build.md')
  assert.equal(build.title, 'Build Workflow')
  assert.equal(build.description, 'build commands and CI notes')
  assert.equal(build.type, 'project')
  const index = readMemoryIndex(location, config)
  assert.equal(index.lineCount, 6)
  assert.match(index.content, /# Memory Index/)
  assert.equal(index.truncated, false)
  cleanup(temp)
})

test('session-start index injection is bounded and never includes topic bodies', () => {
  const { temp, location } = fixture()
  const config = normalizeConfig({})
  const overview = buildOverview(location, config)
  assert.match(overview.text, /Memory Index/)
  assert.match(overview.text, /build commands and CI notes/)
  assert.doesNotMatch(overview.text, /Use `make build`/)
  assert.match(overview.text, /Topic files \(4\)/)
  cleanup(temp)
})

test('index truncation follows Claude Code line and character caps', () => {
  const lines = Array.from({ length: MAX_INDEX_LINES + 20 }, (_, i) => `- line ${i}`)
  const byLine = truncateIndex(lines.join('\n'))
  assert.equal(byLine.lineTruncated, true)
  assert.equal(byLine.content.split('\n').length, MAX_INDEX_LINES)
  assert.match(byLine.warning, /limit 200/)
  const long = 'x'.repeat(MAX_INDEX_CHARS + 100)
  const byChar = truncateIndex(long)
  assert.equal(byChar.charTruncated, true)
  assert.equal(byChar.content.length, MAX_INDEX_CHARS)
  assert.match(byChar.warning, /limit 25000/)
})

test('full recall loads MEMORY.md and every topic body', () => {
  const { temp, location } = fixture()
  const config = normalizeConfig({})
  const state = new SessionMemoryState()
  const result = buildFullRecall(location, state, config, { cursor: 0 })
  assert.equal(result.complete, true)
  assert.equal(result.totalFiles, 5)
  assert.equal(result.changedFiles.length, 5)
  assert.match(result.text, /mode=full/)
  assert.match(result.text, /Complete: yes/)
  assert.match(result.text, /Use `make build`/)
  assert.match(result.text, /Never summarize diffs/)
  assert.match(result.text, /Deployment uses blue-green/)
  assert.equal(state.loadedCount(), 5)
  cleanup(temp)
})

test('repeated full recall avoids duplicate bodies; updates are re-read', () => {
  const { temp, memoryDir, location } = fixture()
  const config = normalizeConfig({})
  const state = new SessionMemoryState()
  const first = buildFullRecall(location, state, config, { cursor: 0 })
  assert.equal(first.complete, true)

  const second = buildFullRecall(location, state, config, { cursor: 0 })
  assert.equal(second.complete, true)
  assert.equal(second.changedFiles.length, 0)
  assert.match(second.text, /already loaded earlier/)
  assert.doesNotMatch(second.text, /Use `make build`/)

  unlinkSync(join(memoryDir, 'feedback.md'))
  writeFile(join(memoryDir, 'feedback.md'), [
    '---',
    'description: user feedback about response style',
    'type: feedback',
    '---',
    'Never summarize diffs. Use pnpm, not npm. NEW: always run tests twice.',
    '',
  ].join('\n'))
  const third = buildFullRecall(location, state, config, { cursor: 0 })
  assert.equal(third.complete, true)
  assert.deepEqual(third.changedFiles, ['feedback.md'])
  assert.match(third.text, /always run tests twice/)
  assert.doesNotMatch(third.text, /Use `make build`/)
  cleanup(temp)
})

test('over-budget full recall is explicitly partial and resumable', () => {
  const big = (label) => `${label}\n${'y'.repeat(3500)}\n`
  const { temp, location } = fixture({
    extraFiles: {
      'big1.md': big('big one'),
      'big2.md': big('big two'),
      'big3.md': big('big three'),
      'big4.md': big('big four'),
    },
  })
  const config = normalizeConfig({ maxBatchChars: 4000 })
  const state = new SessionMemoryState()
  const first = buildFullRecall(location, state, config, { cursor: 0 })
  assert.equal(first.complete, false)
  assert.ok(first.nextCursor > 0)
  assert.match(first.text, /NOT all files were loaded/)
  assert.match(first.text, /Complete: NO/)
  assert.doesNotMatch(first.text, /Complete: yes/)

  let cursor = first.nextCursor
  let guard = 0
  let result = first
  while (!result.complete && guard++ < 10) {
    result = buildFullRecall(location, state, config, { cursor })
    cursor = result.nextCursor
  }
  assert.equal(result.complete, true)
  assert.match(result.text, /Complete: yes/)
  cleanup(temp)
})

test('recall selects relevant topics and does not load unrelated bodies', () => {
  const { temp, location } = fixture()
  const config = normalizeConfig({})
  const state = new SessionMemoryState()
  const build = buildRecall(location, state, config, { query: 'build CI workflow' })
  assert.equal(build.complete, true)
  assert.match(build.text, /Use `make build`/)
  assert.doesNotMatch(build.text, /Never summarize diffs/)

  const feedback = buildRecall(location, new SessionMemoryState(), config, { query: 'pnpm response feedback' })
  assert.match(feedback.text, /Use pnpm, not npm/)
  assert.doesNotMatch(feedback.text, /Use `make build`/)

  const none = buildRecall(location, new SessionMemoryState(), config, { query: 'quantum chromodynamics lattice' })
  assert.match(none.text, /no topic file matched/i)
  assert.doesNotMatch(none.text, /Use `make build`/)
  assert.doesNotMatch(none.text, /Use pnpm, not npm/)
  cleanup(temp)
})

test('explicit file recall validates paths and can include MEMORY.md', () => {
  const { temp, location } = fixture()
  const config = normalizeConfig({})
  const state = new SessionMemoryState()
  const result = buildRecall(location, state, config, { files: ['feedback.md', 'MEMORY.md'] })
  assert.equal(result.complete, true)
  assert.match(result.text, /Never summarize diffs/)
  assert.match(result.text, /# Memory Index/)
  assert.deepEqual(result.files.sort(), ['MEMORY.md', 'feedback.md'])

  const escape = buildRecall(location, new SessionMemoryState(), config, { files: ['../secret.md'] })
  assert.equal(escape.complete, false)
  assert.ok(escape.missing.some(item => item.relPath.includes('../secret.md')))
  assert.match(escape.text, /traverse|outside|relative/i)
  cleanup(temp)
})

test('scan skips symlinks that escape the memory directory', () => {
  const { temp, location, memoryDir } = fixture()
  const outside = join(temp, 'outside-secret.md')
  writeFile(outside, 'TOP SECRET OUTSIDE CONTENT')
  symlinkSync(outside, join(memoryDir, 'escape.md'))
  const config = normalizeConfig({})
  const scan = scanMemoryDir(location, config)
  assert.ok(scan.warnings.some(w => w.code === 'SYMLINK_ESCAPE'))
  assert.equal(scan.topics.some(topic => topic.relPath === 'escape.md'), false)
  const overview = buildOverview(location, config)
  assert.doesNotMatch(overview.text, /TOP SECRET OUTSIDE CONTENT/)
  cleanup(temp)
})

test('oversized files are not silently truncated', () => {
  const { temp, location } = fixture({
    extraFiles: {
      'huge.md': `huge\n${'z'.repeat(5000)}\n`,
    },
  })
  const config = normalizeConfig({ maxFileBytes: 4096 })
  const state = new SessionMemoryState()
  const result = buildFullRecall(location, state, config, { cursor: 0 })
  assert.equal(result.complete, false)
  assert.ok(result.skipped.some(item => item.relPath === 'huge.md'))
  assert.match(result.text, /not loaded/)
  assert.match(result.text, /above maxFileBytes/)
  assert.doesNotMatch(result.text, /z{100}/)
  cleanup(temp)
})

test('missing memory and missing topic files are reported safely', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'project')
  ensureDir(project)
  const location = resolveMemoryLocation({ cwd: project, env: {}, home })
  const config = normalizeConfig({})
  const full = buildFullRecall(location, new SessionMemoryState(), config, { cursor: 0 })
  assert.equal(full.complete, true)
  assert.match(full.text, /No Claude Code Auto Memory directory exists/)
  const recall = buildRecall(location, new SessionMemoryState(), config, { files: ['missing.md'] })
  assert.equal(recall.complete, false)
  assert.equal(recall.missing[0].relPath, 'missing.md')
  const status = buildStatus(location, scanMemoryDir(location, config), config, new SessionMemoryState())
  assert.match(status, /does not exist/)
  cleanup(temp)
})

test('read-only invariant: all recall paths leave files byte-for-byte unchanged', () => {
  const { temp, memoryDir, location } = fixture()
  const before = treeSnapshot(memoryDir)
  const config = normalizeConfig({ maxBatchChars: 6000 })
  const state = new SessionMemoryState()
  buildOverview(location, config)
  buildFullRecall(location, state, config, { cursor: 0 })
  buildRecall(location, state, config, { query: 'pnpm build' })
  buildFullRecall(location, new SessionMemoryState(), config, { cursor: 0, force: true })
  buildStatus(location, scanMemoryDir(location, config), config, state)
  const after = treeSnapshot(memoryDir)
  assertSnapshotsEqual(assert, before, after)
  assert.equal(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8').includes('Memory Index'), true)
  cleanup(temp)
})

test('local relevance scores metadata before content and is capped', () => {
  const { temp, location } = fixture()
  const config = normalizeConfig({ maxRecallFiles: 2 })
  const scan = scanMemoryDir(location, config)
  const index = readMemoryIndex(location, config)
  const selected = selectRelevantTopics(location, scan.topics, 'build deployment', config, index.raw)
  assert.ok(selected.selected.length <= 2)
  assert.ok(selected.selected.some(topic => topic.relPath === 'build.md'))
  cleanup(temp)
})

test('resolveMemoryFile rejects traversal and absolute paths', () => {
  const { temp, location } = fixture()
  const config = normalizeConfig({})
  assert.equal(resolveMemoryFile(location, '../x.md', config).ok, false)
  assert.equal(resolveMemoryFile(location, '/etc/passwd', config).ok, false)
  assert.equal(resolveMemoryFile(location, 'nested/../../x.md', config).ok, false)
  const ok = resolveMemoryFile(location, 'build.md', config)
  assert.equal(ok.ok, true)
  assert.match(ok.content, /make build/)
  cleanup(temp)
})
