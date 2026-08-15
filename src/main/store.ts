import {
  clampEyeCareIntervalMinutes,
  clampRequestConcurrency,
  DEFAULT_PREFS,
  DEFAULT_SETTINGS,
  shelfMatchBaseline,
  type AppPrefs,
  type AppState,
  type BookSource,
  type ReaderSettings,
  type ShelfBook,
  type WindowBounds
} from '../shared/types'
import { blendMatchScore } from '../shared/searchRelevance'
import { isLocalBook } from '../shared/bookLocal'
import { isLegacyPresetFont, platformDefaultFontFamily } from '../shared/fonts'
import { getDb } from './db'

/**
 * 去掉书架书籍上的运行时 cache 字段，避免持久化。
 * @param book - 书架书籍
 * @returns 不含 cache 的副本
 */
function stripCacheField(book: ShelfBook): ShelfBook {
  const { cache: _c, ...rest } = book
  return rest
}

/**
 * 从 settings 表读取并解析 JSON 配置。
 * @param key - 配置键
 * @returns 解析后的对象；不存在或解析失败返回 undefined
 */
function readSettingJson<T>(key: string): T | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  if (!row?.value) return undefined
  try {
    return JSON.parse(row.value) as T
  } catch {
    return undefined
  }
}

/**
 * 将配置以 JSON 写入 settings 表。
 * @param key - 配置键
 * @param value - 任意可序列化值
 */
function writeSettingJson(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, JSON.stringify(value))
}

/**
 * 确保默认阅读器与应用偏好行存在，使配置从首次启动起落在 SQLite。
 */
export function ensureDefaultConfig(): void {
  if (!readSettingJson('reader')) {
    writeSettingJson('reader', {
      ...DEFAULT_SETTINGS,
      fontFamily: platformDefaultFontFamily()
    })
  }
  if (!readSettingJson('app')) {
    writeSettingJson('app', { ...DEFAULT_PREFS })
  }
}

/**
 * 按排序读取全部书源。
 * @returns 书源列表
 */
export function getSources(): BookSource[] {
  const rows = getDb()
    .prepare('SELECT data FROM sources ORDER BY sort_order ASC, book_source_url ASC')
    .all() as { data: string }[]
  return rows.map((r) => JSON.parse(r.data) as BookSource)
}

/**
 * 全量替换保存书源列表。
 * @param sources - 新书源列表
 */
export function saveSources(sources: BookSource[]): void {
  const database = getDb()
  const clear = database.prepare('DELETE FROM sources')
  const insert = database.prepare(
    'INSERT INTO sources (book_source_url, data, sort_order) VALUES (?, ?, ?)'
  )
  const tx = database.transaction((list: BookSource[]) => {
    clear.run()
    list.forEach((s, i) => {
      if (!s.bookSourceUrl) return
      insert.run(s.bookSourceUrl, JSON.stringify(s), i)
    })
  })
  tx(sources)
}

/**
 * 导入书源：已存在 URL 跳过，新 URL 追加。
 * @param incoming - 待导入书源
 * @returns 新增与跳过数量
 */
export function importSources(incoming: BookSource[]): { added: number; skipped: number } {
  const current = getSources()
  const map = new Map(current.map((s) => [s.bookSourceUrl, s]))
  let added = 0
  let skipped = 0
  for (const s of incoming) {
    if (map.has(s.bookSourceUrl)) {
      skipped += 1
      continue
    }
    map.set(s.bookSourceUrl, s)
    added += 1
  }
  if (added > 0) saveSources(Array.from(map.values()))
  return { added, skipped }
}

/**
 * 读取书架书籍列表（已剥离 cache）。
 * @returns 书架书籍数组
 */
export function getShelf(): ShelfBook[] {
  const rows = getDb()
    .prepare('SELECT data FROM shelf_books ORDER BY sort_order ASC, updated_at DESC')
    .all() as { data: string }[]
  return rows.map((r) => stripCacheField(JSON.parse(r.data) as ShelfBook))
}

/**
 * 全量替换保存书架。
 * @param shelf - 书架列表
 */
export function saveShelf(shelf: ShelfBook[]): void {
  const database = getDb()
  const clear = database.prepare('DELETE FROM shelf_books')
  const insert = database.prepare(
    'INSERT INTO shelf_books (id, data, sort_order, updated_at) VALUES (?, ?, ?, ?)'
  )
  const tx = database.transaction((list: ShelfBook[]) => {
    clear.run()
    list.forEach((b, i) => {
      const clean = stripCacheField(b)
      insert.run(clean.id, JSON.stringify(clean), i, clean.updatedAt || Date.now())
    })
  })
  tx(shelf)
}

