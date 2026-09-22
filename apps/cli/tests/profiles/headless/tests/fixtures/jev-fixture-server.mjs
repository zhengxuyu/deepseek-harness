/**
 * Deterministic loopback stand-in for TypeSafe's `POST /v1/systemone` used by
 * the Jev headless snapshot: it checks the bearer key, answers each question
 * from its type (first option, a fixed noul, a fixed score distribution), and
 * echoes the sent criteria as the score legend. The port is fixed because the
 * seam's base URL is part of the recorded composition.
 */
import { createServer } from 'node:http'

/** Fixed loopback port the snapshot composition points `ctx.jev` at. */
const PORT = 43119
/** The literal key the snapshot composition configures. */
const API_KEY = 'jev-snapshot-key'

function answer(question) {
  switch (question.type) {
    case 'choice': {
      const names = Object.keys(question.criteria)
      const probabilities = Object.fromEntries(names.map((name, index) => [name, index === 0 ? 0.85 : 0.15 / (names.length - 1)]))
      return { type: 'choice', choice: names[0], probabilities, confidence: 0.8 }
    }
    case 'noul':
      return { type: 'noul', noul: 0.72 }
    case 'score': {
      const levels = question.criteria
      const legend = Object.fromEntries(levels.map((level, index) => [String(index), level]))
      const probabilities = Object.fromEntries(levels.map((_, index) => [String(index), index === 1 ? 0.7 : 0.3 / (levels.length - 1)]))
      const score = levels.reduce((sum, _, index) => sum + index * probabilities[String(index)], 0)
      return { type: 'score', score: Number(score.toFixed(2)), legend, probabilities, confidence: 0.54 }
    }
    default:
      return { type: question.type }
  }
}

/** Cordis plugin name. */
export const name = 'jev-fixture-server'

/**
 * Start the stand-in on 127.0.0.1 and register its shutdown.
 * @param ctx - Cordis context; the effect disposes the server with the fiber.
 */
export async function apply(ctx) {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/systemone') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"invalid api key"}')
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const request = JSON.parse(body)
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, answer(question)]))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 240, output_tokens: 36 } }))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, '127.0.0.1', () => resolve(undefined))
  })
  // The stand-in must never hold the process open past the one-shot exit.
  server.unref()
  ctx.effect(() => async () => {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve(undefined))
      server.closeAllConnections()
    })
  }, 'jev-fixture-server')
}
