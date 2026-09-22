import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import JevRuntime from '@deepseek-ai/dsh-jev'

/**
 * Real-API smoke for the Jev seam over OpenRouter's System One endpoint, the
 * route the shipped `dsh-base` row uses. Self-skips without
 * `$OPENROUTER_API_KEY` (CI has no secrets), per the with-key e2e policy in
 * docs/testing.md.
 */
const apiKey = process.env.OPENROUTER_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('JevRuntime real API through OpenRouter', () => {
  it('answers every question type with calibrated distributions', async () => {
    const ctx = new Context()
    await ctx.plugin(JevRuntime, {
      apiKey: apiKey!,
      baseURL: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api',
      model: 'typesafe/jev-1.13',
    })
    try {
      const result = await ctx.jev.decide({
        state: { ticket: 'The export button crashes the settings page in Safari. Chrome works, but several customers only use Safari.' },
        questions: {
          team: { type: 'choice', instructions: 'Which team should own the ticket?', options: { frontend: 'UI and browser bugs', backend: 'Export service bugs' } },
          bug: { type: 'noul', instructions: 'Is the customer reporting a software defect?' },
          severity: { type: 'score', instructions: 'How severe is the reported issue?', levels: ['Cosmetic', 'Degraded with a workaround', 'Blocking'] },
        },
      })
      expect(result.model).toContain('jev')
      const team = result.answers.team
      const bug = result.answers.bug
      const severity = result.answers.severity
      if (team?.type !== 'choice' || bug?.type !== 'noul' || severity?.type !== 'score') throw new Error('answer types drifted')
      expect(['frontend', 'backend']).toContain(team.choice)
      expect(Object.values(team.probabilities).reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 1)
      expect(bug.noul).toBeGreaterThan(0.5)
      expect(severity.score).toBeGreaterThanOrEqual(0)
      expect(severity.score).toBeLessThanOrEqual(2)
      expect(Object.keys(severity.legend)).toEqual(['0', '1', '2'])
      expect(result.usage.inputTokens).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 30_000)
})
