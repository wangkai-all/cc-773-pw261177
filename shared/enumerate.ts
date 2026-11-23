import type {
  Dir,
  Heel,
  Lot,
  PlanMode,
  PropertyId,
  ScenarioSet,
  SpecSet,
} from './types.ts'
import { PROPERTY_IDS, property } from './catalog.ts'
import { dirsOf } from './solver.ts'
import {
  boxDeviationTotal,
  budgetDeviationTotal,
  buildFactors,
  deviationForScenario,
  factorCoefficient,
  factorsByProperty,
  halfWidth,
  hasAssay,
  heelNominal,
  nominalQuality,
  type FactorDef,
  type HeelInput,
  type MixLine,
} from './uncertainty.ts'

export interface EnumerationRow {
  quantities: Array<{ lotId: string; quantity: number }>
  nominalCost: number
  nominalQualities: Record<string, number>
  nominalFeasible: boolean
  boxFeasible: boolean
  boxSlack: Record<string, number>
  costPerTonne: number
  /** 相对规格的最坏（正=违反，负=余量）归一化量 */
  worstExcessNorm: number
  worstProperty: PropertyId | null
}

export interface EnumerationResult {
  gridStep: number
  /** 枚举覆盖的原料（其余罐未纳入） */
  lotIds: string[]
  /** 判定可行所用的保护模式 */
  protection: 'box' | 'budget' | 'nominal'
  gamma: number
  combos: number
  feasibleNominal: number
  feasibleBox: number
  bestNominal: EnumerationRow | null
  bestBox: EnumerationRow | null
  /** 既不名义可行也不受保护可行的组合中，最接近可行的一个（用于解释不可行） */
  closestInfeasible: EnumerationRow | null
  top: EnumerationRow[]
  volume: number
  freshVolume: number
  elapsedMs: number
  notes: string[]
}

export interface EnumerateArgs {
  lots: Lot[]
  heel: Heel
  spec: SpecSet
  availability: Record<string, number>
  rho: number
  gridStep: number
  maxCombos?: number
  /** 保护模式；缺省为箱式。budget 时用 Γ 预算偏移判定可行性。 */
  mode?: PlanMode
  gamma?: number
}

/**
 * 计数：把 steps 个网格分配进各罐（不超过 caps）的方案数。
 * 用于在枚举前选择步长，避免静默截断。
 */
export function countCompositions(caps: number[], steps: number): number {
  let dp = new Float64Array(steps + 1)
  dp[0] = 1
  for (const cap of caps) {
    const next = new Float64Array(steps + 1)
    for (let s = 0; s <= steps; s++) {
      const v = dp[s]
      if (v === 0) continue
      const hi = Math.min(cap, steps - s)
      for (let k = 0; k <= hi; k++) next[s + k] += v
    }
    dp = next
  }
  return dp[steps]
}

