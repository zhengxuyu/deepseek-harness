/**
 * The Jev seam's error type. `code` is open like every other seam's error so
 * a future backend may add codes; consumers route on the codes below and
 * tolerate unknown ones.
 * @module @deepseek-ai/dsh-jev/error
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Stable failure classes raised by `ctx.jev`:
 * `JEV_INVALID_REQUEST` (a caller-side question or state violation, or an HTTP 400/422),
 * `JEV_CREDENTIAL_MISSING` (no API key resolves for the configured reference),
 * `JEV_UNAUTHORIZED` (HTTP 401/403), `JEV_RATE_LIMITED` (HTTP 429/529),
 * `JEV_ABORTED` (the caller's signal fired), and `JEV_PROVIDER_ERROR`
 * (network failure, any other HTTP status, or an unprocessable response body).
 */
export class JevError extends HarnessError {}
