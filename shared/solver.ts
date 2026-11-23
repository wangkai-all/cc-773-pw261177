import loadHighs from 'highs'
import type {
  AdversarialFactor,
  Assay,
  AssayCell,
  ChanceMode,
  Dir,
  Heel,
  InfeasibilityDiagnosis,
  LimitReport,
  Lot,
  LotReport,
  PlanAllocation,
  PlanMode,
  PlanResult,
  PropertyId,
  RiskReport,
  ScenarioSet,
  ScenarioViolation,
  SpecSet,
  ViolationReport,
} from './types.ts'
import { PROPERTY_IDS, property } from './catalog.ts'
import { LpBuilder } from './lp.ts'
import {
  buildFactors,
  buildScenarioSet,
  boxCornerProbability,
  boxDeviationTotal,
  budgetDeviationTotal,
  deviationForScenario,
  factorCoefficient,
  factorPartial,
  factorsByProperty,
  halfWidth,
  hasAssay,
  heelHasAssay,
  heelNominal,
  nominalQuality,
  type FactorDef,
  type HeelInput,
  type MixLine,
} from './uncertainty.ts'

export interface SolveContext {
  lots: Lot[]
  heel: Heel
  specSets: SpecSet[]
  specSetId: string
  availability: Record<string, number>
  rho: number
  mode: PlanMode
  volume?: number
  clientVersion?: number
  lotOverrides?: Record<string, Partial<Record<PropertyId, AssayCell>>>
  scenarioSet?: ScenarioSet
  /** 是否计算限额/可用量敏感度（需要额外多次求解）。 */
  sensitivity?: boolean
}

export interface SolveOutcome {
  result: PlanResult
  excluded: Array<{ lotId: string; reason: string }>
}

const EPS = 1e-7

let highsPromise: Promise<any> | null = null
export function highsLoader() {
  if (!highsPromise) highsPromise = loadHighs()
  return highsPromise
}

export function applyOverrides(
  lots: Lot[],
  overrides?: SolveContext['lotOverrides'],
): Lot[] {
  if (!overrides) return lots
  return lots.map((lot) => {
    const o = overrides[lot.id]
    if (!o) return lot
    const assay: Assay = { ...lot.assay }
    for (const k of Object.keys(o) as PropertyId[]) {
      const cell = o[k]
      if (cell) assay[k] = { nominal: cell.nominal, halfWidth: cell.halfWidth, hasAssay: cell.hasAssay }
    }
    return { ...lot, assay }
  })
}

export function dirsOf(min: number | null, max: number | null): Dir[] {
  const out: Dir[] = []
  if (min != null) out.push('min')
  if (max != null) out.push('max')
  return out
}

function effectiveGamma(mode: PlanMode, factorCount: number): number {
  if (mode.kind === 'budget') return Math.max(0, Math.min(mode.gamma, factorCount))
  if (mode.kind === 'box') return Number.POSITIVE_INFINITY
  return 0
}

interface Prepared {
  spec: SpecSet
  volume: number
  freshNeed: number
  heelInput: HeelInput
  candidates: Lot[]
  excluded: Array<{ lotId: string; reason: string }>
  factors: FactorDef[]
  scenarioSet: ScenarioSet
  properties: PropertyId[]
}

function prepare(ctx: SolveContext): Prepared {
  const lots = applyOverrides(ctx.lots, ctx.lotOverrides)
  const spec = ctx.specSets.find((s) => s.id === ctx.specSetId)
  if (!spec) throw new Error(`未知规格牌号：${ctx.specSetId}`)
  const volume = ctx.volume ?? spec.volume
  const properties = PROPERTY_IDS
  const heelInput: HeelInput = {
    quantity: ctx.heel.quantity,
    batchId: ctx.heel.batchId,
    assay: ctx.heel.assay,
    material: ctx.heel.material,
  }
  const needed = [...new Set(spec.limits.flatMap((l) => [l.property]))]
  const excluded: Array<{ lotId: string; reason: string }> = []
  const candidates: Lot[] = []
  for (const lot of lots) {
    const missing = needed.filter((p) => !hasAssay(lot, p))
    if (missing.length) {
      excluded.push({
        lotId: lot.id,
        reason: `缺 ${missing.map((p) => property(p).short).join('、')} 检测，不能用于「${spec.name}」`,
      })
      continue
    }
    if ((ctx.availability[lot.id] ?? 0) <= EPS) continue
    candidates.push(lot)
  }
  for (const p of needed) {
    if (!heelHasAssay(heelInput, p)) {
      throw new Error(`罐底余量缺 ${property(p).short} 检测，无法评估「${spec.name}」`)
    }
  }
  const factors = buildFactors(candidates, heelInput, properties, ctx.rho)
  const scenarioSet = ctx.scenarioSet ?? buildScenarioSet(factors, properties, 20261124)
  return {
    spec,
    volume,
    freshNeed: volume - ctx.heel.quantity,
    heelInput,
    candidates,
    excluded,
    factors,
    scenarioSet,
    properties,
  }
}

// ---------------------------------------------------------------------------
// 主求解
// ---------------------------------------------------------------------------