/**
 * 插入或更新单本书架书籍；新书插到最前。
 * @param book - 书籍数据
 * @returns 更新后的完整书架
 */
export function upsertShelfBook(book: ShelfBook): ShelfBook[] {
  const clean = stripCacheField(book)
  const database = getDb()
  const existing = database.prepare('SELECT sort_order FROM shelf_books WHERE id = ?').get(clean.id) as
    | { sort_order: number }
    | undefined

  if (existing) {
    database
      .prepare('UPDATE shelf_books SET data = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(clean), clean.updatedAt || Date.now(), clean.id)
  } else {
    database.prepare('UPDATE shelf_books SET sort_order = sort_order + 1').run()
    database
      .prepare(
        'INSERT INTO shelf_books (id, data, sort_order, updated_at) VALUES (?, ?, 0, ?)'
      )
      .run(clean.id, JSON.stringify(clean), clean.updatedAt || Date.now())
  }
  return getShelf()
}

/**
 * 仅补丁更新阅读进度相关字段，避免客户端整本覆盖无关字段。
 * @param id - 书籍 ID
 * @param patch - scrollTop / chapterIndex / lastReadAt 可选补丁
 * @returns 更新后的书籍；不存在返回 null
 */
export function patchShelfProgress(
  id: string,
  patch: { scrollTop?: number; chapterIndex?: number; lastReadAt?: number }
): ShelfBook | null {
  const database = getDb()
  const row = database.prepare('SELECT data FROM shelf_books WHERE id = ?').get(id) as
    | { data: string }
    | undefined
  if (!row) return null
  const book = stripCacheField(JSON.parse(row.data) as ShelfBook)
  if (patch.scrollTop != null) book.scrollTop = Math.max(0, Math.round(patch.scrollTop))
  if (patch.chapterIndex != null) {
    book.chapterIndex = Math.max(0, Math.floor(patch.chapterIndex))
  }
  if (patch.lastReadAt != null) book.lastReadAt = patch.lastReadAt
  book.updatedAt = Date.now()
  database
    .prepare('UPDATE shelf_books SET data = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(book), book.updatedAt, id)
  return book
}

/**
 * 从书架移除一本书。
 * @param id - 书籍 ID
 * @returns 更新后的书架
 */
export function removeShelfBook(id: string): ShelfBook[] {
  getDb().prepare('DELETE FROM shelf_books WHERE id = ?').run(id)
  return getShelf()
}

/**
 * 读取阅读器设置（合并默认值，并处理旧预设字体）。
 * @returns 完整 ReaderSettings
 */
export function getSettings(): ReaderSettings {
  const s = readSettingJson<Partial<ReaderSettings>>('reader')
  if (!s) {
    return { ...DEFAULT_SETTINGS, fontFamily: platformDefaultFontFamily() }
  }
  const fontFamily = isLegacyPresetFont(s.fontFamily)
    ? platformDefaultFontFamily()
    : s.fontFamily!
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    fontFamily,
    purifyRules: Array.isArray(s.purifyRules) ? s.purifyRules : []
  }
}

/**
 * 保存阅读器设置。
 * @param settings - 完整阅读器设置
 */
export function saveSettings(settings: ReaderSettings): void {
  writeSettingJson('reader', {
    ...settings,
    purifyRules: settings.purifyRules || []
  })
}

/**
 * 读取应用偏好（含窗口边界、老板键、并发等归一化）。
 * @returns 完整 AppPrefs
 */
export function getPrefs(): AppPrefs {
  const raw = readSettingJson<Partial<AppPrefs>>('app')
  if (!raw) return { ...DEFAULT_PREFS, windowBounds: { ...DEFAULT_PREFS.windowBounds } }
  const bounds = raw.windowBounds || DEFAULT_PREFS.windowBounds
  const lastView =
    raw.lastView === 'search' ||
    raw.lastView === 'sources' ||
    raw.lastView === 'settings' ||
    raw.lastView === 'about' ||
    raw.lastView === 'shelf'
      ? raw.lastView
      : DEFAULT_PREFS.lastView
  const preload =
    typeof raw.preloadCount === 'number' && Number.isFinite(raw.preloadCount)
      ? Math.max(0, Math.min(20, Math.round(raw.preloadCount)))
      : DEFAULT_PREFS.preloadCount
  return {
    sourceTestKeyword:
      typeof raw.sourceTestKeyword === 'string' && raw.sourceTestKeyword.trim()
        ? raw.sourceTestKeyword.trim()
        : DEFAULT_PREFS.sourceTestKeyword,
    lastView,
    windowBounds: {
      width: Math.max(860, Number(bounds.width) || DEFAULT_PREFS.windowBounds.width),
      height: Math.max(560, Number(bounds.height) || DEFAULT_PREFS.windowBounds.height),
      x: typeof bounds.x === 'number' ? bounds.x : undefined,
      y: typeof bounds.y === 'number' ? bounds.y : undefined,
      isMaximized: Boolean(bounds.isMaximized)
    },
    bossKeyEnabled:
      typeof raw.bossKeyEnabled === 'boolean' ? raw.bossKeyEnabled : DEFAULT_PREFS.bossKeyEnabled,
    bossKey:
      typeof raw.bossKey === 'string' && raw.bossKey.trim()
        ? raw.bossKey.trim()
        : DEFAULT_PREFS.bossKey,
    preloadCount: preload,
    requestConcurrency: clampRequestConcurrency(raw.requestConcurrency),
    shelfSort: raw.shelfSort === 'added' ? 'added' : 'lastRead',
    eyeCareEnabled:
      typeof raw.eyeCareEnabled === 'boolean' ? raw.eyeCareEnabled : DEFAULT_PREFS.eyeCareEnabled,
    eyeCareIntervalMinutes: clampEyeCareIntervalMinutes(
      raw.eyeCareIntervalMinutes ?? DEFAULT_PREFS.eyeCareIntervalMinutes
    )
  }
}

/**
 * 校验并保存应用偏好。
 * @param prefs - 待保存偏好
 * @returns 归一化后写入的偏好
 */
export function savePrefs(prefs: AppPrefs): AppPrefs {
  const next: AppPrefs = {
    sourceTestKeyword: prefs.sourceTestKeyword.trim() || DEFAULT_PREFS.sourceTestKeyword,
    lastView: prefs.lastView || DEFAULT_PREFS.lastView,
    windowBounds: prefs.windowBounds || { ...DEFAULT_PREFS.windowBounds },
    bossKeyEnabled: Boolean(prefs.bossKeyEnabled),
    bossKey: prefs.bossKey.trim() || DEFAULT_PREFS.bossKey,
    preloadCount: Math.max(0, Math.min(20, Math.round(prefs.preloadCount ?? DEFAULT_PREFS.preloadCount))),
    requestConcurrency: clampRequestConcurrency(prefs.requestConcurrency),
    shelfSort: prefs.shelfSort === 'added' ? 'added' : 'lastRead',
    eyeCareEnabled: Boolean(prefs.eyeCareEnabled),
    eyeCareIntervalMinutes: clampEyeCareIntervalMinutes(prefs.eyeCareIntervalMinutes)
  }
  writeSettingJson('app', next)
  return next
}

/**
 * 获取当前全局请求并发上限（已钳制）。
 * @returns 并发数
 */
export function getRequestConcurrency(): number {
  return getPrefs().requestConcurrency
}

/**
 * 合并补丁后保存应用偏好。
 * @param patch - 部分偏好字段
 * @returns 保存后的完整偏好
 */
export function patchPrefs(patch: Partial<AppPrefs>): AppPrefs {
  return savePrefs({ ...getPrefs(), ...patch })
}

/**
 * 持久化窗口边界到偏好。
 * @param bounds - 窗口位置与尺寸
 */
export function saveWindowBounds(bounds: WindowBounds): void {
  patchPrefs({ windowBounds: bounds })
}

/**
 * 追加一条净化规则（去重、去空白）。
 * @param rule - 规则文本
 * @returns 更新后的阅读器设置
 */
export function addPurifyRule(rule: string): ReaderSettings {
  const text = rule.trim()
  const settings = getSettings()
  if (!text) return settings
  if (settings.purifyRules.includes(text)) return settings
  const next = { ...settings, purifyRules: [...settings.purifyRules, text] }
  saveSettings(next)
  return next
}

/**
 * 删除一条净化规则。
 * @param rule - 要删除的规则文本
 * @returns 更新后的阅读器设置
 */
export function removePurifyRule(rule: string): ReaderSettings {
  const settings = getSettings()
  const next = {
    ...settings,
    purifyRules: settings.purifyRules.filter((r) => r !== rule)
  }
  saveSettings(next)
  return next
}

/**
 * 用新书源替换旧 URL 对应项（并去掉与新 URL 冲突的旧项）。
 * @param oldUrl - 原书源 URL
 * @param source - 新书源对象
 * @returns 更新后的书源列表
 */
export function replaceSource(oldUrl: string, source: BookSource): BookSource[] {
  const sources = getSources().filter((s) => s.bookSourceUrl !== oldUrl)
  const withoutDup = sources.filter((s) => s.bookSourceUrl !== source.bookSourceUrl)
  withoutDup.push(source)
  saveSources(withoutDup)
  return withoutDup
}

/**
 * 按 URL 合并补丁更新书源字段；显式 null/undefined 会删除该键。
 * @param url - 书源 URL
 * @param patch - 部分字段补丁
 * @returns 更新后的书源列表
 */
export function patchSource(url: string, patch: Partial<BookSource>): BookSource[] {
  const sources = getSources().map((s) => {
    if (s.bookSourceUrl !== url) return s
    const next: BookSource = { ...s, ...patch }
    for (const key of Object.keys(patch) as (keyof BookSource)[]) {
      if (patch[key] === undefined || patch[key] === null) delete next[key]
    }
    return next
  })
  saveSources(sources)
  return sources
}

/**
 * 根据书架使用量抬高书源 flyMatchScore 下限（不会降低已有分数）。
 * @returns 可能已更新的书源列表
 */
export function syncMatchScoresFromShelf(): BookSource[] {
  const counts = new Map<string, number>()
  for (const b of getShelf()) {
    if (isLocalBook(b) || !b.origin) continue
    counts.set(b.origin, (counts.get(b.origin) || 0) + 1)
  }
  let changed = false
  const next = getSources().map((s) => {
    const baseline = shelfMatchBaseline(counts.get(s.bookSourceUrl) || 0)
    if (baseline <= 0) return s
    const cur =
      typeof s.flyMatchScore === 'number' && Number.isFinite(s.flyMatchScore) ? s.flyMatchScore : 0
    if (cur >= baseline) return s
    changed = true
    return {
      ...s,
      flyMatchScore: baseline,
      flyMatchSamples: Math.max(s.flyMatchSamples || 0, 1)
    }
  })
  if (changed) saveSources(next)
  return changed ? next : getSources()
}

/**
 * 记录书源一次成功使用或强相关搜索命中，融合匹配分。
 * @param url - 书源 URL
 * @param sample - 样本分数，默认 90
 * @returns 更新后的书源列表
 */
export function bumpSourceMatch(url: string, sample = 90): BookSource[] {
  if (!url) return getSources()
  const s = getSources().find((x) => x.bookSourceUrl === url)
  if (!s) return getSources()
  return patchSource(url, {
    flyMatchScore: blendMatchScore(s.flyMatchScore, sample),
    flyMatchSamples: (s.flyMatchSamples || 0) + 1
  })
}

/**
 * 组装渲染进程所需的应用全局状态。
 * @returns 含书源、书架、设置与偏好的 AppState
 */
export function getAppState(): AppState {
  const sources = syncMatchScoresFromShelf()
  return {
    sources,
    shelf: getShelf(),
    settings: getSettings(),
    prefs: getPrefs()
  }
}

/**
 * 读取最近搜索历史（最多 20 条）。
 * @returns 关键词数组，新到旧
 */
export function getSearchHistory(): string[] {
  const rows = getDb()
    .prepare('SELECT keyword FROM search_history ORDER BY searched_at DESC LIMIT 20')
    .all() as { keyword: string }[]
  return rows.map((r) => r.keyword)
}

/**
 * 追加或刷新一条搜索历史，并裁剪到 20 条。
 * @param keyword - 搜索关键词
 * @returns 更新后的历史列表
 */
export function addSearchHistory(keyword: string): string[] {
  const key = keyword.trim()
  if (!key) return getSearchHistory()
  const database = getDb()
  database
    .prepare(
      `INSERT INTO search_history (keyword, searched_at) VALUES (?, ?)
       ON CONFLICT(keyword) DO UPDATE SET searched_at = excluded.searched_at`
    )
    .run(key, Date.now())
  database
    .prepare(
      `DELETE FROM search_history WHERE keyword NOT IN (
         SELECT keyword FROM search_history ORDER BY searched_at DESC LIMIT 20
       )`
    )
    .run()
  return getSearchHistory()
}

/**
 * 清空全部搜索历史。
 * @returns 空数组
 */
export function clearSearchHistory(): string[] {
  getDb().prepare('DELETE FROM search_history').run()
  return []
}

/**
 * 删除单条搜索历史。
 * @param keyword - 要删除的关键词
 * @returns 更新后的历史列表
 */
export function removeSearchHistory(keyword: string): string[] {
  const key = keyword.trim()
  if (!key) return getSearchHistory()
  getDb().prepare('DELETE FROM search_history WHERE keyword = ?').run(key)
  return getSearchHistory()
}
