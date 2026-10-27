import { join, resolve } from 'path'

/**
 * 开发运行的根目录（仓库内 .temp\，与便携版 exe 同级目录对应）；非开发运行返回 null。
 * 下层结构：data\（库/items/log）、data\electron\（userData）、downloads\、deleted\。
 */
export function resolveDevRoot(): string | null {
  if (!process.versions.electron) return null
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron')
  if (app.isPackaged) return null
  return resolve(app.getAppPath(), '.temp')
}

/**
 * 数据根目录（DB / 图片 / 日志等工作文件）。
 * portable：exe 同级 data/；开发运行：.temp\data\；非 portable 安装版：userData。
 * 与 index.ts 启动时的 dataDir 计算保持同一规则。
 */
export function resolveDataDir(): string {
  if (process.env.BOOTH_DATA_DIR) return process.env.BOOTH_DATA_DIR
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir) return resolve(portableDir, 'data')
  if (process.versions.electron) {
    const devRoot = resolveDevRoot()
    if (devRoot) return join(devRoot, 'data')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron')
    return app.getPath('userData')
  }
  return resolve(process.cwd(), 'data')
}
