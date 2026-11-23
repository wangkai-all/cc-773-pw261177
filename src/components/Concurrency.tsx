import { useState } from 'react'
import type { PlanMode, PlanResult, PublicState } from '../../shared/types.ts'
import { api, modeLabel, type ConfirmFailure, type ConfirmSuccess } from '../api.ts'
import { Card, Empty, Pill } from './ui.tsx'
import { money, pct, qty } from '../format.ts'

type ModeChoice = 'nominal' | 'budget2' | 'box' | 'chance90'

function toMode(c: ModeChoice): PlanMode {
  if (c === 'nominal') return { kind: 'nominal' }
  if (c === 'budget2') return { kind: 'budget', gamma: 2 }
  if (c === 'box') return { kind: 'box' }
  return { kind: 'chance', alpha: 0.9 }
}

interface Side {
  operator: string
  choice: ModeChoice
  plan: PlanResult | null
  solving: boolean
  confirming: boolean
  outcome: (ConfirmSuccess | ConfirmFailure) | null
}

const initial = (operator: string, choice: ModeChoice): Side => ({
  operator,
  choice,
  plan: null,
  solving: false,
  confirming: false,
  outcome: null,
})

export function ConcurrencyPanel(props: {
  state: PublicState
  specId: string
  rho: number
  onState: (s: PublicState) => void
  onToast: (msg: string, tone: 'good' | 'bad' | 'info') => void
}) {
  const [a, setA] = useState<Side>(() => initial('操作员甲', 'budget2'))
  const [b, setB] = useState<Side>(() => initial('操作员乙', 'chance90'))
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const solveSide = async (side: Side): Promise<PlanResult | null> => {
    try {
      const res = await api.solve(
        { specSetId: props.specId, mode: toMode(side.choice), rho: props.rho },
        side.operator,
      )
      return res.result
    } catch (e: any) {
      props.onToast(e?.message ?? '求解失败', 'bad')
      return null
    }
  }

  const prepareOne = async (which: 'a' | 'b') => {
    const side = which === 'a' ? a : b
    const setSide = which === 'a' ? setA : setB
    setSide({ ...side, solving: true, outcome: null })
    const plan = await solveSide(side)
    setSide({ ...side, plan, solving: false, outcome: null })
    setNote(null)
  }

  const prepareBoth = async () => {
    if (busy) return
    setBusy(true)
    setNote(null)
    setA((s) => ({ ...s, solving: true, outcome: null }))
    setB((s) => ({ ...s, solving: true, outcome: null }))
    const [pa, pb] = await Promise.all([solveSide(a), solveSide(b)])
    setA((s) => ({ ...s, plan: pa, solving: false, outcome: null }))
    setB((s) => ({ ...s, plan: pb, solving: false, outcome: null }))
    setBusy(false)
  }

  const confirmBoth = async () => {
    if (busy || !a.plan || !b.plan) return
    setBusy(true)
    setNote(null)
    setA((s) => ({ ...s, confirming: true, outcome: null }))
    setB((s) => ({ ...s, confirming: true, outcome: null }))
    const version = Math.min(a.plan.basedOnVersion, b.plan.basedOnVersion)
    const [ra, rb] = await Promise.all([
      api.confirm(a.plan.id, { clientVersion: version }, a.operator),
      api.confirm(b.plan.id, { clientVersion: version }, b.operator),
    ])
    const winners = [ra, rb].filter((r) => r.ok).length
    setA((s) => ({ ...s, confirming: false, outcome: ra }))
    setB((s) => ({ ...s, confirming: false, outcome: rb }))
    if (winners === 1) {
      const win = ra.ok ? a : b
      setNote(`只有「${win.operator}」确认成功。另一张单收到版本冲突，需要重新求解。`)
    } else if (winners === 2) {
      setNote('两张单都成功了——这是一个缺陷：两次确认必须互斥。')
    } else {
      setNote('两张单都失败（可能两张方案的基线版本都已过期）。')
    }
    const st = (ra.ok ? ra.state : !rb.ok ? rb.state : null) ?? null
    if (st) props.onState(st)
    else {
      try {
        props.onState(await api.state())
      } catch {
        /* ignore */
      }
    }
    setBusy(false)
  }

  const reSolveLoser = async () => {
    const loserIsA = a.outcome && !a.outcome.ok
    const side = loserIsA ? a : b
    const setSide = loserIsA ? setA : setB
    setBusy(true)
    setSide({ ...side, solving: true, outcome: null })
    const plan = await solveSide(side)
    setSide({ ...side, plan, solving: false, outcome: null })
    setBusy(false)
    setNote('已基于最新库存重新求解，可以再次确认。')
    try {
      props.onState(await api.state())
    } catch {
      /* ignore */
    }
  }

  const bothSolved = Boolean(a.plan && b.plan)
  const oneWon = [a, b].filter((s) => s.outcome?.ok).length === 1

  return (
    <Card
      title="两人同时确认"
      hint="乐观并发控制：同一基线版本只能有一个成功"
      actions={
        <span className="chip">当前 v{props.state.version}</span>
      }
    >
      <div className="small muted" style={{ marginBottom: 10 }}>
        两位操作员基于同一份库存各自求解一张配料单。库存没有变化时两张单都有效；
        「同时确认」时服务端只接受先到的一张，另一张因版本过期返回 409，必须重新求解。
      </div>

      <div className="two-op">
        <SideCard
          side={a}
          title="甲"
          onChoice={(choice) => {
            setA((s) => ({ ...s, choice, plan: null, outcome: null }))
          }}
          onSolve={() => prepareOne('a')}
        />
        <div className="versus">VS</div>
        <SideCard
          side={b}
          title="乙"
          onChoice={(choice) => {
            setB((s) => ({ ...s, choice, plan: null, outcome: null }))
          }}
          onSolve={() => prepareOne('b')}
        />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={prepareBoth} disabled={busy}>
          {busy && !a.confirming && !b.confirming ? <span className="spin" /> : '两人各自求解'}
        </button>
        <button className="primary" onClick={confirmBoth} disabled={busy || !bothSolved}>
          同时确认两张单
        </button>
        {oneWon ? (
          <button onClick={reSolveLoser} disabled={busy}>
            失败方重新求解
          </button>
        ) : null}
        <span className="grow" />
        {a.plan && b.plan ? (
          <span className="small muted">
            两张单分别为 {modeLabel(a.plan.mode)} / {modeLabel(b.plan.mode)}
          </span>
        ) : null}
      </div>

      {note ? (
        <div
          className={`banner ${oneWon ? 'warn' : ''}`}
          style={{ marginTop: 10, marginBottom: 0 }}
        >
          {note}
        </div>
      ) : null}

      {!bothSolved && !a.plan && !b.plan ? (
        <Empty>先让两位操作员各求解一张单。</Empty>
      ) : null}

      <div className="small muted" style={{ marginTop: 10 }}>
        确认成功的方案会写入订单并预留原料；失败方需要点击「重新求解」，
        服务端会用扣减预留后的可用量重新优化——通常成本会上升，或改用其它罐。
      </div>
    </Card>
  )
}

