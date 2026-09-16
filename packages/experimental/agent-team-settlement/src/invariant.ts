/** Package-owned invariant companion for one-shot run settlement. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-agent-team-settlement'

/** Cordis companion plugin name. */
export const name = 'agent-team-settlement-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: every task transition this plugin requests is validated by the Team service's own replay fold. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
