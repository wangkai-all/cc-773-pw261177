/** 极简 CPLEX LP 文本构建器：所有变量项都在约束左侧，避免解析歧义。 */

export interface Row {
  name: string
  /** varName -> coefficient */
  terms: Map<string, number>
  sense: '<=' | '>=' | '='
  rhs: number
}

export class LpBuilder {
  rows: Row[] = []
  objective = new Map<string, number>()
  bounds = new Map<string, { lower: number; upper: number }>()
  binaries = new Set<string>()
  private names = new Set<string>()

  addVar(name: string, lower = 0, upper = Number.POSITIVE_INFINITY) {
    if (this.names.has(name)) return
    this.names.add(name)
    this.bounds.set(name, { lower, upper })
    this.objective.set(name, 0)
  }

  markBinary(name: string, lower = 0, upper = 1) {
    this.addVar(name, lower, upper)
    this.binaries.add(name)
  }

  setCost(name: string, cost: number) {
    this.addVar(name)
    this.objective.set(name, cost)
  }

  addRow(
    name: string,
    terms: Array<[string, number]>,
    sense: Row['sense'],
    rhs: number,
  ) {
    const map = new Map<string, number>()
    for (const [v, c] of terms) {
      if (!Number.isFinite(c) || Math.abs(c) < 1e-12) continue
      this.addVar(v)
      map.set(v, (map.get(v) ?? 0) + c)
    }
    this.rows.push({ name, terms: map, sense, rhs })
  }

  toText(): string {
    const num = (x: number) => {
      if (Math.abs(x) < 1e-12) return '0'
      const s = x.toFixed(9)
      return s.replace(/\.?0+$/, '') || '0'
    }
    const obj = [...this.objective.entries()]
      .filter(([v, c]) => Math.abs(c) > 1e-12)
      .map(([v, c]) => `${num(c)} ${v}`)
      .join(' + ')
    const lines: string[] = []
    lines.push('Minimize')
    lines.push(` obj: ${obj || '0 __zero'}`)
    lines.push('Subject To')
    for (const row of this.rows) {
      const terms = [...row.terms.entries()]
        .map(([v, c]) => `${num(c)} ${v}`)
        .join(' + ')
      lines.push(` ${row.name}: ${terms || '0 __zero'} ${row.sense} ${num(row.rhs)}`)
    }
    lines.push('Bounds')
    if (!this.names.has('__zero')) {
      this.addVar('__zero', 0, 0)
    }
    for (const [v, b] of this.bounds) {
      if (v === '__zero') {
        lines.push(` ${v} = 0`)
        continue
      }
      if (b.upper === Number.POSITIVE_INFINITY) lines.push(` ${v} >= ${num(b.lower)}`)
      else lines.push(` ${num(b.lower)} <= ${v} <= ${num(b.upper)}`)
    }
    if (this.binaries.size > 0) {
      lines.push('Binaries')
      for (const v of this.binaries) lines.push(` ${v}`)
    }
    lines.push('End')
    return lines.join('\n')
  }
}
