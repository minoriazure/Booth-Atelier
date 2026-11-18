import { expect, it, vi } from 'vitest'
import { wrapResponse, type HttpClient } from '../src/main/booth/httpClient'
import { PriceStatsService } from '../src/main/services/priceStatsService'

const orders = 'https://accounts.booth.pm/orders'
const sharedItem = 'https://api.booth.pm/vroid/items/10'
const missingItem = 'https://api.booth.pm/vroid/items/20'

function orderLine(itemId: number, variationId: number, title: string, price: number): string {
  const menu = JSON.stringify([{ deeplinkDownloadableUrl: `https://booth.pm/downloadables/5/deeplink?variation_id=${variationId}` }])
  return `<div class="sheet">
    <div class="desktop:flex-1">
      <div><a href="https://booth.pm/items/${itemId}">${title}</a></div>
      <div>¥ ${price}</div><div>BOOST¥ 100</div>
    </div>
    <div data-dropdown-items='${menu}'></div>
  </div>`
}

it('counts each order once, groups purchased variants by item, and replaces the latest price statistics', async () => {
  const responses = new Map<string, [number, string]>([
    [orders, [200, '<div class="l-orders-index"><a href="/orders/1"></a></div><a rel="next" href="/orders?page=2"></a>']],
    [orders + '?page=2', [200, '<div class="l-orders-index"><a href="/orders/1"></a><a href="/orders/2"></a></div>']],
    [orders + '/1', [200, `<div class="l-order-detail-by-shop">${orderLine(10, 100, '商品 (PC)', 800)}</div>`]],
    [orders + '/2', [200, `<div class="l-order-detail-by-shop">
      ${orderLine(10, 101, '商品 (套装)', 900)}
      ${orderLine(20, 200, '旧商品 (完整版)', 300)}
    </div>`]],
    [sharedItem, [200, JSON.stringify({ id: 10, name: '商品', variations: [
      { id: 100, name: 'PC', price: 1000 },
      { id: 101, name: '套装', price: 1200 }
    ] })]],
    [missingItem, [404, '']]
  ])
  const request = vi.fn<HttpClient['request']>(async (url) => {
    const entry = responses.get(url)
    if (!entry) throw new Error('Unexpected request')
    return wrapResponse(new Response(entry[1], { status: entry[0] }))
  })
  const storage = new Map<string, unknown>()
  const service = new PriceStatsService({ request }, {
    getSetting<T>(key: string, fallback: T): T {
      return storage.has(key) ? storage.get(key) as T : fallback
    },
    setSetting: (key, value) => { storage.set(key, value) }
  })

  await service.refresh(() => {})
  const initial = service.get().snapshot
  expect(initial).toMatchObject({
    purchaseTotal: 2000, currentTotal: 2200, missingCurrentItems: 1,
    rows: [
      { itemId: 10, title: '商品', variationNames: ['PC', '套装'], purchasePrice: 1700, currentPrice: 2200 },
      { itemId: 20, title: '旧商品', variationNames: ['完整版'], purchasePrice: 300, currentPrice: null }
    ]
  })
  expect(request.mock.calls.filter(([url]) => url === orders + '/1')).toHaveLength(1)
  expect(request.mock.calls.filter(([url]) => url === sharedItem)).toEqual([
    [sharedItem, 'GET', expect.objectContaining({ omitCookies: true })]
  ])

  responses.set(orders + '/2', [500, ''])
  await service.refresh(() => {})
  expect(service.get()).toMatchObject({ snapshot: initial, error: expect.any(String) })

  responses.set(orders, [200, '<div class="l-orders-index"></div>'])
  await service.refresh(() => {})
  expect(service.get()).toMatchObject({ snapshot: { rows: [], purchaseTotal: 0, currentTotal: 0 }, error: null })
  expect(storage.size).toBe(1)
})
