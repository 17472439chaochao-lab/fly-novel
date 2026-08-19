import { parentPort, workerData } from 'node:worker_threads'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import Database from 'better-sqlite3'
import type { Chapter, ShelfBook } from '../../shared/types'
import { decodeTxtBuffer, splitTxtChapters } from './txtSplit'
import type { SplitChapter } from './txtSplit'
import { parseEpubBuffer } from './epubParse'
import { chapterUrl, localBookId } from './bookIds'

/**
 * 本地书籍导入 worker。
 *
 * 大文件（几十 MB 的 TXT/EPUB）的读取、编码探测、切章与逐章写库都是重活，
 * 若全部在主进程同步执行会冻结 UI。这里把整条导入流水线放进独立 worker 线程：
 * - readFileSync / iconv 解码 / 正则切章 / JSZip 解压都在 worker 内（阻塞只影响 worker）
 * - 章节写库用 worker 自己的 better-sqlite3 连接 + 单事务批量提交
 * - 不依赖 electron 模块（worker 线程环境更受限），DB 路径由主进程传入
 *
 * 主进程收到结果后再做书架 upsert（封面 data URL 在那一层剥离进 book_covers 表）。
 */

export type ImportWorkerResult =
  | { ok: true; book: ShelfBook; message: string }
  | { ok: false; message: string }

type WorkerPayload = {
  filePath: string
  dbPath: string
}

/**
 * worker 主流程：读取 → 解析 → 写章节缓存 → 回传书籍对象。
 */
async function runImport(): Promise<void> {
  const post = (msg: ImportWorkerResult): void => parentPort?.postMessage(msg)
  const { filePath, dbPath } = workerData as WorkerPayload

  try {
    if (!filePath || !dbPath) throw new Error('缺少导入参数')
    const ext = extname(filePath).toLowerCase()
    if (ext !== '.txt' && ext !== '.epub') throw new Error('仅支持 .txt 与 .epub')

    const buf = readFileSync(filePath)
    const fileName = basename(filePath, ext)
    const bookId = localBookId(filePath)
    const now = Date.now()

    let name: string
    let author: string
    let parts: SplitChapter[]
    let coverUrl: string | undefined
    if (ext === '.txt') {
      const text = decodeTxtBuffer(buf)
      parts = splitTxtChapters(text, fileName)
      name = fileName
      author = '佚名'
    } else {
      const meta = await parseEpubBuffer(buf, fileName)
      parts = meta.chapters
      name = meta.title || fileName
      author = meta.author || '佚名'
      coverUrl = meta.coverDataUrl
    }

    const chapters: Chapter[] = parts.map((p, index) => ({
      title: p.title,
      url: chapterUrl(bookId, index),
      index
    }))

    writeChapters(dbPath, bookId, parts)

    const book: ShelfBook = {
      id: bookId,
      name,
      author,
      bookUrl: filePath,
      coverUrl,
      origin: 'local',
      originName: '本地',
      kind: ext === '.txt' ? 'TXT' : 'EPUB',
      lastChapter: chapters[chapters.length - 1]?.title,
      tocUrl: filePath,
      chapters,
      chapterIndex: 0,
      scrollTop: 0,
      addedAt: now,
      updatedAt: now,
      lastReadAt: 0,
      isLocal: true,
      localPath: filePath,
      localFormat: ext === '.txt' ? 'txt' : 'epub'
    }

    post({
      ok: true,
      book,
      message: `已导入《${name}》· ${chapters.length} 章（${ext.slice(1).toUpperCase()}）`
    })
  } catch (e) {
    post({ ok: false, message: (e as Error).message || '导入失败' })
  }
}

/**
 * 用 worker 自有的 DB 连接把章节正文批量写入 chapters 表（单事务）。
 * @param dbPath - SQLite 文件路径（主进程传入）
 * @param bookId - 本地书籍 ID
 * @param parts - 解析出的章节列表
 */
function writeChapters(dbPath: string, bookId: string, parts: SplitChapter[]): void {
  if (!existsSync(dbPath)) throw new Error('数据库尚未初始化')
  const database = new Database(dbPath)
  try {
    database.pragma('busy_timeout = 5000')
    const remove = database.prepare('DELETE FROM chapters WHERE book_id = ?')
    const insert = database.prepare(
      `INSERT INTO chapters (book_id, chapter_url, chapter_index, title, content, cached_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(book_id, chapter_url) DO UPDATE SET
         content = excluded.content,
         chapter_index = COALESCE(excluded.chapter_index, chapters.chapter_index),
         title = COALESCE(excluded.title, chapters.title),
         cached_at = excluded.cached_at`
    )
    const cachedAt = Date.now()
    database.transaction(() => {
      remove.run(bookId)
      parts.forEach((p, index) => {
        insert.run(bookId, chapterUrl(bookId, index), index, p.title, p.content || '（空）', cachedAt)
      })
    })()
  } finally {
    database.close()
  }
}

runImport()
