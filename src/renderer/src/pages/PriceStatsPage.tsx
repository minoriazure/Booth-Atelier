import { useEffect, useState } from 'react'
import type { CheckSummary, PriceStatsResult } from '../../../shared/types'
import { api } from '../api'

const yen = new Intl.NumberFormat('zh-CN')
const price = (value: number | null | undefined): string => value == null ? '—' : `¥${yen.format(value)}`

export default function PriceStatsPage({ syncSummary }: { syncSummary: CheckSummary | null }) {
  const [data, setData] = useState<PriceStatsResult | null>(null)

  useEffect(() => {
    let active = true
    void api.library.priceStats().then((result) => {
      if (active) setData(result)
    }).catch((error: unknown) => {
      if (active) setData((previous) => ({
        snapshot: previous?.snapshot ?? null,
        error: error instanceof Error ? error.message : '读取价格统计失败'
      }))
    })
    return () => { active = false }
  }, [syncSummary])

  const snapshot = data?.snapshot
  return (
    <div className="dl-page price-page">
      <section className="panel price-summary" aria-label="价格总计">
        <div className="price-totals">
          <div className="price-total">
            <span>购买总花费</span>
            <strong>{price(snapshot?.purchaseTotal)}</strong>
          </div>
          <div className="price-total">
            <span>当前价格合计</span>
            <strong>{price(snapshot?.currentTotal)}</strong>
            {Boolean(snapshot?.missingCurrentItems) && <small>{snapshot?.missingCurrentItems} 件商品缺少全部或部分现价</small>}
          </div>
        </div>
        <div className="dl-stats">
          <span>按订单商品金额统计，不含 BOOST 和运费</span>
          {snapshot && <span>· 共 {snapshot.rows.length} 件商品 · 更新于 {new Date(snapshot.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>}
        </div>
        {data?.error && (
          <p className="price-error" role="status">价格统计更新失败：{data.error}{snapshot ? '。当前显示上次同步结果。' : ''}</p>
        )}
      </section>

      <div className="dl-table-wrap price-table-wrap" tabIndex={0} role="region" aria-label="商品价格明细">
        <table className="dl-table price-table">
          <colgroup><col /><col /><col /><col /></colgroup>
          <thead>
            <tr>
              <th scope="col">BOOTH 编号与商品名</th>
              <th scope="col">购买变体</th>
              <th scope="col">当前价格</th>
              <th scope="col">购买价格</th>
            </tr>
          </thead>
          <tbody>
            {snapshot?.rows.map((row) => (
              <tr className="dl-row" key={row.itemId}>
                <td>
                  <span className="dl-item-id">#{row.itemId}</span>
                  {row.title}
                </td>
                <td>{row.variationNames.join(' / ')}</td>
                <td className="price-amount">
                  {row.currentPrice == null ? '暂无现价' : price(row.currentPrice)}
                  {row.currentPrice != null && row.hasMissingCurrentPrice && <small>部分现价</small>}
                </td>
                <td className="price-amount">{price(row.purchasePrice)}</td>
              </tr>
            ))}
            {!snapshot?.rows.length && (
              <tr><td colSpan={4} className="price-empty">
                {data === null ? '正在读取价格统计…' : snapshot ? '暂无购买商品' : '同步库后显示价格统计'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
