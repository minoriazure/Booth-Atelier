import type { ApiFileCheckResult, CheckProgressEvent, CheckSummary, DownloadableRef, ItemFileUpdateStatus } from '../../shared/types'
import { isAuthError } from '../booth/errors'
import type { ReadBoothItem } from '../booth/itemApi'
import type { LibraryCrawler, ScopedLibraryItem } from '../booth/libraryCrawler'
import type { LibraryRepo } from '../db/repos'
import { createLogger } from '../util/log'
import type { HistoryManager } from './historyManager'
import { retireMissingDownloadLinks } from './libraryDownloadLinks'
import type { FileProbeBatch, ProbeBaseline, UpdateCheckService } from './updateCheckService'

const log = createLogger('itemFileUpdates')
type VariantFiles = { variationId: number; files: Array<{ name: string; updatedAt: string }> }
type FileChange = { variationId: number; name: string; kind: 'added' | 'removed' | 'updated' }
type State = {
  owned: number[]
  observed: VariantFiles[]
  changes: FileChange[]
  abnormal: boolean
  apiTitle?: string
  syncedDownloadIds?: number[]
  pendingProbeBaselines?: Record<number, ProbeBaseline>
}
type Mode = 'pending' | 'direct' | 'retry'
type ApiItem = Awaited<ReturnType<ReadBoothItem>>

interface ApiCheckOptions {
  canCheckLibrary?: boolean
  verifiedItems?: ReadonlyMap<number, ScopedLibraryItem>
  batch?: FileProbeBatch
  onAuthExpired?: (message: string) => void
}

export function apiFileCheckToast(result: ApiFileCheckResult): { level: 'info' | 'warn'; message: string } {
  const abnormal = result.abnormalItemIds
  return {
    level: abnormal.length || result.failed ? 'warn' : 'info',
    message: [
      `文件更新检查完成，发现 ${result.updated} 个更新文件`,
      abnormal.length && `存在 API 异常的商品 BOOTH 号 ${abnormal.map((id) => `#${id}`).join('、')}`,
      result.failed && `${result.failed} 件商品未完成核对`
    ].filter(Boolean).join(' · ')
  }
}

function readFiles(data: Awaited<ReturnType<ReadBoothItem>>, owned: number[]): VariantFiles[] {
  if (!Array.isArray(data.variations)) throw new Error('API 缺少变体列表')
  return owned.map((variationId) => {
    const variants = (data.variations as unknown[]).filter((entry) => (entry as { id?: number } | null)?.id === variationId)
    const downloads = (variants[0] as { downloadables?: unknown } | undefined)?.downloadables
    if (variants.length !== 1 || !Array.isArray(downloads)) throw new Error(`API 未完整列出已购变体 #${variationId}`)
    const names = new Set<string>()
    const files = downloads.map((file: { name?: unknown; updated_at?: unknown } | null) => {
      const name = file?.name
      const updatedAt = file?.updated_at
      if (typeof name !== 'string' || !name.trim() || names.has(name) ||
          typeof updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt))) {
        throw new Error(`已购变体 #${variationId} 的 API 文件名或更新时间无法唯一确认`)
      }
      names.add(name)
      return { name, updatedAt }
    }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    return { variationId, files }
  })
}

function compareFiles(state: State, observed: VariantFiles[]): FileChange[] {
  const changes = new Map(state.changes.map((change) => [JSON.stringify([change.variationId, change.name]), change]))
  for (const next of observed) {
    const previous = state.observed.find((variant) => variant.variationId === next.variationId)
    if (!previous) continue
    const prior = new Map(previous.files.map((file) => [file.name, file.updatedAt]))
    const current = new Set(next.files.map((file) => file.name))
    for (const file of next.files) {
      const before = prior.get(file.name)
      if (before !== file.updatedAt) {
        const key = JSON.stringify([next.variationId, file.name])
        const kind = before === undefined || changes.get(key)?.kind === 'added' ? 'added' : 'updated'
        changes.set(key, { variationId: next.variationId, name: file.name, kind })
      }
    }
    for (const file of previous.files) {
      if (!current.has(file.name)) {
        changes.set(JSON.stringify([next.variationId, file.name]), { variationId: next.variationId, name: file.name, kind: 'removed' })
      }
    }
  }
  return [...changes.values()]
}

