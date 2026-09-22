/** `jev` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'commandInput.aria': '向 Jev 提问',
  'answer.aria': 'Jev 的回答',
  'answer.sender': 'Jev · 快思考队友',
  'answer.thinking': 'Jev 正在判断…',
  'answer.done': '已完成',
  'answer.failed': 'Jev 没有给出回答',
} satisfies Record<string, string>

/** The jev namespace key union. */
export type JevKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'commandInput.aria': 'Question to Jev',
  'answer.aria': 'Answer from Jev',
  'answer.sender': 'Jev · fast-thinking teammate',
  'answer.thinking': 'Jev is deciding…',
  'answer.done': 'Completed',
  'answer.failed': 'Jev gave no answer',
} satisfies Record<JevKey, string>
