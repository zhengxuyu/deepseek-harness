/**
 * Case `orders-report`: three files derived from one orders table, two of
 * them independent and one depending on both. It exercises the plain path of
 * a Team: the Lead divides the work between two teammates, waits for both,
 * and finishes the dependent part itself.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StandardCase } from '../../case.ts'
import type { RubricItem, TeamExpectations } from '../../case.ts'
import { expectedRegionTotals, expectedTopCustomers, ordersCsv } from './fixture.ts'

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

function sameAmount(left: unknown, right: number): boolean {
  const value = typeof left === 'string' ? Number(left) : left
  return typeof value === 'number' && Math.abs(value - right) < 0.005
}

/** The orders-report case; see the module comment. */
export class OrdersReportCase extends StandardCase {
  readonly name = 'orders-report'
  readonly description = 'Two teammates each derive one file from an orders table in parallel, then the Lead writes a report from both.'
  protected readonly directory = import.meta.dirname
  readonly expectations: TeamExpectations = { minTeammates: 2, minTeammatesCompletingTasks: 2 }

  prepare(workspace: string): void {
    mkdirSync(join(workspace, 'data'), { recursive: true })
    writeFileSync(join(workspace, 'data', 'orders.csv'), ordersCsv())
  }

  judgeOutputs(workspace: string): RubricItem[] {
    const regions = expectedRegionTotals()
    const customers = expectedTopCustomers()
    const items: RubricItem[] = []

    const regionText = readText(join(workspace, 'out/region_totals.json'))
    let regionDetail = 'out/region_totals.json is missing'
    let regionPassed = false
    if (regionText !== undefined) {
      try {
        const parsed: unknown = JSON.parse(regionText)
        const actual: Record<string, unknown> = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {}
        const wrong = Object.entries(regions).filter(([region, total]) => !sameAmount(actual[region], total)).map(([region]) => region)
        const extra = Object.keys(actual).filter(region => !(region in regions))
        regionPassed = wrong.length === 0 && extra.length === 0
        regionDetail = regionPassed ? 'every region total matches' : `wrong or missing: ${wrong.join(', ') || 'none'}; unexpected keys: ${extra.join(', ') || 'none'}`
      } catch (error: unknown) {
        regionDetail = `not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    items.push({ id: 'region-totals', criterion: 'out/region_totals.json states the paid total of every region', passed: regionPassed, detail: regionDetail })

    const customerText = readText(join(workspace, 'out/top_customers.csv'))
    let customerDetail = 'out/top_customers.csv is missing'
    let customerPassed = false
    if (customerText !== undefined) {
      const [header, ...rows] = customerText.split('\n').map(line => line.trim()).filter(line => line !== '')
      const parsed = rows.map(row => row.split(',').map(cell => cell.trim()))
      customerPassed = header === 'customer,total' && parsed.length === customers.length
        && customers.every((expected, index) => parsed[index]?.[0] === expected.customer && sameAmount(parsed[index][1], expected.total))
      customerDetail = customerPassed ? 'header and all three rows match, in order' : `got header "${header ?? ''}" and rows ${JSON.stringify(parsed)}`
    }
    items.push({ id: 'top-customers', criterion: 'out/top_customers.csv lists the three highest-paying customers in order', passed: customerPassed, detail: customerDetail })

    const report = readText(join(workspace, 'out/report.md'))
    const topRegion = Object.entries(regions).toSorted((left, right) => right[1] - left[1]).slice(0, 1)
    const needed = [
      ...topRegion.flatMap(([region, total]) => [region, total.toFixed(2)]),
      ...customers.slice(0, 1).flatMap(top => [top.customer, top.total.toFixed(2)]),
    ]
    const missing = report === undefined ? needed : needed.filter(piece => !report.includes(piece))
    items.push({
      id: 'report',
      criterion: 'out/report.md names the top region and the top customer with their totals',
      passed: report !== undefined && missing.length === 0,
      detail: report === undefined ? 'out/report.md is missing' : missing.length === 0 ? 'all four facts are quoted' : `does not contain: ${missing.join(', ')}`,
    })
    return items
  }
}