function alignFiles(observed: VariantFiles[], purchases: ReadonlyArray<Pick<DownloadableRef, 'variationId' | 'filename' | 'downloadableId'>>): string[] {
  const differences: string[] = []
  for (const variant of observed) {
    const apiNames = new Set(variant.files.map((file) => file.name))
    const library = new Map<string, Set<number>>()
    for (const file of purchases) {
      if (file.variationId !== variant.variationId) continue
      const ids = library.get(file.filename) ?? new Set<number>()
      ids.add(file.downloadableId)
      library.set(file.filename, ids)
    }
    for (const [name, ids] of library) {
      if (ids.size !== 1) throw new Error(`已购变体 #${variant.variationId} 的库内同名文件无法唯一匹配：${name}`)
      if (!apiNames.has(name)) differences.push(`变体 #${variant.variationId} 仅购买库：${name}`)
    }
    for (const name of apiNames) {
      if (!library.has(name)) differences.push(`变体 #${variant.variationId} 仅 API：${name}`)
    }
  }
  return differences
}

const emptySummary = (): CheckSummary => ({
  libraryChecked: 0, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0
})

export class ItemFileUpdates {
  private checkingItem: number | null = null
  private running = false
  onChanged: (() => void) | null = null
  onProgress: ((event: CheckProgressEvent) => void) | null = null

  constructor(
    private repo: LibraryRepo,
    private crawler: Pick<LibraryCrawler, 'crawlItem'>,
    private history: HistoryManager,
    private checker: UpdateCheckService,
    private readItem: ReadBoothItem,
    private libraryBusy: () => boolean
  ) {}

  get isRunning(): boolean { return this.running }

  rememberPurchases(itemId: number, ids: number[], addedDownloadIds: number[] = []): void {
    if (!ids.length) return
    const state = this.repo.getItemFileUpdateState<State>(itemId)
    const owned = [...new Set(ids)].sort((a, b) => a - b)
    const syncedDownloadIds = [...new Set([...(state?.syncedDownloadIds ?? []), ...addedDownloadIds])]
    if (JSON.stringify(owned) !== JSON.stringify(state?.owned) || syncedDownloadIds.length !== (state?.syncedDownloadIds?.length ?? 0)) {
      const ownedIds = new Set(owned)
      this.repo.saveItemFileUpdateState(itemId, {
        ...state, owned, abnormal: state?.abnormal ?? false,
        syncedDownloadIds,
        observed: state?.observed.filter((variant) => ownedIds.has(variant.variationId)) ?? [],
        changes: state?.changes.filter((change) => ownedIds.has(change.variationId)) ?? []
      })
    }
  }

  needsBaseline(itemId: number): boolean {
    const state = this.repo.getItemFileUpdateState<State>(itemId)
    return !!state && !state.abnormal && state.owned.some((id) => !state.observed.some((variant) => variant.variationId === id))
  }

  private capturePendingProbeBaselines(itemId: number, state: State): State {
    if (!state.changes.some((change) => change.kind !== 'removed')) {
      return state.pendingProbeBaselines ? { ...state, pendingProbeBaselines: undefined } : state
    }
    // 购买库核对前先保存旧指纹，等真实库确认后再选出相应下载 ID。
    const existing = state.pendingProbeBaselines
    const added = this.repo.listDownloadablesOfItem(itemId).filter((link) => !existing?.[link.downloadableId])
    if (!added.length) return state
    const pendingProbeBaselines = { ...existing }
    for (const link of added) pendingProbeBaselines[link.downloadableId] = { etag: link.lastEtag, size: link.lastSize }
    return { ...state, pendingProbeBaselines }
  }

  observe(itemId: number, data: Awaited<ReturnType<ReadBoothItem>>, seedOnly = false): boolean {
    if (this.checkingItem === itemId) return false
    const state = this.repo.getItemFileUpdateState<State>(itemId)
    if (!state?.owned.length || state.abnormal) return false
    try {
      const current = readFiles(data, state.owned)
      const observed = seedOnly ? current.map((entry) => state.observed.find((old) => old.variationId === entry.variationId) ?? entry) : current
      if (JSON.stringify(observed) === JSON.stringify(state.observed) && data.name === state.apiTitle) {
        const next = this.capturePendingProbeBaselines(itemId, state)
        if (next !== state) this.repo.saveItemFileUpdateState(itemId, next)
        return true
      }
      const changes = compareFiles(state, observed)
      const next = this.capturePendingProbeBaselines(itemId, { ...state, observed, changes, apiTitle: data.name })
      this.repo.saveItemFileUpdateState(itemId, next)
      if (JSON.stringify(changes) !== JSON.stringify(state.changes)) this.onChanged?.()
      return true
    } catch (error) {
      log.warn(`商品 #${itemId} 的 API 文件清单未采用：`, error instanceof Error ? error.message : error)
      return false
    }
  }

