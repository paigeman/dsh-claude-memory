import assert from 'node:assert/strict'
import { realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  findGitRoot,
  resolveCanonicalGitRoot,
  resolveMemoryLocation,
  managedSettingsDir,
  readSettingsFile,
} from '../lib/paths.js'
import {
  parseJsonc,
  sanitizePath,
  sanitizedPrefix,
  validateMemoryPath,
  validateProjectDirName,
} from '../lib/util.js'
import {
  cleanup,
  ensureDir,
  git,
  makeGitRepo,
  makeTemp,
  makeWorktree,
  memoryPath,
  writeFile,
} from './helpers.js'

test('sanitizePath matches Claude Code encoding', () => {
  assert.equal(sanitizePath('/Users/foo/my-project'), '-Users-foo-my-project')
  assert.equal(sanitizePath('C:\\Users\\foo'), 'C--Users-foo')
  assert.equal(sanitizePath('/Users/foo/04-workspace_jpstar'), '-Users-foo-04-workspace-jpstar')
  assert.equal(sanitizePath('/a.b/c d/e_f'), '-a-b-c-d-e-f')
  const long = `/Users/${'x'.repeat(240)}`
  const encoded = sanitizePath(long)
  assert.equal(encoded.length > 200, true)
  assert.match(encoded, /^[A-Za-z0-9-]{200}-[a-z0-9]+$/)
})

test('JSONC settings parser keeps strings and removes comments/trailing commas', () => {
  const parsed = parseJsonc(`{
    // comment
    "autoMemoryDirectory": "~/memory", /* block */
    "url": "https://example.com/a//b",
    "list": [1, 2,],
  }`)
  assert.equal(parsed.autoMemoryDirectory, '~/memory')
  assert.equal(parsed.url, 'https://example.com/a//b')
  assert.deepEqual(parsed.list, [1, 2])
})

test('memory path validation rejects unsafe overrides', () => {
  assert.match(validateMemoryPath('relative/dir').error, /unsafe|non-absolute/)
  assert.match(validateMemoryPath('/').error, /unsafe/)
  assert.match(validateMemoryPath('C:\\').error, /unsafe/)
  assert.match(validateMemoryPath('\\\\server\\share').error, /unsafe/)
  assert.match(validateMemoryPath('~').error, /unsafe|non-absolute/)
  assert.equal(validateMemoryPath('/tmp/memory').value, '/tmp/memory')
  assert.equal(validateMemoryPath('~/memory', { expandHome: true, home: '/Users/x' }).value, '/Users/x/memory')
  assert.match(validateProjectDirName('../escape').error, /single path component/)
  assert.match(validateProjectDirName('a/b').error, /single path component/)
  assert.equal(validateProjectDirName('-Users-foo').value, '-Users-foo')
})

test('managed settings path is platform-specific', () => {
  assert.equal(managedSettingsDir('darwin'), '/Library/Application Support/ClaudeCode')
  assert.equal(managedSettingsDir('linux'), '/etc/claude-code')
  assert.equal(managedSettingsDir('win32'), 'C:\\Program Files\\ClaudeCode')
})

test('non-git project maps to its own sanitized path', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'plain-project')
  ensureDir(project)
  const configHome = join(home, '.claude')
  const dir = memoryPath(configHome, project, {
    'MEMORY.md': '- [A](a.md) — a\n',
    'a.md': 'alpha\n',
  })
  const location = resolveMemoryLocation({ cwd: project, env: {}, home })
  assert.equal(location.ok, true)
  assert.equal(location.projectRoot, realpathSync(project))
  assert.equal(location.memoryDir, realpathSync(dir))
  assert.equal(location.memoryDirExists, true)
  assert.equal(location.entrypointExists, true)
  assert.equal(location.source, 'computed')
  cleanup(temp)
})

test('git subdirectory maps to the repository root', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const repo = makeGitRepo(join(temp, 'repo'))
  const sub = join(repo, 'packages', 'app', 'src')
  ensureDir(sub)
  const dir = memoryPath(join(home, '.claude'), realpathSync(repo), {
    'MEMORY.md': '- [A](a.md) — a\n',
  })
  const location = resolveMemoryLocation({ cwd: sub, env: {}, home })
  assert.equal(location.ok, true)
  assert.equal(location.projectRoot, realpathSync(repo))
  assert.equal(location.memoryDir, realpathSync(dir))
  cleanup(temp)
})

