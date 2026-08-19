# FlyNovel

[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://gitee.com/wucc513721/fly-novel)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![version](https://img.shields.io/badge/version-v1.0.4-blueviolet)](docs/development.html#changelog)
[![stack](https://img.shields.io/badge/UI-Electron%20%2B%20React-orange)](docs/development.html)

轻量桌面小说阅读器，支持导入 **Legado（阅读）** 文本书源，提供搜索、书架、离线缓存与阅读设置。

架构、IPC、数据库与更新记录见 **[开发文档](docs/development.html)**。

- **作者：** 飞鸟传说
- **QQ：** 17472439
- **邮箱：** 17472439chaochao@gmail.com
- **仓库：** https://gitee.com/wucc513721/fly-novel
- **许可证：** MIT（开源）

## 功能概览

- 导入 Legado 书源（本地文件 / URL 订阅），支持按当前筛选导出 JSON；**一键在线获取**社区书源仓库并自动导入（内置 tickmao / XIU2 / yckceo，支持自定义订阅 URL）
- 多书源并发搜索、书源测试与管理（测试自动换关键词，避免单词误判；失效源搜索命中自动恢复）
- 书架、换源、全部更新；条目显示上次阅读相对时间
- 打开本地 TXT / EPUB（自动分章，书架标注「本地」；大文件解析在独立 worker 线程，不卡界面）
- 阅读进度、目录、正文净化（含内置网址规则）；← / → 键盘翻章
- 章节离线缓存（SQLite），断网可读已缓存章节；支持整本缓存与导出 TXT
- 阅读主题：纸感 / 护眼 / 夜间；正文全宽铺满，字号 / 行距 / 系统字体可调；窗口缩放 / 全屏 / 目录开合自动保持阅读位置
- 老板键一键隐藏、自动滚屏、护眼/久坐提醒、Gitee 发行版检查更新

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面壳 | Electron |
| UI | React + TypeScript |
| 构建 | Vite / electron-vite |
| 打包 | electron-builder |
| 本地存储 | better-sqlite3（SQLite） |
| 书源解析 | cheerio、xpath、@xmldom/xmldom、jsonpath-plus、iconv-lite |
| 本地 EPUB | jszip（ZIP 解压）+ 内置 TXT 章节识别

数据目录（macOS 示例）：`~/Library/Application Support/fly-novel/fly-novel.sqlite`

---

## 环境要求

- **Node.js** 18+（推荐 20 LTS）
- **npm** 9+
- macOS / Windows / Linux 均可开发（本仓库默认配置面向桌面 Electron）

原生模块 `better-sqlite3` 需与 Electron ABI 匹配；`npm install` 后的 `postinstall` 会执行 `electron-builder install-app-deps` 进行重建。若启动崩溃（SIGSEGV），请确认使用的是兼容 Electron 34 的 `better-sqlite3@11.x`，并执行：

```bash
npx @electron/rebuild -f -w better-sqlite3
```

---

## 安装依赖

仓库已配置 `.npmrc`（npmmirror 的 npm / Electron / electron-builder 镜像），国内环境一般可直接安装：

```bash
git clone https://gitee.com/wucc513721/fly-novel.git
cd fly-novel
npm install
```

如 Electron 二进制仍下载失败，可显式指定镜像后重试：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
# 或单独修复 Electron
node scripts/ensure-electron.js
```

---

## 开发运行

```bash
npm run dev
```

说明：

- 会启动 Vite 渲染进程开发服务器，并拉起 Electron 窗口
- 修改 `src/renderer` 一般可热更新
- 修改 `src/main` / `src/preload` 后通常需要重启 `npm run dev`

仅构建不打包：

```bash
npm run build
npm run preview
```

---

## 编译与打包（桌面）

项目使用 **electron-builder**。产物默认输出到 `release/`。

### 通用：先编译再打包

```bash
npm run build
```

编译结果在 `out/`（main / preload / renderer）。

### macOS

```bash
# 生成 dmg + zip（当前 package.json 默认）
npm run dist

# 仅生成未打包的 .app 目录（调试更快）
npm run dist:dir
```

产物示例：

- `release/FlyNovel-x.x.x.dmg`
- `release/FlyNovel-x.x.x-mac.zip`
- `release/mac/FlyNovel.app`（`dist:dir`）

图标：`build/icon.icns`、`build/icon.png`。

> 未配置开发者签名时，`identity` 为 `null`，安装可能需在「隐私与安全性」中允许打开。

### Windows

在 macOS/Linux 上交叉打包 Windows 可能受限于代码签名与部分工具；**推荐在 Windows 机器上打包**。

```bash
npm run dist:win
```

产物示例：`release/FlyNovel Setup x.x.x.exe`、`.zip`。

### Linux

```bash
npm run build
npx electron-builder --linux
# 或
npm run dist:linux
```

常见产物：`AppImage`、`deb`（取决于 `linux.target` 配置）。

### 同时打多平台（需在对应平台或 CI 上）

```bash
npx electron-builder --mac --win --linux
```

---

## 开源说明

本软件以 **MIT** 许可证开源。使用、修改、分发时请保留版权与许可声明。

源码仓库：https://gitee.com/wucc513721/fly-novel

主要开源组件：

| 组件 | 用途 | 许可 |
|------|------|------|
| Electron | 桌面运行时 | MIT |
| React | UI | MIT |
| TypeScript | 语言与编译 | Apache-2.0 |
| Vite / electron-vite | 构建 | MIT |
| electron-builder | 打包 | MIT |
| better-sqlite3 | 本地数据库 | MIT |
| cheerio | HTML 解析 | MIT |
| @xmldom/xmldom + xpath | XML / XPath | MIT |
| jsonpath-plus | JSONPath | MIT |
| iconv-lite | 编码转换 | MIT |
| jszip | EPUB（ZIP）解压 | MIT / GPLv3 |

---

## 书源兼容说明

兼容常见 Legado 文本书源字段：`searchUrl`、`ruleSearch`、`ruleBookInfo`、`ruleToc`、`ruleContent`。

轻量引擎支持：

- CSS 选择器（`@text` / `@html` / `@href` / `@src` / `@ownText`）
- XPath、JSONPath
- `##` 正则替换
- `{{key}}` / `{{page}}` 与基础 POST（表达式为自写算术求值器，不含代码执行）
- `@js` 规则（在 `vm` 隔离沙箱中执行，仅暴露安全全局与 `result`/`baseUrl` 等绑定，禁止访问 `process`/`require`/`fs`/`fetch` 等宿主能力）
- HTTP 请求校验状态码（4xx / 5xx 视为该源失败，不影响其他源）

暂不支持：依赖 WebView / `java` 对象或登录态的复杂 `@js`、登录源、听书等非文本类型。

---

## 目录结构（简要）

```
novel/
├── build/                 # 图标等打包资源
├── docs/                  # 开发文档
│   └── development.html
├── scripts/               # Electron 二进制修复等脚本
├── src/
│   ├── main/              # Electron 主进程、书源引擎、SQLite
│   ├── preload/           # 预加载桥
│   ├── renderer/          # React 界面
│   └── shared/            # 共享类型与关于信息
├── .npmrc                 # npm / Electron 国内镜像
├── package.json
└── README.md
```

更完整的模块说明见 [开发文档](docs/development.html)。

---

## 常见问题

**Q: 开发时菜单栏曾显示 Electron？**  
A: 已通过应用菜单与 `CFBundleName` 修补显示为 FlyNovel；改名后需完全退出再启动。

**Q: 书源/书架突然空了？**  
A: 数据固定在 `Application Support/fly-novel`。若曾因改名落到 `FlyNovel` 空目录，重启新版本会回到原目录。

**Q: 上传 Git 要注意什么？**  
A: 已配置 `.gitignore`，勿提交 `node_modules/`、`out/`、`release/`、本地数据库与系统文件。

---

## 更新记录

近期变更（倒序）：

- **2026-08-19 · v1.0.4** — 在线获取书源；TXT/EPUB 导入 worker 化 + zip bomb 防护；封面 BLOB 化；书源测试自动多关键词轮询；@js 沙箱执行；增量 UPSERT 存储；列表虚拟化；正文全宽铺满与滚动位置保持
- **2026-08-18 · v1.0.3** — 阅读页正文全宽铺满；← / → 键盘翻章
- **2026-08-17 · v1.0.2** — 书源按筛选导出 JSON；Windows 书源编辑弹窗按钮错位修复；默认国内镜像
- **2026-08-15 · v1.0.1** — 网址净化、护眼提醒、书架上次阅读时间、侧栏短句、章节更新误报修复、Gitee 检查更新
- **2026-08-15 · v1.0.0** — 初始发布

详细条目见 [开发文档 · 更新记录](docs/development.html#changelog)。

---

## License

MIT © 飞鸟传说
