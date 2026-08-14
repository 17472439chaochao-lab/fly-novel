# FlyNovel

轻量桌面小说阅读器，支持导入 **Legado（阅读）** 文本书源，提供搜索、书架、离线缓存与阅读设置。

- **作者：** 飞鸟传说
- **QQ：** 17472439
- **邮箱：** 17472439chaochao@gmail.com
- **仓库：** https://gitee.com/wucc513721/fly-novel
- **许可证：** MIT（开源）

## 功能概览

- 导入 Legado 书源（本地文件 / URL 订阅）
- 多书源并发搜索、书源测试与管理
- 书架、换源、全部更新
- 打开本地 TXT / EPUB（自动分章，书架标注「本地」；无需换源与在线缓存）
- 阅读进度、目录、正文净化规则
- 章节离线缓存（SQLite），断网可读已缓存章节
- 阅读主题：纸感 / 护眼 / 夜间

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

```bash
git clone https://gitee.com/wucc513721/fly-novel.git
cd fly-novel
npm install
```

如 Electron 二进制下载失败，可使用国内镜像后重试：

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

1. 在 `package.json` 的 `build` 中增加（或已通过脚本传入）：

```json
"win": {
  "target": ["nsis", "zip"],
  "icon": "build/icon.png"
}
```

2. 执行：

```bash
npm run build
npx electron-builder --win
```

或使用已提供脚本：

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

---

## 书源兼容说明

兼容常见 Legado 文本书源字段：`searchUrl`、`ruleSearch`、`ruleBookInfo`、`ruleToc`、`ruleContent`。

轻量引擎支持：

- CSS 选择器（`@text` / `@html` / `@href` / `@src` / `@ownText`）
- XPath、JSONPath
- `##` 正则替换
- `{{key}}` / `{{page}}` 与基础 POST

暂不支持：复杂 `@js` / WebView / 登录源 / 听书等非文本类型。

---

## 目录结构（简要）

```
novel/
├── build/                 # 图标等打包资源
├── scripts/               # Electron 二进制修复等脚本
├── src/
│   ├── main/              # Electron 主进程、书源引擎、SQLite
│   ├── preload/           # 预加载桥
│   ├── renderer/          # React 界面
│   └── shared/            # 共享类型与关于信息
├── package.json
└── README.md
```

---

## 常见问题

**Q: 开发时菜单栏曾显示 Electron？**  
A: 已通过应用菜单与 `CFBundleName` 修补显示为 FlyNovel；改名后需完全退出再启动。

**Q: 书源/书架突然空了？**  
A: 数据固定在 `Application Support/fly-novel`。若曾因改名落到 `FlyNovel` 空目录，重启新版本会回到原目录。

**Q: 上传 Git 要注意什么？**  
A: 已配置 `.gitignore`，勿提交 `node_modules/`、`out/`、`release/`、本地数据库与系统文件。

---

## License

MIT © 飞鸟传说
