/**
 * Service Definition and TypeSafe-backed implementation of the Jev judgment
 * seam (`ctx.jev`). Jev is TypeSafe's System One model: it answers typed
 * questions about supplied state with calibrated probabilities instead of
 * generating text. The service validates a request, resolves its credential
 * for that call, posts `/v1/systemone`, and validates the answers before any
 * consumer sees them.
 * @module @deepseek-ai/dsh-jev
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { JevError } from './error.ts'
import type { JevRequest, JevResult, SystemOneWireError } from './types.ts'
import { assertRequest, toResult, toWireRequest } from './wire.ts'

export { JevError } from './error.ts'
export {
  assertQuestion,
  assertRequest,
  JEV_MAX_SCORE_LEVELS,
  JEV_MIN_CHOICE_OPTIONS,
  JEV_MIN_SCORE_LEVELS,
  toResult,
  toWireRequest,
} from './wire.ts'
export type {
  JevAnswer,
  JevChoiceAnswer,
  JevChoiceQuestion,
  JevNoulAnswer,
  JevNoulQuestion,
  JevQuestion,
  JevRequest,
  JevResult,
  JevScoreAnswer,
  JevScoreQuestion,
  JevUsage,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jev: JevRuntime
  }
}

/** Credential reference resolved when the entry names none. */
const DEFAULT_API_KEY_ENV = 'TYPESAFE_API_KEY'

/** Public TypeSafe API base; {@link SYSTEM_ONE_PATH} is appended. */
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai'

/** Environment variable that overrides the endpoint base when the entry names none. */
const BASE_URL_ENV = 'TYPESAFE_BASE_URL'

/** The System One endpoint path under the base URL. */
export const SYSTEM_ONE_PATH = '/v1/systemone'

/** TypeSafe's alias for the current Jev release. */
export const JEV_DEFAULT_MODEL = 'jev-latest'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Plugin config: credential reference, endpoint, and model. Secrets stay out of configuration through `apiKeyEnv`. */
export interface Config {
  /** Literal TypeSafe API key; prefer {@link apiKeyEnv} so no secret enters configuration files. A non-empty literal wins. */
  apiKey?: string
  /** Credential reference resolved for each request; defaults to `TYPESAFE_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/v1/systemone` is appended. Falls back to `$TYPESAFE_BASE_URL`, then the public API. */
  baseURL?: string
  /** Model sent when a request names none. Defaults to `jev-latest`. */
  model?: string
}

/** Resolved endpoint facts a consumer may show without a value. */
export interface JevEndpointInfo {
  /** The credential reference each request resolves. */
  readonly apiKeyEnv: CredentialRef
  /** The endpoint base requests are posted under. */
  readonly baseURL: string
  /** The model sent when a request names none. */
  readonly model: string
}

/**
 * The Jev judgment service, registered as `ctx.jev`. One request is one
 * `decide()` call; questions inside it run in parallel on the provider and
 * cannot see one another's answers.
 */
