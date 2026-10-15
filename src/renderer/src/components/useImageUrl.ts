import { useEffect, useState } from 'react'
import { api } from '../api'

/** 异步解析远程图片到本地缓存；返回可用 URL 或 null */
export function useImageUrl(remoteUrl: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setUrl(null)
    if (!remoteUrl) return
    void (async () => {
      // 第一次可能未缓存 → null，轮询几次等下载完成
      for (let i = 0; i < 10; i++) {
        const u = await api.library.imageUrl(remoteUrl)
        if (u) {
          if (!cancelled) setUrl(u)
          return
        }
        await new Promise((r) => setTimeout(r, 400 + i * 200))
        if (cancelled) return
      }
    })()
    return () => {
      cancelled = true
    }
  }, [remoteUrl])
  return url
}