export async function solvePlan(ctx: SolveContext): Promise<SolveOutcome> {
  const t0 = Date.now()
  const p = prepare(ctx)
  const { spec, volume, freshNeed, heelInput, candidates, excluded, factors, scenarioSet, properties } = p
  const highs = await highsLoader()

  const baseInfo = {
    specSetId: spec.id,
    specName: spec.name,
    rho: ctx.rho,
    volume,
    freshVolume: freshNeed,
    heelQuantity: ctx.heel.quantity,
    excludedLots: excluded,
    basedOnVersion: ctx.clientVersion ?? 0,
    availableMap: Object.fromEntries(candidates.map((l) => [l.id, ctx.availability[l.id] ?? 0])),
    scenarioSet,
  }

  if (freshNeed < -EPS) {
    return {
      excluded,
      result: blankResult(ctx, spec, baseInfo, `罐底余量 ${ctx.heel.quantity} t 已超过目标产量 ${volume} t`),
    }
  }

  const build = (mode: PlanMode) => buildModel(ctx, p, candidates, factors, mode, effectiveGamma(mode, factors.length), scenarioSet)

  const model = build(ctx.mode)
  if (model.error) {
    return { excluded, result: blankResult(ctx, spec, baseInfo, model.error) }
  }

  const solved = highs.solve(model.text, { output_flag: false })
  const status = solved.Status as string
  if (status !== 'Optimal') {
    const diagnosis = status === 'Infeasible'
      ? await diagnose(ctx, p)
      : undefined
    return {
      excluded,
      result: {
        ...blankResult(ctx, spec, baseInfo, status === 'Infeasible'
          ? '在当前规格、库存与不确定集下没有可行配比'
          : `求解器返回 ${status}`),
        diagnosis,
      },
    }
  }

  const allocations: PlanAllocation[] = []
  for (const lot of candidates) {
    const v = model.varOf.get(lot.id)!
    const q = solved.Columns[v]?.Primal ?? 0
    if (q <= 1e-6) continue
    allocations.push({
      lotId: lot.id,
      material: lot.material,
      batchId: lot.batchId,
      tankId: lot.tankId,
      quantity: q,
      shareOfFresh: freshNeed > 0 ? q / freshNeed : 0,
      costPerTonne: lot.cost,
      cost: q * lot.cost,
    })
  }
  allocations.sort((a, b) => b.quantity - a.quantity)
  const totalCost = solved.ObjectiveValue as number
  const unitCost = totalCost / volume
  const lines: MixLine[] = allocations.map((a) => ({
    lot: candidates.find((l) => l.id === a.lotId)!,
    quantity: a.quantity,
  }))

  const nominal = nominalQuality(lines, heelInput, volume, properties)
  const gamma = effectiveGamma(ctx.mode, factors.length)

  const worst = computeWorstByProperty(
    ctx.mode,
    factors,
    lines,
    properties,
    gamma,
    'directional',
  )
  const guaranteed = directionalGuaranteed(nominal, worst.totals, volume, spec)
  // 「区间为什么不能直接相加」表格始终展示箱式与预算两种参照，与当前所选模式无关。
  const reportTotals = {
    ...computeWorstByProperty({ kind: 'box' }, factors, lines, properties, Number.POSITIVE_INFINITY, 'absolute'),
    budget: Object.fromEntries(
      properties.map((prop) => [
        prop,
        budgetDeviationTotal(factors, lines, prop, effectiveGamma({ kind: 'budget', gamma: 2 }, factors.length)),
      ]),
    ),
    budgetGamma: effectiveGamma({ kind: 'budget', gamma: 2 }, factors.length),
  }

  const adversarialByProperty: Record<string, AdversarialFactor[]> = {}
  for (const prop of properties) {
    adversarialByProperty[prop] = adversarialFactors(
      factors, lines, prop, ctx.mode, gamma,
    )
  }

  const risk = evaluateRisk(scenarioSet, lines, heelInput, volume, properties, factors, spec)
  const ensembleWorst = ensembleWorstByProperty(scenarioSet, lines, heelInput, volume, properties, factors, spec)

  // 概率方案：用场景集上的满足概率作为保证
  if (ctx.mode.kind === 'chance') {
    for (const lim of spec.limits) {
      guaranteed[lim.property] = ensembleWorst[lim.property]
    }
  }
  if (ctx.mode.kind === 'nominal') {
    for (const prop of properties) guaranteed[prop] = nominal[prop]
  }
  if (ctx.mode.kind === 'box' || ctx.mode.kind === 'budget') {
    // 箱式/预算：directionalGuaranteed 已经给出最不利方向
  }

  // 增量敏感度（可选）
  let limitSensitivity: Map<string, number> | null = null
  let capacitySensitivity: Map<string, number> | null = null
  if (ctx.sensitivity) {
    limitSensitivity = await perturbLimits(ctx, p, candidates, factors, model, solved, allocations)
    capacitySensitivity = await perturbCapacity(ctx, p, candidates, model, solved, allocations)
  }

  const limits = buildLimitReports(
    p, allocations, nominal, guaranteed, ensembleWorst, limitSensitivity,
  )
  const lotReports = buildLotReports(candidates, allocations, ctx.availability, capacitySensitivity)

  const fixedCost = variableCostOf(allocations)
  const nominalBaseline = await nominalReference(ctx, p, candidates)
  const premiumPerTonne = nominalBaseline == null ? 0 : unitCost - nominalBaseline
  const premiumPct = nominalBaseline == null || nominalBaseline === 0 ? 0 : premiumPerTonne / nominalBaseline

  const result: PlanResult = {
    ...baseInfo,
    id: '',
    mode: ctx.mode,
    status: 'optimal',
    totalCost,
    unitCost,
    allocations,
    nominal,
    guaranteed,
    ensembleWorst,
    adversarial: {
      method: ctx.mode.kind === 'budget' ? 'budget' : ctx.mode.kind === 'box' ? 'box' : 'scenario',
      gamma: ctx.mode.kind === 'budget' ? gamma : ctx.mode.kind === 'box' ? Number.POSITIVE_INFINITY : 0,
      byProperty: adversarialByProperty,
    },
    limits,
    lots: lotReports,
    risk,
    premiumPerTonne,
    premiumPct,
    nominalUnitCost: nominalBaseline,
    nominalStatus: nominalBaseline == null ? 'Infeasible' : 'Optimal',
    boxCornerProbability: boxCornerProbability(factors),
    factorCount: factors.length,
    solvedAt: new Date().toISOString(),
    gammaEffective: ctx.mode.kind === 'chance' ? Infinity : gamma,
    chanceTarget: ctx.mode.kind === 'chance' ? ctx.mode.alpha : null,
    solveMs: Date.now() - t0,
    fixedCost,
    reportTotals,
  }
  return { excluded, result }
}

