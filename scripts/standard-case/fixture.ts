/** The standard case's fixed input and the results a correct run produces from it. */

/** One order row of the fixture. */
export interface Order {
  readonly orderId: string
  readonly customer: string
  readonly region: string
  readonly amount: number
  readonly status: 'paid' | 'refunded' | 'pending'
}

const CUSTOMERS = ['Acme', 'Borealis', 'Cobalt', 'Dune', 'Ember', 'Fjord', 'Garnet'] as const
const REGIONS = ['north', 'south', 'east', 'west'] as const
const STATUSES = ['paid', 'paid', 'paid', 'refunded', 'paid', 'pending'] as const

function cycle<Value>(values: readonly [Value, ...Value[]], index: number): Value {
  return values[index % values.length] ?? values[0]
}

/**
 * The fixture's orders, derived from reviewed constants so every run reads the same file.
 * @returns 60 orders across seven customers and four regions.
 */
export function orders(): Order[] {
  return Array.from({ length: 60 }, (_, index): Order => ({
    orderId: `o-${String(index + 1).padStart(3, '0')}`,
    customer: cycle(CUSTOMERS, index * 3 + Math.floor(index / 7)),
    region: cycle(REGIONS, index * 5 + Math.floor(index / 4)),
    amount: ((index * 37) % 211) + 10 + ((index * 13) % 100) / 100,
    status: cycle(STATUSES, index),
  }))
}

/**
 * Render the fixture as the CSV file the task reads.
 * @returns CSV text with a header row and one line per order.
 */
export function ordersCsv(): string {
  const rows = orders().map(order => [order.orderId, order.customer, order.region, order.amount.toFixed(2), order.status].join(','))
  return `${['order_id,customer,region,amount,status', ...rows].join('\n')}\n`
}

function paidTotals(key: 'customer' | 'region'): Map<string, number> {
  const totals = new Map<string, number>()
  for (const order of orders()) {
    if (order.status !== 'paid') continue
    totals.set(order[key], (totals.get(order[key]) ?? 0) + Math.round(order.amount * 100))
  }
  return new Map([...totals].map(([name, cents]) => [name, cents / 100]))
}

/**
 * The paid total per region a correct `out/region_totals.json` states.
 * @returns region name to total, rounded to 2 decimals.
 */
export function expectedRegionTotals(): Record<string, number> {
  return Object.fromEntries(paidTotals('region'))
}

/**
 * The rows a correct `out/top_customers.csv` lists below its header.
 * @returns the three customers with the highest paid totals, highest first.
 */
export function expectedTopCustomers(): { customer: string; total: number }[] {
  return [...paidTotals('customer')]
    .map(([customer, total]) => ({ customer, total }))
    .toSorted((left, right) => right.total - left.total)
    .slice(0, 3)
}
