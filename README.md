<div align="center">

# Booth Atelier

**BOOTH 素材库管理器 —— 官方 `BOOTH Library Manager` 的替代品**

![Project version: 1.0.0](https://img.shields.io/badge/version-1.0.0-blue)
![Supported platform: Windows 10 and later](https://img.shields.io/badge/platform-Windows%2010%20%2B-0078D4?logo=windows&logoColor=white)
![Electron version 33](https://img.shields.io/badge/Electron-33-9FEAF9?logo=electron&logoColor=black)
![Node.js version 24 or later](https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&logoColor=white)
![GitHub Actions build and release workflow status](https://github.com/minoriazure/Booth-Atelier/actions/workflows/build-release.yml/badge.svg)

基于 Cookie 登录，把你的 BOOTH 购买库完整搬到本地：资源库浏览、文件级更新自动检查与下载、完整历史版本保留。

</div>

> [!NOTE]
> 本项目是第三方个人工具，与 booth.pm 官方无关联，也未经其授权。
> 请仅用于管理**你自己账号已购买**的素材，遵守 BOOTH 的服务条款。

## 目录

- [主要特性](#主要特性)
- [下载与使用](#下载与使用)
- [Cookie 获取](#cookie-获取)
- [从源码构建](#从源码构建)
- [开发](#开发)
- [数据目录结构](#数据目录结构)
- [功能详解](#功能详解)
- [已知问题](#已知问题)
- [技术要点](#技术要点)
- [许可与免责声明](#许可与免责声明)

## 主要特性

- Cookie 登录，cookies 文件更新后热加载，不用重启
- 同步购买库与赠送库的全部元数据，本地浏览、搜索，不自动下载素材文件
- 更新检查精确到单个下载链接（官方只能到商品级），可自动检查、可自动下载
- 下载直接拿到卖家上传的原始文件，多任务队列、断点续传
- 接管 BOOTH 网页的「用 BOOTH Library Manager 下载」深链接，点击直接开始下载
- 旧版本文件和说明快照永久保留，随时按日期回看
- 便携版免安装，数据全在 exe 同级目录，整个文件夹拷走即用
- 代理支持系统代理 / 自定义 / 直连三档，切换即时生效

各功能的具体行为见下方[功能详解](#功能详解)。

## 下载与使用

前往 [Releases](../../releases) 下载最新的 `BoothAtelier-x.y.z-portable.exe`。

**便携版使用步骤：**

1. 把 `BoothAtelier-x.y.z-portable.exe` 放到任意目录
2. 把 `booth_cookies.txt` 放在 exe **同一目录**（见下方 [Cookie 获取](#cookie-获取)）
3. 双击运行。**首次启动**会把程序文件解压到 exe 同级的 `app-cache\`（约 10-30 秒，仅此一次），然后自动同步BOOTH资料库并检查全部文件更新；之后每次启动直接运行，约 1-2 秒就绪
4. 所有工作文件（数据库 `data/`、素材 `downloads/`、cookies）默认都在 **exe 同级目录**，整个文件夹拷走即用；下载根目录可在「设置」改到任意盘

> [!TIP]
> portable 模式数据不依赖 `%APPDATA%`；程序文件缓存在 exe 同级 `app-cache\`（随文件夹一起拷贝即可在新机器上免二次解压），运行 `BoothAtelier-x.y.z-portable.exe /purge` 可清除该缓存（数据不受影响）。开发模式（`npm run dev`）下数据库在 `%APPDATA%\booth-library-manager\`。

## Cookie 获取

1. 浏览器安装导出 cookies 的插件（如 *[Get cookies.txt LOCALLY](https://github.com/kairi003/Get-cookies.txt-LOCALLY)*）
2. 登录 <https://accounts.booth.pm/library>
3. 导出 Netscape 格式 cookies，保存为程序目录下的 `booth_cookies.txt`
4. Cookie 过期时程序会弹窗提示；重新导出覆盖文件即可自动生效，点「重试」继续

> [!WARNING]
> `booth_cookies.txt` 等同于你的登录凭证，**已被加入 `.gitignore`，切勿提交到仓库或分享给他人**。

## 从源码构建

要求：Windows 10+、[Node.js](https://nodejs.org/) 24 或更高版本、npm。

```bash
git clone https://github.com/minoriazure/Booth-Atelier.git
cd Booth-Atelier
npm install          # 安装依赖（含 Electron 二进制）
npm run dist         # 构建产物到 out/ 并打包便携版 exe 到 dist/
```

打包产物位于 `dist/`：`BoothAtelier-<version>-portable.exe`（便携版）。
打包脚本会自动准备 NSIS 工具链（优先复用 electron-builder 本地缓存，缺失时从官方源下载并做 SHA-256 校验），无需手动安装。

## 开发

```bash
npm run dev        # 开发模式（Vite HMR）
npm run build      # 仅构建到 out/
npm run preview    # 预览构建结果
npm run dist       # 打包便携版 exe
npm run typecheck  # 类型检查（tsconfig.node + tsconfig.web）
```

独立验证脚本（不启动界面）：

```bash
npx tsx scripts/check-auth.ts        # 验证 cookies 是否有效
npx tsx scripts/crawl-library.ts     # 全量抓取库并 dump JSON
npx tsx scripts/dl-one.ts <id> <vid> # 端到端下载单个文件验证
npx tsx scripts/m3-verify.ts         # 全链路回归（同步→检查→下载→模拟更新→归档）
```

> 上述脚本均需有效的 `booth_cookies.txt`，仅在本地运行，不会在 CI 中执行。

## 数据目录结构

```
{data 目录}/                       # 数据文件（portable 版在 exe 同级 data/）
└── items/{商品编号}/
    ├── images/                    # 缩略图/宣传图/描述插图（本地化）
    ├── videos/                    # yt-dlp 下载的描述内嵌视频
    ├── snapshots/                 # 商品说明历史快照
    └── description.html           # 当前说明

{下载根目录}/                       # 只放素材文件（portable 版在 exe 同级 downloads/）
└── {商品编号}/
    ├── current/                   # 当前版本文件
    └── history/{日期}/            # 历史版本（更新时旧文件移入）
```

数据库与图片缓存位于数据目录；下载根可在设置中改到任意盘。

## 功能详解

### 库同步

自动抓取购买库与赠送库的全部商品（列表页加商品详情页），在本地建立索引：资源库展示、宣传图、商品描述、全文搜索。同步只更新元数据，不会下载素材文件。

抓库时缩略图、宣传图、描述插图直接下载到商品的 `images/` 目录，资源库和详情页都读本地文件，打开是秒开。文字更新优先处理，图片在后台自动补齐，不需要人工确认。

### 更新检查

通过 BOOTH Library Manager 专用 deeplink 协议提取每个下载链接的文件指纹（ETag 和文件大小），粒度比官方的"商品是否有更新"更细，能精确到单个链接。检查方式有三种：启动时全局自动检查（可关）、手动点"检查全部更新"、在单个商品里点"检查此商品全部链接"；检查到更新后可设置自动下载（也可关）。

启动时的同步和检查是两个独立开关，另外可以设置启动检查间隔：距离上次全局检查不足设定天数就跳过（默认 7 天，0~365 天可调，0 表示每次都查）。手动检查不受这个间隔影响。

### 下载

优先走 `DL with BOOTH Library Manager` 专用链接，直接拿到卖家上传的原始文件（unitypackage 之类），不做 zip 包装。可以逐个文件确认下载、单个商品全部下载，或者一键下载全部。任务走多并发队列，支持断点续传和原子落盘；还在排队的文件点「立即下载」可以直接开下，不用等并发额度和排队顺序。

### 更新与下载页

所有下载任务集中在一个页面，类似 qBittorrent 的任务列表：表头可以拖拽调宽（行为和 Windows 资源管理器一样，左侧固定、右侧整体平移，双击恢复默认宽度，宽度会被记住），支持六种状态筛选、行内进度、单行取消和重试、全局暂停恢复、一键重试失败项。

### 深链接

接管 `booth-library-manager://` 协议。在 BOOTH 网页点「用 BOOTH Library Manager 下载」后，本程序自动拉起并把窗口前置，解析链接后直接进入下载，不经过排队。支持网页按钮和 `/deeplink` 端点两种 URL 形态，细节见下方技术要点。

### 代理

设置页三档：系统代理、自定义、直连。系统代理跟随 Windows 系统设置，行为和 Chrome 一致，改了即时生效；自定义支持 `http://`、`socks5://` 和裸地址三种写法。切换不需要重启程序，yt-dlp 视频下载也走当前生效的代理。

### 描述与媒体

抓取商品完整描述 HTML（多段落、内嵌视频 iframe），详情页按网页端风格渲染。描述里的 YouTube、NicoNico、Vimeo 视频可以用 yt-dlp 一键下载到商品的 `videos/` 目录，之后嵌进本地播放器离线观看；没装 yt-dlp 时程序会给出安装提示。

图片会自动生成缩略图（4000px 压到 360px，体积约为原图的 1%）：画廊的缩略图条加载缩略图，点开的大图加载原图；大图支持滚轮缩放、拖拽平移、双击复位。

### 历史备份

旧数据一律不删除。素材文件更新时，旧文件移动到 `{下载根}/{商品编号}/history/{日期}/`，同名覆盖和作者改名传新两种情况都会立即归档；商品简介或宣传图变化时，自动在 `snapshots/` 存一份日期快照。详情页和历史页各有一个日期下拉，可以分别查看某天归档的文件和某天的说明快照。

## 已知问题

### 点深链接后浏览器报错（仅首次启动可能出现）

只有**首次启动**需要解压程序文件到 `app-cache\`（约 10-30 秒，仅此一次）。如果恰在此时在 BOOTH 网页点「用 BOOTH Library Manager 下载」，浏览器等不到应用响应会返回错误页（提示应用打开异常之类）。

**下载本身是正常的**：程序启动完成后会继续处理这条链接并开始下载，浏览器的报错直接忽略即可。之后的启动（包括点深链接拉起）约 1-2 秒就绪，不会再出现这个等待。

## 技术要点

- **专用下载链接**：`GET https://booth.pm/downloadables/{id}/deeplink?client=booth-library-manager&variation_id={vid}` → 302 到 `booth-library-manager://item-import?dlurl=<S3 签名直链>`，程序直接用 `dlurl` 下载原始文件。签名 180 秒过期，因此每次下载前即时解析，绝不缓存。
- **文件指纹**：对签名直链发 `Range: bytes=0-0` GET，从 `Content-Range` 取总大小 + `ETag`（HEAD 会 301 不可用；Range 响应的 `Content-Length` 是 1 也不可用）。
- **商品详情页**必须带语言路径（`/zh-cn/items/{id}`），裸路径 404。
- **限速**：所有 booth.pm 请求共享令牌桶（默认 250ms 间隔 + 抖动）。
- **网络层**：统一走 Electron `net` 栈（自动遵循代理三档设置）；`redirect: 'manual'` 必须用 `net.request` 实现（`net.fetch` 的 manual 收到 302 会直接 reject）；**跨源且带路径的 Referer 会被 Chromium 拦截**（同源发完整值、跨源只发 origin）。
- **深链两种形态**：`booth-library-manager://import?item_id=&dlurls[]=&filenames[]=`（网页按钮，多文件按索引配对）与 `item-import?dlurl=`（`/deeplink` 端点 302）；接收端先抢焦点让浏览器失焦（网页有 blur 超时检测），解析延后。
- **便携版打包**：`electron-builder --dir` + 自研 NSIS 启动器 stub（`scripts/build-portable.mjs`）。首次运行把内嵌 app.7z 解压到 exe 同级 `app-cache\<版本-载荷哈希>\`（旧版本缓存自动清理），之后每次直接启动缓存中的主程序，零解压；`PORTABLE_EXECUTABLE_DIR` 由 stub 指向 exe 所在目录，数据布局不变；`/purge` 清除程序缓存。

## 许可与免责声明

- 本仓库源码默认**不附带开源许可**（`UNLICENSED`），仅供个人学习与自用；如需其他授权请自行与作者协商。
- 本工具非官方出品，与 booth.pm 无关联；BOOTH 相关商标与内容归其各自权利人所有。
- 本项目所有代码均由AI生成，请谨慎使用。使用本工具产生的一切后果（含账号风控、数据丢失等）由使用者自行承担。