function variableCostOf(allocations: PlanAllocation[]) {
  return allocations.reduce((a, x) => a + x.cost, 0)
}

function blankResult(
  ctx: SolveContext,
  spec: SpecSet,
  baseInfo: Omit<PlanResult, 'id' | 'mode' | 'status' | 'message' | 'totalCost' | 'unitCost' | 'allocations' | 'nominal' | 'guaranteed' | 'ensembleWorst' | 'adversarial' | 'limits' | 'lots' | 'risk' | 'premiumPerTonne' | 'premiumPct' | 'nominalUnitCost' | 'boxCornerProbability' | 'factorCount' | 'solvedAt' | 'gammaEffective' | 'chanceTarget' | 'solveMs' | 'fixedCost' | 'reportTotals' | 'nominalStatus'>,
  message: string,
): PlanResult {
  return {
    ...baseInfo,
    id: '',
    mode: ctx.mode,
    status: 'infeasible',
    message,
    totalCost: 0,
    unitCost: 0,
    allocations: [],
    nominal: {},
    guaranteed: {},
    ensembleWorst: {},
    adversarial: { method: 'scenario', gamma: 0, byProperty: {} },
    limits: [],
    lots: [],
    risk: {
      scenarioSetId: baseInfo.scenarioSet.id,
      scenarioCount: baseInfo.scenarioSet.scenarios.length,
      evaluated: 0,
      satisfiedProbability: 0,
      violatedProbability: 1,
      perPropertyViolationProbability: {},
      worstScenario: null,
      violations: [],
    },
    premiumPerTonne: 0,
    premiumPct: 0,
    nominalUnitCost: null,
    nominalStatus: 'Infeasible',
    boxCornerProbability: 0,
    factorCount: 0,
    solvedAt: new Date().toISOString(),
    gammaEffective: 0,
    chanceTarget: ctx.mode.kind === 'chance' ? ctx.mode.alpha : null,
    solveMs: 0,
    fixedCost: 0,
    reportTotals: { plus: {}, minus: {}, budget: {}, budgetGamma: 0 },
  }
}

// ---------------------------------------------------------------------------
// 模型构建
// ---------------------------------------------------------------------------

interface BuiltModel {
  text: string
  varOf: Map<string, string>
  specRows: Array<{ row: string; property: PropertyId; dir: Dir; limit: number }>
  limitRowNames: Map<string, string>
  error?: string
}

