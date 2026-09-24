/**
 * Output contracts checked against the workspace at `complete`: presence,
 * shape by kind, JSON schema validity, and the standalone rule for a Python
 * entry file. A claimed completion whose declared outputs are not on disk is
 * refused, naming what is missing, so `completed` means the artifacts exist.
 */

import { createHash } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileSystem, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { errorMessage, TeamError } from './error.ts'
import type { ArtifactContract, TaskArtifact, TeamId, TeamTaskId, TeamTaskSnapshot } from './types.ts'

/** What the check needs besides the task: the workspace and the retained-history root. */
export interface OutputCheckContext {
  readonly fs: FileSystem
  /** The completing task; its non-optional outputs must all be acceptable. */
  readonly task: TeamTaskSnapshot
  /** Workspace the contract paths are relative to; absent resolves against the filesystem's own base. */
  readonly cwd: string | undefined
  readonly teamId: TeamId
  /** Completed tasks whose artifacts an output at the same path may supersede. */
  readonly completed: readonly TeamTaskSnapshot[]
  readonly artifactRoot: string | undefined
}

/** Bytes read at most for hashing an output whose size the backend does not report. */
const HASH_READ_CAP = 256 * 1024 * 1024

const PNG = [0x89, 0x50, 0x4e, 0x47]
const JPEG = [0xff, 0xd8, 0xff]
const GIF = [0x47, 0x49, 0x46, 0x38]
const RIFF = [0x52, 0x49, 0x46, 0x46]
const NPY = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte)
}

/**
 * Top-level module names a Python source imports, including relative imports as `.`.
 * @param source - Python source text.
 * @returns distinct top-level module names in first-seen order.
 */
export function pythonImports(source: string): string[] {
  const names = new Set<string>()
  for (const line of source.split('\n')) {
    const [, fromName] = /^\s*from\s+(\.+|[A-Za-z_]\w*)[\w.]*\s+import\b/u.exec(line) ?? []
    if (fromName !== undefined) {
      names.add(fromName.startsWith('.') ? '.' : fromName)
      continue
    }
    const [, imported] = /^\s*import\s+(.+)$/u.exec(line) ?? []
    if (imported === undefined) continue
    for (const part of imported.split(',')) {
      const [, name] = /^\s*([A-Za-z_]\w*)/u.exec(part) ?? []
      if (name !== undefined) names.add(name)
    }
  }
  return [...names]
}

/** A sanitized directory name for one identity inside the artifact root. */
function safeSegment(value: string): string {
  return value.replaceAll(/[^\w.-]/gu, '_')
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // The only failure access reports for a retained copy is that none was kept.
    return false
  }
}

