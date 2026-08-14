import type { BookCacheInfo, BookCacheStatus, Chapter } from '../shared/types'
import { getDb } from './db'

/**
 * 初始化章节缓存相关表（确保主库已打开）。
 */
export function initChapterDb(): void {
  getDb()
}

/**
 * 读取章节正文缓存。
 * @param bookId - 书籍 ID；有值时优先按书匹配，否则按 URL 取最新一条
 * @param chapterUrl - 章节 URL
 * @returns 正文内容；未命中返回 undefined
 */
export function getChapterContent(bookId: string | undefined, chapterUrl: string): string | undefined {
  const database = getDb()
  if (bookId) {
    const row = database
      .prepare('SELECT content FROM chapters WHERE book_id = ? AND chapter_url = ?')
      .get(bookId, chapterUrl) as { content: string } | undefined
    if (row?.content) return row.content
  }
  const any = database
    .prepare('SELECT content FROM chapters WHERE chapter_url = ? ORDER BY cached_at DESC LIMIT 1')
    .get(chapterUrl) as { content: string } | undefined
  return any?.content
}

/**
 * 写入或更新章节正文缓存。
 * @param bookId - 书籍 ID
 * @param chapterUrl - 章节 URL
 * @param content - 正文内容
 * @param meta - 可选的章节下标与标题
 */
export function setChapterContent(
  bookId: string,
  chapterUrl: string,
  content: string,
  meta?: { index?: number; title?: string }
): void {
  if (!bookId || !chapterUrl || !content) return
  getDb()
    .prepare(
      `INSERT INTO chapters (book_id, chapter_url, chapter_index, title, content, cached_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(book_id, chapter_url) DO UPDATE SET
         content = excluded.content,
         chapter_index = COALESCE(excluded.chapter_index, chapters.chapter_index),
         title = COALESCE(excluded.title, chapters.title),
         cached_at = excluded.cached_at`
    )
    .run(bookId, chapterUrl, meta?.index ?? null, meta?.title ?? null, content, Date.now())
}

/**
 * 列出某书已缓存的全部章节 URL。
 * @param bookId - 书籍 ID
 * @returns 章节 URL 集合
 */
export function listCachedUrls(bookId: string): Set<string> {
  const rows = getDb()
    .prepare('SELECT chapter_url FROM chapters WHERE book_id = ?')
    .all(bookId) as { chapter_url: string }[]
  return new Set(rows.map((r) => r.chapter_url))
}

/**
 * 统计给定章节 URL 中已缓存的数量（单次读取缓存集合）。
 * @param bookId - 书籍 ID
 * @param chapterUrls - 待检查的章节 URL 列表
 * @returns 已缓存数量
 */
export function countCachedChapters(bookId: string, chapterUrls: string[]): number {
  if (!bookId || !chapterUrls.length) return 0
  const cached = listCachedUrls(bookId)
  let n = 0
  for (const url of chapterUrls) {
    if (url && cached.has(url)) n += 1
  }
  return n
}

/**
 * 根据总章数与已缓存数推导缓存状态。
 * @param total - 可读章节总数
 * @param cached - 已缓存数量
 * @returns none / partial / full
 */
function statusFromCounts(total: number, cached: number): BookCacheStatus {
  if (total <= 0 || cached <= 0) return 'none'
  if (cached >= total) return 'full'
  return 'partial'
}

/**
 * 获取某书的缓存概况。
 * @param bookId - 书籍 ID
 * @param chapters - 可选目录；用于计算可读章总数
 * @returns 含总数、已缓存数与状态的缓存信息
 */
export function getBookCacheInfo(bookId: string, chapters?: Chapter[]): BookCacheInfo {
  const readable = (chapters || []).filter((c) => c.url && !c.isVolume)
  const total = readable.length
  const cached = countCachedChapters(
    bookId,
    readable.map((c) => c.url)
  )
  return {
    bookId,
    total,
    cached,
    status: statusFromCounts(total, cached)
  }
}

/**
 * 清除某书的全部章节缓存。
 * @param bookId - 书籍 ID
 * @returns 删除的行数
 */
export function clearBookCache(bookId: string): number {
  const result = getDb().prepare('DELETE FROM chapters WHERE book_id = ?').run(bookId)
  return result.changes
}