export function buildModel(
  ctx: SolveContext,
  p: Prepared,
  candidates: Lot[],
  factors: FactorDef[],
  mode: PlanMode,
  gamma: number,
  scenarioSet: ScenarioSet,
): BuiltModel {
  const { spec, volume, freshNeed, heelInput, properties } = p
  const model = new LpBuilder()
  const varOf = new Map<string, string>()
  const limitRowNames = new Map<string, string>()

  candidates.forEach((lot, i) => {
    const v = `x${i}`
    varOf.set(lot.id, v)
    model.addVar(v, 0, ctx.availability[lot.id] ?? 0)
    model.setCost(v, lot.cost)
  })
  model.addVar('__zero', 0, 0)
  model.addRow('total', candidates.map((l) => [varOf.get(l.id)!, 1]), '=', freshNeed)

  const specRows: BuiltModel['specRows'] = []
  const addSpecRows = (modeForRow: 'nominal' | 'box' | 'budget') => {
    spec.limits.forEach((lim, i) => {
      for (const dir of dirsOf(lim.min, lim.max)) {
        const prop = lim.property
        const sign = dir === 'min' ? -1 : 1
        const bound = dir === 'min' ? lim.min! : lim.max!
        const rowName = `spec_${prop}_${dir}`
        limitRowNames.set(`${prop}:${dir}`, rowName)
        const terms: Array<[string, number]> = []
        for (const lot of candidates) {
          const cell = lot.assay[prop]!
          let coef = cell.nominal
          if (modeForRow === 'box') coef += sign * cell.halfWidth
          terms.push([varOf.get(lot.id)!, sign * coef])
        }
        const heelCell = heelInput.assay[prop]!
        let rhs = sign * bound * volume - sign * heelCell.nominal * heelInput.quantity
        if (modeForRow === 'box') rhs -= heelCell.halfWidth * heelInput.quantity
        if (modeForRow === 'budget') {
          const lambda = `lam${i}_${dir}`
          model.addVar(lambda, 0, Number.POSITIVE_INFINITY)
          terms.push([lambda, gamma])
          const props = factorsByProperty(factors, prop)
          props.forEach((f, fi) => {
            const pv = `p${i}_${dir}_${fi}`
            model.addVar(pv, 0, Number.POSITIVE_INFINITY)
            terms.push([pv, 1])
            const lo: Array<[string, number]> = [[pv, 1], [lambda, 1]]
            const hi: Array<[string, number]> = [[pv, 1], [lambda, 1]]
            for (const lot of candidates) {
              const a = factorPartial(f, lot.id)
              if (a === 0) continue
              lo.push([varOf.get(lot.id)!, -a])
              hi.push([varOf.get(lot.id)!, a])
            }
            model.addRow(`fac_${i}_${dir}_${fi}_lo`, lo, '>=', f.constant)
            model.addRow(`fac_${i}_${dir}_${fi}_hi`, hi, '>=', -f.constant)
          })
        }
        model.addRow(rowName, terms, '<=', rhs)
        specRows.push({ row: rowName, property: prop, dir, limit: bound })
      }
    })
  }

  if (mode.kind === 'chance') {
    // 场景法：Σ p_s y_s ≤ 1−α，y_s=1 表示允许该场景违反（需付概率预算）
    spec.limits.forEach((lim) => {
      for (const dir of dirsOf(lim.min, lim.max)) {
        const sign = dir === 'min' ? -1 : 1
        const bound = dir === 'min' ? lim.min! : lim.max!
        const rowName = `spec_${lim.property}_${dir}`
        limitRowNames.set(`${lim.property}:${dir}`, rowName)
        const terms: Array<[string, number]> = candidates.map((lot) => [
          varOf.get(lot.id)!,
          sign * lot.assay[lim.property]!.nominal,
        ])
        let rhs = sign * bound * volume - sign * heelInput.assay[lim.property]!.nominal * heelInput.quantity
        model.addRow(rowName, terms, '<=', rhs)
        specRows.push({ row: rowName, property: lim.property, dir, limit: bound })
      }
    })
    // 场景违反约束
    const coefByScenario: Array<{
      scenario: (typeof scenarioSet.scenarios)[number]
      coeffs: Map<string, number>
      extra: Record<PropertyId, number>
    }> = scenarioSet.scenarios.map((s) => {
      const coeffs = new Map<string, number>()
      const extra: Record<PropertyId, number> = {} as any
      for (const prop of properties) {
        extra[prop] = heelNominal(heelInput, prop) * heelInput.quantity
        for (const f of factorsByProperty(factors, prop)) {
          const xi = s.factors[f.key] ?? 0
          if (!xi) continue
          extra[prop] += xi * f.constant
          for (const lot of candidates) {
            const a = factorPartial(f, lot.id)
            if (a) coeffs.set(`${lot.id}|${prop}`, (coeffs.get(`${lot.id}|${prop}`) ?? 0) + a * xi)
          }
        }
      }
      return { scenario: s, coeffs, extra }
    })
    const yVars: string[] = []
    scenarioSet.scenarios.forEach((s, si) => {
      const y = `y${si}`
      model.markBinary(y)
      yVars.push(y)
      for (const lim of spec.limits) {
        for (const dir of dirsOf(lim.min, lim.max)) {
          const prop = lim.property
          const sign = dir === 'min' ? -1 : 1
          const bound = dir === 'min' ? lim.min! : lim.max!
          const M = bigM(prop, candidates, ctx.availability, heelInput, volume)
          const terms: Array<[string, number]> = []
          for (const lot of candidates) {
            const c = (lot.assay[prop]!.nominal + (coefByScenario[si].coeffs.get(`${lot.id}|${prop}`) ?? 0))
            terms.push([varOf.get(lot.id)!, sign * c])
          }
          // 放宽该场景的约束：LHS − M·y_s ≤ RHS（y_s=1 时允许违反）
          terms.push([y, -M])
          const rhs = sign * bound * volume - sign * coefByScenario[si].extra[prop]
          model.addRow(`sc_${si}_${prop}_${dir}`, terms, '<=', rhs)
        }
      }
    })
    model.addRow(
      'chance_budget',
      yVars.map((y) => [y, scenarioSet.scenarios[yVars.indexOf(y)].probability] as [string, number]),
      '<=',
      1 - (mode as ChanceMode).alpha + 1e-9,
    )
  } else {
    addSpecRows(mode.kind)
  }

  return { text: model.toText(), varOf, specRows, limitRowNames }
}

function bigM(
  prop: PropertyId,
  candidates: Lot[],
  availability: Record<string, number>,
  heel: HeelInput,
  volume: number,
) {
  let total = Math.abs(heelNominal(heel, prop)) * heel.quantity + heelHalf(heel, prop) * heel.quantity
  for (const lot of candidates) {
    const cell = lot.assay[prop]!
    total += (Math.abs(cell.nominal) + cell.halfWidth) * (availability[lot.id] ?? 0)
  }
  return 2 * (total + volume)
}