  list(): ItemFileUpdateStatus[] {
    return this.repo.listItemFileUpdateStates<State>().flatMap(({ itemId, title, state }) =>
      state.abnormal || state.changes.length ? [{ itemId, title, pending: state.changes.length > 0, abnormal: state.abnormal }] : [])
  }

  statusFor(itemId: number): ItemFileUpdateStatus | null {
    const state = this.repo.getItemFileUpdateState<State>(itemId)
    if (!state || (!state.abnormal && !state.changes.length)) return null
    return { itemId, title: this.repo.getItemTitle(itemId), pending: state.changes.length > 0, abnormal: state.abnormal }
  }

  async checkItem(itemId: number): Promise<CheckSummary> {
    const item = this.repo.getItemDetail(itemId)
    if (!item || item.isFree || item.isGift) return this.checker.checkItem(itemId)
    return this.exclusive(async () => {
      const state = this.repo.getItemFileUpdateState<State>(itemId) ?? { owned: [], observed: [], changes: [], abnormal: false }
      if (state.abnormal) return (await this.process(itemId, state, 'direct')).summary

      this.checkingItem = itemId
      try {
        const data = await this.readApiForCheck(itemId)
        if (!data) {
          return state.changes.length
            ? (await this.process(itemId, state, 'pending', null)).summary
            : await this.checker.checkItem(itemId)
        }
        if (!state.owned.length) return (await this.process(itemId, state, 'pending', data)).summary

        let observed: VariantFiles[]
        try {
          observed = readFiles(data, state.owned)
        } catch (error) {
          log.warn(`商品 #${itemId} 的 API 文件清单无法比较：`, error instanceof Error ? error.message : error)
          return state.changes.length
            ? (await this.process(itemId, state, 'pending', data)).summary
            : await this.checker.checkItem(itemId)
        }
        const next = this.capturePendingProbeBaselines(itemId, { ...state, observed, changes: compareFiles(state, observed), apiTitle: data.name })
        this.repo.saveItemFileUpdateState(itemId, next)
        if (next.changes.length || next.syncedDownloadIds?.length) return (await this.process(itemId, next, 'pending', data)).summary

        // 本地链接可能刚被库同步更新，即使 API 快照相同也应核实两者的差异。
        const localLinks = this.repo.listDownloadablesOfItem(itemId)
        let matchesLocal = false
        try {
          matchesLocal = alignFiles(observed, localLinks).length === 0
        } catch (error) {
          log.warn(`商品 #${itemId} 的本地链接无法唯一匹配，将重新核对购买库：`, error instanceof Error ? error.message : error)
        }
        if (!matchesLocal) return (await this.process(itemId, next, 'pending', data)).summary
        return await this.checker.checkItem(itemId)
      } finally {
        this.checkingItem = null
      }
    })
  }

