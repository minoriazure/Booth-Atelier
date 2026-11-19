import { BoothError } from './errors'
import type { HttpClient } from './httpClient'

interface BoothApiItem {
  name: string
  description: unknown
  embeds: unknown
  images: unknown
  variations: unknown
}

export type ReadBoothItem = (itemId: number) => Promise<BoothApiItem>

export async function fetchBoothItem(http: HttpClient, itemId: number): Promise<BoothApiItem> {
  const response = await http.request(`https://api.booth.pm/vroid/items/${itemId}`, 'GET', {
    omitCookies: true, headers: { accept: 'application/json', referer: '' }
  })
  if (response.status !== 200) {
    const kind = response.status === 404 ? 'not_found' : response.status === 403 || response.status === 429 ? 'rate_limited' : 'server'
    throw new BoothError(`HTTP ${response.status}`, kind, response.status)
  }
  const data = JSON.parse(await response.text())
  if (data?.id !== itemId || typeof data.name !== 'string') throw new BoothError('商品 API 响应结构异常', 'parse')
  return data
}
