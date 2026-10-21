# 技术说明

本文档面向开发者，描述代码结构、关键技术路径与设计约定。修改网络、下载、协议或 Cookie 相关逻辑前请先阅读。

## 技术栈

- Electron 33 + TypeScript + React 18
- sql.js（WASM）作为 SQLite 实现
- electron-vite 构建
- 便携版：`electron-builder --dir` 加自研 NSIS 启动器 stub

主进程持有全部业务逻辑（网络、数据库、文件）；渲染进程运行在沙箱中，通过 `preload` 的 `contextBridge` 暴露 `window.boothAPI`。

## 代码结构

```
src/main/
  index.ts            启动编排与单实例处理
  protocol.ts         深链协议注册、URL 解析、焦点处理、宿主自检
  appContext.ts       依赖注入装配
  booth/
    systemFetch.ts    网络层唯一出口（见下文「网络层」）
    httpClient.ts     限速、Referer 策略、重定向处理
    deeplink.ts       deeplink 解析（302 → Location）与指纹探测（Range）
    cookieJar.ts      Netscape Cookie 解析、热加载与路径切换（仅内存，不落盘）
  db/                 sql.js 封装、迁移脚本、查询
  services/           下载管理、更新检查、库同步、历史归档、代理、视频等
  ipc/handlers.ts     全部 IPC 入口（Zod 校验）
src/renderer/src/
  App.tsx             导航、状态栏、主题、登录检查统一入口
  components/         对话框等通用组件
  pages/              资源库、商品详情、更新与下载、历史、设置
scripts/              验证脚本与便携版打包脚本
```

## 下载管线

库列表页抓取 → deeplink 解析得到 S3 签名直链 → Range 探测取得指纹（ETag 与大小）→ 流式写入 `.part` → 大小校验 → 原子重命名 → 旧文件归档到 `history/` → 写入数据库。

签名直链 180 秒过期，因此每次下载前即时解析，**绝不缓存**。

### 任务状态

待下载（`remote` / `update_available`）→ 排队中（`queued_at` 持久化，退出不清除）→ 下载中（`active`）→ 已下载（`downloaded`）或失败（`failed`）。启动时 `restoreQueue` 自动续传。

## 网络层

所有 booth.pm 请求统一经过 `systemFetch.ts`，使用 Electron `net` 栈与专用的**进程内存 session**（`booth-runtime` 分区）：

- 不落盘，无 HTTP 缓存，`credentials: 'omit'`，不使用会话 cookie。
- 请求中唯一的 Cookie 来源是 Cookie 文件注入的显式请求头。这是「拷贝程序到别处不会带走登录态」的实现基础，**不要改回 `defaultSession`**。
- 自动遵循代理三档设置（系统 / 自定义 / 直连）。

### 已知的 Electron 行为约束

- **`net.fetch` 的 `redirect: 'manual'` 不可用**：收到 302 会直接以 "Redirect was cancelled" 拒绝。需要手动处理重定向时必须使用 `systemManualGet`（基于 `net.request` 的 `redirect` 事件）。`httpClient` 已自动路由。
- **跨源且带路径的 Referer 会被 Chromium 拦截**（`ERR_BLOCKED_BY_CLIENT`）。同源发送完整 Referer，跨源只发送 origin 形式（`https://host/`）。直接调用 `systemFetch` 的代码不要自行设置跨源带路径的 Referer。
- **限速**：所有 booth.pm 请求共享令牌桶（默认 250ms 间隔并加入抖动）。
- **403 不等于未登录**：限流（rate_limited）与认证失效（auth）分开处理。403 会触发 2 秒冷却，连续 5 次则熔断。认证失效时暂停队列但不清空队列。

## 深链协议

### 专用下载链接

```
GET https://booth.pm/downloadables/{id}/deeplink?client=booth-library-manager&variation_id={vid}
→ 302 Location: booth-library-manager://item-import?dlurl=<S3 签名直链>
```

程序直接使用 `dlurl` 下载原始文件。

### 两种 URL 形态

- `booth-library-manager://import?item_id=&dlurls[]=&filenames[]=`：网页按钮，多文件按索引配对。
- `booth-library-manager://item-import?dlurl=`：`/deeplink` 端点的 302 目标。

### 接收流程