/** 小规模枚举：整数步长下的全部配比，直接算成本与箱式最坏质量。 */
export function enumerateBlends(args: EnumerateArgs): EnumerationResult {
  const t0 = Date.now()
  const { lots, heel, spec, availability, rho, gridStep } = args
  const properties = PROPERTY_IDS
  const needed = [...new Set(spec.limits.map((l) => l.property))]
  const candidates = lots.filter(
    (l) => needed.every((p) => hasAssay(l, p)) && (availability[l.id] ?? 0) > 0,
  )
  const volume = spec.volume
  const fresh = volume - heel.quantity
  const heelInput: HeelInput = { quantity: heel.quantity, batchId: heel.batchId, assay: heel.assay }
  const factors = buildFactors(candidates, heelInput, properties, rho)
  // 网格步长必须整除新鲜量，否则配比总和会少一截、成本与 LP 不可比。
  // 取整数份数后反推精确步长，保证每组配比之和严格等于新鲜量。
  const requested = Math.max(0.001, gridStep)
  const steps = Math.max(1, Math.round(fresh / requested))
  const grid = fresh / steps
  const mode: PlanMode = args.mode ?? { kind: 'box' }
  const protection: EnumerationResult['protection'] =
    mode.kind === 'budget' ? 'budget' : mode.kind === 'nominal' ? 'nominal' : 'box'
  const gamma = mode.kind === 'budget' ? args.gamma ?? mode.gamma : Number.POSITIVE_INFINITY
  const maxCombos = args.maxCombos ?? 4_000_000
  let combos = 0
  let feasibleNominal = 0
  let feasibleBox = 0
  let truncated = false
  // 不保留全部组合（否则大步长下内存会爆），只留成本最低的若干可行/近可行组合。
  const keep = 40
  const bestNominalRows: EnumerationRow[] = []
  const bestBoxRows: EnumerationRow[] = []
  let worstSeen: EnumerationRow | null = null
  const pushSorted = (arr: EnumerationRow[], row: EnumerationRow, n: number) => {
    if (arr.length >= n && row.nominalCost >= arr[arr.length - 1].nominalCost) return
    let i = arr.length
    while (i > 0 && arr[i - 1].nominalCost > row.nominalCost) i--
    arr.splice(i, 0, row)
    if (arr.length > n) arr.length = n
  }

  const caps = candidates.map((l) => Math.floor((availability[l.id] ?? 0) / grid + 1e-9))
  // 递归上限保护：即使调用方没算组合数，也不让递归爆栈。
  const maxDepth = 60
  if (candidates.length > maxDepth) {
    throw new Error(`枚举原料过多（${candidates.length} > ${maxDepth}），请减少参与枚举的罐`)
  }
  const quantities = new Array(candidates.length).fill(0)

  const visit = (idx: number, remaining: number) => {
    if (truncated) return
    if (combos >= maxCombos) {
      truncated = true
      return
    }
    if (idx === candidates.length - 1) {
      const q = remaining * grid
      if (q > (availability[candidates[idx].id] ?? 0) + 1e-9) return
      quantities[idx] = remaining
      combos += 1
      evaluate()
      quantities[idx] = 0
      return
    }
    const maxHere = Math.min(caps[idx], remaining)
    for (let s = 0; s <= maxHere; s++) {
      quantities[idx] = s
      visit(idx + 1, remaining - s)
      if (truncated) break
    }
    quantities[idx] = 0
  }

  function evaluate() {
    const lines: MixLine[] = []
    let cost = 0
    for (let i = 0; i < candidates.length; i++) {
      if (quantities[i] === 0) continue
      lines.push({ lot: candidates[i], quantity: quantities[i] * grid })
      cost += quantities[i] * grid * candidates[i].cost
    }
    const nominal = nominalQuality(lines, heelInput, volume, properties)
    let nominalOk = true
    const slacks: Record<string, number> = {}
    for (const lim of spec.limits) {
      for (const dir of dirsOf(lim.min, lim.max)) {
        const bound = dir === 'min' ? lim.min! : lim.max!
        const v = nominal[lim.property]
        const slack = dir === 'min' ? v - bound : bound - v
        slacks[`${lim.property}:${dir}`] = slack
        if (slack < -1e-9) nominalOk = false
      }
    }
    if (nominalOk) feasibleNominal += 1

    let boxOk = nominalOk
    let worstExcessNorm = Number.NEGATIVE_INFINITY
    let worstProperty: PropertyId | null = null
    const boxSlack: Record<string, number> = {}
    for (const lim of spec.limits) {
      const dev =
        protection === 'nominal'
          ? 0
          : protection === 'budget'
            ? budgetDeviationTotal(factors, lines, lim.property, gamma) / volume
            : boxDeviationTotal(factors, lines, lim.property) / volume
      for (const dir of dirsOf(lim.min, lim.max)) {
        const bound = dir === 'min' ? lim.min! : lim.max!
        const worst = dir === 'min' ? nominal[lim.property] - dev : nominal[lim.property] + dev
        const slack = dir === 'min' ? worst - bound : bound - worst
        boxSlack[`${lim.property}:${dir}`] = slack
        const excess = -slack / Math.max(Math.abs(bound), 1)
        if (excess > worstExcessNorm) {
          worstExcessNorm = excess
          worstProperty = lim.property
        }
        if (slack < -1e-9) boxOk = false
      }
    }
    if (boxOk) feasibleBox += 1

    if (worstExcessNorm === Number.NEGATIVE_INFINITY) worstExcessNorm = 0
    if (!nominalOk && !boxOk && worstSeen && worstExcessNorm >= worstSeen.worstExcessNorm) return
    const row: EnumerationRow = {
      quantities: candidates
        .map((l, i) => ({ lotId: l.id, quantity: quantities[i] * grid }))
        .filter((q) => q.quantity > 0),
      nominalCost: cost,
      nominalQualities: nominal,
      nominalFeasible: nominalOk,
      boxFeasible: boxOk,
      boxSlack,
      costPerTonne: cost / volume,
      worstExcessNorm,
      worstProperty,
    }
    if (!nominalOk && !boxOk) {
      if (!worstSeen || worstExcessNorm < worstSeen.worstExcessNorm) worstSeen = row
      return
    }
    if (nominalOk) pushSorted(bestNominalRows, row, keep)
    if (boxOk) pushSorted(bestBoxRows, row, keep)
  }

  visit(0, steps)

  const nominalRows = bestNominalRows
  const boxRows = bestBoxRows
  const notes: string[] = []
  if (truncated) notes.push(`枚举超过 ${maxCombos.toLocaleString()} 组，结果被截断`)
  const label = protection === 'budget' ? `预算 Γ=${gamma}` : protection === 'box' ? '箱式最坏' : '名义'
  if (boxRows.length === 0) notes.push(`${label}下没有可行组合：说明名义最优方案并不抗误差`)
  if (nominalRows.length > 0 && boxRows.length > 0) {
    const delta = boxRows[0].nominalCost - nominalRows[0].nominalCost
    notes.push(
      delta > 1e-6
        ? `${label}可行组合比名义最优贵 ¥${delta.toFixed(0)}（${(delta / volume).toFixed(1)} 元/t）`
        : `${label}可行组合的最优成本与名义最优相同：当前网格步长下没有更便宜的可行组合`,
    )
  }
  notes.push(
    `枚举范围：${candidates.map((l) => l.id).join('、')}（${candidates.length} 罐，步长 ${grid.toFixed(2)} t）`,
  )

  return {
    gridStep: grid,
    lotIds: candidates.map((l) => l.id),
    protection,
    gamma: Number.isFinite(gamma) ? gamma : 0,
    combos,
    feasibleNominal,
    feasibleBox,
    bestNominal: nominalRows[0] ?? null,
    bestBox: boxRows[0] ?? null,
    top: boxRows.slice(0, 8),
    closestInfeasible: worstSeen,
    volume,
    freshVolume: fresh,
    elapsedMs: Date.now() - t0,
    notes,
  }
}

