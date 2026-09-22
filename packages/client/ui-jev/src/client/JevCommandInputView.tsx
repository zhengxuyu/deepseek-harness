import { memo } from 'react'
import { projectUserText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { JEV_COMMAND, type JevCommandInputData } from './jev-command-input.ts'
import css from './JevCommandInputView.module.css'

type JevCommandInputViewProps =
  PropsRuntime<'conversation.chat.node', 'jev-command-input'>
  & PropsLocale<'jev'>

/** Right-aligned `/jev` question bubble: a dimmed command name, then the question, with no message actions. */
export const JevCommandInputView = memo(function JevCommandInputView({ node, t }: JevCommandInputViewProps) {
  const data: JevCommandInputData = node.data
  return (
    <div className={css.row} data-jev-command-input="" role="group" aria-label={t('commandInput.aria')}>
      <div className={css.bubble}>
        {projectUserText(`/${JEV_COMMAND}`, [], [JEV_COMMAND], 'command')}
        {data.question.length > 0 && projectUserText(` ${data.question}`, [])}
      </div>
    </div>
  )
})
