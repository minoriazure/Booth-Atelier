import type { CheckSummary } from './types'

export function librarySummary(s: CheckSummary): string {
  const stats = s.library
  if (!stats) return ''
  const linkUpdates = stats.linksAdded + stats.linksChanged + stats.linksRemoved
  return [
    stats.listFailures ? '库同步部分完成' : '库同步完成',
    `库抓取 ${s.libraryChecked} 件，新增 ${stats.added} 件`,
    `获取下载链接 ${stats.linksFetched} 条，更新 ${linkUpdates} 条`,
    `封面变化 ${stats.coversChanged} 件，画廊变化 ${stats.galleriesChanged} 件，简介变化 ${stats.descriptionsChanged} 件`,
    `详情成功 ${stats.detailsChecked}/${stats.detailsTotal}，失败 ${stats.listFailures + stats.detailFailures + stats.notFound}（404 ${stats.notFound}）`,
    stats.imagesPending > 0 ? `${stats.imagesPending} 张图片待下载` : ''
  ].filter(Boolean).join(' · ')
}
