import { api } from '../api'

/**
 * 可见商品优先生成缩略图/预览图：进入可视区的卡片合并到一批（200ms 防抖，单批最多 50 个）通知主进程。
 * 每个商品本次会话只通知一次，主进程侧对已就绪的商品是空操作。
 */
const notified = new Set<number>()
const pending = new Set<number>()
let timer: ReturnType<typeof setTimeout> | null = null

const BATCH = 50

function flush(): void {
  timer = null
  const ids = Array.from(pending)
  pending.clear()
  for (let i = 0; i < ids.length; i += BATCH) {
    void api.images.prioritize(ids.slice(i, i + BATCH)).catch(() => {})
  }
}

export function requestDerivativePriority(itemId: number): void {
  if (notified.has(itemId)) return
  notified.add(itemId)
  pending.add(itemId)
  if (!timer) timer = setTimeout(flush, 200)
}
