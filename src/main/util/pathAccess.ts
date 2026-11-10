import { realpathSync, statSync } from 'fs'
import { isAbsolute, relative, sep, resolve } from 'path'

export function isWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
export function allowedFile(path: string, roots: string[], allowDirectory = false): string {
  const stat = statSync(path)
  if (!isAbsolute(path) || (!stat.isFile() && !(allowDirectory && stat.isDirectory()))) throw new Error('文件不存在或不是普通文件')
  const canonical = realpathSync(path)
  if (!roots.some((root) => {
    try { return isWithin(root, path) && isWithin(realpathSync(root), canonical) } catch { return false }
  })) throw new Error('文件不在允许的数据目录内')
  return canonical
}