// ---------------------------------------------------------------------------
// 核对：因子顶点枚举 vs 解析最坏情形
// ---------------------------------------------------------------------------

export interface WorstCaseCheck {
  property: PropertyId
  dir: Dir
  /** 解析最坏偏移，基于参与枚举的因子子集 */
  analytical: number
  /** 解析最坏偏移，基于全部因子（可能大于枚举子集值） */
  analyticalFull: number
  enumerated: number
  vertices: number
  match: boolean
  diff: number
  gamma: number
  method: 'box' | 'budget'
  truncated: boolean
  factorCount: number
  enumeratedFactors: number
}

/**
 * 对少量因子枚举 ξ，与解析最坏偏移对比。
 *
 * 为使枚举规模可控，只取幅度最大的前 maxFactors 个因子，解析值也在同一子集上计算。
 *
 * 预算模式 Γ 的可行集是 { ξ : Σ|ξ_i| ≤ Γ, |ξ_i| ≤ 1 }，其顶点形如
 *「⌊Γ⌋ 个坐标取 ±1 且恰有一个坐标取 ±(Γ−⌊Γ⌋)」；Γ 为整数时就是 ⌊Γ⌋ 个坐标取 ±1。
 * 因此这里按「幅度最大的 k 个因子取端点」枚举（k = ⌊Γ⌋ 或 ⌊Γ⌋+1），
 * 再用解析公式从同一子集算出上界，二者必须相等。
 */
