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
| `npm run test:electron` | 先build，再运行隔离的Electron组件/应用启动与访问边界回归，网络被禁用 |
| `npm run benchmark` | 在临时合成库测量100/1000/5000商品的搜索、历史摘要、离线同步、内存和图片派生吞吐 |

正式单元测试只收集根目录 `tests/`；本地交接目录中的测试不属于CI。分支/PR和发布CI均运行typecheck、单元测试、build和Electron回归。Electron测试使用空白虚拟Cookie和隔离profile，不使用用户数据；隐藏窗口的rAF可能超时，因此资源墙scroll probe不视为真实FPS。

发布时 `scripts/release-check.mjs` 核对标签、package和lock版本，`--hash` 核对便携产物名并生成SHA256SUMS.txt；CI将校验值与exe一起上传。构建不会自动签名，安装版仍冻结。

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
| 便携版 | exe 同级 `data/`（库数据、日志 `log/YYYY-MM-DD.log`）与 `data/electron/`（Electron userData：缓存、单实例锁），下载根默认 exe 同级 `downloads/`，已删除归档 `deleted/` |
| 开发版（`npm run dev`，未设置 `PORTABLE_EXECUTABLE_DIR`） | 仓库内 `.temp\` 作为等价根，布局与便携版一致：`.temp\data\`（库数据、日志）、`.temp\data\electron\`（userData）、`.temp\downloads\`、`.temp\deleted\`；可用 `BOOTH_DATA_DIR` 覆盖数据目录 |

开发版日志位于 `.temp\data\log\`，便携版日志位于 exe 同级 `data\log\`（按日期命名，如 `2026-10-20.log`）。旧版开发数据位于 `.temp\electron\`，不再使用，可手动删除。

## 注意事项

- Electron `userData` 由 `src/main/util/userDataPath.ts` 在启动最早处重定向：设置 `PORTABLE_EXECUTABLE_DIR` 时到 `data\electron\`，未打包的开发运行到 `.temp\data\electron\`。该模块必须是 `src/main/index.ts` 的第一个 import。
- 未打包运行时 userData 目录名来自 `package.json` 顶层 `name`（`booth-atelier`）。
- `appId` 是 Windows 应用/安装包身份，本项目当前发布的是便携版；未来如启用安装版，修改 `appId` 后须验证原位升级、快捷方式和卸载行为。
- BOOTH 当前 deeplink 依赖固定 scheme `booth-library-manager://` 与 `client=booth-library-manager`，这两个外部兼容标识不随产品品牌更名。
- 数据库使用 sql.js（WASM），不依赖需要本地编译的原生模块（如 better-sqlite3），因此打包时无需 Visual Studio。
- 网络层、深链与 Cookie 相关改动前，请先阅读 [技术说明](architecture.md) 中的安全模型。
