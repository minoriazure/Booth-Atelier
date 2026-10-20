<div align="center">

# Booth Atelier

**Booth Atelier 是一款独立的 BOOTH 素材库管理工具**

![Version](https://img.shields.io/badge/version-1.2.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2B-0078D4?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-33-9FEAF9?logo=electron&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&logoColor=white)
![Build](https://github.com/minoriazure/Booth-Atelier/actions/workflows/build-release.yml/badge.svg)

</div>

基于 Cookie 登录，把你的 BOOTH 购买库完整搬到本地：资源库浏览、文件级更新检查与下载、完整历史版本保留。

> [!NOTE]
> 本项目是第三方个人工具，与 booth.pm 官方无关联，也未经其授权。
> 请仅用于管理**你自己账号已购买**的素材，并遵守 BOOTH 的服务条款。

## 功能概览

- **Cookie 登录**：cookies 文件更新后自动热加载，无需重启
- **库同步**：同步购买库与赠送库的全部元数据，支持本地浏览与搜索（不自动下载素材）
- **精确更新检查**：精确到单个下载链接（官方只能到商品级），可自动检查与自动下载
- **下载管理**：直接获取卖家上传的原始文件，多任务队列，断点续传，原子落盘
- **深链接接管**：接管 BOOTH 网页的「DL with BOOTH Library Manager」按钮
- **历史保留**：旧版本文件与商品说明快照永久保留，可按日期回看
- **便携版**：免安装，数据全部位于 exe 同级目录，整个文件夹拷走即可使用
- **代理**：系统代理 / 自定义 / 直连三档，切换即时生效

## 快速开始

1. 前往 [Releases](https://github.com/minoriazure/Booth-Atelier/releases) 下载最新的 `BoothAtelier-x.y.z-portable.exe`
2. 按 [Cookie 获取说明](docs/user-guide.md#cookie-获取) 导出 `booth_cookies.txt`，放在 exe 同一目录
3. 双击运行

完整的使用说明见 [使用指南](docs/user-guide.md)。

## 从源码构建

要求：Windows 10+、[Node.js](https://nodejs.org/) 24 或更高版本、npm。

```bash
git clone https://github.com/minoriazure/Booth-Atelier.git
cd Booth-Atelier
npm install
npm run dist      # 产物输出到 dist/
```

开发命令与验证脚本见 [开发指南](docs/development.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/user-guide.md) | 安装运行、Cookie 配置、下载、深链接、代理、数据目录、已知问题 |
| [开发指南](docs/development.md) | 环境要求、开发与构建命令、验证脚本、调试钩子 |
| [技术说明](docs/architecture.md) | 代码结构、网络层、深链协议、凭据安全模型、便携版打包原理 |
| [更新日志](CHANGELOG.md) | 版本变更记录 |

## 许可与免责声明

- 本仓库源码默认**不附带开源许可**（`UNLICENSED`），仅供个人学习与自用。如需其他授权，请与作者协商。
- 本工具非官方出品，与 booth.pm 无关联。BOOTH 相关商标与内容归其各自权利人所有。
- 本项目代码由 AI 生成，请谨慎使用。使用本工具产生的一切后果（包括账号风控、数据丢失等）由使用者自行承担。
