/**
 * The `/jev` input grammar: `question` asks a yes/no (noul) judgment;
 * `question | option | option …` asks Jev to pick one option (choice). Pure
 * parsing, no I/O.
 * @module @deepseek-ai/dsh-command-jev/grammar
 */

/** Human usage line returned on every grammar failure. */
export const JEV_COMMAND_USAGE = 'Usage: /jev <yes/no question>  or  /jev <question> | <option> | <option> [| …]'

/** Composer placeholder advertised to capable clients. */
export const JEV_COMMAND_HINT = 'question | option | option'

/** A parsed `/jev` line; `choice` carries at least two distinct options. */
export type JevCommandParse =
  | { readonly kind: 'noul'; readonly question: string }
  | { readonly kind: 'choice'; readonly question: string; readonly options: readonly string[] }

/** A rejected `/jev` line with the human error text to render. */
export interface JevCommandParseError {
  readonly error: string
}

/** Option separators: the ASCII bar and the full-width bar a CJK keyboard produces. */
const SEPARATOR = /[|｜]/u

/**
 * Parse the text after `/jev`. The first bar-separated segment (`|` or the
 * full-width `｜`) is the question; any further segments are options. One
 * option is rejected because a one-way choice is not a choice, and duplicate
 * options are rejected because Jev keys its distribution by option name.
 * @param rawInput - exact text following the command name.
 * @returns the parsed judgment request, or the error to show.
 */
export function parseJevCommand(rawInput: string): JevCommandParse | JevCommandParseError {
  // `split` always yields at least one segment.
  const [question, ...options] = rawInput.split(SEPARATOR).map(segment => segment.trim()) as [string, ...string[]]
  if (question.length === 0) return { error: JEV_COMMAND_USAGE }
  if (options.length === 0) return { kind: 'noul', question }
  if (options.some(option => option.length === 0)) return { error: `Every option must be non-empty. ${JEV_COMMAND_USAGE}` }
  if (options.length === 1) return { error: `A choice needs at least two options. ${JEV_COMMAND_USAGE}` }
  if (new Set(options).size !== options.length) return { error: `Options must be distinct. ${JEV_COMMAND_USAGE}` }
  return { kind: 'choice', question, options }
}
