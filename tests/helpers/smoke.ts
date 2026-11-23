import { BASE_FIXTURE } from '../../shared/fixtures.ts'
import { solvePlan } from '../../shared/solver.ts'
import type { PlanMode } from '../../shared/types.ts'

const availability = Object.fromEntries(BASE_FIXTURE.lots.map((l) => [l.id, l.quantity]))
const modes: Array<[string, PlanMode]> = [
  ['nominal', { kind: 'nominal' }],
  ['box', { kind: 'box' }],
  ['budget Γ=2', { kind: 'budget', gamma: 2 }],
  ['budget Γ=4', { kind: 'budget', gamma: 4 }],
  ['chance α=0.9', { kind: 'chance', alpha: 0.9 }],
]
for (const [name, mode] of modes) {
  const { result } = await solvePlan({
    lots: BASE_FIXTURE.lots,
    heel: BASE_FIXTURE.heel,
    specSets: BASE_FIXTURE.specSets,
    specSetId: 'SPEC-92',
    availability,
    rho: 0.6,
    mode,
    sensitivity: true,
  })
  if (result.status !== 'optimal') {
    console.log(name, 'INFEASIBLE', result.message, JSON.stringify(result.diagnosis?.reasons))
    continue
  }
  console.log(
    `${name}: ¥${result.unitCost.toFixed(1)}/t  risk=${(result.risk.violatedProbability * 100).toFixed(1)}%  ` +
    result.allocations.map((a) => `${a.lotId}=${a.quantity.toFixed(0)}`).join(' '),
  )
  console.log('   nominal', fmt(result.nominal), 'guar', fmt(result.guaranteed), 'ens', fmt(result.ensembleWorst))
  const binding = result.limits.filter((l) => l.active).map((l) => `${l.property}:${l.dir} ~${l.costPerTenthTotal?.toFixed(0)}`)
  console.log('   active:', binding.join(', ') || '(none)', ' nominalBaseline', result.nominalUnitCost?.toFixed(1))
}
function fmt(o: Record<string, number>) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(2)]))
}
