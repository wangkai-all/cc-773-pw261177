import { useState } from 'react'
import type { Order, PublicState, Reservation } from '../../shared/types.ts'
import { Card, Pill, Empty } from './ui.tsx'
import { money, pct, qty } from '../format.ts'

export function OrdersPanel(props: {
  state: PublicState
  onRelease: (orderId: string) => Promise<void> | void
  onCommit: (orderId: string) => Promise<void> | void
  busy: string | null
}) {
  const { state } = props
  const [open, setOpen] = useState(true)
  const active = state.orders.filter((o) => reservationsOf(state, o).some((r) => r.status === 'active'))
  return (
    <Card
      title="订单与预留"
      hint={`${state.orders.length} 张订单`}
      actions={
        <button className="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
        </button>
      }
      bodyClass="tight"
    >
      {open ? (
        state.orders.length === 0 ? (
          <Empty>还没有订单。求解方案后点「确认并预留库存」。</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>订单</th>
                <th>牌号 / 产量</th>
                <th className="num">预留</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.orders.map((o) => {
                const rs = reservationsOf(state, o)
                const activeCount = rs.filter((r) => r.status === 'active').length
                const committed = rs.filter((r) => r.status === 'committed').length
                const released = rs.filter((r) => r.status === 'released').length
                const status =
                  committed > 0 && activeCount === 0
                    ? { tone: 'neutral' as const, label: '已投料' }
                    : activeCount > 0
                      ? { tone: 'good' as const, label: '预留中' }
                      : { tone: 'neutral' as const, label: '已释放' }
                return (
                  <tr key={o.id}>
                    <td>
                      <div className="mono">{o.id}</div>
                      <div className="muted small">{new Date(o.createdAt).toLocaleTimeString('zh-CN')} · {o.operator}</div>
                    </td>
                    <td>
                      <div>{o.specSetId}</div>
                      <div className="muted small">{qty(o.volume)} · {o.allocations.length} 罐</div>
                    </td>
                    <td className="num small">
                      {rs.length} 条
                      <div className="muted">
                        有效 {activeCount}
                        {committed ? ` · 投料 ${committed}` : ''}
                        {released ? ` · 释放 ${released}` : ''}
                      </div>
                    </td>
                    <td>
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </td>
                    <td className="right nowrap">
                      {activeCount > 0 ? (
                        <>
                          <button
                            className="ghost"
                            disabled={props.busy === o.id}
                            onClick={() => props.onRelease(o.id)}
                            title="释放尚未投料的预留"
                          >
                            释放未投料
                          </button>
                          <button
                            className="ghost"
                            disabled={props.busy === o.id}
                            onClick={() => props.onCommit(o.id)}
                            title="标记已投料，此后不可释放"
                          >
                            标记投料
                          </button>
                        </>
                      ) : (
                        <span className="small muted">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )
      ) : null}
    </Card>
  )
}

function reservationsOf(state: PublicState, order: Order): Reservation[] {
  return state.reservations.filter((r) => r.planId === order.planId)
}

export function AvailabilityPanel(props: { state: PublicState }) {
  const { state } = props
  return (
    <Card title="可用量" hint="总量 − 预留 − 已投料" bodyClass="tight">
      <table className="compact">
        <thead>
          <tr>
            <th>原料</th>
            <th className="num">库存</th>
            <th className="num">预留</th>
            <th className="num">投料</th>
            <th className="num">可用</th>
          </tr>
        </thead>
        <tbody>
          {state.availability.map((a) => {
            const lot = state.lots.find((l) => l.id === a.lotId)
            const usedShare = a.quantity > 0 ? 1 - a.available / a.quantity : 0
            return (
              <tr key={a.lotId}>
                <td>
                  <span className="mono">{a.lotId}</span>
                  <div className="muted small">{lot?.material}</div>
                </td>
                <td className="num">{qty(a.quantity, 0)}</td>
                <td className="num">{a.reserved ? qty(a.reserved, 0) : <span className="muted">—</span>}</td>
                <td className="num">{a.committed ? qty(a.committed, 0) : <span className="muted">—</span>}</td>
                <td className="num">
                  <b>{qty(a.available, 0)}</b>
                  <div className="bar" title={`${pct(usedShare, 0)} 已占用`} style={{ marginTop: 3 }}>
                    <span
                      style={{
                        width: `${(usedShare * 100).toFixed(1)}%`,
                        background: a.available <= 0.01 ? 'var(--bad)' : 'var(--accent)',
                      }}
                    />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}

export function AuditPanel(props: { state: PublicState }) {
  const { state } = props
  return (
    <Card title="操作审计" hint={`v${state.version}`} bodyClass="tight">
      <div style={{ maxHeight: 220, overflow: 'auto' }}>
        {state.audit.map((a, i) => (
          <div key={i} className="row small" style={{ padding: '4px 0', borderBottom: '1px solid var(--rule)', gap: 8 }}>
            <span className="mono muted" style={{ fontSize: 11 }}>
              {new Date(a.at).toLocaleTimeString('zh-CN')}
            </span>
            <span className="chip" style={{ fontSize: 10.5 }}>{a.actor}</span>
            <span className="grow">{a.detail}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

export function CostHint(props: { total: number; unit: number }) {
  return (
    <span className="small muted">
      合计 {money(props.total)} · {money(props.unit, 1)}/t
    </span>
  )
}