  async checkApiUpdates(
    scan?: (
      onItem: (itemId: number, data: ApiItem | null) => Promise<void>,
      onProgress: (event: CheckProgressEvent) => void
    ) => Promise<void>,
    enqueueUpdates?: (ids: number[]) => void,
    options: ApiCheckOptions = {}
  ): Promise<ApiFileCheckResult> {
    return this.exclusive(async () => {
      const result: ApiFileCheckResult = { scanned: 0, checked: 0, abnormalItemIds: [], updated: 0, failed: 0 }
      const updatedIds = new Set<number>()
      let libraryAuthFailed = options.canCheckLibrary === false
      const record = async (itemId: number, data: ApiItem | null): Promise<void> => {
        // 启动扫描也会请求仅检查详情的商品，这些请求仍计入本轮扫描。
        result.scanned++
        const state = this.repo.getItemFileUpdateState<State>(itemId)
        if (!state?.owned.length || state.abnormal) return
        if (!data || !this.observe(itemId, data)) {
          result.failed++
          return
        }
        const observed = this.repo.getItemFileUpdateState<State>(itemId)
        if (!observed || (!observed.changes.length && !observed.syncedDownloadIds?.length)) return
        if (libraryAuthFailed) {
          result.failed++
          return
        }
        try {
          const { summary, abnormal } = await this.process(itemId, observed, 'pending', data, updatedIds, options)
          result.checked++
          result.failed += Number(summary.failed > 0)
          if (abnormal) result.abnormalItemIds.push(itemId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log.warn(`商品 #${itemId} 的购买库核对失败：`, message)
          result.failed++
          if (isAuthError(error)) {
            libraryAuthFailed = true
            options.onAuthExpired?.(message)
          }
        }
      }
      try {
        if (scan) await scan(record, (event) => this.onProgress?.(event))
        else {
          const items = this.repo.listItemFileUpdateStates<State>().filter(({ state }) => state.owned.length && !state.abnormal)
          for (const [index, { itemId }] of items.entries()) {
            this.onProgress?.({ phase: 'item-api', current: index, total: items.length, label: `商品 #${itemId}` })
            await record(itemId, await this.readApiForCheck(itemId))
          }
        }
        result.updated = updatedIds.size
        return result
      } finally {
        if (updatedIds.size) enqueueUpdates?.([...updatedIds])
        this.onProgress?.({ phase: 'item-api', current: 0, total: 0 })
      }
    })
  }

  async retryApi(itemId: number): Promise<boolean> {
    const state = this.repo.getItemFileUpdateState<State>(itemId)
    if (!state?.abnormal) throw new Error('该商品没有文件更新 API 异常')
    return this.exclusive(async () => !(await this.process(itemId, state, 'retry')).abnormal)
  }

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.running || this.libraryBusy() || this.checker.isRunning) throw new Error('购买库同步或文件检查正在进行')
    this.running = true
    try {
      return await run()
    } finally {
      this.running = false
      this.onChanged?.()
    }
  }

  private readApiForCheck(itemId: number): Promise<Awaited<ReturnType<ReadBoothItem>> | null> {
    return this.readItem(itemId).catch((error) => {
      log.warn(`商品 #${itemId} 的 API 文件核对失败：`, error instanceof Error ? error.message : error)
      return null
    })
  }

  private async process(
    itemId: number, state: State, mode: Mode, checkedApi?: ApiItem | null, updatedIds?: Set<number>,
    options: ApiCheckOptions = {}
  ): Promise<{ summary: CheckSummary; abnormal: boolean }> {
    this.checkingItem = itemId
    try {
      if (mode === 'pending' && !state.pendingProbeBaselines) {
        const next = this.capturePendingProbeBaselines(itemId, state)
        if (next !== state) this.repo.saveItemFileUpdateState(itemId, next)
        state = next
      }
      const apiData = mode === 'direct' ? null : checkedApi === undefined ? await this.readApiForCheck(itemId) : checkedApi
      const verified = options.verifiedItems?.get(itemId)
      const actual = verified?.purchases.length ? verified
        : await this.crawler.crawlItem(itemId, this.repo.getItemTitle(itemId), apiData?.name || state.apiTitle)
      if (!this.repo.getItemMetadataCheck(itemId)) throw new Error(`商品 #${itemId} 已离开资源库`)
      const summary = emptySummary()
      const owned = [...new Set([...state.owned, ...actual.purchases.flatMap((file) => file.variationId ?? [])])].sort((a, b) => a - b)

      let observed: VariantFiles[] | null = null
      let differences: string[] | null = null
      if (apiData) {
        try {
          observed = readFiles(apiData, owned)
          differences = alignFiles(observed, actual.purchases)
          if (differences.length) log.warn(`商品 #${itemId} 文件更新 API 与购买库不一致：`, differences)
        } catch (error) {
          log.warn(`商品 #${itemId} 文件清单无法完整核对：`, error instanceof Error ? error.message : error)
        }
      }
      const changes = observed && mode === 'pending' ? compareFiles(state, observed) : state.changes
      const { added, check, apiChangedFiles } = this.reconcile(itemId, actual, changes, mode, new Set(state.syncedDownloadIds))
      summary.libraryChecked = 1
      if (mode !== 'retry') {
        summary.filesUpdated = added.size
        for (const id of added) {
          this.repo.setStatus(id, 'update_available')
          updatedIds?.add(id)
        }
      }

      let nextState = state
      if (differences && observed && (mode === 'retry' || differences.length)) {
        nextState = { owned, observed, changes: [], abnormal: differences.length > 0, apiTitle: apiData?.name }
      } else if (state.syncedDownloadIds?.length && mode !== 'retry') {
        nextState = { ...state, syncedDownloadIds: undefined }
      }
      const abnormal = nextState.abnormal
      const pendingProbeBaselines: Record<number, ProbeBaseline> = {}
      if (!abnormal && mode === 'pending') {
        for (const id of apiChangedFiles) {
          const link = this.repo.getDownloadable(id)
          if (link) pendingProbeBaselines[id] = state.pendingProbeBaselines?.[id] ?? { etag: link.lastEtag, size: link.lastSize }
        }
      }
      const baselineIds = Object.keys(pendingProbeBaselines).map(Number)
      if (nextState !== state || baselineIds.length || state.pendingProbeBaselines) {
        nextState = { ...nextState, pendingProbeBaselines: baselineIds.length ? pendingProbeBaselines : undefined }
        this.repo.saveItemFileUpdateState(itemId, nextState)
      }
      if (check.size) {
        const batch = options.batch ?? { attemptedIds: new Set<number>(), checkedIds: new Set<number>(), fingerprintUpdates: new Set<number>() }
        try {
          const result = await this.checker.checkSelected(itemId, check, apiChangedFiles, updatedIds, batch, pendingProbeBaselines)
          summary.filesChecked += result.filesChecked
          summary.filesUpdated += result.filesUpdated
          summary.downloaded += result.downloaded
          summary.failed += result.failed
        } finally {
          if (baselineIds.some((id) => batch.checkedIds.has(id))) {
            for (const id of baselineIds) if (batch.checkedIds.has(id)) delete pendingProbeBaselines[id]
            nextState = { ...nextState, pendingProbeBaselines: Object.keys(pendingProbeBaselines).length ? pendingProbeBaselines : undefined }
            this.repo.saveItemFileUpdateState(itemId, nextState)
          }
        }
      }
      if (mode === 'pending' && differences && observed && !differences.length) {
        this.repo.saveItemFileUpdateState(itemId, {
          owned, observed, changes: summary.failed ? changes : [], abnormal: false, apiTitle: apiData?.name,
          pendingProbeBaselines: summary.failed ? nextState.pendingProbeBaselines : undefined
        })
      }
      if (mode !== 'direct' && !differences) summary.failed++
      if (mode === 'pending' && abnormal) summary.apiAbnormalItemIds = [itemId]
      return { summary, abnormal }
    } finally {
      this.checkingItem = null
    }
  }

  private reconcile(itemId: number, actual: ScopedLibraryItem, changes: FileChange[], mode: Mode, syncedDownloadIds?: ReadonlySet<number>):
    { added: Set<number>; check: Set<number>; apiChangedFiles: Set<number> } {
    const refs = [...actual.purchases, ...actual.gifts]
    if (!actual.purchases.length) throw new Error(`商品 #${itemId} 没有可核实的购买库下载链接，已保留原状态`)
    const unique = new Map<number, DownloadableRef>()
    for (const file of refs) {
      const same = unique.get(file.downloadableId)
      const old = this.repo.getDownloadable(file.downloadableId)
      if ((same && same.filename !== file.filename) || (old && old.itemId !== itemId)) {
        throw new Error(`商品 #${itemId} 的下载 ID #${file.downloadableId} 存在冲突`)
      }
      if (!same) unique.set(file.downloadableId, file)
    }
    const added = new Set<number>()
    const check = new Set<number>()
    const apiChangedFiles = new Set<number>()
    for (const [id, file] of unique) {
      const old = this.repo.getDownloadable(id)
      if (!old || old.status === 'missing' || (old.status === 'remote' && syncedDownloadIds?.has(id))) added.add(id)
      else if (mode === 'direct' || (mode === 'pending' && old.filename !== file.filename)) check.add(id)
    }
    if (mode === 'pending') {
      const hinted = new Map(changes.filter((change) => change.kind !== 'removed')
        .map((change) => [JSON.stringify([change.variationId, change.name]), change.kind]))
      for (const file of actual.purchases) {
        const kind = hinted.get(JSON.stringify([file.variationId, file.filename]))
        const id = file.downloadableId
        if (!kind || added.has(id)) continue
        if (kind === 'added' && this.repo.getDownloadable(id)?.status === 'remote') {
          // 同步库可能已登记新链接，仍应让尚未下载的新文件进入更新列表。
          added.add(id)
          check.delete(id)
        } else {
          check.add(id)
          apiChangedFiles.add(id)
        }
      }
    }
    retireMissingDownloadLinks(this.repo, this.history, itemId, new Set(unique.keys()))
    this.repo.upsertDownloadables(itemId, [...unique.values()])
    return { added, check, apiChangedFiles }
  }
}