function heelHalf(heel: HeelInput, p: PropertyId) {
  const c = heel.assay[p]
  return c && c.hasAssay ? c.halfWidth : 0
}

// ---------------------------------------------------------------------------
// 最坏情形
// ---------------------------------------------------------------------------

function computeWorstByProperty(
  mode: PlanMode,
  factors: FactorDef[],
  lines: MixLine[],
  properties: PropertyId[],
  gamma: number,
  kind: 'absolute' | 'directional',
): { plus: Record<string, number>; minus: Record<string, number>; totals: Record<string, number> } {
  const plus: Record<string, number> = {}
  const minus: Record<string, number> = {}
  const totals: Record<string, number> = {}
  for (const prop of properties) {
    let up = 0
    let down = 0
    if (mode.kind === 'nominal') {
      up = 0
      down = 0
    } else if (mode.kind === 'box' || mode.kind === 'chance') {
      const b = boxDeviationTotal(factors, lines, prop)
      up = b
      down = b
    } else {
      const b = budgetDeviationTotal(factors, lines, prop, gamma)
      up = b
      down = b
    }
    plus[prop] = up
    minus[prop] = down
    totals[prop] = kind === 'absolute' ? Math.max(up, down) : up
  }
  return { plus, minus, totals }
}

function directionalGuaranteed(
  nominal: Record<string, number>,
  totals: Record<string, number>,
  volume: number,
  spec: SpecSet,
): Record<string, number> {
  const out: Record<string, number> = { ...nominal }
  for (const lim of spec.limits) {
    const prop = lim.property
    const d = (totals[prop] ?? 0) / volume
    if (lim.min != null && lim.max != null) {
      // 双向：取更紧的一侧
      const lo = nominal[prop] - d
      const hi = nominal[prop] + d
      const loSlack = lo - lim.min
      const hiSlack = lim.max - hi
      out[prop] = loSlack <= hiSlack ? lo : hi
    } else if (lim.min != null) {
      out[prop] = nominal[prop] - d
    } else if (lim.max != null) {
      out[prop] = nominal[prop] + d
    }
  }
  return out
}

export function adversarialFactors(
  factors: FactorDef[],
  lines: MixLine[],
  prop: PropertyId,
  mode: PlanMode,
  gamma: number,
): AdversarialFactor[] {
  const entries = factorsByProperty(factors, prop)
    .map((f) => ({ f, coef: factorCoefficient(f, lines) }))
    .sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef))
  if (mode.kind === 'nominal' || mode.kind === 'chance') {
    // 场景法：列出场景集里被违反最多的场景，见 risk.worstScenario
    return []
  }
  let rem = mode.kind === 'box' ? Number.POSITIVE_INFINITY : gamma
  const out: AdversarialFactor[] = []
  for (const e of entries) {
    if (rem <= 1e-12) break
    const take = Math.min(1, rem)
    rem -= take
    out.push({
      key: e.f.key,
      label: e.f.label,
      property: prop,
      xi: e.coef >= 0 ? take : -take,
      contribution: e.coef * take,
    })
  }
  return out.filter((x) => Math.abs(x.contribution) > 1e-9)
}

// ---------------------------------------------------------------------------
// 风险（场景集）
// ---------------------------------------------------------------------------

export function evaluateRisk(
  set: ScenarioSet,
  lines: MixLine[],
  heel: HeelInput,
  volume: number,
  properties: PropertyId[],
  factors: FactorDef[],
  spec: SpecSet,
): RiskReport {
  const limitByProp = new Map<PropertyId, { min: number | null; max: number | null }>()
  for (const l of spec.limits) limitByProp.set(l.property, { min: l.min, max: l.max })
  const nom = nominalQuality(lines, heel, volume, properties)
  const violations: ScenarioViolation[] = []
  const perProp: Record<string, number> = {}
  for (const p of properties) perProp[p] = 0
  let satisfied = 0
  let worst: ScenarioViolation | null = null
  let worstScore = -1
  for (const scenario of set.scenarios) {
    const dev = deviationForScenario(factors, lines, scenario)
    const bad: ViolationReport[] = []
    for (const [p, lim] of limitByProp) {
      const q = nom[p] + (dev[p] ?? 0) / volume
      if (lim.min != null && q < lim.min - 1e-9) {
        bad.push({
          property: p, dir: 'min', limit: lim.min, value: q,
          excessAbs: lim.min - q,
          excessNorm: (lim.min - q) / Math.max(Math.abs(lim.min), 1e-9),
        })
      }
      if (lim.max != null && q > lim.max + 1e-9) {
        bad.push({
          property: p, dir: 'max', limit: lim.max, value: q,
          excessAbs: q - lim.max,
          excessNorm: (q - lim.max) / Math.max(Math.abs(lim.max), 1e-9),
        })
      }
    }
    if (bad.length === 0) {
      satisfied += scenario.probability
    } else {
      for (const b of bad) perProp[b.property] += scenario.probability
    }
    const worstHere = bad.reduce<ViolationReport | null>(
      (best, b) => (!best || b.excessNorm > best.excessNorm ? b : best),
      null,
    )
    const entry: ScenarioViolation = {
      scenarioId: scenario.id,
      label: scenario.label,
      kind: scenario.kind,
      probability: scenario.probability,
      l1: Object.values(scenario.factors).reduce((a, x) => a + Math.abs(x), 0),
      violations: bad,
      worst: worstHere,
    }
    violations.push(entry)
    const score = bad.reduce((a, b) => a + b.excessNorm, 0) + (bad.length ? entry.l1 * 1e-6 : 0)
    if (bad.length > 0 && score > worstScore) {
      worstScore = score
      worst = entry
    }
  }
  const satisfiedProbability = round6(satisfied)
  return {
    scenarioSetId: set.id,
    scenarioCount: set.scenarios.length,
    evaluated: set.scenarios.length,
    satisfiedProbability,
    violatedProbability: round6(Math.max(0, 1 - satisfiedProbability)),
    perPropertyViolationProbability: Object.fromEntries(
      Object.entries(perProp).map(([k, v]) => [k, round6(v)]),
    ),
    worstScenario: worst,
    violations,
  }
}

