import { resolve } from 'path'

/**
 * 数据根目录（DB / 图片 / 日志等工作文件）。
 * portable：exe 同级 data/；非 portable（dev / 安装版）：userData。
 * 与 index.ts 启动时的 dataDir 计算保持同一规则。
 */
export function resolveDataDir(): string {
  if (process.env.BOOTH_DATA_DIR) return process.env.BOOTH_DATA_DIR
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir) return resolve(portableDir, 'data')
  if (process.versions.electron) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron')
    return app.getPath('userData')
  }
  return resolve(process.cwd(), 'data')
}
