import { promises as fsp } from 'fs'
import { basename } from 'path'
import { BrowserWindow, dialog } from 'electron'
import type { Chapter, ShelfBook } from '../../shared/types'
import { APP_ABOUT } from '../../shared/about'
import { authorName } from '../../shared/author'
import { ensureNovelParagraphs } from '../../shared/novelText'
import * as chapterDb from '../chapterDb'
import * as store from '../store'
import { getBookInfo, getChapterList, getContent } from '../legado/engine'
import { mapPool, withTimeout } from '../asyncPool'
import { isLocalBook } from './importLocal'

export type ExportTxtResult =
  | { ok: true; message: string; path: string; exported: number; total: number }
  | { ok: false; message: string }

/**
 * 将书名清理为适合文件系统的文件名。
 * @param name - 原始书名
 * @returns 安全文件名片段
 */
function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || '未命名'
  )
}

/**
 * 生成导出文件中的开源署名行。
 * @returns 署名文案
 */
function exportCreditLine(): string {
  return `开源电子书阅读软件${APP_ABOUT.name}，Git地址${APP_ABOUT.repo}`
}

/**
 * 将书架上的在线书籍导出为 TXT（缺章时尝试按书源拉取）。
 * @param bookId - 书架书籍 ID
 * @param win - 父窗口；可为 null
 * @param opts - 提供按 origin 查找书源的回调
 * @returns 导出结果
 */
export async function exportShelfBookToTxt(
  bookId: string,
  win: BrowserWindow | null,
  opts: {
    findSource: (origin: string) => import('../../shared/types').BookSource | undefined
  }
): Promise<ExportTxtResult> {
  const book = store.getShelf().find((b) => b.id === bookId)
  if (!book) return { ok: false, message: '书架中未找到该书' }
  if (isLocalBook(book)) return { ok: false, message: '本地书籍请直接使用原文件' }

  let working: ShelfBook = book
  const source = opts.findSource(book.origin)

  if (!working.chapters?.length) {
    if (!source) return { ok: false, message: '书源不存在，且没有目录，无法导出' }
    try {
      const info = await withTimeout(getBookInfo(source, working.bookUrl), 15000, '获取书籍信息超时')
      const tocUrl = info.tocUrl || working.tocUrl || working.bookUrl
      const chapters = await withTimeout(getChapterList(source, tocUrl), 20000, '获取目录超时')
      working = {
        ...working,
        name: info.name || working.name,
        author: info.author || working.author,
        tocUrl,
        chapters,
        updatedAt: Date.now()
      }
      store.upsertShelfBook(working)
    } catch (e) {
      return { ok: false, message: `获取目录失败：${(e as Error).message}` }
    }
  }

  const chapters = (working.chapters || []).filter((c) => c.url && !c.isVolume)
  if (!chapters.length) return { ok: false, message: '没有可导出的章节' }

  const defaultName = `${sanitizeFileName(working.name)}.txt`
  const saveOpts = {
    title: '导出为 TXT',
    defaultPath: defaultName,
    filters: [{ name: '文本文件', extensions: ['txt'] }]
  }
  const save = win
    ? await dialog.showSaveDialog(win, saveOpts)
    : await dialog.showSaveDialog(saveOpts)
  if (save.canceled || !save.filePath) return { ok: false, message: '已取消' }

  const contents = new Map<string, string>()
  const missing: Chapter[] = []
  for (const ch of chapters) {
    const cached = chapterDb.getChapterContent(working.id, ch.url)
    if (cached?.trim()) contents.set(ch.url, ensureNovelParagraphs(cached))
    else missing.push(ch)
  }

  if (missing.length) {
    if (!source) {
      /* 无书源则仅导出已有缓存 */
    } else {
      await mapPool(missing, store.getRequestConcurrency(), async (ch) => {
        try {
          const text = await withTimeout(getContent(source, ch.url), 15000, '章节超时')
          if (text?.trim()) {
            const normalized = ensureNovelParagraphs(text)
            contents.set(ch.url, normalized)
            chapterDb.setChapterContent(working.id, ch.url, normalized, {
              index: ch.index,
              title: ch.title
            })
          }
        } catch {
          /* 跳过失败章节 */
        }
      })
    }
  }

  const credit = exportCreditLine()
  const lines: string[] = []
  lines.push(working.name)
  lines.push(`作者：${authorName(working.author)}`)
  lines.push(credit)
  lines.push('')
  lines.push(''.padEnd(24, '—'))
  lines.push('')

  let exported = 0
  for (const ch of chapters) {
    const body = contents.get(ch.url)
    lines.push(ch.title || `第 ${ch.index + 1} 章`)
    lines.push('')
    if (body) {
      lines.push(body)
      exported += 1
    } else {
      lines.push('（本章未能获取正文）')
    }
    lines.push('')
    lines.push('')
  }

  lines.push(''.padEnd(24, '—'))
  lines.push('')
  lines.push(working.name)
  lines.push(`作者：${authorName(working.author)}`)
  lines.push(credit)

  const text = lines.join('\n').replace(/\n{4,}/g, '\n\n\n')
  const payload = `\uFEFF${text}`
  try {
    await fsp.writeFile(save.filePath, payload, 'utf8')
  } catch (e) {
    return { ok: false, message: `写入失败：${(e as Error).message}` }
  }

  const file = basename(save.filePath)
  return {
    ok: true,
    path: save.filePath,
    exported,
    total: chapters.length,
    message:
      exported === chapters.length
        ? `已导出《${working.name}》· ${exported} 章 → ${file}`
        : `已导出《${working.name}》· ${exported}/${chapters.length} 章（部分章节未获取到）→ ${file}`
  }
}
