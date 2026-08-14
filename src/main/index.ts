import { app, BrowserWindow, dialog, ipcMain, shell, nativeImage, Menu, globalShortcut, nativeTheme } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from './utils'
import * as store from './store'
import * as chapterDb from './chapterDb'
import { closeDb, initDb } from './db'
import { getBookInfo, getChapterList, getContent, normalizeSources, searchBooks, testSource, isSourceStructuralOk } from './legado/engine'
import { fetchText } from './legado/http'
import { mapPool, withTimeout } from './asyncPool'
import { APP_ABOUT } from '../shared/about'
import { ensureNovelParagraphs } from '../shared/novelText'
import type { BookSource, ReaderSettings, SearchBook, ShelfBook } from '../shared/types'
import { compareSourcesForSearch, speedTagFromRespondMs } from '../shared/types'
import { isLocalBook } from '../shared/bookLocal'
import { filterRelevantSearchHits, titleSimilarity, scoreSearchMatchSample, blendMatchScore } from '../shared/searchRelevance'
import { matchChapterIndex } from '../shared/matchChapter'
import { importLocalBookDialogAsync } from './localBooks/importLocal'
import { exportShelfBookToTxt } from './localBooks/exportTxt'
import { listSystemFontFamilies } from './systemFonts'

const APP_NAME = APP_ABOUT.name
/** 固定用户数据目录名，避免 productName 变更导致迁移 userData。 */
const USER_DATA_DIR = 'fly-novel'
app.setName(APP_NAME)
app.setPath('userData', join(app.getPath('appData'), USER_DATA_DIR))

const THEME_WINDOW_BG: Record<ReaderSettings['theme'], string> = {
  paper: '#e6ebe4',
  green: '#dce8d6',
  night: '#121516'
}

/**
 * 按阅读主题设置系统主题与所有窗口背景色。
 * @param theme - 阅读主题，默认 paper
 */
function applyAppTheme(theme: ReaderSettings['theme'] = 'paper'): void {
  const bg = THEME_WINDOW_BG[theme] || THEME_WINDOW_BG.paper
  nativeTheme.themeSource = theme === 'night' ? 'dark' : 'light'
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(bg)
  }
}

/**
 * 从 package.json 读取应用版本号。
 * @returns 版本字符串；失败则回退 APP_ABOUT.version
 */
function readAppVersion(): string {
  try {
    const pkgPath = join(__dirname, '../../package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
      if (pkg.version) return pkg.version
    }
  } catch {
    /* 忽略 */
  }
  return APP_ABOUT.version
}

const APP_VERSION = readAppVersion()

const cacheJobs = new Map<string, AbortController>()
let registeredBossKey = ''
let bossHidden = false

/**
 * 解析应用图标文件路径（开发/打包多候选）。
 * @returns 存在的图标路径；均不存在则为 undefined
 */
function resolveAppIcon(): string | undefined {
  const candidates = [
    join(__dirname, '../../build/icon.png'),
    join(process.resourcesPath, 'icon.png'),
    join(app.getAppPath(), 'build/icon.png')
  ]
  return candidates.find((p) => existsSync(p))
}

/**
 * 配置系统「关于」面板文案与图标。
 */
function setupAboutPanel(): void {
  const iconPath = resolveAppIcon()
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: APP_VERSION,
    version: APP_VERSION,
    copyright: `Copyright © ${new Date().getFullYear()} ${APP_ABOUT.author}`,
    website: APP_ABOUT.repo,
    credits: [
      `作者：${APP_ABOUT.author}`,
      `QQ：${APP_ABOUT.qq}`,
      `邮箱：${APP_ABOUT.email}`,
      `仓库：${APP_ABOUT.repo}`,
      '',
      APP_ABOUT.features,
      '',
      APP_ABOUT.opensourceNote,
      '',
      '主要开源组件：',
      ...APP_ABOUT.components.map((c) => `· ${c.name}（${c.license}）— ${c.desc}`)
    ].join('\n'),
    ...(iconPath ? { iconPath } : {})
  })
}