export function checkWorstCase(args: {
  factors: FactorDef[]
  lines: MixLine[]
  properties: PropertyId[]
  mode: PlanMode
  gamma: number
  maxFactors?: number
}): WorstCaseCheck[] {
  const { factors, lines, properties, mode, gamma } = args
  const maxFactors = args.maxFactors ?? 5
  const out: WorstCaseCheck[] = []
  const isBudget = mode.kind === 'budget'
  for (const prop of properties) {
    const relevant = factorsByProperty(factors, prop)
      .map((f) => ({ f, coef: factorCoefficient(f, lines) }))
      .filter((x) => Math.abs(x.coef) > 1e-9)
    const sorted = relevant.slice().sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef))
    const chosen = sorted.slice(0, maxFactors)
    const n = chosen.length
    if (n === 0) continue

    // 未截断时，解析值基于全部因子；枚举覆盖不到的那些因子按 0 处理，
    // 因此「被枚举覆盖到」要求解析值 ≤ 枚举极值。截断时解析值仍用全部因子，
    // 但为了给出可比的数值，下面同时记录子集解析值。
    const subset = chosen.map((c) => c.f)
    const subsetAnalyticalPlus = isBudget
      ? budgetDeviationTotal(subset, lines, prop, gamma)
      : boxDeviationTotal(subset, lines, prop)

    let enumeratedPlus = Number.NEGATIVE_INFINITY
    let enumeratedMinus = Number.POSITIVE_INFINITY
    let vertices = 0
    const consider = (dev: number) => {
      vertices += 1
      if (dev > enumeratedPlus) enumeratedPlus = dev
      if (dev < enumeratedMinus) enumeratedMinus = dev
    }

    if (!isBudget) {
      for (let mask = 0; mask < 2 ** n; mask++) {
        let dev = 0
        for (let i = 0; i < n; i++) dev += chosen[i].coef * ((mask >> i) & 1 ? 1 : -1)
        consider(dev)
      }
    } else {
      const g = Math.max(0, Math.min(gamma, n))
      const floor = Math.floor(g)
      const frac = g - floor
      // Γ 的顶点：floor 个坐标取 ±1，若 frac>0 再有一个坐标取 ±frac，其余为 0。
      const enumerateSets = (k: number) => {
        const idx = new Array(k).fill(0)
        const rec = (pos: number) => {
          if (pos === k) {
            for (let signMask = 0; signMask < 2 ** k; signMask++) {
              let dev = 0
              for (let i = 0; i < k; i++) {
                const s = (signMask >> i) & 1 ? 1 : -1
                dev += chosen[idx[i]].coef * s
              }
              if (!frac) consider(dev)
              else {
                // 第 floor+1 个点取分数量：对每个不在集合中的坐标与符号分别计算
                const inSet = new Set(idx)
                for (let j = 0; j < n; j++) {
                  if (inSet.has(j)) continue
                  for (const sgn of [1, -1] as const) {
                    consider(dev + chosen[j].coef * sgn * frac)
                  }
                }
              }
            }
            return
          }
          const startI = pos === 0 ? 0 : idx[pos - 1] + 1
          for (let i = startI; i <= n - (k - pos); i++) {
            idx[pos] = i
            rec(pos + 1)
          }
        }
        if (k === 0) {
          // 只有分坐标，或 Γ=0（枚举 0 向量）
          if (frac > 1e-9) {
            for (let j = 0; j < n; j++) {
              consider(chosen[j].coef * frac)
              consider(-chosen[j].coef * frac)
            }
          } else {
            consider(0)
          }
          return
        }
        rec(0)
      }
      if (g <= 1e-12) consider(0)
      else enumerateSets(floor)
    }

    const truncated = relevant.length > n
    // 解析值用同一子集计算，便于与枚举直接比对；未截断时子集=全部因子。
    // 全集解析值另行给出，用于说明实际保护范围。
    const analytical = subsetAnalyticalPlus
    const analyticalFull = isBudget
      ? budgetDeviationTotal(relevant.map((x) => x.f), lines, prop, gamma)
      : boxDeviationTotal(relevant.map((x) => x.f), lines, prop)
    for (const dir of ['min', 'max'] as Dir[]) {
      const enumerated = dir === 'max' ? enumeratedPlus : -enumeratedMinus
      const diff = Math.abs(analytical - enumerated)
      const covers = enumerated >= analytical - 1e-6
      out.push({
        property: prop,
        dir,
        analytical,
        analyticalFull,
        enumerated,
        vertices,
        match: covers,
        diff,
        gamma: isBudget ? gamma : Number.POSITIVE_INFINITY,
        method: isBudget ? 'budget' : 'box',
        truncated,
        factorCount: relevant.length,
        enumeratedFactors: n,
      })
    }
  }
  return out
}

