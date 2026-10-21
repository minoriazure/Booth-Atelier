# 开发指南

## 环境要求

- Windows 10 或更高版本
- [Node.js](https://nodejs.org/) 24 或更高版本
- npm

## 安装依赖

```bash
git clone https://github.com/minoriazure/Booth-Atelier.git
cd Booth-Atelier
npm install          # 安装依赖（含 Electron 二进制）
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式（Vite HMR） |
| `npm run build` | 仅构建到 `out/` |
| `npm run preview` | 预览构建结果 |
| `npm run dist` | 构建并打包便携版 exe 到 `dist/` |
| `npm run typecheck` | 类型检查（`tsconfig.node.json` + `tsconfig.web.json`） |
| `npm test` | 运行测试（Vitest） |

### 打包说明

`npm run dist` 产物位于 `dist/`：`BoothAtelier-<version>-portable.exe`（便携版）。

打包脚本 `scripts/build-portable.mjs` 会自动准备 NSIS 工具链：优先复用 electron-builder 的本地缓存，缺失时从官方源下载并做 SHA-256 校验，无需手动安装。构建成功后会自动清理中间产物，设置环境变量 `BOOTH_KEEP_BUILD_INTERMEDIATES=1` 可保留它们。

## 验证脚本

`scripts/` 中的独立脚本不启动界面，可直接用 `tsx` 运行：

```bash
npx tsx scripts/check-auth.ts        # 验证 cookies 是否有效
npx tsx scripts/crawl-library.ts     # 全量抓取库并导出 JSON
npx tsx scripts/dl-one.ts <id> <vid> # 端到端下载单个文件
npx tsx scripts/m3-verify.ts         # 全链路回归（同步 → 检查 → 下载 → 模拟更新 → 归档）
```

> 以上脚本都需要有效的 `booth_cookies.txt`，仅在本地运行，不会在 CI 中执行。

## 调试环境变量

以下环境变量用于开发调试，普通使用无需设置：

| 变量 | 作用 |
| --- | --- |
| `BOOTH_HASH=tab=settings` | 启动后直接进入指定路由 |
| `BOOTH_SCREENSHOT=<路径>` | 启动后截图保存到指定路径（配合 `BOOTH_SCREENSHOT_DELAY`） |
| `BOOTH_NO_STARTUP=1` | 跳过启动时的库同步与文件检查 |
| `BOOTH_ENQUEUE=1` | 启动后自动加入队列 |
| `BOOTH_FORCE_HOST_PROMPT=1` | 在 dev 模式下强制弹出深链注册询问 |

挂载真实数据运行开发版（PowerShell 示例）：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:PORTABLE_EXECUTABLE_DIR = 'E:\path\to\dist'
npx electron .
```

> 若终端中设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 会以 Node 模式运行并直接退出，启动前需先清除该变量。

## 数据位置

| 模式 | 数据库与日志 |
| --- | --- |
| 便携版 | exe 同级 `data/`（库数据）与 `data/electron/`（Electron userData：日志 `logs/main.log`、缓存、单实例锁），下载根默认 exe 同级 `downloads/` |
| 开发版（`npm run dev`，未设置 `PORTABLE_EXECUTABLE_DIR`） | 仓库内 `.temp\electron\`（库数据与 userData 同目录；可用 `BOOTH_DATA_DIR` 覆盖） |

开发版日志位于 `.temp\electron\logs\main.log`，便携版日志位于 exe 同级 `data\electron\logs\main.log`。

## 注意事项

- Electron `userData` 由 `src/main/util/userDataPath.ts` 在启动最早处重定向：设置 `PORTABLE_EXECUTABLE_DIR` 时到 `data\electron\`，未打包的开发运行到 `.temp\electron\`。该模块必须是 `src/main/index.ts` 的第一个 import。
- 未打包运行时 userData 目录名来自 `package.json` 顶层 `name`（`booth-atelier`）。
- `appId` 是 Windows 应用/安装包身份，本项目当前发布的是便携版；未来如启用安装版，修改 `appId` 后须验证原位升级、快捷方式和卸载行为。
- BOOTH 当前 deeplink 依赖固定 scheme `booth-library-manager://` 与 `client=booth-library-manager`，这两个外部兼容标识不随产品品牌更名。
- 数据库使用 sql.js（WASM），不依赖需要本地编译的原生模块（如 better-sqlite3），因此打包时无需 Visual Studio。
- 网络层、深链与 Cookie 相关改动前，请先阅读 [技术说明](architecture.md) 中的安全模型。
