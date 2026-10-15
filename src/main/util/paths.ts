import { join } from 'path'
import { existsSync } from 'fs'
import { localDate, sanitizeFilename } from './filenames'

/**
 * 双根路径（用户要求 #1）：
 * - 数据根 dataRoot：图片/视频/快照/描述等数据文件 → {dataRoot}/items/{item_id}/...
 * - 下载根 downloadRoot：只有 booth 链接下载的素材文件 → {downloadRoot}/{item_id}/current|history
 *
 * 这样 downloads 目录可直接逐层点进去把文件拖进 Unity，data 目录可整体视作程序数据。
 */
export class Paths {
  constructor(
    private dataRoot: string,
    private downloadRoot: string
  ) {}

  /** 下载根（兼容旧接口：Settings 默认值用） */
  get rootPath(): string {
    return this.downloadRoot
  }

  get dataRootPath(): string {
    return this.dataRoot
  }

  setRoot(root: string): void {
    this.downloadRoot = root
  }

  // ── 数据侧（dataRoot/items/{id}） ──

  itemDataDir(itemId: number): string {
    return join(this.dataRoot, 'items', String(itemId))
  }

  imagesDir(itemId: number): string {
    return join(this.itemDataDir(itemId), 'images')
  }

  /** 压缩缩略图目录（与 images 平级；画廊条/轻量展示用） */
  thumbsDir(itemId: number): string {
    return join(this.itemDataDir(itemId), 'thumb')
  }

  videosDir(itemId: number): string {
    return join(this.itemDataDir(itemId), 'videos')
  }

  snapshotsDir(itemId: number): string {
    return join(this.itemDataDir(itemId), 'snapshots')
  }

  itemJson(itemId: number): string {
    return join(this.itemDataDir(itemId), 'item.json')
  }

  descriptionPath(itemId: number): string {
    return join(this.itemDataDir(itemId), 'description.html')
  }

  snapshotPath(itemId: number, date: string, n?: number): string {
    const suffix = n && n > 1 ? `-${n}` : ''
    return join(this.snapshotsDir(itemId), `${date}${suffix}.html`)
  }

  ensureItemDataDirs(itemId: number): void {
    this.ensureDir(this.imagesDir(itemId))
    this.ensureDir(this.thumbsDir(itemId))
    this.ensureDir(this.videosDir(itemId))
    this.ensureDir(this.snapshotsDir(itemId))
  }

  // ── 下载侧（downloadRoot/{id}，只放素材文件） ──

  itemDir(itemId: number): string {
    return join(this.downloadRoot, String(itemId))
  }

  currentDir(itemId: number): string {
    return join(this.itemDir(itemId), 'current')
  }

  historyDir(itemId: number, date: string = localDate()): string {
    return join(this.itemDir(itemId), 'history', date)
  }

  ensureDir(dir: string): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('fs').mkdirSync(dir, { recursive: true })
  }

  ensureItemDownloadDirs(itemId: number): void {
    this.ensureDir(this.currentDir(itemId))
  }

  /** 清洗后的当前文件完整路径 */
  currentFilePath(itemId: number, filename: string): string {
    return join(this.currentDir(itemId), sanitizeFilename(filename))
  }

  /** 归档路径（同日冲突处理由 historyManager 负责） */
  historyFilePath(itemId: number, date: string, filename: string): string {
    return join(this.historyDir(itemId, date), sanitizeFilename(filename))
  }
}
