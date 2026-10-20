import { existsSync, mkdirSync, renameSync, cpSync, rmSync } from 'fs'
import { basename, join } from 'path'
import type { RemoveItemResult } from '../../shared/types'
import type { LibraryRepo } from '../db/repos'
import type { Paths } from '../util/paths'
import type { DownloadManager } from './downloadManager'
import type { ImageLocalizer } from './imageLocalizer'
import type { VideoService } from './videoService'
import { createLogger } from '../util/log'

const log = createLogger('itemRemoval')

/**
 * 单商品本地删除（仅本地，不影响 BOOTH 端与库）：
 * - 取消该商品的排队/进行中下载，清理图片后台任务
 * - 删除 DB 中该商品的全部记录（事务）
 * - 数据根 {dataRoot}/items/{id} 整个目录直接删除
 * - 下载根 {downloadRoot}/{id} 整个目录移入 {deletedRoot}/{id}-{时间戳}（deletedRoot 位于 exe 同级），不直接销毁
 * 下次全局库同步会把仍在库里的商品同步回来。
 */
export class ItemRemovalService {
  constructor(
    private repo: LibraryRepo,
    private paths: Paths,
    private downloads: DownloadManager,
    private images: ImageLocalizer,
    private videos: VideoService,
    private deletedRoot: string
  ) {}

  async remove(itemId: number): Promise<RemoveItemResult> {
    if (!this.repo.getItemDetail(itemId)) throw new Error('本地不存在该商品')

    const videoKeys = this.repo.listVideosByItem(itemId).map((v) => v.key)
    if (videoKeys.some((k) => this.videos.isDownloading(k))) {
      throw new Error('该商品有视频正在下载，请等待完成后再删除')
    }

    await this.downloads.cancelItem(itemId)
    await this.images.purgeItem(itemId, this.repo.listImagesByItem(itemId).map((i) => i.url))

    this.repo.deleteItemRows(itemId)
    log.info(`item ${itemId}: db rows removed`)

    const warnings: string[] = []
    const dataDir = this.paths.itemDataDir(itemId)
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch (e) {
      const msg = `数据目录删除失败：${dataDir}（${e instanceof Error ? e.message : String(e)}）`
      log.error(msg)
      warnings.push(msg)
    }

    let archivedTo: string | null = null
    const dlDir = this.paths.itemDir(itemId)
    if (existsSync(dlDir)) {
      try {
        const target = join(this.deletedRoot, `${basename(dlDir)}-${timestamp()}`)
        mkdirSync(this.deletedRoot, { recursive: true })
        moveDir(dlDir, target)
        archivedTo = target
        log.info(`item ${itemId}: downloads archived → ${target}`)
      } catch (e) {
        const msg = `下载文件移动失败：${dlDir}（${e instanceof Error ? e.message : String(e)}）`
        log.error(msg)
        warnings.push(msg)
      }
    }

    return { archivedTo, warnings }
  }
}

/** 跨盘时 rename 会失败（EXDEV），回退为复制后删除源目录 */
function moveDir(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    cpSync(src, dest, { recursive: true })
    rmSync(src, { recursive: true, force: true })
  }
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