/** 场景集上某配比的实际最坏违反场景（与 evaluateRisk 一致的最小实现，供核对页使用）。 */
export function worstScenarioFor(
  set: ScenarioSet,
  lines: MixLine[],
  heel: HeelInput,
  volume: number,
  properties: PropertyId[],
  factors: FactorDef[],
  spec: SpecSet,
) {
  const nom = nominalQuality(lines, heel, volume, properties)
  const limits = new Map<PropertyId, { min: number | null; max: number | null }>()
  for (const l of spec.limits) limits.set(l.property, { min: l.min, max: l.max })
  let best: { scenarioId: string; label: string; score: number; property: PropertyId | null; value: number; limit: number | null; probability: number } | null = null
  for (const s of set.scenarios) {
    const dev = deviationForScenario(factors, lines, s)
    let score = 0
    let worstProp: PropertyId | null = null
    let worstValue = 0
    let worstLimit: number | null = null
    for (const [p, lim] of limits) {
      const q = nom[p] + (dev[p] ?? 0) / volume
      if (lim.min != null && q < lim.min) {
        const e = (lim.min - q) / Math.max(Math.abs(lim.min), 1)
        if (e > score) { score = e; worstProp = p; worstValue = q; worstLimit = lim.min }
      }
      if (lim.max != null && q > lim.max) {
        const e = (q - lim.max) / Math.max(Math.abs(lim.max), 1)
        if (e > score) { score = e; worstProp = p; worstValue = q; worstLimit = lim.max }
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = {
        scenarioId: s.id, label: s.label, score,
        property: worstProp, value: worstValue, limit: worstLimit, probability: s.probability,
      }
    }
  }
  return best
}

export function describeMix(lines: MixLine[]): string {
  return lines.map((l) => `${l.lot.id} ${l.quantity.toFixed(0)}t`).join(' + ')
}

export function qualityColor(property_: PropertyId, v: number, spec: SpecSet): 'ok' | 'warn' | 'bad' {
  const lim = spec.limits.find((l) => l.property === property_)
  if (!lim) return 'ok'
  if (lim.min != null && v < lim.min) return 'bad'
  if (lim.max != null && v > lim.max) return 'bad'
  const margin = 0.05
  if (lim.min != null && v < lim.min + Math.abs(lim.min) * margin) return 'warn'
  if (lim.max != null && v > lim.max - Math.abs(lim.max) * margin) return 'warn'
  return 'ok'
}

export function formatQty(q: number) {
  return `${q.toFixed(1)} t`
}
