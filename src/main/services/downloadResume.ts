import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'fs'

export interface ResumeIdentity { id: number; etag: string | null; size: number | null }
export function strongEtag(etag: string | null): string | null {
  return etag && !etag.startsWith('W/') ? etag.replace(/^"|"$/g, '') : null
}
/** Never store expiring signed URLs or credentials alongside a partial file. */
export function preparePartial(path: string, identity: ResumeIdentity): number {
  let reusable = false
  try {
    const previous = JSON.parse(readFileSync(path + '.json', 'utf8')) as ResumeIdentity
    reusable = !!strongEtag(identity.etag) && previous.id === identity.id &&
      previous.etag === identity.etag && previous.size === identity.size && identity.size !== null &&
      statSync(path).isFile() && statSync(path).size < identity.size
  } catch { /* absent or incompatible metadata: restart */ }
  if (!reusable && existsSync(path)) rmSync(path)
  writeFileSync(path + '.json.tmp', JSON.stringify(identity))
  renameSync(path + '.json.tmp', path + '.json')
  return reusable ? statSync(path).size : 0
}
export function responseOffset(status: number, range: string | null, offset: number, total: number | null): number {
  if (status === 200) return 0
  if (status !== 206) throw new Error(`Unexpected download status ${status}`)
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range ?? '')
  if (!match || Number(match[1]) !== offset || Number(match[2]) < offset ||
      Number(match[2]) >= Number(match[3]) || (total !== null && Number(match[3]) !== total)) {
    throw new Error('下载响应区间与请求不一致')
  }
  return offset
}
