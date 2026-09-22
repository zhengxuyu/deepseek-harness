/**
 * Deterministic keyless adapter for the Jev headless snapshot: one `jev` tool
 * call over the three question types, then a final answer that repeats the
 * rendered judgments, so the transcript pins the real tool round trip.
 */

import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

const JEV_ARGS = {
  state: {
    ticket: 'The export button crashes the settings page in Safari. Chrome works, but several customers only use Safari.',
    candidates: { frontend: 'Owns the settings page and browser compatibility.', backend: 'Owns the export service.' },
  },
  questions: [
    { id: 'team', type: 'choice', instructions: 'Which team should own the ticket?', options: { frontend: 'UI and browser bugs', backend: 'Export service bugs' } },
    { id: 'urgent', type: 'noul', instructions: 'Does the ticket need same-day attention?' },
    { id: 'severity', type: 'score', instructions: 'How severe is the reported issue?', levels: ['Cosmetic; no impact to functionality', 'Broken or degraded feature, but a workaround exists', 'Blocking issue; no workaround exists'] },
  ],
}

function toolChunks() {
  const id = ToolCallId('jev-fixture-1')
  const args = JSON.stringify(JEV_ARGS)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'jev', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'jev', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function latestToolText(messages) {
  const message = messages.findLast(candidate => candidate.role === 'tool')
  if (message === undefined) return undefined
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

class JevFixtureAdapter extends LlmAdapter {
  async * stream(options) {
    const toolText = latestToolText(options.messages)
    const chunks = toolText === undefined
      ? toolChunks()
      : textChunks(`JEV_DECISION_OK\n${toolText}`)
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

/** Cordis plugin name. */
export const name = 'jev-fixture-llm'
/** LLM registry dependency. */
export const inject = ['llm']

/** Register the keyless adapter on the shipped default provider route. */
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new JevFixtureAdapter())
}