/**
 * 为书架列表附加缓存状态（本地书视为已满缓存）。
 * @param list - 书架书籍
 * @returns 带 cache 字段的列表
 */
function enrichShelf(list: ShelfBook[]): ShelfBook[] {
  return list.map((b) => {
    if (isLocalBook(b)) {
      const total = (b.chapters || []).filter((c) => c.url && !c.isVolume).length
      return {
        ...b,
        isLocal: true,
        originName: b.originName || '本地',
        cache: { bookId: b.id, total, cached: total, status: 'full' as const }
      }
    }
    const info = chapterDb.getBookCacheInfo(b.id, b.chapters)
    if (cacheJobs.has(b.id)) {
      return { ...b, cache: { ...info, status: 'caching' as const } }
    }
    return { ...b, cache: info }
  })
}

/**
 * 将导入书源的 added/skipped 统计转为前端消息载荷。
 * @param result - 导入统计
 * @returns 含 ok、message、sources 的结果
 */
function importResultPayload(result: { added: number; skipped: number }) {
  if (!result.added && result.skipped) {
    return {
      ok: true as const,
      message: `全部 ${result.skipped} 个书源已存在，未导入`,
      sources: store.getSources()
    }
  }
  return {
    ok: true as const,
    message:
      result.skipped > 0
        ? `导入完成：新增 ${result.added}，已存在跳过 ${result.skipped}`
        : `导入完成：新增 ${result.added}`,
    sources: store.getSources()
  }
}

/**
 * 规范化并导入解析后的书源 JSON。
 * @param json - 原始 JSON
 * @returns 导入结果或失败消息
 */
function importFromParsed(json: unknown) {
  const sources = normalizeSources(json)
  if (!sources.length) return { ok: false as const, message: '未识别到有效书源' }
  return importResultPayload(store.importSources(sources))
}

/**
 * 获取当前主窗口（第一个 BrowserWindow）。
 * @returns 主窗口或 null
 */
function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] || null
}

/**
 * 切换老板键隐藏/显示主窗口（macOS 同步 dock）。
 */
function toggleBossVisibility(): void {
  const win = getMainWindow()
  if (!win) return
  if (bossHidden || !win.isVisible()) {
    if (process.platform === 'darwin') app.dock?.show()
    win.show()
    if (win.isMinimized()) win.restore()
    win.focus()
    bossHidden = false
  } else {
    win.hide()
    if (process.platform === 'darwin') app.dock?.hide()
    bossHidden = true
  }
}

/**
 * 根据偏好注册或注销全局老板键快捷键。
 * @returns 注册结果与说明文案
 */
function registerBossKeyFromPrefs(): { ok: boolean; message: string } {
  const prefs = store.getPrefs()
  if (registeredBossKey) {
    try {
      globalShortcut.unregister(registeredBossKey)
    } catch {
      /* 忽略 */
    }
    registeredBossKey = ''
  }
  if (!prefs.bossKeyEnabled) {
    return { ok: true, message: '老板键已关闭' }
  }
  const accel = prefs.bossKey.trim()
  if (!accel) return { ok: false, message: '快捷键不能为空' }
  const ok = globalShortcut.register(accel, () => toggleBossVisibility())
  if (!ok) return { ok: false, message: `无法注册快捷键：${accel}（可能被占用）` }
  registeredBossKey = accel
  return { ok: true, message: `老板键已启用：${accel}` }
}

/**
 * 构建并设置应用菜单（按平台区分）。
 */
function setupAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about' as const, label: `关于 ${APP_NAME}` },
              { type: 'separator' as const },
              { role: 'services' as const, label: '服务' },
              { type: 'separator' as const },
              { role: 'hide' as const, label: `隐藏 ${APP_NAME}` },
              { role: 'hideOthers' as const, label: '隐藏其他' },
              { role: 'unhide' as const, label: '全部显示' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: `退出 ${APP_NAME}` }
            ]
          }
        ]
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '查看',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const, label: '全部置于顶层' }
            ]
          : [{ role: 'close' as const, label: '关闭' }])
      ]
    }
  ]

  if (!isMac) {
    template.push({
      label: '帮助',
      submenu: [{ role: 'about', label: `关于 ${APP_NAME}` }]
    })
  }

  if (!isMac) {
    template.unshift({
      label: '文件',
      submenu: [{ role: 'quit', label: `退出 ${APP_NAME}` }]
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 创建主窗口并加载渲染进程，持久化窗口边界。
 */
function createWindow(): void {
  const prefs = store.getPrefs()
  const theme = store.getSettings().theme || 'paper'
  const bounds = prefs.windowBounds
  const iconPath = resolveAppIcon()
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 860,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: THEME_WINDOW_BG[theme] || THEME_WINDOW_BG.paper,
    show: false,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  applyAppTheme(theme)

  if (bounds.isMaximized) win.maximize()

  if (process.platform === 'darwin' && iconPath && app.dock) {
    const img = nativeImage.createFromPath(iconPath)
    if (!img.isEmpty()) app.dock.setIcon(img)
  }

  const persistBounds = () => {
    if (win.isDestroyed()) return
    const isMaximized = win.isMaximized()
    const normal = isMaximized ? win.getNormalBounds() : win.getBounds()
    store.saveWindowBounds({
      x: normal.x,
      y: normal.y,
      width: normal.width,
      height: normal.height,
      isMaximized
    })
  }

  win.on('ready-to-show', () => win.show())
  win.on('resize', persistBounds)
  win.on('move', persistBounds)
  win.on('close', persistBounds)

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 注册全部 ipcMain.handle 通道。
 */
function registerIpc(): void {
  // 获取应用全局状态（书架含缓存信息）
  ipcMain.handle('app:getState', () => {
    const state = store.getAppState()
    return { ...state, shelf: enrichShelf(state.shelf) }
  })

  // 列出书源并同步书架匹配分
  ipcMain.handle('sources:list', () => store.syncMatchScoresFromShelf())

  // 从本地 JSON 文件导入书源
  ipcMain.handle('sources:importFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入 Legado 书源',
      filters: [{ name: 'JSON', extensions: ['json', 'txt'] }],
      properties: ['openFile']
    })
    if (canceled || !filePaths[0]) return { ok: false, message: '已取消' }
    try {
      const raw = readFileSync(filePaths[0], 'utf-8')
      return importFromParsed(JSON.parse(raw) as unknown)
    } catch (e) {
      return { ok: false, message: `导入失败：${(e as Error).message}` }
    }
  })

  // 从 URL 订阅导入书源
  ipcMain.handle('sources:importUrl', async (_e, url: string) => {
    const target = url.trim()
    if (!/^https?:\/\//i.test(target)) {
      return { ok: false, message: '请输入以 http:// 或 https:// 开头的书源地址' }
    }
    try {
      const { text } = await fetchText(target)
      const trimmed = text.trim()
      const body = trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim()
      return importFromParsed(JSON.parse(body) as unknown)
    } catch (e) {
      return { ok: false, message: `URL 导入失败：${(e as Error).message}` }
    }
  })

  // 启用或禁用单个书源
  ipcMain.handle('sources:toggle', (_e, url: string, enabled: boolean) => {
    const sources = store.getSources().map((s) =>
      s.bookSourceUrl === url ? { ...s, enabled } : s
    )
    store.saveSources(sources)
    return sources
  })

  // 删除单个书源
  ipcMain.handle('sources:remove', (_e, url: string) => {
    const sources = store.getSources().filter((s) => s.bookSourceUrl !== url)
    store.saveSources(sources)
    return sources
  })

  // 更新（替换）单个书源
  ipcMain.handle('sources:update', (_e, oldUrl: string, source: BookSource) => {
    const normalized = normalizeSources([source])
    if (!normalized.length) throw new Error('书源格式无效')
    return store.replaceSource(oldUrl, normalized[0])
  })

  // 测试单个书源搜索
  ipcMain.handle('sources:test', async (_e, url: string, keyword?: string) => {
    const source = findSource(url)
    if (!source) throw new Error('书源不存在')
    const result = await testSource(source, keyword)
    const sources = store.patchSource(url, {
      flyTestStatus: result.ok ? 'ok' : 'fail',
      flyTestMessage: result.message,
      flyTestAt: Date.now(),
      flyRespondMs: result.respondMs,
      respondTime: result.respondMs,
      flySpeedTag: speedTagFromRespondMs(result.respondMs)
    })
    return { result: { ...result, url, name: source.bookSourceName }, sources }
  })

  // 批量测试书源（可指定 URL 列表）
  ipcMain.handle('sources:testAll', async (e, keyword?: string, urls?: string[]) => {
    const all = store.getSources()
    const urlSet = Array.isArray(urls) && urls.length ? new Set(urls) : null
    const list = urlSet ? all.filter((s) => urlSet.has(s.bookSourceUrl)) : all
    const total = list.length
    const sender = e.sender
    sender.send('sources:test-progress', { done: 0, total, current: '', phase: 'start' })

    if (!total) {
      sender.send('sources:test-progress', { done: 0, total: 0, current: '', phase: 'done' })
      return all
    }

    let done = 0
    const CONCURRENCY = store.getRequestConcurrency()
    const TEST_TIMEOUT_MS = 15000
    const outcomes = await mapPool(list, CONCURRENCY, async (s) => {
      try {
        const result = await withTimeout(
          testSource(s, keyword),
          TEST_TIMEOUT_MS,
          `书源「${s.bookSourceName}」测试超时`
        )
        done += 1
        sender.send('sources:test-progress', {
          done,
          total,
          current: s.bookSourceName,
          phase: 'progress',
          ok: result.ok
        })
        return { url: s.bookSourceUrl, result }
      } catch (err) {
        done += 1
        const result = {
          ok: false,
          message: (err as Error).message || '测试失败',
          found: 0,
          respondMs: TEST_TIMEOUT_MS,
          structuralOk: isSourceStructuralOk(s)
        }
        sender.send('sources:test-progress', {
          done,
          total,
          current: s.bookSourceName,
          phase: 'progress',
          ok: false
        })
        return { url: s.bookSourceUrl, result }
      }
    })

    const byUrl = new Map(outcomes.map((o) => [o.url, o.result]))
    const now = Date.now()
    const next = store.getSources().map((s) => {
      const result = byUrl.get(s.bookSourceUrl)
      if (!result) return s
      return {
        ...s,
        flyTestStatus: (result.ok ? 'ok' : 'fail') as 'ok' | 'fail',
        flyTestMessage: result.message,
        flyTestAt: now,
        flyRespondMs: result.respondMs,
        respondTime: result.respondMs,
        flySpeedTag: speedTagFromRespondMs(result.respondMs)
      }
    })
    store.saveSources(next)

    sender.send('sources:test-progress', { done: total, total, current: '', phase: 'done' })
    return next
  })

  // 移除结构无效或测试失败的书源
  ipcMain.handle('sources:removeInvalid', () => {
    const current = store.getSources()
    const keep = current.filter((s) => {
      if (!isSourceStructuralOk(s)) return false
      if (s.flyTestStatus === 'fail') return false
      return true
    })
    const removed = current.length - keep.length
    store.saveSources(keep)
    return { sources: keep, removed }
  })

  // 多书源并发搜索书籍
  ipcMain.handle('books:search', async (e, keyword: string) => {
    const key = keyword.trim()
    const shelfCountByOrigin = new Map<string, number>()
    for (const b of store.getShelf()) {
      if (isLocalBook(b) || !b.origin) continue
      shelfCountByOrigin.set(b.origin, (shelfCountByOrigin.get(b.origin) || 0) + 1)
    }
    const sources = store
      .getSources()
      .filter((s) => s.enabled !== false && s.searchUrl)
      .slice()
      .sort((a, b) => compareSourcesForSearch(a, b, shelfCountByOrigin))
    const total = sources.length
    const sender = e.sender
    sender.send('books:search-progress', {
      done: 0,
      total,
      found: 0,
      current: '',
      phase: 'start'
    })

    let done = 0
    let found = 0
    const orderedBooks: SearchBook[] = []
    const matchSamples = new Map<string, number>()
    const CONCURRENCY = store.getRequestConcurrency()
    const SEARCH_TIMEOUT_MS = 12000

    await mapPool(sources, CONCURRENCY, async (s) => {
      try {
        const raw = await withTimeout(
          searchBooks(s, key, 1),
          SEARCH_TIMEOUT_MS,
          `书源「${s.bookSourceName}」搜索超时`
        )
        const books = filterRelevantSearchHits(key, raw)
        matchSamples.set(s.bookSourceUrl, scoreSearchMatchSample(key, raw, books))
        done += 1
        found += books.length
        if (books.length) {
          orderedBooks.push(...books)
          sender.send('books:search-partial', books)
        }
        sender.send('books:search-progress', {
          done,
          total,
          found,
          current: s.bookSourceName,
          phase: 'progress'
        })
        return books
      } catch (err) {
        console.error('search failed', s.bookSourceName, err)
        matchSamples.set(s.bookSourceUrl, 0)
        done += 1
        sender.send('books:search-progress', {
          done,
          total,
          found,
          current: s.bookSourceName,
          phase: 'progress'
        })
        return []
      }
    })

    if (matchSamples.size) {
      const nextSources = store.getSources().map((s) => {
        const sample = matchSamples.get(s.bookSourceUrl)
        if (sample == null) return s
        return {
          ...s,
          flyMatchScore: blendMatchScore(s.flyMatchScore, sample),
          flyMatchSamples: (s.flyMatchSamples || 0) + 1
        }
      })
      store.saveSources(nextSources)
    }

    const history = key ? store.addSearchHistory(key) : store.getSearchHistory()
    const books = filterRelevantSearchHits(key, orderedBooks).slice().sort((a, b) => {
      const d = titleSimilarity(key, b.name) - titleSimilarity(key, a.name)
      if (d !== 0) return d
      const sa = shelfCountByOrigin.get(a.origin) || 0
      const sb = shelfCountByOrigin.get(b.origin) || 0
      if (sa !== sb) return sb - sa
      return (a.originName || '').localeCompare(b.originName || '', 'zh')
    })

    sender.send('books:search-progress', {
      done: total,
      total,
      found: books.length,
      current: '',
      phase: 'done'
    })
    return { books, history, sources: store.getSources() }
  })

  // 获取搜索历史
  ipcMain.handle('search:history', () => store.getSearchHistory())

  // 清空搜索历史
  ipcMain.handle('search:clearHistory', () => store.clearSearchHistory())

  // 删除单条搜索历史
  ipcMain.handle('search:removeHistory', (_e, keyword: string) => store.removeSearchHistory(keyword))

  // 获取书籍详情
  ipcMain.handle('books:info', async (_e, origin: string, bookUrl: string) => {
    const source = findSource(origin)
    if (!source) throw new Error('书源不存在')
    return getBookInfo(source, bookUrl)
  })

  // 获取章节目录
  ipcMain.handle('books:toc', async (_e, origin: string, tocUrl: string) => {
    const source = findSource(origin)
    if (!source) throw new Error('书源不存在')
    return getChapterList(source, tocUrl)
  })

  // 获取章节正文（优先缓存）
  ipcMain.handle(
    'books:content',
    async (_e, origin: string, chapterUrl: string, bookId?: string) => {
      const cached = chapterDb.getChapterContent(bookId, chapterUrl)
      if (cached) {
        const normalized = ensureNovelParagraphs(cached)
        if (bookId && normalized) chapterDb.setChapterContent(bookId, chapterUrl, normalized)
        return normalized
      }
      if (origin === 'local' || chapterUrl.startsWith('local://')) {
        throw new Error('本地章节内容缺失，请重新打开本地文件')
      }
      const source = findSource(origin)
      if (!source) throw new Error('书源不存在或网络不可用，且本地无缓存')
      try {
        const content = await getContent(source, chapterUrl)
        if (content) {
          chapterDb.setChapterContent(bookId || '__browse__', chapterUrl, content)
        }
        return content
      } catch (err) {
        const fallback = chapterDb.getChapterContent(undefined, chapterUrl)
        if (fallback) {
          if (bookId) chapterDb.setChapterContent(bookId, chapterUrl, fallback)
          return fallback
        }
        throw err
      }
    }
  )

  // 列出某书已缓存章节 URL
  ipcMain.handle('books:cachedUrls', (_e, bookId: string) => {
    if (!bookId) return [] as string[]
    return Array.from(chapterDb.listCachedUrls(bookId))
  })

  // 预加载指定章节正文到缓存
  ipcMain.handle(
    'books:preload',
    async (_e, origin: string, bookId: string, chapterUrls: string[]) => {
      if (!bookId || !Array.isArray(chapterUrls) || !chapterUrls.length) {
        return Array.from(chapterDb.listCachedUrls(bookId || ''))
      }
      const source = findSource(origin)
      if (!source) return Array.from(chapterDb.listCachedUrls(bookId))
      const already = chapterDb.listCachedUrls(bookId)
      const pending = chapterUrls.filter((u) => u && !already.has(u))
      if (pending.length) {
        await mapPool(pending, store.getRequestConcurrency(), async (url) => {
          try {
            const content = await withTimeout(getContent(source, url), 12000, '预加载超时')
            if (content) chapterDb.setChapterContent(bookId, url, content)
          } catch {
            /* 跳过失败预加载 */
          }
        })
      }
      return Array.from(chapterDb.listCachedUrls(bookId))
    }
  )

  // 获取书架列表
  ipcMain.handle('shelf:list', () => enrichShelf(store.getShelf()))

  // 插入或更新书架书籍
  ipcMain.handle('shelf:upsert', (_e, book: ShelfBook) => {
    const next = enrichShelf(store.upsertShelfBook(book))
    if (book?.origin && !isLocalBook(book)) {
      store.bumpSourceMatch(book.origin, 92)
    }
    return next
  })

  // 仅更新阅读进度字段
  ipcMain.handle(
    'shelf:patchProgress',
    (
      _e,
      id: string,
      patch: { scrollTop?: number; chapterIndex?: number; lastReadAt?: number }
    ) => {
      return store.patchShelfProgress(id, patch)
    }
  )

  // 通过对话框导入本地书籍
  ipcMain.handle('shelf:importLocal', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await importLocalBookDialogAsync(win)
    if (!result.ok) return result
    return {
      ok: true as const,
      message: result.message,
      book: result.book,
      shelf: enrichShelf(result.shelf)
    }
  })

  // 从书架移除书籍并清除缓存
  ipcMain.handle('shelf:remove', (_e, id: string) => {
    cacheJobs.get(id)?.abort()
    cacheJobs.delete(id)
    chapterDb.clearBookCache(id)
    return enrichShelf(store.removeShelfBook(id))
  })

  // 查询单本书缓存状态
  ipcMain.handle('shelf:cacheStatus', (_e, id: string) => {
    const book = store.getShelf().find((b) => b.id === id)
    if (!book) return null
    const info = chapterDb.getBookCacheInfo(book.id, book.chapters)
    if (cacheJobs.has(id)) return { ...info, status: 'caching' as const }
    return info
  })

  // 取消正在进行的整本缓存任务
  ipcMain.handle('shelf:cancelCache', (_e, id: string) => {
    cacheJobs.get(id)?.abort()
    cacheJobs.delete(id)
    return enrichShelf(store.getShelf())
  })

  // 导出书架书籍为 TXT
  ipcMain.handle('shelf:exportTxt', async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return exportShelfBookToTxt(id, win, { findSource })
  })

  // 整本缓存书架书籍各章正文
  ipcMain.handle('shelf:cacheBook', async (e, id: string) => {
    if (cacheJobs.has(id)) throw new Error('该书正在缓存中')
    let book = store.getShelf().find((b) => b.id === id)
    if (!book) throw new Error('书架中未找到该书')
    if (isLocalBook(book)) throw new Error('本地书籍无需缓存')

    const source = findSource(book.origin)
    if (!source) throw new Error('书源不存在，无法缓存')

    if (!book.chapters?.length) {
      const info = await withTimeout(getBookInfo(source, book.bookUrl), 15000, '获取书籍信息超时')
      const tocUrl = info.tocUrl || book.tocUrl || book.bookUrl
      const chapters = await withTimeout(getChapterList(source, tocUrl), 20000, '获取目录超时')
      book = {
        ...book,
        name: info.name || book.name,
        author: info.author || book.author,
        coverUrl: info.coverUrl || book.coverUrl,
        intro: info.intro || book.intro,
        lastChapter: info.lastChapter || book.lastChapter,
        tocUrl,
        chapters,
        updatedAt: Date.now()
      }
      store.upsertShelfBook(book)
    }

    const chapters = (book.chapters || []).filter((c) => c.url && !c.isVolume)
    const total = chapters.length
    const sender = e.sender
    const controller = new AbortController()
    cacheJobs.set(id, controller)

    sender.send('shelf:cache-progress', {
      bookId: id,
      done: 0,
      total,
      current: '',
      phase: 'start',
      cached: chapterDb.getBookCacheInfo(id, book.chapters).cached
    })

    const already = chapterDb.listCachedUrls(id)
    let done = 0
    let cachedCount = chapters.filter((c) => already.has(c.url)).length
    let cancelled = false
    let lastProgressAt = 0

    const emitProgress = (current: string, ok?: boolean) => {
      const now = Date.now()
      if (now - lastProgressAt < 120 && done < total) return
      lastProgressAt = now
      sender.send('shelf:cache-progress', {
        bookId: id,
        done,
        total,
        current,
        phase: 'progress',
        ok,
        cached: cachedCount
      })
    }

    try {
      await mapPool(chapters, store.getRequestConcurrency(), async (ch) => {
        if (controller.signal.aborted) {
          cancelled = true
          return
        }
        if (already.has(ch.url)) {
          done += 1
          emitProgress(ch.title, true)
          return
        }
        try {
          const content = await withTimeout(
            getContent(source, ch.url),
            12000,
            `《${book!.name}》章节超时`
          )
          if (controller.signal.aborted) {
            cancelled = true
            return
          }
          if (content) {
            chapterDb.setChapterContent(id, ch.url, content, {
              index: ch.index,
              title: ch.title
            })
            cachedCount += 1
          }
          done += 1
          emitProgress(ch.title, Boolean(content))
        } catch {
          done += 1
          emitProgress(ch.title, false)
        }
      })
    } finally {
      cacheJobs.delete(id)
    }

    const info = chapterDb.getBookCacheInfo(id, book.chapters)
    sender.send('shelf:cache-progress', {
      bookId: id,
      done: total,
      total,
      current: '',
      phase: cancelled ? 'cancelled' : 'done',
      cached: info.cached
    })
    return enrichShelf(store.getShelf())
  })

  // 批量更新书架在线书籍目录与元信息
  ipcMain.handle('shelf:updateAll', async (e) => {
    const list = store.getShelf()
    const online = list.filter((b) => !isLocalBook(b))
    const total = online.length
    const sender = e.sender
    sender.send('shelf:update-progress', { done: 0, total, current: '', phase: 'start' })

    if (!total) {
      sender.send('shelf:update-progress', { done: 0, total: 0, current: '', phase: 'done' })
      return enrichShelf(list)
    }

    let done = 0
    const updatedOnline = await mapPool(online, store.getRequestConcurrency(), async (book) => {
      try {
        const source = findSource(book.origin)
        if (!source) throw new Error('书源不存在')
        const info = await withTimeout(
          getBookInfo(source, book.bookUrl),
          15000,
          `《${book.name}》更新超时`
        )
        const tocUrl = info.tocUrl || book.tocUrl || book.bookUrl
        const chapters = await withTimeout(
          getChapterList(source, tocUrl),
          20000,
          `《${book.name}》目录超时`
        )
        const current = book.chapters?.[book.chapterIndex]
        const chapterIndex =
          current && chapters.length ? matchChapterIndex(book, chapters) : 0
        const updated: ShelfBook = {
          ...book,
          name: info.name || book.name,
          author: info.author || book.author,
          coverUrl: info.coverUrl || book.coverUrl,
          intro: info.intro || book.intro,
          lastChapter: info.lastChapter || book.lastChapter,
          tocUrl,
          chapters,
          chapterIndex,
          updatedAt: Date.now()
        }
        done += 1
        sender.send('shelf:update-progress', {
          done,
          total,
          current: book.name,
          phase: 'progress',
          ok: true
        })
        return updated
      } catch (err) {
        done += 1
        sender.send('shelf:update-progress', {
          done,
          total,
          current: book.name,
          phase: 'progress',
          ok: false
        })
        console.error('shelf update failed', book.name, err)
        return book
      }
    })

    const byId = new Map(updatedOnline.map((b) => [b.id, b]))
    const outcomes = list.map((b) => byId.get(b.id) || b)
    store.saveShelf(outcomes)
    sender.send('shelf:update-progress', { done: total, total, current: '', phase: 'done' })
    return enrichShelf(outcomes)
  })

  // 获取阅读器设置
  ipcMain.handle('settings:get', () => store.getSettings())

  // 保存阅读器设置并应用主题
  ipcMain.handle('settings:save', (_e, settings: ReaderSettings) => {
    store.saveSettings(settings)
    applyAppTheme(settings.theme || 'paper')
    return settings
  })

  // 添加净化规则
  ipcMain.handle('settings:addPurify', (_e, rule: string) => store.addPurifyRule(rule))

  // 删除净化规则
  ipcMain.handle('settings:removePurify', (_e, rule: string) => store.removePurifyRule(rule))

  // 列出系统字体族
  ipcMain.handle('fonts:list', () => listSystemFontFamilies())

  // 获取应用偏好
  ipcMain.handle('prefs:get', () => store.getPrefs())

  // 保存应用偏好并刷新老板键
  ipcMain.handle('prefs:save', (_e, patch: Partial<import('../shared/types').AppPrefs>) => {
    const next = store.patchPrefs(patch)
    const result = registerBossKeyFromPrefs()
    return { prefs: next, bossKey: result }
  })
}

/**
 * 按 origin URL 查找已保存书源。
 * @param origin - 书源 URL
 * @returns 书源对象或 undefined
 */
function findSource(origin: string): BookSource | undefined {
  return store.getSources().find((s) => s.bookSourceUrl === origin)
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.flynovel.app')
  setupAboutPanel()
  setupAppMenu()
  initDb()
  store.ensureDefaultConfig()
  chapterDb.initChapterDb()
  applyAppTheme(store.getSettings().theme || 'paper')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  registerIpc()
  createWindow()
  registerBossKeyFromPrefs()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else if (bossHidden) toggleBossVisibility()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  closeDb()
})
