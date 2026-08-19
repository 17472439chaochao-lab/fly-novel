import { nativeImage } from 'electron'
import type { ShelfBook } from '../../shared/types'
import { getDb } from '../db'

/**
 * 封面存储：
 * - `data:` 前缀的封面（EPUB 内嵌、书源返回的 base64 图）若整体塞进 shelf_books.data，
 *   一本书几 MB 的 base64 会让书架 JSON 膨胀，且每次进度补丁都会整本重写。
 * - 因此落库前把 data URL 抽到独立的 book_covers 表（缩略图化后存储），
 *   shelf JSON 里只留一个短哨兵 `flycover://<bookId>`，读取时再还原为 data URL。
 */

/** 持久化在书架 JSON 中的封面哨兵前缀。 */
const COVER_PREFIX = 'flycover://'

/** 封面缩略图最长边像素。 */
const MAX_COVER_SIDE = 300

/** 原图超过该字节数时强制重编码压缩。 */
const FORCE_ENCODE_BYTES = 400_000

/** 内存缓存：bookId -> data URL，避免每次读书架都 base64 解码一遍。 */
const coverCache = new Map<string, string>()

/**
 * 解析 data URL 为 mime 与二进制。
 * @param dataUrl - `data:<mime>[;base64],<payload>` 格式
 * @returns 解析结果；格式非法返回 null
 */
function parseDataUrl(dataUrl: string): { mime: string; buf: Buffer } | null {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl)
  if (!m) return null
  const mime = (m[1] || 'image/jpeg').trim() || 'image/jpeg'
  const isBase64 = Boolean(m[2])
  const payload = m[3]
  if (isBase64) {
    try {
      return { mime, buf: Buffer.from(payload, 'base64') }
    } catch {
      return null
    }
  }
  // 非 base64（URL 编码）payload：解码后按 utf8 收
  try {
    const text = decodeURIComponent(payload)
    return { mime, buf: Buffer.from(text, 'utf8') }
  } catch {
    return null
  }
}

/**
 * 缩略图化封面：超边或超大图重编码，控制库体膨胀。
 * @param buf - 原始图片字节
 * @param mime - 图片 MIME
 * @returns 编码后的 mime 与字节
 */
function downscaleCover(buf: Buffer, mime: string): { mime: string; data: Buffer } {
  const needsEncode = buf.length > FORCE_ENCODE_BYTES
  if (!needsEncode) return { mime, data: buf }

  try {
    const img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) return { mime, data: buf }
    const { width, height } = img.getSize()
    const maxSide = Math.max(width, height)
    let resized = img
    if (maxSide > MAX_COVER_SIDE) {
      const scale = MAX_COVER_SIDE / maxSide
      resized = img.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'good'
      })
    }
    // 带透明通道的格式优先保留 PNG；否则一律 JPEG
    if (/png|gif|webp/i.test(mime)) {
      const png = resized.toPNG()
      if (png.length <= 256_000) return { mime: 'image/png', data: png }
    }
    return { mime: 'image/jpeg', data: resized.toJPEG(82) }
  } catch {
    return { mime, data: buf }
  }
}

/**
 * 持久化封面：data URL 抽取进 book_covers 表并返回可落库的哨兵 URL；
 * 非 data URL（http(s) 等）原样返回；无封面返回 undefined。
 * @param bookId - 书籍 ID
 * @param coverUrl - 原封面 URL
 * @returns 应持久化到书架 JSON 的封面值
 */
export function persistCover(bookId: string, coverUrl: string | undefined): string | undefined {
  if (!bookId || !coverUrl) return undefined
  if (!coverUrl.startsWith('data:')) return coverUrl

  const parsed = parseDataUrl(coverUrl)
  if (!parsed || !parsed.buf.length) return undefined
  const thumb = downscaleCover(parsed.buf, parsed.mime)
  getDb()
    .prepare(
      `INSERT INTO book_covers (book_id, mime, data) VALUES (?, ?, ?)
       ON CONFLICT(book_id) DO UPDATE SET mime = excluded.mime, data = excluded.data`
    )
    .run(bookId, thumb.mime, thumb.data)
  coverCache.delete(bookId)
  return `${COVER_PREFIX}${bookId}`
}

/**
 * 读取某书封面 data URL（优先内存缓存）。
 * @param bookId - 书籍 ID
 * @returns data URL；无封面返回 undefined
 */
export function getCoverDataUrl(bookId: string): string | undefined {
  if (!bookId) return undefined
  const cached = coverCache.get(bookId)
  if (cached) return cached

  const row = getDb()
    .prepare('SELECT mime, data FROM book_covers WHERE book_id = ?')
    .get(bookId) as { mime: string; data: Buffer } | undefined
  if (!row) return undefined
  const dataUrl = `data:${row.mime};base64,${row.data.toString('base64')}`
  coverCache.set(bookId, dataUrl)
  return dataUrl
}

/**
 * 还原书架书封面：哨兵 URL 替换为表中的 data URL（读时展开，库内不留 base64）。
 * @param book - 书架书籍
 * @returns 封面已还原的书籍副本
 */
export function attachCover(book: ShelfBook): ShelfBook {
  const url = book.coverUrl
  if (!url || !url.startsWith(COVER_PREFIX)) return book
  const dataUrl = getCoverDataUrl(book.id)
  if (!dataUrl) return { ...book, coverUrl: undefined }
  return { ...book, coverUrl: dataUrl }
}

/**
 * 删除某书封面记录并失效缓存。
 * @param bookId - 书籍 ID
 */
export function deleteCover(bookId: string): void {
  if (!bookId) return
  coverCache.delete(bookId)
  getDb().prepare('DELETE FROM book_covers WHERE book_id = ?').run(bookId)
}

/**
 * 一次性迁移：把旧版本遗留的 data URL 封面从 shelf_books.data 抽离到 book_covers 表。
 * 仅在启动时调用一次（幂等）。
 * @returns 迁移的书籍数
 */
export function migrateLegacyDataUrlCovers(): number {
  const database = getDb()
  const rows = database
    .prepare("SELECT id, data FROM shelf_books WHERE data LIKE '%data:image%'")
    .all() as { id: string; data: string }[]
  let moved = 0
  const tx = database.transaction(() => {
    for (const row of rows) {
      try {
        const book = JSON.parse(row.data) as ShelfBook
        if (typeof book.coverUrl !== 'string' || !book.coverUrl.startsWith('data:')) continue
        const sentinel = persistCover(book.id, book.coverUrl)
        const next = { ...book }
        if (sentinel) next.coverUrl = sentinel
        else delete next.coverUrl
        database
          .prepare('UPDATE shelf_books SET data = ? WHERE id = ?')
          .run(JSON.stringify(next), row.id)
        moved += 1
      } catch {
        /* 单行损坏跳过 */
      }
    }
  })
  tx()
  return moved
}
