import { useMemo, useState } from 'react'
import type { LimitReport, PlanResult, PublicState, SpecSet } from '../../shared/types.ts'
import { PROPERTIES, property } from '../../shared/catalog.ts'
import { Card, Kpi, Pill, Bar, Empty } from './ui.tsx'
import { dirLabel, money, pct, propValue, qty, signed } from '../format.ts'
import { modeLabel } from '../api.ts'

type Tab = 'overview' | 'limits' | 'mix' | 'risk' | 'verify'

export function Results(props: {
  result: PlanResult
  state: PublicState
  onConfirm: () => void
  onVerify: () => void
  confirming: boolean
  verified: boolean
}) {
  const { result, state } = props
  const [tab, setTab] = useState<Tab>('overview')
  const spec = state.specSets.find((s) => s.id === result.specSetId)

  if (result.status !== 'optimal') {
    return <Infeasible result={result} />
  }

  return (
    <div>
      <KpiRow result={result} onConfirm={props.onConfirm} confirming={props.confirming} />

      <div className="tabs" role="tablist">
        {(
          [
            ['overview', '概览'],
            ['limits', `指标与限额 (${result.limits.length})`],
            ['mix', `配比 (${result.allocations.length} 罐)`],
            ['risk', '场景风险'],
            ['verify', '枚举核对'],
          ] as Array<[Tab, string]>
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview result={result} state={state} />}
      {tab === 'limits' && <Limits result={result} spec={spec} />}
      {tab === 'mix' && <Mix result={result} state={state} />}
      {tab === 'risk' && <Risk result={result} />}
      {tab === 'verify' && (
        <VerifyPreview result={result} onVerify={props.onVerify} verified={props.verified} />
      )}
    </div>
  )
}

function Infeasible({ result }: { result: PlanResult }) {
  const generic = '在当前规格、库存与不确定集下没有可行配比'
  return (
    <Card title="无可行方案" hint={result.specName}>
      <div className="banner bad" style={{ marginTop: 0 }}>
        <b>{generic}。</b>
        {result.message && result.message !== generic ? (
          <div style={{ marginTop: 4 }}>{result.message}</div>
        ) : null}
      </div>
      {result.diagnosis ? (
        <div className="stack" style={{ marginTop: 12 }}>
          {result.diagnosis.reasons.length === 0 ? (
            <div className="small muted">{result.diagnosis.headline}</div>
          ) : (
            result.diagnosis.reasons.map((r, i) => (
              <div key={i} className="banner warn" style={{ margin: 0 }}>
                {r.message}
                {r.bestAvailable != null && !/最好(也)?只能做到/.test(r.message) ? (
                  <span className="mono">
                    （最好 {propValue(r.property!, r.bestAvailable)}，要求 {propValue(r.property!, r.limit)}）
                  </span>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}
      {result.excludedLots.length ? (
        <>
          <div className="divider" />
          <div className="small muted">因缺检测被排除的原料：</div>
          {result.excludedLots.map((e) => (
            <div key={e.lotId} className="small">
              <span className="mono">{e.lotId}</span> — {e.reason}
            </div>
          ))}
        </>
      ) : null}
    </Card>
  )
}

function KpiRow(props: { result: PlanResult; onConfirm: () => void; confirming: boolean }) {
  const r = props.result
  const nominalGap = r.nominalUnitCost == null ? null : r.unitCost - r.nominalUnitCost
  const isNominal = r.mode.kind === 'nominal'
  return (
    <div className="kpis">
      <Kpi
        label="总成本"
        value={money(r.totalCost)}
        note={`${money(r.unitCost, 1)}/t · ${r.specName}`}
      />
      <Kpi
        label={isNominal ? '名义成本' : '保守溢价'}
        value={nominalGap == null ? '—' : `+${money(nominalGap, 1)}`}
        unit={nominalGap == null ? undefined : '/t'}
        note={
          nominalGap == null
            ? '名义方案不可行'
            : `相对名义最优 ${money(r.nominalUnitCost!, 1)}/t · 溢价 ${pct(r.premiumPct, 1)}`
        }
        tone={nominalGap && nominalGap > 0.5 ? 'warn' : undefined}
      />
      <Kpi
        label="场景满足概率"
        value={pct(r.risk.satisfiedProbability, 1)}
        note={`${r.risk.scenarioCount} 个场景 · ${modeLabel(r.mode)}`}
        tone={
          r.risk.satisfiedProbability >= 0.95
            ? 'good'
            : r.risk.satisfiedProbability >= 0.8
              ? 'warn'
              : 'bad'
        }
      />
      <Kpi
        label="保守程度"
        value={isNominal ? '无' : r.mode.kind === 'box' ? '箱式' : `Γ=${r.mode.kind === 'budget' ? r.mode.gamma : '—'}`}
        note={
          isNominal
            ? '仅用检测中心值'
            : `${r.factorCount} 个随机因子 · 全顶点同时发生概率 ${r.boxCornerProbability.toExponential(1)}`
        }
        tone={isNominal ? 'warn' : undefined}
      />
      <Kpi
        label="求解耗时"
        value={`${r.solveMs}`}
        unit="ms"
        note={`基于 v${r.basedOnVersion}${r.excludedLots.length ? ` · 排除 ${r.excludedLots.length} 罐缺检测` : ''}`}
      />
      <div className="kpi" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6 }}>
        <button className="primary" onClick={props.onConfirm} disabled={props.confirming}>
          {props.confirming ? <span className="spin" /> : '确认并预留库存'}
        </button>
        <span className="small muted">确认时会校验版本与可用量</span>
      </div>
    </div>
  )
}

function Overview({ result, state }: { result: PlanResult; state: PublicState }) {
  const r = result
  const worst = r.risk.worstScenario
  return (
    <div className="grid-2">
      <Card title="方案解读">
        <div className="stack small">
          <p style={{ margin: 0 }}>
            {r.mode.kind === 'nominal' ? (
              <>
                这是只用检测中心值求出的最低成本方案。它<b>完全忽略</b>了检测区间：
                实际成分偏离中心值时，可能超出规格。
              </>
            ) : r.mode.kind === 'box' ? (
              <>
                这是箱式最坏方案：所有 {r.factorCount} 个随机因子同时取到最坏端点。
                它保证任何允许的检测误差都不会超限，但代价是要求这些极端偏离<b>同时发生</b>，
                概率约为 {r.boxCornerProbability.toExponential(2)}，通常过于保守。
              </>
            ) : r.mode.kind === 'budget' ? (
              <>
                预算方案允许最多 Γ={r.mode.gamma} 个因子同时取到最坏端点（分数部分按比例）。
                相比箱式，它承认「所有指标、所有罐同时朝不利方向偏移」几乎不可能，
                但仍对任意 Γ 个因子的组合给出保证。
              </>
            ) : (
              <>
                场景概率方案要求：在 {r.scenarioSet.scenarios.length} 个按概率加权的抽样场景中，
                满足规格的概率不低于 α={pct(r.mode.alpha, 0)}。它直接给出可解释的违反概率。
              </>
            )}
          </p>
          <p style={{ margin: 0 }}>
            同批共同偏移份额 ρ={r.rho.toFixed(2)}：同一检测批的原料共用一个偏移变量，
            因此同批两罐的误差<b>不能</b>被当作独立上限相加。罐底余量按其自身批次处理，
            其检测误差同样计入区间，并按质量加权进入总量。
          </p>
          {worst ? (
            <p style={{ margin: 0 }}>
              实际最坏违反场景是 <b>{worst.label}</b>（概率 {pct(worst.probability, 3)}）：
              {worst.worst ? (
                <>
                  {' '}
                  {property(worst.worst.property).name} {dirLabel(worst.worst.dir)}要求{' '}
                  {propValue(worst.worst.property, worst.worst.limit)}，实际达到{' '}
                  <b style={{ color: 'var(--bad)' }}>{propValue(worst.worst.property, worst.worst.value)}</b>
                  （超出 {propValue(worst.worst.property, worst.worst.excessAbs)}）。
                </>
              ) : (
                ' 无违反。'
              )}
            </p>
          ) : (
            <p style={{ margin: 0 }}>
              场景集中没有任何场景违反规格。
            </p>
          )}
        </div>
      </Card>

      <Card title="区间为什么不能直接相加">
        <div className="small muted" style={{ marginBottom: 8 }}>
          计算规则：每个因子 ξ∈[−1,1] 独立（同批共用 ξ），指标偏移 = Σ cᵢξᵢ。
          下表列出各指标名义值与「箱式最坏」「预算 Γ={r.reportTotals.budgetGamma}」偏移量（整罐质量加权），作为两种参照，与当前方案模式无关。
        </div>
        <table>
          <thead>
            <tr>
              <th>指标</th>
              <th className="num">名义</th>
              <th className="num">箱式最坏偏移</th>
              <th className="num">预算 Γ={r.reportTotals.budgetGamma} (±)</th>
              <th className="num">预算/箱式</th>
              <th>上限相加?</th>
            </tr>
          </thead>
          <tbody>
            {PROPERTIES.map((p) => {
              const plus = r.reportTotals.plus[p.id] ?? 0
              const budgetDev = r.reportTotals.budget[p.id] ?? 0
              const share = plus > 1e-9 ? budgetDev / plus : 0
              return (
                <tr key={p.id}>
                  <td>
                    {p.name} <span className="mono small">{p.short}</span>
                  </td>
                  <td className="num mono">{propValue(p.id, r.nominal[p.id])}</td>
                  <td className="num mono">±{propValue(p.id, plus / r.volume, false)}</td>
                  <td className="num mono">±{propValue(p.id, budgetDev / r.volume, false)}</td>
                  <td className="num mono">{pct(share, 0)}</td>
                  <td className="small">
                    {r.mode.kind === 'box'
                      ? '仅当全部同时偏移'
                      : r.mode.kind === 'budget'
                        ? `最多 ${r.mode.gamma} 个`
                        : '否'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="divider" />
        <div className="small">
          <b>箱式逐项相加</b>是理论上界（全部因子同时取端点）；预算列只取幅度最大的 Γ 个因子当量。
          {r.mode.kind === 'box' ? (
            <>本方案采用箱式保护，成本对应上表的最大偏移。</>
          ) : r.mode.kind === 'budget' ? (
            <>本方案采用 Γ={r.mode.gamma} 预算保护，只对「最多 Γ 个因子当量同时偏移」给出保证。</>
          ) : r.mode.kind === 'nominal' ? (
            <>本方案只按检测中心值求解，实际偏移下的违反情况见「场景风险」。</>
          ) : (
            <>本方案按场景集满足概率 α={pct(r.mode.alpha, 0)} 选配比，实际风险见「场景风险」。</>
          )}
        </div>
      </Card>

      <Card title="原料使用与可用量">
        <table>
          <thead>
            <tr>
              <th>原料</th>
              <th className="num">用量</th>
              <th className="num">占比</th>
              <th className="num">可用</th>
              <th>状态</th>
              <th className="num">+10t 价值</th>
            </tr>
          </thead>
          <tbody>
            {r.allocations.map((a) => {
              const lot = r.lots.find((l) => l.lotId === a.lotId)
              return (
                <tr key={a.lotId}>
                  <td>
                    <span className="mono">{a.lotId}</span>{' '}
                    <span className="muted small">{a.material}</span>
                  </td>
                  <td className="num">{qty(a.quantity)}</td>
                  <td className="num">{pct(a.shareOfFresh, 1)}</td>
                  <td className="num">{qty(lot?.available ?? 0)}</td>
                  <td>
                    {lot?.usedUp ? (
                      <Pill tone="warn">用尽</Pill>
                    ) : (
                      <Pill tone="neutral">有余量</Pill>
                    )}
                  </td>
                  <td className="num mono">
                    {lot?.costPerTenTonnes == null ? '—' : money(lot.costPerTenTonnes, 0)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="small muted" style={{ marginTop: 6 }}>
          「+10t 价值」= 该罐可用量增加 10 t 时整罐成本的变化；负值表示增加供应可降本。
        </div>
      </Card>

      <Card title="罐底余量">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="chip">{r.heelQuantity.toFixed(1)} t</span>
          <span className="chip">新鲜原料 {r.freshVolume.toFixed(1)} t</span>
          <span className="chip">目标产量 {r.volume.toFixed(0)} t</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>指标</th>
              <th className="num">余量名义</th>
              <th className="num">混合后名义</th>
              <th className="num">混合后保证值</th>
            </tr>
          </thead>
          <tbody>
            {PROPERTIES.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="num mono">
                  {state.heel.assay[p.id]?.hasAssay
                    ? `${state.heel.assay[p.id]!.nominal.toFixed(p.decimals)} ± ${state.heel.assay[p.id]!.halfWidth}`
                    : '—'}
                </td>
                <td className="num mono">{propValue(p.id, r.nominal[p.id])}</td>
                <td className="num mono">{propValue(p.id, r.guaranteed[p.id])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="small muted" style={{ marginTop: 6 }}>
          余量不是决策变量，但它的质量计入总量与所有指标；它的检测误差也进入不确定集。
        </div>
      </Card>
    </div>
  )
}

function Limits({ result, spec }: { result: PlanResult; spec?: SpecSet }) {
  const rows = useMemo(() => result.limits, [result])
  const active = rows.filter((r) => r.active)
  return (
    <Card
      title="指标与限额"
      hint={`${active.length} 条限制成本`}
      actions={<span className="small muted">影子价格 = 放宽 0.1 个指标单位的整罐成本变化</span>}
    >
      <table>
        <thead>
          <tr>
            <th>指标</th>
            <th>方向</th>
            <th className="num">限额</th>
            <th className="num">名义值</th>
            <th className="num">保证值</th>
            <th className="num">名义余量</th>
            <th style={{ minWidth: 120 }}>余量使用</th>
            <th className="num">放宽价值</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => {
            const slackTone = l.slackGuaranteed < -1e-9 ? 'bad' : l.active ? 'warn' : 'good'
            return (
              <tr key={`${l.property}:${l.dir}`} className={l.active ? 'active-row' : ''}>
                <td>
                  {property(l.property).name}{' '}
                  <span className="mono small muted">{property(l.property).short}</span>
                </td>
                <td>{dirLabel(l.dir)}</td>
                <td className="num mono">{propValue(l.property, l.limit)}</td>
                <td className="num mono">{propValue(l.property, l.nominal)}</td>
                <td className="num mono" style={{ color: l.slackGuaranteed < -1e-9 ? 'var(--bad)' : undefined }}>
                  {propValue(l.property, l.guaranteed)}
                </td>
                <td className="num mono">{propValue(l.property, l.slackNominal, false)}</td>
                <td>
                  <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    <Bar value={l.marginUsedShare} tone={slackTone as any} />
                    <span className="mono small">{pct(l.marginUsedShare, 0)}</span>
                  </div>
                </td>
                <td className="num mono">
                  {l.costPerTenthTotal == null ? '—' : `${money(l.costPerTenthTotal, 1)}`}
                </td>
                <td>
                  {l.slackGuaranteed < -1e-9 ? (
                    <Pill tone="bad">保证值越界</Pill>
                  ) : l.active ? (
                    <Pill tone="warn">限制成本</Pill>
                  ) : (
                    <Pill tone="good">有余量</Pill>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="legend" style={{ marginTop: 10 }}>
        <span>
          <i style={{ background: 'var(--warn)' }} />
          限制成本：放宽该限额可降低整罐成本
        </span>
        <span>
          <i style={{ background: 'var(--good)' }} />
          保证值仍满足限额，多出的余量用不上
        </span>
        <span>
          <i style={{ background: 'var(--bad)' }} />
          保证值（最坏情形）已经越界
        </span>
      </div>
      {spec ? (
        <div className="small muted" style={{ marginTop: 8 }}>
          规格 {spec.name}：{spec.limits.map((l) => `${property(l.property).short} ${l.min != null ? `≥${l.min}` : ''}${l.max != null ? ` ≤${l.max}` : ''}`).join('；')}
        </div>
      ) : null}
    </Card>
  )
}

function Mix({ result, state }: { result: PlanResult; state: PublicState }) {
  const [copied, setCopied] = useState(false)
  const text = useMemo(
    () =>
      result.allocations
        .map((a) => `${a.tankId}\t${a.lotId}\t${a.material}\t${a.quantity.toFixed(2)} t\t${money(a.costPerTonne)}/t`)
        .join('\n'),
    [result],
  )
  return (
    <Card
      title="配比明细"
      hint={`合计 ${result.freshVolume.toFixed(1)} t 新鲜料 + ${result.heelQuantity.toFixed(1)} t 余量`}
      actions={
        <button
          onClick={() => {
            navigator.clipboard?.writeText(text).then(
              () => setCopied(true),
              () => setCopied(false),
            )
            setTimeout(() => setCopied(false), 1800)
          }}
        >
          {copied ? '已复制' : '复制配料表'}
        </button>
      }
    >
      <table>
        <thead>
          <tr>
            <th>罐号</th>
            <th>原料批次</th>
            <th>品种</th>
            <th className="num">用量</th>
            <th className="num">占新鲜料</th>
            <th className="num">单价</th>
            <th className="num">成本</th>
            <th className="num">检测区间</th>
          </tr>
        </thead>
        <tbody>
          {result.allocations.map((a) => (
            <tr key={a.lotId}>
              <td className="mono">{a.tankId}</td>
              <td className="mono">{a.lotId}</td>
              <td>{a.material}</td>
              <td className="num">{qty(a.quantity, 2)}</td>
              <td className="num">{pct(a.shareOfFresh, 1)}</td>
              <td className="num mono">{money(a.costPerTonne)}</td>
              <td className="num mono">{money(a.cost)}</td>
              <td className="num small muted">{summarizeAssay(state, a.lotId)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={3} className="right muted small">
              余量（不参与决策）
            </td>
            <td className="num">{qty(result.heelQuantity)}</td>
            <td className="num muted">—</td>
            <td className="num muted">—</td>
            <td className="num muted">—</td>
            <td />
          </tr>
          <tr>
            <td colSpan={3} className="right">
              <b>合计</b>
            </td>
            <td className="num">
              <b>{qty(result.volume)}</b>
            </td>
            <td colSpan={2} />
            <td className="num mono">
              <b>{money(result.totalCost)}</b>
            </td>
            <td className="num small muted">{money(result.unitCost, 1)}/t</td>
          </tr>
        </tbody>
      </table>
      {result.excludedLots.length ? (
        <>
          <div className="divider" />
          <div className="small">
            <b>被排除的原料</b>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {result.excludedLots.map((e) => (
                <li key={e.lotId}>
                  <span className="mono">{e.lotId}</span> — {e.reason}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </Card>
  )
}

function summarizeAssay(state: PublicState, lotId: string): string {
  const lot = state.lots.find((l) => l.id === lotId)
  if (!lot) return '—'
  return PROPERTIES.filter((p) => lot.assay[p.id]?.hasAssay && (lot.assay[p.id]!.halfWidth ?? 0) > 0)
    .map((p) => `${p.short} ${lot.assay[p.id]!.nominal}±${lot.assay[p.id]!.halfWidth}`)
    .join(' · ') || '精确值'
}

function Risk({ result }: { result: PlanResult }) {
  const [showAll, setShowAll] = useState(false)
  const r = result.risk
  const violating = r.violations.filter((v) => v.violations.length > 0)
  const shown = showAll ? violating : violating.slice(0, 12)
  const sorted = [...violating].sort((a, b) => b.probability - a.probability)
  const perProp = Object.entries(r.perPropertyViolationProbability).sort((a, b) => b[1] - a[1])
  return (
    <div className="grid-2">
      <Card title="场景集满足情况" hint={`${r.scenarioCount} 个场景，概率合计 1`}>
        <div className="kpis" style={{ marginBottom: 12 }}>
          <Kpi
            label="满足概率"
            value={pct(r.satisfiedProbability, 1)}
            tone={r.satisfiedProbability >= 0.95 ? 'good' : r.satisfiedProbability >= 0.8 ? 'warn' : 'bad'}
          />
          <Kpi
            label="违反概率"
            value={pct(r.violatedProbability, 1)}
            tone={r.violatedProbability <= 0.01 ? 'good' : r.violatedProbability <= 0.1 ? 'warn' : 'bad'}
          />
          <Kpi label="违反场景数" value={`${violating.length}`} note={`共 ${r.scenarioCount} 个`} />
        </div>
        {perProp.length ? (
          <table>
            <thead>
              <tr>
                <th>指标</th>
                <th className="num">违反概率</th>
                <th style={{ minWidth: 100 }} />
              </tr>
            </thead>
            <tbody>
              {perProp.map(([p, v]) => (
                <tr key={p}>
                  <td>{property(p as any).name}</td>
                  <td className="num mono">{pct(v, 2)}</td>
                  <td>
                    <Bar value={v} tone={v > 0.05 ? 'bad' : v > 0 ? 'warn' : 'good'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>没有任何指标被违反。</Empty>
        )}
        <div className="small muted" style={{ marginTop: 8 }}>
          场景集由命名压力场景（同批全偏移、单指标极端、名义）与均匀随机抽样组成，
          概率归一化。方案选择时若模式为「场景概率」，MILP 直接约束该满足概率 ≥ α；
          其余模式仅事后评估。
        </div>
      </Card>

      <Card
        title="违反场景列表"
        hint={`${violating.length} 个`}
        actions={
          violating.length > 12 ? (
            <button className="ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? '只看前 12 个' : `显示全部 ${violating.length} 个`}
            </button>
          ) : null
        }
      >
        {r.worstScenario ? (
          <div className="banner bad" style={{ marginTop: 0, marginBottom: 8 }}>
            <b>最坏场景：{r.worstScenario.label}</b>
            <div className="small">
              概率 {pct(r.worstScenario.probability, 3)} · 归一化超出{' '}
              {r.worstScenario.worst ? pct(r.worstScenario.worst.excessNorm, 2) : '—'}
              {r.worstScenario.worst ? (
                <>
                  {' '}
                  · {property(r.worstScenario.worst.property).name} ={' '}
                  <b>{propValue(r.worstScenario.worst.property, r.worstScenario.worst.value)}</b>（要求{' '}
                  {propValue(r.worstScenario.worst.property, r.worstScenario.worst.limit)}）
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="banner good" style={{ marginTop: 0, marginBottom: 8 }}>
            场景集中没有违反。
          </div>
        )}
        <div className="scenario-list">
          {shown.length === 0 ? (
            <div className="scenario-row">无违反场景</div>
          ) : (
            shown.map((s) => (
              <div
                key={s.scenarioId}
                className={`scenario-row${r.worstScenario?.scenarioId === s.scenarioId ? ' bad' : ''}`}
              >
                <div className="row" style={{ gap: 6 }}>
                  <b className="grow" style={{ fontWeight: 600 }}>
                    {s.label}
                  </b>
                  <span className="mono small muted">p={pct(s.probability, 3)}</span>
                </div>
                {s.violations.map((v, i) => (
                  <div key={i} className="meta">
                    {property(v.property).name} {dirLabel(v.dir)} {propValue(v.property, v.limit)} →{' '}
                    <span style={{ color: 'var(--bad)' }}>{propValue(v.property, v.value)}</span>{' '}
                    （超 {propValue(v.property, v.excessAbs)}）
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          按概率从高到低排列；同一场景可能同时违反多个指标。
        </div>
      </Card>

      <Card title="最不利因子（解析）" hint={result.adversarial.method}>
        {result.adversarial.method === 'scenario' ? (
          <Empty>
            名义/场景概率模式不使用解析最坏因子；请参考上方的实际最坏违反场景。
          </Empty>
        ) : (
          <div className="stack">
            {PROPERTIES.map((p) => {
              const list = result.adversarial.byProperty[p.id] ?? []
              if (!list.length) return null
              return (
                <div key={p.id}>
                  <div className="small" style={{ fontWeight: 600, marginBottom: 3 }}>
                    {p.name}
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>因子</th>
                        <th className="num">ξ</th>
                        <th className="num">贡献（整罐）</th>
                        <th className="num">折算含量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((f) => (
                        <tr key={f.key}>
                          <td className="small">{f.label}</td>
                          <td className="num mono">{signed(f.xi, 2)}</td>
                          <td className="num mono">{signed(f.contribution, 2)}</td>
                          <td className="num mono">
                            {propValue(p.id, f.contribution / result.volume, false)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            })}
            {PROPERTIES.every((p) => !(result.adversarial.byProperty[p.id] ?? []).length) ? (
              <Empty>没有需要考虑的随机因子。</Empty>
            ) : null}
          </div>
        )}
        <div className="small muted" style={{ marginTop: 8 }}>
          贡献 = 因子系数 × ξ，系数按质量加权（t·指标单位）。Γ 预算下只有前 Γ 个最大因子取满端点。
        </div>
      </Card>

      <Card title="场景抽样" hint={`seed ${result.scenarioSet.seed}`}>
        <div className="stack">
          {sorted.slice(0, 5).map((s) => (
            <div key={s.scenarioId} className="op-card">
              <div className="row">
                <b className="grow">{s.label}</b>
                <span className="mono small">{pct(s.probability, 3)}</span>
              </div>
              <div className="small muted">L1 偏移 {s.l1.toFixed(2)}</div>
            </div>
          ))}
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          场景定义在因子空间（ξ ∈ [−1,1]）；质量偏移 = Σ cᵢξᵢ，再除以总产量得到含量偏移。
        </div>
      </Card>
    </div>
  )
}

function VerifyPreview(props: { result: PlanResult; onVerify: () => void; verified: boolean }) {
  return (
    <Card title="小规模枚举核对" hint="验证最坏场景与最优成本">
      <div className="banner" style={{ marginTop: 0 }}>
        枚举在固定步长的整数配比上穷举所有组合，直接计算成本与箱式最坏质量；
        同时枚举因子顶点，与解析最坏偏移逐项比对。连续 LP 的成本应不高于离散最优。
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={props.onVerify}>
          {props.verified ? '重新核对' : '运行核对'}
        </button>
        <span className="small muted">使用本方案求解时的可用量与 ρ；仅核对已求解方案。</span>
      </div>
      <div className="small muted" style={{ marginTop: 10 }}>
        核对会保留上一步求得的计划 ID，因此如果库存已被其他单占用，结果仍对应求解时的可用量。
      </div>
    </Card>
  )
}