test('git worktree maps to the main repository memory', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const main = makeGitRepo(join(temp, 'main'))
  const worktree = makeWorktree(main, join(temp, 'worktree'))
  const configHome = join(home, '.claude')
  const dir = memoryPath(configHome, realpathSync(main), {
    'MEMORY.md': '- [WT](worktree.md) — shared\n',
    'worktree.md': 'shared memory\n',
  })
  const location = resolveMemoryLocation({ cwd: worktree, env: {}, home })
  assert.equal(location.ok, true)
  assert.equal(location.projectRoot, realpathSync(main))
  assert.equal(location.isWorktree, true)
  assert.equal(location.memoryDir, realpathSync(dir))
  assert.equal(location.memoryDirExists, true)
  const canonical = resolveCanonicalGitRoot(findGitRoot(worktree))
  assert.equal(canonical.root, realpathSync(main))
  cleanup(temp)
})

test('symlinked cwd resolves to the real repository and same memory', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const repo = makeGitRepo(join(temp, 'real-repo'))
  const link = join(temp, 'linked-worktree')
  symlinkSync(repo, link, 'dir')
  const dir = memoryPath(join(home, '.claude'), realpathSync(repo), {
    'MEMORY.md': 'index\n',
  })
  const location = resolveMemoryLocation({ cwd: link, env: {}, home })
  assert.equal(location.ok, true)
  assert.equal(location.cwd, realpathSync(repo))
  assert.equal(location.memoryDir, realpathSync(dir))
  cleanup(temp)
})

test('CLAUDE_CONFIG_DIR selects a custom config root', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'project')
  ensureDir(project)
  const custom = join(temp, 'custom-claude')
  const dir = memoryPath(custom, project, { 'MEMORY.md': 'custom\n' })
  const location = resolveMemoryLocation({
    cwd: project,
    env: { CLAUDE_CONFIG_DIR: custom },
    home,
  })
  assert.equal(location.ok, true)
  assert.equal(location.configHome, custom)
  assert.equal(location.memoryDir, realpathSync(dir))
  cleanup(temp)
})

test('autoMemoryDirectory from user settings is honored with ~ expansion', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'project')
  ensureDir(project)
  const custom = join(home, 'my-claude-memory')
  ensureDir(custom)
  writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/my-claude-memory' }))
  const location = resolveMemoryLocation({ cwd: project, env: {}, home })
  assert.equal(location.ok, true)
  assert.equal(location.memoryDir, realpathSync(custom))
  assert.equal(location.source, 'settings:userSettings')
  assert.equal(location.explicitOverride, true)
  cleanup(temp)
})

test('local settings win over user settings and conflicts are reported', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'project')
  ensureDir(project)
  const userDir = join(home, 'user-memory')
  const localDir = join(project, 'local-memory')
  ensureDir(userDir)
  ensureDir(localDir)
  writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: userDir }))
  writeFile(join(project, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: localDir }))
  const location = resolveMemoryLocation({ cwd: project, env: {}, home })
  assert.equal(location.memoryDir, realpathSync(localDir))
  assert.equal(location.source, 'settings:localSettings')
  assert.ok(location.warnings.some(w => w.code === 'CONFIG_CONFLICT'))
  cleanup(temp)
})

test('policy settings win over local and user settings', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'project')
  ensureDir(project)
  const policyDir = join(temp, 'policy')
  const policyMemory = join(temp, 'policy-memory')
  const localMemory = join(temp, 'local-memory')
  ensureDir(policyDir)
  ensureDir(policyMemory)
  ensureDir(localMemory)
  writeFile(join(policyDir, 'managed-settings.json'), JSON.stringify({ autoMemoryDirectory: policyMemory }))
  writeFile(join(project, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: localMemory }))
  const location = resolveMemoryLocation({
    cwd: project,
    env: { CLAUDE_CODE_MANAGED_SETTINGS_PATH: policyDir },
    home,
  })
  assert.equal(location.memoryDir, realpathSync(policyMemory))
  assert.equal(location.source, 'settings:policySettings')
  cleanup(temp)
})

