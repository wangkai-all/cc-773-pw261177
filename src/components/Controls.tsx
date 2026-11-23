import { useEffect, useRef, useState } from 'react'
import type { PlanMode, PropertyId, PublicState, AssayCell } from '../../shared/types.ts'
import { PROPERTIES } from '../../shared/catalog.ts'
import { Card, Seg } from './ui.tsx'
import { pct } from '../format.ts'

export interface LotEdit {
  nominal: number
  halfWidth: number
  hasAssay: boolean
}

interface Props {
  state: PublicState
  mode: PlanMode
  onMode: (m: PlanMode) => void
  rho: number
  onRho: (v: number) => void
  gamma: number
  alpha: number
  onGamma: (v: number) => void
  onAlpha: (v: number) => void
  specId: string
  onSpec: (id: string) => void
  edits: Record<string, Partial<Record<PropertyId, AssayCell>>>
  onEdit: (lotId: string, property: PropertyId, cell: LotEdit) => void
  onResetEdit: (lotId: string, property: PropertyId) => void
  onResetFixture: (id: 'BASE' | 'MISSING' | 'TIGHT') => void
  onSolve: () => void
  solving: boolean
  dirty: boolean
}

const MODE_KIND = (m: PlanMode) => m.kind

export function Controls(props: Props) {
  const { state, mode } = props
  const kind = MODE_KIND(mode)
  const spec = state.specSets.find((s) => s.id === props.specId) ?? state.specSets[0]

  return (
    <div>
      <Card title="方案设置" hint="虚构数据">
        <div className="field">
          <label htmlFor="fixture">罐区样例</label>
          <select
            id="fixture"
            value={state.fixture}
            onChange={(e) => {
              const v = e.target.value
              if (v !== state.fixture) props.onResetFixture(v as 'BASE' | 'MISSING' | 'TIGHT')
            }}
          >
            <option value="BASE">基准罐区</option>
            <option value="MISSING">缺检测</option>
            <option value="TIGHT">库存竞争</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="spec">产品规格</label>
          <select
            id="spec"
            value={spec.id}
            onChange={(e) => props.onSpec(e.target.value)}
          >
            {state.specSets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="small muted" style={{ marginTop: 4 }}>
            {spec.note}
          </div>
        </div>

        <div className="field">
          <label>不确定度处理</label>
          <Seg
            ariaLabel="方案模式"
            value={kind}
            onChange={(v) => {
              if (v === 'nominal') props.onMode({ kind: 'nominal' })
              else if (v === 'box') props.onMode({ kind: 'box' })
              else if (v === 'budget') props.onMode({ kind: 'budget', gamma: props.gamma })
              else props.onMode({ kind: 'chance', alpha: props.alpha })
            }}
            options={[
              { value: 'nominal', label: '名义', title: '只用检测中心值，不看区间' },
              { value: 'budget', label: '预算 Γ', title: '允许 Γ 个因子同时取到最坏端点' },
              { value: 'budget_y', label: 'x', title: '' },
              { value: 'box', label: '箱式最坏', title: '所有因子同时取最坏端点（极保守）' },
              { value: 'chance', label: '场景概率 α', title: '在场景集上至少以 α 概率满足规格' },
            ].filter((o) => o.value !== 'budget_y') as any}
          />
        </div>

        {kind === 'budget' ? (
          <div className="field">
            <label>
              Γ 预算系数：<b className="mono">{props.gamma.toFixed(1)}</b>
              <span className="muted small"> · 0=名义，{Math.max(1, 5)} 以上趋近箱式</span>
            </label>
            <input
              type="range"
              min={0}
              max={8}
              step={0.5}
              value={props.gamma}
              onChange={(e) => {
                const g = Number(e.target.value)
                props.onGamma(g)
                props.onMode({ kind: 'budget', gamma: g })
              }}
              style={{ width: '100%' }}
            />
          </div>
        ) : null}

        {kind === 'chance' ? (
          <div className="field">
            <label>
              满足概率下限 α：<b className="mono">{pct(props.alpha, 0)}</b>
            </label>
            <input
              type="range"
              min={0.5}
              max={0.99}
              step={0.01}
              value={props.alpha}
              onChange={(e) => {
                const a = Number(e.target.value)
                props.onAlpha(a)
                props.onMode({ kind: 'chance', alpha: a })
              }}
              style={{ width: '100%' }}
            />
          </div>
        ) : null}

        <div className="field" style={{ marginBottom: 6 }}>
          <label>
            同批共同偏移份额 ρ：<b className="mono">{props.rho.toFixed(2)}</b>
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={props.rho}
            onChange={(e) => props.onRho(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div className="small muted" style={{ marginTop: 2 }}>
            ρ 份额的区间宽度按「同批一次共同偏移」处理，剩余按各罐独立误差处理。
            同批偏移只有一个随机变量，<b>不能把同批各罐的上限相加</b>。
          </div>
        </div>

        <button
          className="primary"
          onClick={props.onSolve}
          disabled={props.solving}
          style={{ width: '100%', padding: '8px 12px' }}
        >
          {props.solving ? (
            <>
              <span className="spin" /> 求解中…
            </>
          ) : props.dirty ? (
            '重新求解（参数已变）'
          ) : (
            '求解最低成本配比'
          )}
        </button>
      </Card>

      <AssayEditor state={state} edits={props.edits} onEdit={props.onEdit} onResetEdit={props.onResetEdit} />
    </div>
  )
}

function AssayEditor(props: {
  state: PublicState
  edits: Record<string, Partial<Record<PropertyId, AssayCell>>>
  onEdit: (lotId: string, property: PropertyId, cell: LotEdit) => void
  onResetEdit: (lotId: string, property: PropertyId) => void
}) {
  const { state } = props
  const [open, setOpen] = useState(true)
  return (
    <Card
      title="检测区间"
      hint="报告值 ± 半宽"
      actions={
        <button className="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
        </button>
      }
      bodyClass="tight"
    >
      {open ? (
        <div className="assay-grid">
          <table>
            <thead>
              <tr>
                <th>原料罐</th>
                {PROPERTIES.map((p) => (
                  <th key={p.id} className="num" title={p.name}>
                    {p.short}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.lots.map((lot) => {
                const avail = state.availability.find((a) => a.lotId === lot.id)?.available ?? lot.quantity
                return (
                  <tr key={lot.id} className={avail <= 0.01 ? 'no-assay' : ''}>
                    <td className="lot">
                      {lot.id}
                      <div className="muted" style={{ fontWeight: 400, fontSize: 10.5 }}>
                        {lot.batchId} · {avail.toFixed(0)}t
                      </div>
                    </td>
                    {PROPERTIES.map((p) => {
                      const edited = props.edits[lot.id]?.[p.id]
                      const cell = edited ?? lot.assay[p.id]
                      if (!cell) return <td key={p.id} />
                      return (
                        <td key={p.id} className="nowrap">
                          {cell.hasAssay ? (
                            <AssayCellInput
                              lotId={lot.id}
                              property={p.id}
                              cell={cell}
                              edited={Boolean(edited)}
                              onEdit={props.onEdit}
                              onReset={props.onResetEdit}
                            />
                          ) : (
                            <button
                              className="assay-toggle"
                              title="点击补录检测值"
                              onClick={() =>
                                props.onEdit(lot.id, p.id, {
                                  nominal: cell.nominal || 0,
                                  halfWidth: cell.halfWidth || 0,
                                  hasAssay: true,
                                })
                              }
                            >
                              <span className="missing">缺检测</span>
                            </button>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
              <tr>
                <td className="lot">
                  {state.heel.tankId} 余量
                  <div className="muted" style={{ fontWeight: 400, fontSize: 10.5 }}>
                    {state.heel.quantity.toFixed(0)}t
                  </div>
                </td>
                {PROPERTIES.map((p) => {
                  const c = state.heel.assay[p.id]
                  return (
                    <td key={p.id} className="num mono small">
                      {c?.hasAssay ? `${c.nominal}±${c.halfWidth}` : '—'}
                    </td>
                  )
                })}
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="small muted" style={{ marginTop: 6 }}>
        点击数值可直接编辑；半宽=0 表示该项视为精确检测。编辑后按「重新求解」生效。
      </div>
    </Card>
  )
}

function AssayCellInput(props: {
  lotId: string
  property: PropertyId
  cell: AssayCell
  edited: boolean
  onEdit: (lotId: string, property: PropertyId, cell: LotEdit) => void
  onReset: (lotId: string, property: PropertyId) => void
}) {
  const [nominal, setNominal] = useState(String(props.cell.nominal))
  const [half, setHalf] = useState(String(props.cell.halfWidth))
  const ref = useRef(props.cell)
  useEffect(() => {
    setNominal(String(props.cell.nominal))
    setHalf(String(props.cell.halfWidth))
    ref.current = props.cell
  }, [props.cell])
  const commit = (n: string, h: string) => {
    const nv = Number(n)
    const hv = Number(h)
    if (!Number.isFinite(nv) || !Number.isFinite(hv) || hv < 0) return
    if (nv === ref.current.nominal && hv === ref.current.halfWidth) return
    props.onEdit(props.lotId, props.property, { nominal: nv, halfWidth: hv, hasAssay: true })
  }
  return (
    <span className="row" style={{ gap: 2, flexWrap: 'nowrap' }}>
      <input
        type="number"
        step="any"
        value={nominal}
        aria-label={`${props.lotId} ${props.property} 报告值`}
        onChange={(e) => setNominal(e.target.value)}
        onBlur={() => commit(nominal, half)}
        onKeyDown={(e) => e.key === 'Enter' && commit(nominal, half)}
        style={props.edited ? { borderColor: 'var(--warn)' } : undefined}
      />
      <span className="muted" style={{ fontSize: 11 }}>±</span>
      <input
        type="number"
        step="any"
        min="0"
        value={half}
        aria-label={`${props.lotId} ${props.property} 半宽`}
        onChange={(e) => setHalf(e.target.value)}
        onBlur={() => commit(nominal, half)}
        onKeyDown={(e) => e.key === 'Enter' && commit(nominal, half)}
        style={{ ...(props.edited ? { borderColor: 'var(--warn)' } : {}), width: 52 }}
      />
      {props.edited ? (
        <button
          className="ghost"
          style={{ fontSize: 11, padding: '0 3px' }}
          title="撤销本地编辑"
          onClick={() => props.onReset(props.lotId, props.property)}
        >
          ↺
        </button>
      ) : null}
    </span>
  )
}
