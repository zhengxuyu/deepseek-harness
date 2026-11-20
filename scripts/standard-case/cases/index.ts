/** Every standard case, in the order a run without a named case executes them. */

import type { StandardCase } from '../case.ts'
import { OrdersReportCase } from './orders-report/case.ts'

/** The registered cases. Add a new case's instance here. */
export const cases: readonly StandardCase[] = [
  new OrdersReportCase(),
]