/** Check one contract; returns the failure text, or the artifact record when the output is acceptable. */
async function checkOne(
  context: OutputCheckContext,
  contract: ArtifactContract,
): Promise<{ failure: string } | { artifact: TaskArtifact }> {
  const { fs, cwd } = context
  const target: FsTarget = await fs.resolve(contract.path, cwd === undefined ? {} : { cwd })
  const info: FsInfo | undefined = await fs.stat(target)
  if (info === undefined) return { failure: `${contract.path}: declared, not produced` }
  if (info.type !== 'file') return { failure: `${contract.path}: is a ${info.type}, not a file` }
  /* v8 ignore next -- the local backend always reports a regular file's size; the cap serves backends that do not. */
  const bytes = await fs.readBytes(target, undefined, info.size ?? HASH_READ_CAP)
  if (bytes.length === 0) return { failure: `${contract.path}: is empty` }
  const text = (): string => new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  switch (contract.kind) {
    case 'file':
      break
    case 'json': {
      let value: unknown
      try {
        value = JSON.parse(text())
      } catch (error: unknown) {
        return { failure: `${contract.path}: is not valid JSON (${errorMessage(error)})` }
      }
      if (contract.schema !== undefined) {
        assertSupportedJsonSchema(contract.schema)
        const violations = validateJsonSchemaValue(contract.schema, value, contract.path)
        if (violations.length > 0) return { failure: `${contract.path}: does not match its schema: ${violations.join('; ')}` }
      }
      break
    }
    case 'csv': {
      const lines = text().split('\n').filter(line => line.trim() !== '')
      if (lines.length < 2) return { failure: `${contract.path}: has no data rows below its header` }
      break
    }
    case 'npy':
      if (!startsWith(bytes, NPY)) return { failure: `${contract.path}: is not a NumPy .npy file` }
      break
    case 'image':
      if (!(startsWith(bytes, PNG) || startsWith(bytes, JPEG) || startsWith(bytes, GIF) || startsWith(bytes, RIFF))) {
        return { failure: `${contract.path}: is not a PNG, JPEG, GIF, or WebP image` }
      }
      break
    case 'python': {
      const local: string[] = []
      for (const name of pythonImports(text())) {
        if (name === '.') {
          local.push('a relative import')
          continue
        }
        for (const candidate of [`${name}.py`, `${name}/__init__.py`]) {
          const moduleTarget = await fs.resolve(candidate, cwd === undefined ? {} : { cwd })
          if ((await fs.stat(moduleTarget)) !== undefined) {
            local.push(name)
            break
          }
        }
      }
      if (local.length > 0) {
        return { failure: `${contract.path}: imports workspace modules (${local.join(', ')}), so it does not run alone` }
      }
      break
    }
    /* v8 ignore next 2 -- ArtifactKind is closed and every member is handled above. */
    default:
      return { failure: `${contract.path}: unknown output kind` }
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const artifact: TaskArtifact = { path: contract.path, bytes: bytes.length, sha256 }
  const previous = context.completed
    .flatMap(task => (task.artifacts ?? [])
      .filter(item => item.path === contract.path)
      .map(item => ({ task: task.id, sha256: item.sha256 })))
    .at(-1)
  const supersedes = previous !== undefined && previous.sha256 !== sha256 ? previous : undefined
  const retained = await retain(context, contract.path, bytes, supersedes?.task)
  return {
    artifact: {
      ...artifact,
      ...supersedes === undefined ? {} : { supersedes },
      ...retained === undefined ? {} : { previousVersion: retained },
    },
  }
}

/**
 * Keep this version under the artifact root and return the retained path of
 * the superseded task's version when both retention and that copy exist.
 */
async function retain(
  context: OutputCheckContext,
  path: string,
  bytes: Uint8Array,
  supersededTask: TeamTaskId | undefined,
): Promise<string | undefined> {
  if (context.artifactRoot === undefined) return undefined
  const teamDir = join(context.artifactRoot, safeSegment(context.teamId))
  const current = join(teamDir, safeSegment(context.task.id), path)
  await mkdir(join(current, '..'), { recursive: true })
  await writeFile(current, bytes)
  if (supersededTask === undefined) return undefined
  const previous = join(teamDir, safeSegment(supersededTask), path)
  return (await exists(previous)) ? previous : undefined
}

/**
 * Check every declared output of a task about to complete.
 * @param context - the completing task, filesystem, workspace, retention root, and the completed tasks it may supersede.
 * @returns the artifact record per acceptable output, optional absent ones omitted.
 * @throws TeamError `TEAM_TASK_OUTPUT_MISSING` naming every unacceptable output.
 */
export async function checkOutputs(context: OutputCheckContext): Promise<TaskArtifact[]> {
  const { task } = context
  const artifacts: TaskArtifact[] = []
  const failures: string[] = []
  /* v8 ignore next -- the board calls this only for a task with declared outputs. */
  for (const contract of task.outputs ?? []) {
    const result = await checkOne(context, contract)
    if ('artifact' in result) {
      artifacts.push(result.artifact)
    } else if (contract.optional !== true) {
      failures.push(result.failure)
    }
  }
  if (failures.length > 0) {
    throw new TeamError(
      `team task "${task.id}" cannot complete: ${failures.join('; ')}`,
      'TEAM_TASK_OUTPUT_MISSING',
    )
  }
  return artifacts
}
