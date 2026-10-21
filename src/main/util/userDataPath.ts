import { app } from 'electron'
import { resolve } from 'path'

// 必须是 main 入口的第一个 import：在单实例锁、electron-log 等读取 userData 的代码执行前完成重定向。
// portable：userData 落在 exe 同级 data\electron\（随文件夹一起搬走，不写 %APPDATA%）。
// 开发运行：落在仓库内 .temp\electron\，同样不污染 %APPDATA%。
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
if (portableDir) {
  app.setPath('userData', resolve(portableDir, 'data', 'electron'))
} else if (!app.isPackaged) {
  app.setPath('userData', resolve(app.getAppPath(), '.temp', 'electron'))
}
