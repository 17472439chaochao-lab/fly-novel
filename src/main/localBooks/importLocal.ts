import { createHash } from 'crypto'
import { basename, extname } from 'path'
import { readFileSync } from 'fs'
import { dialog, BrowserWindow } from 'electron'
import type { Chapter, ShelfBook } from '../../shared/types'
import * as chapterDb from '../chapterDb'
import * as store from '../store'
import { decodeTxtBuffer, splitTxtChapters } from './txtSplit'
import { parseEpubBuffer } from './epubParse'
import { isLocalBook } from '../../shared/bookLocal'

export { isLocalBook }

export type ImportLocalResult =
  | { ok: true; book: ShelfBook; shelf: ShelfBook[]; message: string }
  | { ok: false; message: string }

/**
 * 由文件路径生成稳定的本地书籍 ID。
 * @param filePath - 本地文件绝对路径
 * @returns `local:` 前缀的哈希 ID
 */
function localBookId(filePath: string): string {
  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 20)
  return `local:${hash}`
}

/**
 * 生成本地章节伪 URL。
 * @param bookId - 本地书籍 ID
 * @param index - 章节下标
 * @returns local:// 协议 URL
 */
function chapterUrl(bookId: string, index: number): string {
  return `local://${bookId}/${index}`
}

/**
 * 弹出文件对话框并导入选中的本地书籍。
 * @param win - 父窗口；可为 null
 * @returns 导入结果
 */
export async function importLocalBookDialogAsync(
  win: BrowserWindow | null
): Promise<ImportLocalResult> {
  const opts = {
    title: '打开本地书籍',
    properties: ['openFile' as const],
    filters: [
      { name: '电子书', extensions: ['txt', 'epub'] },
      { name: 'TXT', extensions: ['txt'] },
      { name: 'EPUB', extensions: ['epub'] }
    ]
  }
  const result = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts)
  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, message: '已取消' }
  }
  return importLocalBookAsync(result.filePaths[0])
}

/**
 * 从指定路径导入 TXT/EPUB 到书架并写入章节缓存。
 * @param filePath - 文件路径
 * @returns 导入结果（成功含 book 与 shelf）
 */
export async function importLocalBookAsync(filePath: string): Promise<ImportLocalResult> {
  const ext = extname(filePath).toLowerCase()
  if (ext !== '.txt' && ext !== '.epub') {
    return { ok: false, message: '仅支持 .txt 与 .epub' }
  }

  let buf: Buffer
  try {
    buf = readFileSync(filePath)
  } catch (e) {
    return { ok: false, message: `无法读取文件：${(e as Error).message}` }
  }

  const fileName = basename(filePath, ext)
  const bookId = localBookId(filePath)
  const now = Date.now()

  try {
    if (ext === '.txt') {
      const text = decodeTxtBuffer(buf)
      const parts = splitTxtChapters(text, fileName)
      return persistLocalBook({
        bookId,
        filePath,
        format: 'txt',
        name: fileName,
        author: '佚名',
        parts,
        now
      })
    }

    const meta = await parseEpubBuffer(buf, fileName)
    return persistLocalBook({
      bookId,
      filePath,
      format: 'epub',
      name: meta.title || fileName,
      author: meta.author || '佚名',
      parts: meta.chapters,
      coverUrl: meta.coverDataUrl,
      now
    })
  } catch (e) {
    return { ok: false, message: (e as Error).message || '导入失败' }
  }
}

/**
 * 将解析出的章节写入缓存并 upsert 到书架。
 * @param args - 书籍元数据与章节正文
 * @returns 成功导入结果
 */
function persistLocalBook(args: {
  bookId: string
  filePath: string
  format: 'txt' | 'epub'
  name: string
  author: string
  parts: { title: string; content: string }[]
  coverUrl?: string
  now: number
}): ImportLocalResult {
  const { bookId, filePath, format, name, author, parts, coverUrl, now } = args
  const existing = store.getShelf().find((b) => b.id === bookId)
  const chapters: Chapter[] = parts.map((p, index) => ({
    title: p.title,
    url: chapterUrl(bookId, index),
    index
  }))

  chapterDb.clearBookCache(bookId)
  for (let i = 0; i < parts.length; i++) {
    chapterDb.setChapterContent(bookId, chapters[i].url, parts[i].content || '（空）', {
      index: i,
      title: parts[i].title
    })
  }

  const book: ShelfBook = {
    id: bookId,
    name,
    author,
    bookUrl: filePath,
    coverUrl: coverUrl || undefined,
    origin: 'local',
    originName: '本地',
    kind: format.toUpperCase(),
    lastChapter: chapters[chapters.length - 1]?.title,
    tocUrl: filePath,
    chapters,
    chapterIndex: existing
      ? Math.min(existing.chapterIndex, Math.max(chapters.length - 1, 0))
      : 0,
    scrollTop: existing?.scrollTop ?? 0,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
    lastReadAt: existing?.lastReadAt ?? 0,
    isLocal: true,
    localPath: filePath,
    localFormat: format
  }

  const shelf = store.upsertShelfBook(book)
  return {
    ok: true,
    book,
    shelf,
    message: `已导入《${name}》· ${chapters.length} 章（${format.toUpperCase()}）`
  }
}
