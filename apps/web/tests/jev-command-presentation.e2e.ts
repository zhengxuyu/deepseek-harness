// Web e2e: /jev on a fresh session shows its question bubble and Jev's
// answer message without a model turn. The overlay unsets the seam's credential
// reference, so the answer row is the deterministic keyless failure text.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-commands/types'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria,
  compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/jev-command-presentation', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/jev-command-presentation/ui.expected.md', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./jev-command-presentation.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()
// Jev is opt-in: the shipped rows stay disabled until a deployment says yes,
// and the scaffold boots the profile in this process.
process.env.DSH_JEV_ENABLED = 'yes'
const QUESTION = 'Which storage fits? | sqlite | jsonl'
const ANSWER_PREFIX = 'Jev is unavailable (JEV_CREDENTIAL_MISSING)'

describe('web e2e: /jev human transcript presentation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the question bubble and the answer row from a fresh session without a model turn', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-jev-command-presentation'))
    await expect.poll(() => page.getByText('Into the Unknown', { exact: false }).count(), { timeout: 15_000 }).toBe(1)
    const input = page.locator('[data-composer-input]').first()
    await input.fill(`/jev ${QUESTION}`)
    await input.press('Enter')

    const bubble = page.locator('[data-jev-command-input]')
    await bubble.waitFor({ timeout: 10_000 })
    await expect.poll(() => bubble.textContent()).toBe(`/jev ${QUESTION}`)
    expect(await bubble.getAttribute('role')).toBe('group')
    expect(await bubble.getAttribute('aria-label')).toBe('Question to Jev')
    expect(await bubble.getByRole('button').count()).toBe(0)
    const answer = page.locator('[data-jev-answer]').filter({ hasText: ANSWER_PREFIX })
    await expect.poll(() => answer.count(), { timeout: 10_000 }).toBe(1)
    expect(await answer.getAttribute('data-state')).toBe('error')
    expect(await answer.getAttribute('aria-label')).toBe('Answer from Jev')
    expect(await page.locator('[data-variant="others"]').count()).toBe(0)
    await expect.poll(() => page.locator('[data-phase="active"]').count()).toBe(1)
    expect(await page.getByText('Into the Unknown', { exact: false }).count()).toBe(0)

    expect(events.find(event => event.type === 'command/run')).toMatchObject({
      type: 'command/run',
      data: { name: 'jev', args: ` ${QUESTION}`, source: { kind: 'user' } },
    })
    expect(events.find(event => event.type === 'command/done')).toMatchObject({
      data: { kind: 'error', text: expect.stringContaining(ANSWER_PREFIX) as string },
    })
    expect(events.some(event => event.type === 'user/message')).toBe(false)
    expect(events.some(event => event.type === 'turn/start')).toBe(false)
    expect(events.some(event => event.type === 'step/start')).toBe(false)
    expect(events.some(event => event.type === 'request/header')).toBe(false)

    // The command result can arrive before Lexical clears the submitted claim.
    await expect.poll(() => input.textContent(), { timeout: 10_000 }).toBe('')
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('reloads the same bubble and row from the persisted command lifecycle', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-jev-command-presentation-reload'))
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)

    await expect.poll(() => page.locator('[data-jev-command-input]').textContent(), { timeout: 15_000 }).toBe(`/jev ${QUESTION}`)
    const answer = page.locator('[data-jev-answer]').filter({ hasText: ANSWER_PREFIX })
    await expect.poll(() => answer.count(), { timeout: 10_000 }).toBe(1)

    const sessions = scaffold.ctx.sessions.list()
    expect(sessions).toHaveLength(1)
    const persisted = sessions[0]?.snapshotEvents() ?? []
    expect(persisted.filter(event => event.type === 'command/run' || event.type === 'command/done').map(event => event.type))
      .toEqual(['command/run', 'command/done'])
    expect(persisted.some(event => event.type === 'turn/start')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 90_000)
})
