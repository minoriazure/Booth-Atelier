import React from 'react'
import { createRoot } from 'react-dom/client'
import type { VideoProgressEvent } from '../src/preload/index'
import type { ItemVideo } from '../src/shared/types'

const wait = (ms = 35) => new Promise<void>((done) => setTimeout(done, ms))
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
Object.assign(window, { runRegression: async () => {
  const { sanitizeDesc } = await import('../src/renderer/src/components/boothDesc')
  const clean = sanitizeDesc('<base href="https://evil.test"><svg><a href="javascript:alert(1)">bad</a></svg><img src="x" onerror="alert(1)"><a href="jav&#97;script:alert(1)">x</a><iframe srcdoc="x" src="https://evil.test"></iframe><p class="test">Safe<br><strong>text</strong></p><a href="https://booth.pm/">web</a>')
  assert(!/javascript:|onerror|srcdoc|<svg|<base|<iframe/.test(clean), 'unsafe description survived')
  assert(clean.includes('<strong>text</strong>') && clean.includes('https://booth.pm/'), 'valid formatting lost')
  const item = { itemId: 1, title: 'Test asset', shopName: 'Shop', thumbnailUrl: null, localThumb: null, isGift: false, isFree: false, status: 'active', fileTotal: 0, fileDownloaded: 0, fileUpdateAvailable: 0, tags: [] }
  const snapshot = (id: number) => ({ id, itemId: 1, snapshotDate: '2026-11-10', capturedAt: '2026-11-10 12:00:00', title: 'Test', descriptionHtml: `<p>version-${id}</p>`, ogImageUrl: null, localImages: {} })
  Object.assign(window, { boothAPI: {
    history: {
      index: async () => ({ items: [item], files: [], descriptions: [snapshot(2), snapshot(1)] }),
      readSnapshot: async (id: number) => { await wait(id === 1 ? 100 : 5); return snapshot(id) },
      onDeleteProgress: () => () => {}, previewDelete: async () => ({ fileCount: 1, totalBytes: 3, missingFiles: 0, errors: [] })
    },
    events: { onImageReady: () => () => {} },
    tags: { setItemTags: async () => [{ id: 1, name: 'Alpha' }] },
    images: { prioritize: async () => 0 }
  } })
  const { default: HistoryPage } = await import('../src/renderer/src/pages/HistoryPage')
  const root = createRoot(document.getElementById('root')!)
  root.render(<HistoryPage version={0} onOpen={() => {}} focus={null} toast={() => {}} />)
  await wait()
  const descButton = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('商品说明历史'))!
  descButton.click(); await wait()
  const select = document.querySelector('select')!
  select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })); await wait(5)
  select.value = '2'; select.dispatchEvent(new Event('change', { bubbles: true })); await wait(150)
  assert(document.body.textContent?.includes('version-2') && !document.body.textContent?.includes('version-1'), 'stale history response overwrote current selection')
  const colors: string[] = []
  for (const theme of ['dark', 'light']) {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.setProperty('--accent', '#a356df')
    await wait()
    colors.push(getComputedStyle(document.body).backgroundColor)
  }
  const { TagContextMenu } = await import('../src/renderer/src/components/TagWidgets')
  let saved = false
  root.render(<TagContextMenu x={100} y={100} itemId={1} itemTags={[]} tags={[{ id: 1, name: 'Alpha', itemCount: 0 }]} onItemTagsChange={() => { saved = true }} onTagsChanged={() => {}} onManage={() => {}} onClose={() => {}} />)
  await wait()
  assert(colors[0] !== colors[1], 'theme background did not change')
  const input = document.querySelector<HTMLInputElement>('.tag-menu-input')!
  input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await wait(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait()
  assert(saved, 'keyboard tag selection failed')
  assert(document.activeElement === document.querySelector('.tag-menu-input'), 'input focus not restored')
  const { default: LibraryWallPage } = await import('../src/renderer/src/pages/LibraryWallPage')
  const api = (window as unknown as { boothAPI: Record<string, unknown> }).boothAPI
  Object.assign(api.tags as object, { list: async () => [] })
  const wallBench: unknown[] = []
  const scroller = document.getElementById('root')!
  scroller.className = 'main'; scroller.style.height = '800px'; scroller.style.overflow = 'auto'
  for (const count of [100, 1000, 5000]) {
    Object.assign(api, { library: { list: async () => Array.from({ length: count }, (_, i) => ({ ...item, itemId: i + 1, title: `Asset ${i}` })) } })
    const start = performance.now()
    root.render(<LibraryWallPage version={count} onOpen={() => {}} scrollMemory={{ current: 0 }} />)
    await wait(50)
    assert(document.querySelectorAll('.card').length === count, 'library wall lost items')
    const renderSettledMs = performance.now() - start
    const frameMs: number[] = []
    let frameTimeouts = 0
    for (let i = 0; i < 8; i++) {
      const t = performance.now(); scroller.scrollTop = scroller.scrollHeight * i / 8
      const painted = await Promise.race([new Promise<boolean>((done) => requestAnimationFrame(() => done(true))), wait(100).then(() => false)])
      if (!painted) frameTimeouts++
      frameMs.push(performance.now() - t)
    }
    wallBench.push({ count, renderSettledMs, maxScrollProbeMs: Math.max(...frameMs), frameTimeouts })
  }
  const { default: ItemDetailPage } = await import('../src/renderer/src/pages/ItemDetailPage')
  const videos: ItemVideo[] = Array.from({ length: 12 }, (_, i) => ({
    key: `1:youtube:video-${i}`,
    platform: 'youtube',
    videoId: `video-${i}`,
    url: `https://www.youtube.com/watch?v=video-${i}`,
    embedUrl: `https://www.youtube.com/embed/video-${i}`,
    localPath: i === 0 ? 'C:/booth/video-0.mp4' : null,
    status: i === 0 ? 'downloaded' : 'remote',
    progress: i === 0 ? 100 : 0
  }))
  let emitVideoProgress: ((event: VideoProgressEvent) => void) | undefined
  Object.assign(api.events as object, {
    onVideoProgress: (handler: (event: VideoProgressEvent) => void) => {
      emitVideoProgress = handler
      return () => { emitVideoProgress = undefined }
    }
  })
  Object.assign(api.images as object, { enqueueItem: async () => {}, checkItem: async () => ({ redownload: 0, derivMissing: 0 }) })
  Object.assign(api.history as object, { listDescriptionEntries: async () => [], listFileGroups: async () => [] })
  let revealedVideoPath: string | undefined
  Object.assign(api, {
    library: {
      getItem: async () => ({
        ...item, localGallery: [], downloadables: [], videos,
        descriptionHtml: `<p>Product description</p><iframe src="${videos[0].embedUrl}?si=original&amp;start=5"></iframe>`
      })
    },
    videos: {
      checkYtDlp: async () => ({ found: true }),
      download: async () => ({ ok: true }),
      ensureThumb: async () => null,
      reveal: async (path: string) => { revealedVideoPath = path }
    }
  })
  const renderDetail = () => root.render(
    <ItemDetailPage itemId={1} version={0} onDeleted={() => {}} onChanged={() => {}} toast={() => {}} onOpenHistory={() => {}} />
  )
  renderDetail()
  await wait()
  const strip = document.querySelector<HTMLDivElement>('.video-download-strip')!
  const desc = document.querySelector('.desc-html')!
  const localList = document.querySelector('.video-list')!
  assert(strip.childElementCount === 11 && strip.scrollWidth > strip.clientWidth, 'undownloaded videos did not overflow horizontally')
  assert(strip.compareDocumentPosition(desc) & Node.DOCUMENT_POSITION_FOLLOWING, 'download strip did not precede description')
  assert(desc.compareDocumentPosition(localList) & Node.DOCUMENT_POSITION_FOLLOWING, 'local videos did not follow description')
  assert(!document.querySelector('.video-card-player, .desc-html iframe'), 'description loaded a player before expansion')
  assert(desc.querySelector('a')?.getAttribute('href') === `${videos[0].embedUrl}?si=original&start=5`,
    'current description lost the original embedded video URL')
  const activeSlide = () => document.querySelector('.gallery2-slide[aria-hidden="false"]')!
  assert(activeSlide().querySelector<HTMLVideoElement>('video[controls]')?.getAttribute('src')?.endsWith('video-0.mp4') &&
    !activeSlide().querySelector('button'), 'downloaded video did not play inline in the gallery')

  document.querySelector<HTMLButtonElement>('.gallery2-nav.next')!.click()
  await wait()
  const pendingCard = strip.firstElementChild!
  let scrolledToCard = false
  pendingCard.scrollIntoView = () => { scrolledToCard = true }
  document.querySelector<HTMLButtonElement>('.gallery2-slide[aria-hidden="false"] .gallery2-video-placeholder')!.click()
  assert(scrolledToCard, 'gallery did not target the matching download card')
  pendingCard.querySelector('button')!.click()
  await wait()
  assert(pendingCard.querySelector('button')!.disabled, 'video download did not enter progress state')
  videos[1] = { ...videos[1], status: 'downloaded', localPath: 'C:/booth/video-1.mp4', progress: 100 }
  emitVideoProgress!({ key: videos[1].key, itemId: 1, progress: 100, status: 'downloaded', localPath: videos[1].localPath! })
  await wait()
  assert(!pendingCard.isConnected && strip.childElementCount === 10, 'completed download remained in the strip')
  assert(activeSlide().querySelector<HTMLVideoElement>('video[controls]')?.getAttribute('src')?.endsWith('video-1.mp4') &&
    !activeSlide().querySelector('button'), 'completed download did not replace its gallery placeholder with a player')
  const toggle = localList.querySelector<HTMLButtonElement>(':scope > :last-child .video-card-toggle')!
  assert(toggle.getAttribute('aria-expanded') === 'false' && !document.querySelector('.video-card-player'), 'new download was not collapsed')
  const revealButton = toggle.parentElement!.querySelector<HTMLButtonElement>('.mini-btn')!
  revealButton.click()
  await wait()
  assert(revealedVideoPath === videos[1].localPath && toggle.getAttribute('aria-expanded') === 'false',
    'opening the file location while collapsed failed or expanded the player')
  toggle.click()
  await wait()
  const player = document.querySelector('.video-card-player')!
  assert(player.getAttribute('src')?.startsWith('image-cache://local/'), 'expansion did not load the local video')
  toggle.click()
  await wait()
  assert(!player.isConnected && !player.hasAttribute('src'), 'collapse did not unload the video')
  assert(revealButton.isConnected, 'collapse removed the file location button')
  toggle.click()
  await wait()
  const reopenedPlayer = document.querySelector('.video-card-player')!
  root.render(null)
  await wait()
  assert(!reopenedPlayer.isConnected && !reopenedPlayer.hasAttribute('src'), 'leaving detail did not unload the video')
  renderDetail()
  await wait()
  assert(document.querySelectorAll('.video-card-toggle[aria-expanded="false"]').length === 2 &&
    !document.querySelector('.video-card-player'), 'reopening detail restored an expanded video')
  root.unmount()
  return { passed: ['DOM sanitizer', 'history rapid switching', 'dark/light CSS', 'tag keyboard selection', 'focus restoration', 'library wall 100/1000/5000', 'detail video layout, inline gallery playback, download transition and lazy player lifecycle'], themeBackgrounds: colors, wallBench }
} })