function ensembleWorstByProperty(
  set: ScenarioSet,
  lines: MixLine[],
  heel: HeelInput,
  volume: number,
  properties: PropertyId[],
  factors: FactorDef[],
  spec: SpecSet,
): Record<string, number> {
  const out: Record<string, number> = {}
  const nom = nominalQuality(lines, heel, volume, properties)
  const dirs = new Map<PropertyId, { min: number | null; max: number | null }>()
  for (const l of spec.limits) dirs.set(l.property, { min: l.min, max: l.max })
  for (const prop of properties) {
    const d = dirs.get(prop)
    if (!d) {
      out[prop] = nom[prop]
      continue
    }
    let best = nom[prop]
    let bestSlack = Number.POSITIVE_INFINITY
    for (const s of set.scenarios) {
      const dev = deviationForScenario(factors, lines, s)[prop] ?? 0
      const q = nom[prop] + dev / volume
      let slack = Number.POSITIVE_INFINITY
      if (d.min != null) slack = Math.min(slack, q - d.min)
      if (d.max != null) slack = Math.min(slack, d.max - q)
      if (slack < bestSlack) {
        bestSlack = slack
        best = q
      }
    }
    out[prop] = best
  }
  return out
}

// ---------------------------------------------------------------------------
// 敏感度：对限额放宽 0.1 个指标单位 / 可用量增加 10 t 的整罐成本变化
// ---------------------------------------------------------------------------

async function solveVariant(
  ctx: SolveContext,
  p: Prepared,
  candidates: Lot[],
  factors: FactorDef[],
  mode: PlanMode,
  gamma: number,
  options: {
    limitOverrides?: Map<string, number>
    availabilityOverrides?: Record<string, number>
  },
): Promise<number | null> {
  const highs = await highsLoader()
  const spec = p.spec
  const patched: SpecSet = options.limitOverrides
    ? {
        ...spec,
        limits: spec.limits.map((l) => {
          const next = { ...l }
          for (const dir of dirsOf(l.min, l.max)) {
            const v = options.limitOverrides!.get(`${l.property}:${dir}`)
            if (v != null) {
              if (dir === 'min') next.min = v
              else next.max = v
            }
          }
          return next
        }),
      }
    : spec
  const ctx2: SolveContext = {
    ...ctx,
    availability: { ...ctx.availability, ...(options.availabilityOverrides ?? {}) },
  }
  const p2: Prepared = { ...p, spec: patched }
  const model = buildModel(ctx2, p2, candidates, factors, mode, gamma, p.scenarioSet)
  if (model.error) return null
  const res = highs.solve(model.text, { output_flag: false })
  if (res.Status !== 'Optimal') return null
  return res.ObjectiveValue as number
}

async function perturbLimits(
  ctx: SolveContext,
  p: Prepared,
  candidates: Lot[],
  factors: FactorDef[],
  model: BuiltModel,
  _solved: any,
  _allocations: PlanAllocation[],
): Promise<Map<string, number>> {
  const gamma = effectiveGamma(ctx.mode, factors.length)
  const out = new Map<string, number>()
  if (ctx.mode.kind === 'chance') return out
  const base = (await solveVariant(ctx, p, candidates, factors, ctx.mode, gamma, {})) ?? null
  if (base == null) return out
  for (const lim of p.spec.limits) {
    for (const dir of dirsOf(lim.min, lim.max)) {
      const step = 0.1
      const relaxed = dir === 'min' ? lim.min! - step : lim.max! + step
      const map = new Map([[`${lim.property}:${dir}`, relaxed]])
      const v = await solveVariant(ctx, p, candidates, factors, ctx.mode, gamma, { limitOverrides: map })
      if (v != null) out.set(`${lim.property}:${dir}`, v - base)
    }
  }
  return out
}

async function perturbCapacity(
  ctx: SolveContext,
  p: Prepared,
  candidates: Lot[],
  model: BuiltModel,
  _solved: any,
  allocations: PlanAllocation[],
): Promise<Map<string, number>> {
  const gamma = effectiveGamma(ctx.mode, p.factors.length)
  const out = new Map<string, number>()
  if (ctx.mode.kind === 'chance') return out
  const base = allocations.reduce((a, x) => a + x.cost, 0)
  for (const alloc of allocations) {
    const overrides = { [alloc.lotId]: (ctx.availability[alloc.lotId] ?? 0) + 10 }
    const v = await solveVariant(ctx, p, candidates, p.factors, ctx.mode, gamma, {
      availabilityOverrides: overrides,
    })
    if (v != null) out.set(alloc.lotId, v - base)
  }
  return out
}

