import { useEffect, useRef, useState } from 'react'
import type { VerifyResponse } from '../api.ts'
import type { PublicState } from '../../shared/types.ts'
import { property } from '../../shared/catalog.ts'
import { Card, Kpi, Pill, Empty } from './ui.tsx'
import { dirLabel, money, propValue, qty } from '../format.ts'

export function VerifyPanel(props: {
  data: VerifyResponse | null
  state: PublicState
  onClose: () => void
}) {
  const [tab, setTab] = useState<'enum' | 'vertex'>('enum')
  const d = props.data
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (d && !el.open) el.showModal()
    if (!d && el.open) el.close()
  }, [d])
  return (
    <dialog
      ref={ref}
      className="modal"
      onClose={props.onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      {d ? (
        <>
          <div className="modal-head">
            <h3>核对：{d.planId}</h3>
            <span className="chip">{d.method === 'box' ? '箱式最坏' : d.method === 'budget' ? `预算 Γ=${d.gamma}` : '不适用'}</span>
            <span className="spacer grow" />
            <button onClick={props.onClose}>关闭</button>
          </div>
          <div className="modal-body">
            <div className="tabs">
              <button aria-selected={tab === 'enum'} onClick={() => setTab('enum')}>
                配比枚举 vs LP 最优
              </button>
              <button aria-selected={tab === 'vertex'} onClick={() => setTab('vertex')}>
                因子顶点 vs 解析最坏
              </button>
            </div>
            {tab === 'enum' ? <EnumTab data={d} state={props.state} /> : <VertexTab data={d} />}
          </div>
        </>
      ) : null}
    </dialog>
  )
}

