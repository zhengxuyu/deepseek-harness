/** Input normalization shared by Team roster and task commands. */

import { TeamError } from './error.ts'

/**
 * Normalize one required human-authored string.
 * @param value - raw input value.
 * @param field - diagnostic field name.
 * @param maxLength - maximum normalized character count.
 * @returns trimmed non-empty text.
 */
export function requiredText(value: string, field: string, maxLength: number): string {
  const text = value.trim()
  if (text.length === 0) throw new TeamError(`${field} must be non-empty`, 'TEAM_INVALID_ARGUMENT')
  if (text.length > maxLength) {
    throw new TeamError(`${field} exceeds ${maxLength} characters`, 'TEAM_INVALID_ARGUMENT')
  }
  return text
}

/**
 * Normalize one workspace-relative path prefix without treating it as a lock.
 * An absolute path inside `cwd` is accepted as the same path relative to `cwd`;
 * any other absolute path is refused. The comparison is textual, so `cwd` and
 * the path must spell the directory the same way (no symlink or case folding).
 * @param value - user-authored path prefix.
 * @param cwd - the Team root's workspace directory, or `undefined` when the session has none.
 * @returns normalized slash-separated prefix.
 */
export function writeScope(value: string, cwd: string | undefined): string {
  let normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  const root = cwd?.replaceAll('\\', '/').replace(/\/+$/u, '')
  if (root !== undefined && root.length > 0 && normalized.startsWith(`${root}/`)) {
    normalized = normalized.slice(root.length + 1)
  }
  const segments = normalized.split('/')
  if (normalized.length === 0 || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TeamError(`invalid workspace-relative write scope ${JSON.stringify(value)}`, 'TEAM_INVALID_WRITE_SCOPE')
  }
  return normalized
}
