/** The standard every registered case is held to; see `case.ts`. */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StandardCase } from './case.ts'
import { cases } from './cases/index.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-standard-case-'))
  roots.push(root)
  return root
}

function snapshot(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).toSorted()
}

describe('standard case registry', () => {
  it('lists every case directory exactly once, under its own name', () => {
    const directories = readdirSync(join(import.meta.dirname, 'cases'), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name).toSorted()
    expect(cases.map(standardCase => standardCase.name).toSorted()).toEqual(directories)
  })
})

describe.each(cases.map(standardCase => [standardCase.name, standardCase] as const))('standard case %s', (_name, standardCase) => {
  it('extends the base class and states its identity', () => {
    expect(standardCase).toBeInstanceOf(StandardCase)
    expect(standardCase.name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u)
    expect(standardCase.description.trim().length).toBeGreaterThan(20)
    expect(existsSync(join(import.meta.dirname, 'cases', standardCase.name, 'task.md'))).toBe(true)
    expect(standardCase.task().length).toBeGreaterThan(50)
    expect(Number.isInteger(standardCase.expectations.minTeammates) && standardCase.expectations.minTeammates >= 0).toBe(true)
    expect(standardCase.expectations.minTeammatesCompletingTasks).toBeLessThanOrEqual(standardCase.expectations.minTeammates)
  })

  it('prepares the same workspace every time', () => {
    const first = workspace()
    const second = workspace()
    standardCase.prepare(first)
    standardCase.prepare(second)
    expect(snapshot(first)).toEqual(snapshot(second))
  })

  it('fails every output item for a workspace the run never touched', () => {
    const untouched = workspace()
    standardCase.prepare(untouched)
    const items = standardCase.judgeOutputs(untouched)
    expect(items.length).toBeGreaterThan(0)
    expect(new Set(items.map(item => item.id)).size).toBe(items.length)
    expect(items.filter(item => item.passed)).toEqual([])
    for (const item of items) expect(item.detail.trim()).not.toBe('')
  })

  it('keeps output item ids apart from the shared trajectory ids', () => {
    const trajectory = standardCase.judgeTrajectory({ exitCode: undefined, timedOut: false, unsettled: [], agents: [], tasks: [] })
    const outputs = standardCase.judgeOutputs(workspace())
    const ids = [...trajectory, ...outputs].map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
