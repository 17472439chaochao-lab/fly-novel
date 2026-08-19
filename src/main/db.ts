import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'

let db: Database.Database | null = null

/**
 * 获取（并按需创建）应用统一 SQLite 数据库连接。
 * 首次调用时建库、开启 WAL/外键，并创建业务表与索引。
 * @returns better-sqlite3 数据库实例
 */
export function getDb(): Database.Database {
  if (db) return db
  const path = join(app.getPath('userData'), 'fly-novel.sqlite')
  db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // 多连接（导入 worker 等）同时写库时避免 SQLITE_BUSY
  db.pragma('busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      book_source_url TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS shelf_books (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS search_history (
      keyword TEXT PRIMARY KEY,
      searched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS book_covers (
      book_id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chapters (
      book_id TEXT NOT NULL,
      chapter_url TEXT NOT NULL,
      chapter_index INTEGER,
      title TEXT,
      content TEXT NOT NULL,
      cached_at INTEGER NOT NULL,
      PRIMARY KEY (book_id, chapter_url)
    );

    CREATE INDEX IF NOT EXISTS idx_chapters_url ON chapters(chapter_url);
    CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);
    CREATE INDEX IF NOT EXISTS idx_shelf_sort ON shelf_books(sort_order, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sources_sort ON sources(sort_order);
    CREATE INDEX IF NOT EXISTS idx_history_time ON search_history(searched_at DESC);
  `)
  return db
}

/**
 * 初始化数据库：打开连接并执行一次性迁移。
 */
export function initDb(): void {
  getDb()
  migrateFromElectronStore()
  migrateFromLegacyChaptersSqlite()
}

/**
 * 读取 meta 表中的键值。
 * @param key - 元数据键
 * @returns 对应值；不存在则为 undefined
 */
function getMeta(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

/**
 * 写入或更新 meta 表键值。
 * @param key - 元数据键
 * @param value - 元数据值
 */
function setMeta(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}

/**
 * 一次性迁移：从 electron-store 的 fly-novel.json 导入数据。
 * 若迁移标记已存在但书源为空（例如 userData 路径变更后库被清空），会尝试再次导入。
 */
function migrateFromElectronStore(): void {
  if (getMeta('migrated_electron_store') === '1') {
    const sourceCount = (
      getDb().prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }
    ).n
    if (sourceCount > 0) return
  }

  const userData = app.getPath('userData')
  const candidates = [
    join(userData, 'fly-novel.json'),
    join(userData, 'fly-novel.json.migrated.bak')
  ]
  const jsonPath = candidates.find((p) => existsSync(p))
  if (!jsonPath) {
    setMeta('migrated_electron_store', '1')
    return
  }

  try {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8')) as {
      sources?: unknown[]
      shelf?: unknown[]
      settings?: unknown
      chapterCache?: Record<string, string>
      searchHistory?: string[]
    }
    const database = getDb()
    const tx = database.transaction(() => {
      if (raw.settings && typeof raw.settings === 'object') {
        database
          .prepare(
            `INSERT INTO settings (key, value) VALUES ('reader', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
          )
          .run(JSON.stringify(raw.settings))
      }

      if (Array.isArray(raw.sources) && raw.sources.length) {
        const count = (
          database.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }
        ).n
        if (count === 0) {
          const insert = database.prepare(
            'INSERT OR REPLACE INTO sources (book_source_url, data, sort_order) VALUES (?, ?, ?)'
          )
          raw.sources.forEach((s, i) => {
            const item = s as { bookSourceUrl?: string }
            if (!item?.bookSourceUrl) return
            insert.run(item.bookSourceUrl, JSON.stringify(s), i)
          })
        }
      }

      if (Array.isArray(raw.shelf) && raw.shelf.length) {
        const count = (
          database.prepare('SELECT COUNT(*) AS n FROM shelf_books').get() as { n: number }
        ).n
        if (count === 0) {
          const insert = database.prepare(
            'INSERT OR REPLACE INTO shelf_books (id, data, sort_order, updated_at) VALUES (?, ?, ?, ?)'
          )
          raw.shelf.forEach((b, i) => {
            const item = b as { id?: string; updatedAt?: number; cache?: unknown }
            if (!item?.id) return
            const { cache: _c, ...rest } = item
            insert.run(item.id, JSON.stringify(rest), i, item.updatedAt || Date.now())
          })
        }
      }

      if (Array.isArray(raw.searchHistory) && raw.searchHistory.length) {
        const count = (
          database.prepare('SELECT COUNT(*) AS n FROM search_history').get() as { n: number }
        ).n
        if (count === 0) {
          const insert = database.prepare(
            'INSERT OR REPLACE INTO search_history (keyword, searched_at) VALUES (?, ?)'
          )
          const now = Date.now()
          raw.searchHistory.forEach((k, i) => {
            if (typeof k === 'string' && k.trim()) insert.run(k.trim(), now - i)
          })
        }
      }

      if (raw.chapterCache && typeof raw.chapterCache === 'object') {
        const insert = database.prepare(
          `INSERT OR IGNORE INTO chapters (book_id, chapter_url, chapter_index, title, content, cached_at)
           VALUES ('__legacy__', ?, NULL, NULL, ?, ?)`
        )
        const now = Date.now()
        for (const [key, content] of Object.entries(raw.chapterCache)) {
          if (!content) continue
          const url = key.startsWith('v2:') ? key.slice(3) : key
          if (url) insert.run(url, content, now)
        }
      }

      setMeta('migrated_electron_store', '1')
    })
    tx()

    if (jsonPath.endsWith('.json') && !jsonPath.endsWith('.bak')) {
      try {
        renameSync(jsonPath, `${jsonPath}.migrated.bak`)
      } catch {
        /* 忽略备份重命名失败 */
      }
    }
  } catch (e) {
    console.error('migrate electron-store failed', e)
  }
}

/**
 * 一次性迁移：将旧版独立 chapters.sqlite 中的行复制到统一库。
 */
function migrateFromLegacyChaptersSqlite(): void {
  if (getMeta('migrated_chapters_sqlite') === '1') return

  const legacyPath = join(app.getPath('userData'), 'chapters.sqlite')
  if (!existsSync(legacyPath)) {
    setMeta('migrated_chapters_sqlite', '1')
    return
  }

  try {
    const legacy = new Database(legacyPath, { readonly: true, fileMustExist: true })
    const rows = legacy
      .prepare(
        'SELECT book_id, chapter_url, chapter_index, title, content, cached_at FROM chapters'
      )
      .all() as {
      book_id: string
      chapter_url: string
      chapter_index: number | null
      title: string | null
      content: string
      cached_at: number
    }[]
    legacy.close()

    const database = getDb()
    const insert = database.prepare(
      `INSERT OR IGNORE INTO chapters (book_id, chapter_url, chapter_index, title, content, cached_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    const tx = database.transaction(() => {
      for (const r of rows) {
        insert.run(
          r.book_id,
          r.chapter_url,
          r.chapter_index,
          r.title,
          r.content,
          r.cached_at
        )
      }
      setMeta('migrated_chapters_sqlite', '1')
    })
    tx()

    try {
      renameSync(legacyPath, `${legacyPath}.migrated.bak`)
    } catch {
      /* 忽略 */
    }
  } catch (e) {
    console.error('migrate chapters.sqlite failed', e)
    setMeta('migrated_chapters_sqlite', '1')
  }
}

/**
 * 关闭数据库连接并清空单例引用。
 */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