// ---------------------------------------------------------------------------
// 报表
// ---------------------------------------------------------------------------

function buildLimitReports(
  p: Prepared,
  allocations: PlanAllocation[],
  nominal: Record<string, number>,
  guaranteed: Record<string, number>,
  ensembleWorst: Record<string, number>,
  sensitivity: Map<string, number> | null,
): LimitReport[] {
  const out: LimitReport[] = []
  const { spec, volume } = p
  for (const lim of spec.limits) {
    for (const dir of dirsOf(lim.min, lim.max)) {
      const bound = dir === 'min' ? lim.min! : lim.max!
      const nom = nominal[lim.property]
      const guar = guaranteed[lim.property]
      const slackNominal = dir === 'min' ? nom - bound : bound - nom
      const slackGuaranteed = dir === 'min' ? guar - bound : bound - guar
      const marginUsed = slackNominal > 1e-9
        ? Math.min(1, Math.max(0, 1 - slackGuaranteed / slackNominal))
        : (slackGuaranteed < 0 ? 1 : 0)
      const delta = sensitivity?.get(`${lim.property}:${dir}`) ?? null
      out.push({
        property: lim.property,
        dir,
        limit: bound,
        nominal: nom,
        guaranteed: guar,
        ensembleWorst: ensembleWorst[lim.property],
        slackNominal,
        slackGuaranteed,
        marginUsedShare: marginUsed,
        active: delta != null && Math.abs(delta) > 1,
        costPerTenthTotal: delta,
        costPerTenthPerTonne: delta == null ? null : delta / volume,
        bestAchievable: null,
        bestAchievableFeasible: null,
      })
    }
  }
  return out
}

function buildLotReports(
  candidates: Lot[],
  allocations: PlanAllocation[],
  availability: Record<string, number>,
  capacitySensitivity: Map<string, number> | null,
): LotReport[] {
  return candidates.map((lot) => {
    const alloc = allocations.find((a) => a.lotId === lot.id)
    const q = alloc?.quantity ?? 0
    const avail = availability[lot.id] ?? 0
    const delta = capacitySensitivity?.get(lot.id) ?? null
    return {
      lotId: lot.id,
      quantity: q,
      available: avail,
      usedUp: avail > 0 && q >= avail - 1e-6,
      costPerTonne: lot.cost,
      costPerTenTonnes: delta,
      capacityValuePerTonne: delta == null ? null : -delta / 10,
    }
  })
}

async function nominalReference(
  ctx: SolveContext,
  p: Prepared,
  candidates: Lot[],
): Promise<number | null> {
  const highs = await highsLoader()
  const { spec, volume, freshNeed, heelInput } = p
  const b = new LpBuilder()
  const v = new Map<string, string>()
  candidates.forEach((lot, i) => {
    const name = `n${i}`
    v.set(lot.id, name)
    b.addVar(name, 0, ctx.availability[lot.id] ?? 0)
    b.setCost(name, lot.cost)
  })
  b.addVar('__zero', 0, 0)
  b.addRow('total', candidates.map((l) => [v.get(l.id)!, 1]), '=', freshNeed)
  for (const lim of spec.limits) {
    for (const dir of dirsOf(lim.min, lim.max)) {
      const sign = dir === 'min' ? -1 : 1
      const bound = dir === 'min' ? lim.min! : lim.max!
      const terms: Array<[string, number]> = candidates.map((l) => [
        v.get(l.id)!,
        sign * l.assay[lim.property]!.nominal,
      ])
      const rhs = sign * bound * volume - sign * heelInput.assay[lim.property]!.nominal * heelInput.quantity
      b.addRow(`n_${lim.property}_${dir}`, terms, '<=', rhs)
    }
  }
  const res = highs.solve(b.toText(), { output_flag: false })
  if (res.Status !== 'Optimal') return null
  return (res.ObjectiveValue as number) / volume
}

// ---------------------------------------------------------------------------
// 不可行诊断
// ---------------------------------------------------------------------------

