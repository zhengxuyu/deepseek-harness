import { memo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './JevAnswerView.module.css'

type JevAnswerViewProps =
  PropsRuntime<'conversation.chat.commandview'>
  & PropsLocale<'jev'>

/**
 * The `/jev` result rendered as a left-aligned message from Jev instead of the
 * generic collapsed command row: a sender line, then the settled answer text,
 * the failure text, or a thinking placeholder while the run is open.
 */
export const JevAnswerView = memo(function JevAnswerView({ node, t }: JevAnswerViewProps) {
  const outcome = node.outcome
  const state = outcome === null ? 'running' : outcome.kind === 'error' ? 'error' : 'ok'
  const text = outcome === null
    ? t('answer.thinking')
    : outcome.text ?? (outcome.kind === 'error' ? t('answer.failed') : t('answer.done'))
  return (
    <div className={css.row} data-jev-answer="" data-state={state} role="group" aria-label={t('answer.aria')}>
      <span className={css.sender}>{t('answer.sender')}</span>
      <div className={css.text} data-error={state === 'error' || undefined} data-running={state === 'running' || undefined}>
        {text}
      </div>
    </div>
  )
})
