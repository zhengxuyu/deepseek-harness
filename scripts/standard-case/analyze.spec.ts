/** The standard-case runner and analysis: settings, log folding, the rubric, and the rendered summary. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyze, parseSessionLog, renderSummary } from './analyze.ts'
import { OrdersReportCase } from './cases/orders-report/case.ts'
import { RtlToLayoutCase } from './cases/rtl-to-layout/case.ts'
import { expectedRegionTotals, expectedTopCustomers, ordersCsv } from './cases/orders-report/fixture.ts'
import { patchLayer, resolveRevision, resolveSettings, runCase, toolVersions } from './run.ts'

const standardCase = new OrdersReportCase()
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function lines(id: string, events: [type: string, time: number, data: object][], parentSession?: string): string {
  return [{ type: 'session', version: 4, id, ...parentSession === undefined ? {} : { parentSession } }, ...events.map(([type, time, data], seq) => ({ type, seq, time, data }))]
    .map(row => `${JSON.stringify(row)}\n`).join('')
}

function task(id: string, status: string, ownerId?: string, lostCause?: string) {
  return { version: 3, task: { id, revision: 1, subject: `${id} subject`, status, ...ownerId === undefined ? {} : { ownerId }, ...lostCause === undefined ? {} : { lostCause } } }
}

function member(id: string, name: string, phase = 'active') {
  return { version: 2, member: { id, name, phase } }
}

function turn(calls: string[], end: string): [string, number, object][] {
  return [
    ['assistant/attempt', 1_990, { turn: 1, step: 1, stream: [] }],
    ['assistant/message', 2_000, { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 7_000, cacheWriteTokens: 300 } }],
    ...calls.map((name): [string, number, object] => ['tool/call', 2_100, { name }]),
    // The fields of a real `tool/result` event: the error flag is on the message, beside its content.
    ['tool/result', 2_200, { message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'x' }], ...calls.length > 1 ? { isError: true } : {} } }],
    ['turn/end', 9_000, { reason: { kind: end } }],
  ]
}

function runDirectory(logs: Record<string, string>, files: Record<string, string>, exitCode: number, stderr = ''): string {
  const out = mkdtempSync(join(tmpdir(), 'dsh-standard-case-'))
  roots.push(out)
  for (const [id, source] of Object.entries(logs)) {
    mkdirSync(join(out, 'dsh-home/sessions/workspace', id), { recursive: true })
    writeFileSync(join(out, 'dsh-home/sessions/workspace', id, 'session.v4.jsonl'), source)
  }
  mkdirSync(join(out, 'workspace/out'), { recursive: true })
  for (const [name, source] of Object.entries(files)) writeFileSync(join(out, 'workspace/out', name), source)
  writeFileSync(join(out, 'stderr.log'), stderr)
  writeFileSync(join(out, 'run.json'), JSON.stringify({
    case: standardCase.name, settings: resolveSettings({}), settlement: true, revision: 'r'.repeat(40), dirty: true, environment: 'image i@sha256:d', tools: { node: 'v24.0.0', yosys: 'Yosys 0.50' }, exitCode, signal: null, timedOut: false, startedAt: '2026-01-01T00:00:00.000Z', elapsedMs: 9_000,
  }))
  return out
}

describe('standard case fixture', () => {
  it('derives one fixed input and its results', () => {
    expect(ordersCsv().split('\n')).toHaveLength(62)
    expect(expectedRegionTotals()).toEqual({ north: 1133.91, south: 893.35, east: 1075, west: 1042.24 })
    expect(expectedTopCustomers()).toEqual([
      { customer: 'Borealis', total: 912.64 }, { customer: 'Ember', total: 732.78 }, { customer: 'Dune', total: 633.54 },
    ])
  })
})

describe('standard case settings', () => {
  it('defaults the route, treats empty variables as unset, and rejects malformed ones', () => {
    expect(resolveSettings({ STANDARD_CASE_PROVIDER: '', STANDARD_CASE_ROUTE: ' ' })).toMatchObject({
      provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', effort: 'high', apiKeyEnv: 'OPENROUTER_API_KEY',
      route: { baseURL: 'https://openrouter.ai/api/v1' },
    })
    expect(resolveSettings({ STANDARD_CASE_PROVIDER: 'p', STANDARD_CASE_ROUTE: '{"api":"x"}' }))
      .toMatchObject({ provider: 'p', model: 'deepseek/deepseek-v4.1-flash', route: { api: 'x' } })
    expect(() => resolveSettings({ STANDARD_CASE_ROUTE: '[]' })).toThrow('must be a JSON object')
  })

  it('composes the model, the Team, and settlement into the patch layer', () => {
    const patch = patchLayer(resolveSettings({}), '/home', 900_000)
    expect(patch).toContain('apiKeyEnv: OPENROUTER_API_KEY')
    expect(patch).toContain('compression: none')
    expect(load(patch)).toContainEqual({ id: 'session-persistence-jsonl', config: { root: join('/home', 'sessions'), compression: 'none' } })
    expect(patch).toContain('id: agent-team-settlement')
    expect(patch).toContain('deadlineMs: 900000')
    expect(patch).toContain('trackSubagentRuns: true')
    const without = patchLayer(resolveSettings({}), '/home', undefined)
    expect(without).toContain('id: tool-agent-team')
    expect(without).not.toContain('agent-team-settlement')
    expect(without).not.toContain('trackSubagentRuns')
  })
})

describe('standard case run record', () => {
  it('takes the revision a wrapper states, and asks git otherwise', () => {
    expect(resolveRevision({ STANDARD_CASE_REVISION: 'abc', STANDARD_CASE_DIRTY: '1' })).toEqual({ revision: 'abc', dirty: true })
    expect(resolveRevision({ STANDARD_CASE_REVISION: 'abc', STANDARD_CASE_DIRTY: '0' })).toEqual({ revision: 'abc', dirty: false })
    expect(() => resolveRevision({ STANDARD_CASE_REVISION: 'abc' })).toThrow('STANDARD_CASE_DIRTY must be 1 or 0')
    expect(resolveRevision({ STANDARD_CASE_REVISION: '' }).revision).toMatch(/^[0-9a-f]{40}$/u)
  })

  it('refuses an output directory that already holds files', async () => {
    const out = runDirectory({}, {}, 0)
    vi.stubEnv('OPENROUTER_API_KEY', 'not-a-key')
    await expect(runCase(standardCase, out)).rejects.toThrow('is not empty; choose a new --out')
  })

  it('records the first line each tool prints for its version', () => {
    expect(toolVersions([
      { command: process.execPath, versionArgs: ['--version'] },
      { command: 'dsh-standard-case-no-such-tool', versionArgs: ['-V'] },
    ])).toEqual({ 'node': process.version, [process.execPath]: process.version, 'dsh-standard-case-no-such-tool': 'unknown' })
  })
})

describe('standard case analysis', () => {
  it('reads a log only when it carries a Session header', () => {
    expect(parseSessionLog('{"type":"turn/end","time":1,"data":{}}\n')).toBeUndefined()
    expect(parseSessionLog('\n{"type":"session","id":"s","parentSession":"p"}\n{"seq":0}\n{"type":"turn/start","time":"x"}\n'))
      .toEqual({ id: 's', parent: 'p', events: [{ type: 'turn/start', time: 0, data: {} }] })
  })

  it('skips the line a killed run left unfinished, and refuses a complete line that is not JSON', () => {
    expect(parseSessionLog('{"type":"session","id":"s"}\n{"type":"turn/end","time":1,"data":{}}\n{"type":"tool/ca'))
      .toEqual({ id: 's', parent: undefined, events: [{ type: 'turn/end', time: 1, data: {} }] })
    expect(() => parseSessionLog('{"type":"session","id":"s"}\n{"type":"tool/ca\n')).toThrow(SyntaxError)
  })

  it('passes every rubric item for a run that divided the work and produced the files', () => {
    const regions = expectedRegionTotals()
    const [first, second, third] = expectedTopCustomers()
    const out = runDirectory({
      lead: lines('lead', [
        ['team/task', 1_000, task('task-1', 'in_progress', 'lead')],
        ['team/member', 1_500, member('a', 'alice', 'provisioning')],
        ['team/member', 1_600, member('a', 'alice')],
        ['team/member', 1_700, member('b', 'bob')],
        ['team/member', 1_700, { version: 2, member: { id: 'x' } }],
        ['team/task', 1_800, task('task-2', 'pending')],
        ['team/task', 1_800, { version: 3, task: { id: 'broken' } }],
        ['team/task', 1_900, task('task-2', 'in_progress', 'a')],
        ['team/task', 1_950, task('task-2', 'in_progress', 'a')],
        ['team/task', 2_000, task('task-3', 'in_progress', 'b')],
        ['team/task', 2_050, task('task-4', 'deleted')],
        ['team/message/queued', 2_500, { message: { senderId: 'a', targetId: 'lead' } }],
        ['team/task', 3_000, task('task-2', 'completed', 'a')],
        ['team/task', 3_100, task('task-3', 'completed', 'b')],
        ...turn(['wait_agent', 'write'], 'completed'),
        ['team/task', 9_100, task('task-1', 'completed', 'lead')],
      ]),
      a: lines('a', turn(['bash'], 'completed'), 'lead'),
      b: lines('b', [['tool/call', 2_100, {}], ...turn(['bash'], 'completed')], 'lead'),
      stranger: lines('stranger', turn(['bash'], 'completed'), 'a'),
    }, {
      'region_totals.json': JSON.stringify(regions),
      'top_customers.csv': `customer,total\n${[first, second, third].map(row => `${row?.customer},${row?.total.toFixed(2)}`).join('\n')}\n`,
      'report.md': 'north leads with 1133.91; Borealis is the top customer with 912.64.',
    }, 0)
    writeFileSync(join(out, 'dsh-home/sessions/workspace/lead/session.lock'), '')

    const analysis = analyze(standardCase, out)
    expect(analysis.rubric.filter(item => !item.passed)).toEqual([])
    expect(analysis.score).toEqual({ passed: 8, total: 8 })
    expect(analysis.agents.map(agent => [agent.name, agent.role, agent.modelRequests, agent.failedRequests, agent.toolErrors])).toEqual([
      ['lead', 'lead', 1, 1, 1], ['alice', 'teammate', 1, 1, 0], ['bob', 'teammate', 1, 1, 0],
    ])
    expect(analysis.agents[0]).toMatchObject({ inputTokens: 100, cacheReadTokens: 7_000, cacheWriteTokens: 300, outputTokens: 20, toolCalls: { wait_agent: 1, write: 1 }, turnEnds: ['completed'] })
    expect(analysis.agents[2]?.toolCalls).toEqual({ unknown: 1, bash: 1 })
    expect(analysis.tasks.map(item => [item.id, item.status, item.owner])).toEqual([
      ['task-1', 'completed', 'lead'], ['task-2', 'completed', 'alice'], ['task-3', 'completed', 'bob'], ['task-4', 'deleted', undefined],
    ])
    expect(analysis.timeline.map(entry => entry.text)).toEqual([
      'task-1 in_progress, owner lead: task-1 subject',
      'member alice joined',
      'member bob joined',
      'task-2 pending, owner nobody: task-2 subject',
      'task-2 in_progress, owner alice: task-2 subject',
      'task-3 in_progress, owner bob: task-3 subject',
      'task-4 deleted, owner nobody: task-4 subject',
      'message alice → lead',
      'task-2 completed, owner alice: task-2 subject',
      'task-3 completed, owner bob: task-3 subject',
      'lead turn ended completed',
      'task-1 completed, owner lead: task-1 subject',
    ])
    const summary = renderSummary(analysis)
    expect(summary).toContain('# Standard case: orders-report\n\nTwo teammates each derive')
    expect(summary).toContain('**Rubric: 8/8 passed.**')
    expect(summary).toContain('| lead | lead | 1 | completed | 1 | 1 | 100 | 7000 | 300 | 20 | wait_agent×1, write×1 | 1 |')
    expect(summary).toContain('Revision `rrrrrrrrrr` with uncommitted changes, model')
    expect(summary).toContain('Environment: image i@sha256:d; node v24.0.0; yosys Yosys 0.50.')
    expect(summary).toContain('| 0.5 | member alice joined |')
    expect(summary).not.toContain('## Unsettled')
  })

  it('fails the items a run that lost work and produced wrong files does not meet', () => {
    const out = runDirectory({
      lead: lines('lead', [
        ['team/task', 1_000, task('task-1', 'in_progress', 'lead')],
        ['team/member', 1_500, member('a', 'alice', 'failed')],
        ['team/member', 1_600, { version: 2, member: { id: 'c', name: 'carol', phase: 'failed', error: 'no | route' } }],
        ['team/task', 1_900, task('task-2', 'in_progress', 'ghost')],
        ['team/message/queued', 2_000, { message: {} }],
        ['turn/end', 3_000, { reason: {} }],
        ['team/task', 3_100, task('task-2', 'lost', 'ghost', 'run-ended')],
        ['team/task', 3_100, task('task-1', 'lost', 'lead', 'owner-failed')],
      ]),
      a: lines('a', [], 'lead'),
    }, {
      'region_totals.json': JSON.stringify({ north: '1133.91', south: 1, mars: 2 }),
      'top_customers.csv': 'name,total\nBorealis,912.64\n',
      'report.md': 'north leads.',
    }, 1, 'dsh: AUTH\ndsh: unsettled: task-2 "x" owned by ghost: still in progress\n')

    const analysis = analyze(standardCase, out)
    expect(Object.fromEntries(analysis.rubric.map(item => [item.id, item.detail]))).toEqual({
      'exit': 'exit 1, 1 unsettled row(s)',
      'lead-turn': 'turn ends: unknown',
      'teammates': '1 teammate(s): alice; never ran: alice',
      'division': 'completed tasks are owned by: none',
      'board': 'task-1 is lost (owner-failed); task-2 is lost (run-ended)',
      'region-totals': 'wrong or missing: south, east, west; unexpected keys: mars',
      'top-customers': 'got header "name,total" and rows [["Borealis","912.64"]]',
      'report': 'does not contain: 1133.91, Borealis, 912.64',
    })
    expect(analysis.score).toEqual({ passed: 0, total: 8 })
    expect(analysis.timeline.map(entry => entry.text)).toContain('member carol failed: no | route')
    expect(analysis.timeline.map(entry => entry.text)).toContain('member alice failed: no reason recorded')
    expect(analysis.timeline.map(entry => entry.text)).toContain('message nobody → nobody')
    const summary = renderSummary(analysis)
    expect(summary).toContain('| task-2 | lost (run-ended) | ghost | 1 | task-2 subject |')
    expect(summary).toContain('member carol failed: no \\| route')
    expect(summary).toContain('## Unsettled\n\n- task-2 "x" owned by ghost: still in progress')
  })

  it('finds the Lead by its Session header when it never formed a Team', () => {
    const out = runDirectory({ solo: lines('solo', turn(['bash'], 'completed')) }, {}, 0)
    const analysis = analyze(standardCase, out)
    expect(analysis.agents.map(agent => [agent.name, agent.role])).toEqual([['lead', 'lead']])
    expect(renderSummary(analysis)).toContain('Environment: ')
    // A record written before the run's tools were recorded has no environment to print.
    const record = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) as object
    writeFileSync(join(out, 'run.json'), JSON.stringify({ ...record, dirty: undefined, environment: undefined, tools: undefined }))
    const older = renderSummary(analyze(standardCase, out))
    expect(older).toContain('Revision `rrrrrrrrrr`, model')
    expect(older).not.toContain('Environment')
    expect(Object.fromEntries(analysis.rubric.map(item => [item.id, item.detail]))).toMatchObject({
      'lead-turn': 'turn ends: completed',
      'board': 'the board recorded no task',
    })
  })

  it('reports an informational item without counting it in the score', () => {
    const out = mkdtempSync(join(tmpdir(), 'dsh-standard-case-'))
    roots.push(out)
    const analysis = analyze(new RtlToLayoutCase(), out)
    const informational = analysis.rubric.filter(item => item.informational === true)
    expect(informational.map(item => item.id)).toEqual(['rtl-dataset'])
    expect(analysis.score).toEqual({ passed: 0, total: analysis.rubric.length - 1 })
    expect(renderSummary(analysis)).toContain('passes the dataset\'s own testbench (not scored) |')
  })

  it('reports a run that left nothing behind', () => {
    const out = mkdtempSync(join(tmpdir(), 'dsh-standard-case-'))
    roots.push(out)
    mkdirSync(join(out, 'workspace/out'), { recursive: true })
    writeFileSync(join(out, 'workspace/out/region_totals.json'), '{')
    const analysis = analyze(standardCase, out)
    expect(analysis).toMatchObject({ case: 'orders-report', run: undefined, agents: [], tasks: [], timeline: [], unsettled: [], score: { passed: 0, total: 8 } })
    expect(analysis.rubric.map(item => item.detail)).toEqual([
      'exit unknown, 0 unsettled row(s)',
      'no Lead log found',
      'the board recorded no task',
      '0 teammate(s): none',
      'completed tasks are owned by: none',
      expect.stringContaining('not valid JSON: '),
      'out/top_customers.csv is missing',
      'out/report.md is missing',
    ])
    expect(renderSummary(analysis)).toContain('**Rubric: 0/8 passed.**\n\n## Rubric')
  })
})