test('project .claude/settings.json autoMemoryDirectory is ignored', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'project')
  ensureDir(project)
  const hostile = join(temp, 'hostile-memory')
  ensureDir(hostile)
  writeFile(join(project, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: hostile }))
  const location = resolveMemoryLocation({ cwd: project, env: {}, home })
  assert.equal(location.ok, true)
  assert.notEqual(location.memoryDir, realpathSync(hostile))
  assert.ok(location.warnings.some(w => w.code === 'PROJECT_SETTING_IGNORED'))
  cleanup(temp)
})

test('CLAUDE_CODE_PROJECT_DIR_NAME selects an explicit project directory', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'project')
  ensureDir(project)
  const customName = 'my-custom-project'
  const dir = join(home, '.claude', 'projects', customName, 'memory')
  ensureDir(dir)
  writeFile(join(dir, 'MEMORY.md'), 'custom name\n')
  const location = resolveMemoryLocation({
    cwd: project,
    env: { CLAUDE_CODE_PROJECT_DIR_NAME: customName },
    home,
  })
  assert.equal(location.ok, true)
  assert.equal(location.projectDirName, customName)
  assert.equal(location.memoryDir, realpathSync(dir))
  assert.equal(location.source, 'env:CLAUDE_CODE_PROJECT_DIR_NAME')
  cleanup(temp)
})

test('symlinked memory directory escaping projects/ is refused', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'project')
  ensureDir(project)
  const outside = join(temp, 'other-repo-memory')
  ensureDir(outside)
  writeFile(join(outside, 'MEMORY.md'), 'other repo\n')
  const projectName = realpathSync(project).replace(/[^a-zA-Z0-9]/g, '-')
  const parent = join(home, '.claude', 'projects', projectName)
  ensureDir(parent)
  symlinkSync(outside, join(parent, 'memory'), 'dir')
  const location = resolveMemoryLocation({ cwd: project, env: {}, home })
  assert.equal(location.ok, false)
  assert.equal(location.code, 'SYMLINK_ESCAPE')
  cleanup(temp)
})

test('missing memory is reported without guessing a sibling', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'project')
  ensureDir(project)
  const location = resolveMemoryLocation({ cwd: project, env: {}, home })
  assert.equal(location.ok, true)
  assert.equal(location.memoryDirExists, false)
  assert.match(location.memoryDir, /projects/)
  cleanup(temp)
})

test('long project names with multiple candidates are ambiguous and refused', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'a'.repeat(70), 'b'.repeat(70), 'c'.repeat(70))
  ensureDir(project)
  const prefix = sanitizedPrefix(realpathSync(project))
  const projectsDir = join(home, '.claude', 'projects')
  ensureDir(join(projectsDir, `${prefix}-aaa`, 'memory'))
  ensureDir(join(projectsDir, `${prefix}-bbb`, 'memory'))
  writeFile(join(projectsDir, `${prefix}-aaa`, 'memory', 'MEMORY.md'), 'a\n')
  writeFile(join(projectsDir, `${prefix}-bbb`, 'memory', 'MEMORY.md'), 'b\n')
  const location = resolveMemoryLocation({ cwd: project, env: {}, home })
  assert.equal(location.ok, false)
  assert.equal(location.code, 'AMBIGUOUS_PROJECT_DIR')
  assert.match(location.reason, /ambiguous long project path/)
  cleanup(temp)
})

test('autoMemoryEnabled=false is reported and stays readable', () => {
  const temp = makeTemp()
  const home = join(temp, 'home')
  const project = join(temp, 'project')
  ensureDir(project)
  memoryPath(join(home, '.claude'), project, { 'MEMORY.md': 'x\n' })
  writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ autoMemoryEnabled: false }))
  const location = resolveMemoryLocation({ cwd: project, env: {}, home })
  assert.equal(location.autoMemoryEnabled.enabled, false)
  assert.equal(location.autoMemoryEnabled.source, 'settings:userSettings')
  assert.equal(location.memoryDirExists, true)
  cleanup(temp)
})

test('readSettingsFile parses JSONC and reports malformed JSON', () => {
  const temp = makeTemp()
  const good = writeFile(join(temp, 'good.json'), '{// c\n"a": 1,}')
  const bad = writeFile(join(temp, 'bad.json'), '{oops')
  assert.equal(readSettingsFile(good).value.a, 1)
  assert.match(readSettingsFile(bad).error, /cannot parse settings/)
  cleanup(temp)
})