export async function diagnose(ctx: SolveContext, p: Prepared): Promise<InfeasibilityDiagnosis> {
  const highs = await highsLoader()
  const { candidates, heelInput, spec, volume, freshNeed } = p
  const reasons: InfeasibilityDiagnosis['reasons'] = []
  let candidateShortfall: number | null = null
  const totalAvail = candidates.reduce((a, l) => a + (ctx.availability[l.id] ?? 0), 0)
  if (totalAvail < freshNeed - 1e-6) {
    candidateShortfall = freshNeed - totalAvail
    reasons.push({
      message: `可用新鲜原料合计 ${totalAvail.toFixed(1)} t，少于所需的 ${freshNeed.toFixed(1)} t。先释放未投料的预留，或减少同一罐区的其它订单。`,
    })
    // 总量都不够时，逐项诊断只会得到「所有指标同时不可行」的噪声结论。
    return { headline: reasons[0].message, reasons, candidateShortfall }
  }
  // 分两步：先看「完全不考虑其它指标」时的能力极限（真正的短板），
  // 再把已确认不可达的指标从约束里剔除，检查其余指标之间是否还有冲突。
  // 这样不会因为一个指标不可行，就给所有指标同时报警。
  const culprits: InfeasibilityDiagnosis['reasons'] = []
  const tensions: InfeasibilityDiagnosis['reasons'] = []
  const allKeys = new Set<string>()
  for (const lim of spec.limits) {
    for (const dir of dirsOf(lim.min, lim.max)) allKeys.add(`${lim.property}:${dir}`)
  }
  const culpritKeys = new Set<string>()
  const tol = (b: number) => 1e-4 * Math.max(1, Math.abs(b))
  for (const lim of spec.limits) {
    for (const dir of dirsOf(lim.min, lim.max)) {
      const bound = dir === 'min' ? lim.min! : lim.max!
      // 关键：把「当前指标」这一侧也放开，只留硬性总量，才能测出能力极限
      const ownKey = `${lim.property}:${dir}`
      const relaxed = await optimizeSingle(ctx, p, lim.property, dir, new Set([...allKeys, ownKey]))
      const inherentOk =
        relaxed != null &&
        (dir === 'min' ? relaxed.value >= bound - tol(bound) : relaxed.value <= bound + tol(bound))
      if (!inherentOk) {
        culpritKeys.add(`${lim.property}:${dir}`)
        culprits.push({
          property: lim.property,
          dir,
          limit: bound,
          bestAvailable: relaxed?.value,
          message:
            relaxed == null
              ? `${property(lim.property).name} 无法在任何配比下评估`
              : `即使完全不考虑其它指标，${property(lim.property).name} 最好也只能做到 ${fmtNear(
                  relaxed.value,
                  property(lim.property).decimals,
                  bound,
                )}，达不到${dir === 'min' ? '下限' : '上限'} ${bound}`,
        })
      }
    }
  }
  for (const lim of spec.limits) {
    for (const dir of dirsOf(lim.min, lim.max)) {
      if (culpritKeys.has(`${lim.property}:${dir}`)) continue
      const bound = dir === 'min' ? lim.min! : lim.max!
      const achieved = await optimizeSingle(ctx, p, lim.property, dir, culpritKeys)
      const ok =
        achieved != null &&
        (dir === 'min' ? achieved.value >= bound - tol(bound) : achieved.value <= bound + tol(bound))
      if (!ok) {
        tensions.push({
          property: lim.property,
          dir,
          limit: bound,
          bestAvailable: achieved?.value,
          message:
            achieved == null
              ? `${property(lim.property).name} 与其它规格无法同时成立`
              : `在其余可达规格同时成立时，${property(lim.property).name} 最好只能做到 ${fmtNear(
                  achieved.value,
                  property(lim.property).decimals,
                  bound,
                )}，达不到${dir === 'min' ? '下限' : '上限'} ${bound}`,
        })
      }
    }
  }
  reasons.push(...culprits, ...tensions)
  if (reasons.length === 0) {
    reasons.push({ message: '单项指标都在能力范围内，可能是多个指标方向同时收紧所致' })
  }
  return {
    headline: reasons[0].message,
    reasons,
    candidateShortfall,
  }
}

async function optimizeSingle(
  ctx: SolveContext,
  p: Prepared,
  target: PropertyId,
  dir: Dir,
  ignoreKeys?: Set<string>,
): Promise<{ value: number } | null> {
  const highs = await highsLoader()
  const { candidates, heelInput, spec, volume } = p
  const b = new LpBuilder()
  const v = new Map<string, string>()
  candidates.forEach((lot, i) => {
    const name = `y${i}`
    v.set(lot.id, name)
    b.addVar(name, 0, ctx.availability[lot.id] ?? 0)
    const c = lot.assay[target]!.nominal
    // 检查下限能否达到要把目标指标推到最大；检查上限则推到最小。
    b.setCost(name, dir === 'min' ? -c : c)
  })
  b.addVar('__zero', 0, 0)
  b.addRow('total', candidates.map((l) => [v.get(l.id)!, 1]), '=', volume - heelInput.quantity)
  for (const lim of spec.limits) {
    if (lim.property === target) continue
    for (const d of dirsOf(lim.min, lim.max)) {
      if (ignoreKeys?.has(`${lim.property}:${d}`)) continue
      const sign = d === 'min' ? -1 : 1
      const bound = d === 'min' ? lim.min! : lim.max!
      const terms: Array<[string, number]> = candidates.map((l) => [
        v.get(l.id)!,
        sign * l.assay[lim.property]!.nominal,
      ])
      const rhs = sign * bound * volume - sign * heelInput.assay[lim.property]!.nominal * heelInput.quantity
      b.addRow(`o_${lim.property}_${d}`, terms, '<=', rhs)
    }
  }
  const res = highs.solve(b.toText(), { output_flag: false })
  if (res.Status !== 'Optimal') return null
  const total =
    heelInput.assay[target]!.nominal * heelInput.quantity +
    candidates.reduce(
      (a, l) => a + (res.Columns[v.get(l.id)!]?.Primal ?? 0) * l.assay[target]!.nominal,
      0,
    )
  return { value: total / volume }
}

function round6(x: number) {
  return Math.round(x * 1e6) / 1e6
}

/** 诊断用：若按指标精度四舍五入后与限额看上去相同，则多给几位小数。 */
function fmtNear(value: number, decimals: number, bound: number) {
  let d = decimals
  while (d < 4 && value.toFixed(d) === bound.toFixed(d)) d += 1
  return value.toFixed(d)
}