1. 收到链接后立即抢占焦点，使浏览器失焦（BOOTH 网页会检测 blur 来判断应用是否已打开）。
2. 解析与下载延后到下一轮事件循环执行。
3. 下载前即时探测指纹：本地已下载且指纹一致则跳过，source 记为 `deeplink`，界面提示「已是最新」。手动「立即下载 / 重新下载」使用 `manual` 来源，强制重新下载。

### 协议启动器选择

同时存在 portable exe 与 NSIS Setup exe 时，注册表中的协议命令必须指向 portable 版。`protocol.ts` 会排除文件名包含 `setup` 或 `install` 的 exe，并优先选择 `*portable*`。否则深链会拉起安装向导。

### 注册自检

启动时可通过 `protocol:hostStatus` 检查 HKCU 中的协议注册是否指向本副本。若指向其他副本或未注册，应用内弹出询问对话框。注册表读取需注意：默认值名为 `(默认)`，查询时不能带 `/v`；中文 Windows 的输出需按 GBK 解码。

## 凭据安全模型

- Cookie 文件是唯一的登录凭证来源，程序只在内存中持有解析后的 Cookie。
- 登录判定：`AuthChecker` 请求 `accounts.booth.pm/library?page=1`，若被重定向到 `/login`、返回 401，或页面标题不在库页白名单内（`Library - BOOTH` / 日语界面的 `ライブラリ - BOOTH`），则判定为失效。标题随界面语言变化，因此不能只比对英文标题。
- 热加载：监听 Cookie 文件所在的父目录（按文件名过滤），因此文件缺失后再补放、覆盖或删除都能被感知。每次发送请求前还会通过 mtime 做惰性核对作为兜底。文件变化后发出 `cookiesReloaded` 事件，渲染进程自动重新检查登录状态。
- Cookie 路径为纯覆盖项：设置了且存在则生效，否则回退到默认查找链（exe 同级优先）。

## 数据库

- 位于 `{dataDir}/library.db`，使用 sql.js 的 WASM 实现。
- 迁移脚本按编号递增（当前到 006），`downloadables.queued_at` 用于持久化队列。
- sql.js 没有 FTS5，搜索使用 `LIKE`。
- 批量写入必须攒批并以约 5 秒为间隔节流 flush，否则容易因 WASM 内存不足（OOM）而失败。

## 便携版打包

1. `electron-builder --dir` 生成未打包的应用目录。
2. 目录压缩为 `app.7z`，并嵌入到 NSIS 启动器 stub（`scripts/portable-stub.nsi.in`）。
3. 首次运行时，stub 将程序解压到 exe 同级的 `app-cache\<版本-载荷哈希>\`，旧版本缓存自动清理。之后每次直接启动缓存中的主程序，无需再次解压。
4. stub 通过 `PORTABLE_EXECUTABLE_DIR` 将 exe 所在目录告知程序，数据布局因此保持不变。
5. `/purge` 参数会清除程序缓存。

中间产物不完整（缺少 `.ready` 标记）时会自动重新解压。

### NSIS stub 注意事项

- 使用 `$PLUGINSDIR` 前必须先调用 `InitPluginsDir`，否则文件会被写到盘根目录。
- `CopyFiles /SILENT` 会无条件设置错误标志，不能用它判断成功与否。
- makensis 无法读取 Electron exe 的图标，stub 不设置 `Icon`。
- NSIS 3.0.4 不支持 `SetCompressor off`。包含中文的 `.nsi` 文件必须保存为 UTF-8 BOM 编码。
- `win.signAndEditExecutable` 设为 `false`，以跳过 winCodeSign 的下载。

## 版本与分发

- 当前版本号以 `package.json` 的 `version` 为准。
- 产物名为 `BoothAtelier-<version>-portable.exe`。
- `package.json` 的 `name` 是 npm 包标识；`build.appId` 是 Windows 应用身份。便携版启动时（`src/main/util/userDataPath.ts`）将 Electron `userData` 重定向到 exe 同级 `data\electron\`；开发运行重定向到仓库内 `.temp\electron\`。两者都不写入 `%APPDATA%`。
- BOOTH deeplink 的 `booth-library-manager://` scheme 与 `client=booth-library-manager` 是外部兼容标识，必须保持不变；它们不是应用的显示名称。