function SideCard(props: {
  side: Side
  title: string
  onChoice: (c: ModeChoice) => void
  onSolve: () => void
}) {
  const { side } = props
  const outcome = side.outcome
  return (
    <div className={`op-card${outcome ? (outcome.ok ? ' win' : ' lose') : ''}`}>
      <div className="row" style={{ marginBottom: 6 }}>
        <b className="grow">{side.operator}</b>
        {outcome ? (
          outcome.ok ? (
            <Pill tone="good">确认成功</Pill>
          ) : (
            <Pill tone="bad">冲突 {outcome.status}</Pill>
          )
        ) : side.solving ? (
          <span className="spin" />
        ) : side.plan ? (
          <Pill tone="neutral">已求解</Pill>
        ) : (
          <Pill tone="neutral">未求解</Pill>
        )}
      </div>
      <select
        value={side.choice}
        aria-label={`${props.title} 方案模式`}
        onChange={(e) => props.onChoice(e.target.value as ModeChoice)}
        style={{ width: '100%', marginBottom: 6 }}
      >
        <option value="nominal">名义方案</option>
        <option value="budget2">预算 Γ=2</option>
        <option value="box">箱式最坏</option>
        <option value="chance90">场景概率 α=90%</option>
      </select>
      {side.plan ? (
        <div className="small">
          <div>
            {money(side.plan.totalCost)} · {money(side.plan.unitCost, 1)}/t
          </div>
          <div className="muted">
            {qty(side.plan.volume)} · 场景满足 {pct(side.plan.risk.satisfiedProbability, 0)} · 基于 v
            {side.plan.basedOnVersion}
          </div>
          <div className="muted mono" style={{ fontSize: 10.5 }}>
            {side.plan.id}
          </div>
        </div>
      ) : (
        <div className="small muted">尚未求解</div>
      )}
      {outcome && !outcome.ok ? (
        <div className="small" style={{ color: 'var(--bad)', marginTop: 6 }}>
          {outcome.error}
        </div>
      ) : null}
      {outcome && outcome.ok ? (
        <div className="small" style={{ color: 'var(--good)', marginTop: 6 }}>
          订单 {outcome.orderId} · 预留 {outcome.reservationIds.length} 条
        </div>
      ) : null}
      <button
        style={{ width: '100%', marginTop: 6 }}
        onClick={props.onSolve}
        disabled={side.solving}
      >
        求解
      </button>
    </div>
  )
}