export default class JevRuntime extends Service {
  static Config: z<Config> = z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
    model: z.string().default(JEV_DEFAULT_MODEL),
    // Declared so a configuration surface renders the resolved value; the
    // constructor still applies the environment and constant fallbacks.
    baseURL: z.string(),
    apiKey: z.string().role('secret'),
  })

  private readonly literalApiKey: string | undefined
  private readonly endpoint: JevEndpointInfo

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'jev')
    this.literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
    const baseURL = config.baseURL
      ?? launchEnvironmentOf(ctx).get(BASE_URL_ENV)?.value
      ?? JEV_DEFAULT_BASE_URL
    if (!URL.canParse(baseURL)) throw new TypeError(`jev: baseURL ${JSON.stringify(baseURL)} is not an absolute URL`)
    this.endpoint = {
      apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
      baseURL: baseURL.replace(/\/+$/, ''),
      model: config.model ?? JEV_DEFAULT_MODEL,
    }
  }

  /**
   * Describe the endpoint without exposing any credential value.
   * @returns the credential reference, base URL, and default model in force.
   */
  describe(): JevEndpointInfo {
    return this.endpoint
  }

  /**
   * Resolve the API key for one call. A mounted credentials service is
   * authoritative; without one, the launch environment is the whole credential
   * plane. A literal `apiKey` wins over both.
   * @returns the key, or `undefined` when nothing resolves.
   */
  private async resolveApiKey(): Promise<string | undefined> {
    if (this.literalApiKey !== undefined) return this.literalApiKey
    const ref = this.endpoint.apiKeyEnv
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(ref))?.value
    const ambient = launchEnvironmentOf(this.ctx).get(ref)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }

  /**
   * Answer one request. Validation failures reject before any network call;
   * the credential is resolved per call so a stored or rotated key reaches the
   * next request without a restart.
   * @param request - state plus at least one typed question.
   * @param signal - optional cancellation; an abort rejects as `JEV_ABORTED`.
   * @returns one validated answer per question id.
   * @throws {JevError} with a code from the {@link JevError} taxonomy.
   */
  async decide(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    assertRequest(request)
    let apiKey: string | undefined
    try {
      apiKey = await this.resolveApiKey()
    } catch (error: unknown) {
      throw new JevError(`Jev credential resolution failed: ${String(error)}`, 'JEV_PROVIDER_ERROR', { cause: error })
    }
    if (apiKey === undefined) {
      throw new JevError(
        `no TypeSafe API key resolves for ${this.endpoint.apiKeyEnv}; store it through the credentials seam or the environment`,
        'JEV_CREDENTIAL_MISSING',
      )
    }
    if (signal?.aborted) throw new JevError('Jev request aborted', 'JEV_ABORTED', { cause: signal.reason })

    let response: Response
    try {
      response = await fetch(`${this.endpoint.baseURL}${SYSTEM_ONE_PATH}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(toWireRequest(request, this.endpoint.model)),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new JevError('Jev request aborted', 'JEV_ABORTED', { cause: error })
      throw new JevError(`Jev request failed: ${String(error)}`, 'JEV_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) throw await httpFailure(response)

    let body: unknown
    try {
      body = await response.json()
    } catch (error: unknown) {
      if (isAbortError(error)) throw new JevError('Jev request aborted', 'JEV_ABORTED', { cause: error })
      throw new JevError(`Jev returned an unprocessable response body: ${String(error)}`, 'JEV_PROVIDER_ERROR', { cause: error })
    }
    return toResult(request, body)
  }
}

/** Map one non-2xx response to its {@link JevError} code, keeping the provider's message when it has one. */
async function httpFailure(response: Response): Promise<JevError> {
  const status = response.status
  let message = `TypeSafe API error (HTTP ${status})`
  try {
    const parsed = await response.json() as SystemOneWireError
    const detail = typeof parsed.error === 'string'
      ? parsed.error
      : parsed.error?.message ?? parsed.message
    if (detail !== undefined && detail.length > 0) message = `${message}: ${detail}`
  } catch (error: unknown) {
    // An abort mid-body is a cancellation, never a provider error.
    if (isAbortError(error)) return new JevError('Jev request aborted', 'JEV_ABORTED', { cause: error })
    // Otherwise the status already carries the failure; a non-JSON error body
    // (normal for gateway 5xx/429s) only costs a richer message.
  }
  return new JevError(message, httpCode(status))
}

/** Classify an HTTP failure status into the seam's stable codes. */
function httpCode(status: number): string {
  if (status === 400 || status === 422) return 'JEV_INVALID_REQUEST'
  if (status === 401 || status === 403) return 'JEV_UNAUTHORIZED'
  if (status === 429 || status === 529) return 'JEV_RATE_LIMITED'
  return 'JEV_PROVIDER_ERROR'
}

/** True for a fetch/`AbortSignal` abort, surfaced as `JEV_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