function EnumTab({ data, state }: { data: VerifyResponse; state: PublicState }) {
  const e = data.enumeration
  const lp = data.lp
  const gap = e.bestBox ? e.bestBox.nominalCost - lp.totalCost : null
  return (
    <div className="stack">
      <div className="kpis" style={{ marginBottom: 4 }}>
        <Kpi label="枚举组合数" value={e.combos.toLocaleString('zh-CN')} note={`步长 ${e.gridStep.toFixed(1)} t`} />
        <Kpi
          label={`名义可行 / ${e.protection === 'budget' ? `Γ=${e.gamma}` : e.protection === 'box' ? '箱式' : '保护'}可行`}
          value={`${e.feasibleNominal} / ${e.feasibleBox}`}
          note={`共 ${e.combos.toLocaleString('zh-CN')} 组`}
        />
        <Kpi
          label="LP 最优成本"
          value={money(lp.totalCost)}
          note={`${money(lp.unitCost, 1)}/t`}
        />
        <Kpi
          label={`离散${e.protection === 'budget' ? `Γ=${e.gamma}` : '箱式'}最优`}
          value={e.bestBox ? money(e.bestBox.nominalCost) : '—'}
          note={
            gap == null
              ? '无箱式可行组合'
              : gap >= -1e-6
                ? `比 LP 高 ${money(gap)}（离散网格导致，符合预期）`
                : `比 LP 低 ${money(-gap)}：说明 LP 遗漏了离散点（异常）`
          }
          tone={gap != null && gap < -1e-6 ? 'bad' : undefined}
        />
      </div>

      {e.notes.map((n, i) => (
        <div key={i} className="banner" style={{ margin: 0 }}>
          {n}
        </div>
      ))}

      <Card
        title={`${e.protection === 'budget' ? `预算 Γ=${e.gamma}` : e.protection === 'box' ? '箱式' : '保护'}最优的离散候选`}
        hint={`按成本升序，前 ${e.top.length} 组`}
        bodyClass="tight"
      >
        <table>
          <thead>
            <tr>
              <th>配比（t）</th>
              <th className="num">成本</th>
              <th className="num">元/t</th>
              <th>最紧指标</th>
              <th className="num">最坏超出</th>
            </tr>
          </thead>
          <tbody>
            {e.top.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>
                    没有{e.protection === 'budget' ? `预算 Γ=${e.gamma}` : '箱式'}可行组合。
                    {e.closestInfeasible ? '下方给出最接近可行的组合。' : ''}
                  </Empty>
                </td>
              </tr>
            ) : (
              e.top.map((row, i) => (
                <tr key={i}>
                  <td className="mono small">
                    {row.quantities.map((q) => `${q.lotId} ${q.quantity.toFixed(0)}`).join(' + ')}
                  </td>
                  <td className="num mono">{money(row.nominalCost)}</td>
                  <td className="num mono">{row.costPerTonne.toFixed(1)}</td>
                  <td className="small">
                    {row.worstProperty ? property(row.worstProperty).name : '—'}
                  </td>
                  <td className="num mono">{row.worstExcessNorm <= 0 ? '无' : `${(row.worstExcessNorm * 100).toFixed(2)}%`}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      <Card title="离散最优组合的名义质量" bodyClass="tight">
        <table>
          <thead>
            <tr>
              <th>指标</th>
              <th className="num">名义混合值</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(e.bestBox?.nominalQualities ?? e.bestNominal?.nominalQualities ?? {}).map(
              ([p, v]) => (
                <tr key={p}>
                  <td>{property(p as any).name}</td>
                  <td className="num mono">{propValue(p as any, v)}</td>
                  <td className="small muted">
                    该离散配比在检测中心值下的混合结果（未含误差偏移）
                  </td>
                </tr>
              ),
            )}
            {!e.bestBox && !e.bestNominal ? (
              <tr>
                <td colSpan={3}>
                  <Empty>无可行组合。</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>

      <div className="small muted">
        枚举所用可用量：{' '}
        {Object.entries(data.availableAtSolve)
          .map(([k, v]) => `${k} ${v.toFixed(0)}t`)
          .join(' · ')}{' '}
        （共 {state.lots.length} 罐）
      </div>
    </div>
  )
}

function VertexTab({ data }: { data: VerifyResponse }) {
  const checks = data.checks
  if (!checks.length) {
    return <Empty>该方案模式不使用解析最坏因子（名义或场景概率）。</Empty>
  }
  const bad = checks.filter((c) => !c.match)
  return (
    <div className="stack">
      <div className="kpis" style={{ marginBottom: 4 }}>
        <Kpi label="核对项" value={`${checks.length}`} note="指标 × 方向" />
        <Kpi
          label="全部覆盖"
          value={bad.length === 0 ? '是' : `否（${bad.length}）`}
          tone={bad.length === 0 ? 'good' : 'bad'}
          note="解析最坏值 ≤ 枚举极值"
        />
        <Kpi
          label="最大因子数"
          value={`${Math.max(...checks.map((c) => c.factorCount))}`}
          note="超过枚举上限时仅取前 5 个最大的因子"
        />
        <Kpi
          label="全集解析 / 子集枚举"
          value={`${Math.max(...checks.map((c) => c.analyticalFull)).toFixed(1)} / ${Math.max(...checks.map((c) => c.analytical)).toFixed(1)}`}
          note="整罐偏移量（t·指标）"
        />
      </div>
      {bad.length ? (
        <div className="banner bad" style={{ margin: 0 }}>
          有 {bad.length} 项解析值超出顶点枚举，说明最坏情形计算或因子构造有误。
        </div>
      ) : (
        <div className="banner good" style={{ margin: 0 }}>
          所有解析最坏偏移都能被顶点枚举覆盖；未被截断的项数值完全一致。
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>指标</th>
            <th>方向</th>
            <th className="num">全集解析</th>
            <th className="num">子集解析</th>
            <th className="num">顶点枚举极值</th>
            <th className="num">差</th>
            <th>顶点数</th>
            <th>因子数（全部/枚举）</th>
            <th>结论</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c, i) => (
            <tr key={i}>
              <td>{property(c.property).name}</td>
              <td>{dirLabel(c.dir)}</td>
              <td className="num mono">{c.analyticalFull.toFixed(3)}</td>
              <td className="num mono">{c.analytical.toFixed(3)}</td>
              <td className="num mono">{c.enumerated.toFixed(3)}</td>
              <td className="num mono">{c.diff.toFixed(4)}</td>
              <td className="num">{c.vertices}</td>
              <td className="num">
                {c.factorCount} / {c.enumeratedFactors}
                {c.truncated ? <span className="muted"> (截断)</span> : null}
              </td>
              <td>
                {!c.match ? (
                  <Pill tone="bad">不覆盖</Pill>
                ) : c.truncated ? (
                  <Pill tone="warn">覆盖（截断子集）</Pill>
                ) : (
                  <Pill tone="good">完全一致</Pill>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="small muted">
        「全集解析」用全部因子计算实际保护范围；「子集解析」与枚举用同样幅度最大的前 5 个因子，
        因此可以逐位比较。两者差值来自未纳入枚举的较小因子。
        箱式枚举覆盖全部 ±1 组合（{checks[0]?.method === 'box' ? '2^n 个顶点' : '预算多面体顶点'}），
        状态为「覆盖」即说明解析公式给出的是可达上界。
      </div>
    </div>
  )
}
