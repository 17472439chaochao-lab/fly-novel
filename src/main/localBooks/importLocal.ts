import { Worker } from 'node:worker_threads'
import { extname, join } from 'path'
import { promises as fsp } from 'fs'
import { app, BrowserWindow, dialog } from 'electron'
import type { ShelfBook } from '../../shared/types'
import * as store from '../store'
import { isLocalBook } from '../../shared/bookLocal'
import type { ImportWorkerResult } from './importWorker'

export { isLocalBook }

export type ImportLocalResult =
  | { ok: true; book: ShelfBook; shelf: ShelfBook[]; message: string }
  | { ok: false; message: string }

/** 导入文件大小上限：再大说明不是正常电子书，直接拒绝。 */
const MAX_IMPORT_BYTES = 512 * 1024 * 1024

/** 导入 worker 超时上限（解析大文件主要在 worker 内进行）。 */
const IMPORT_TIMEOUT_MS = 5 * 60 * 1000

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
 * 在独立 worker 线程中执行解析与章节落库，避免大文件阻塞主进程。
 * @param filePath - 文件路径
 * @param dbPath - SQLite 数据库路径（与主库同一文件）
 * @returns worker 解析结果
 */
function runImportWorker(filePath: string, dbPath: string): Promise<ImportWorkerResult> {
  return new Promise((resolve) => {
    const worker = new Worker(join(__dirname, 'importWorker.js'), {
      workerData: { filePath, dbPath }
    })
    let settled = false
    const finish = (msg: ImportWorkerResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(msg)
    }
    const timer = setTimeout(
      () => finish({ ok: false, message: '导入超时，请检查文件是否损坏' }),
      IMPORT_TIMEOUT_MS
    )
    worker.once('message', (msg: ImportWorkerResult) => finish(msg))
    worker.once('error', (err) =>
      finish({ ok: false, message: `导入失败：${err.message}` })
    )
    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        finish({ ok: false, message: '导入进程异常退出' })
      }
    })
  })
}

/**
 * 从指定路径导入 TXT/EPUB 到书架并写入章节缓存。
 * 读取/解码/切章/写库全部在 worker 线程完成，主进程只做书架 upsert。
 * @param filePath - 文件路径
 * @returns 导入结果（成功含 book 与 shelf）
 */
export async function importLocalBookAsync(filePath: string): Promise<ImportLocalResult> {
  const ext = extname(filePath).toLowerCase()
  if (ext !== '.txt' && ext !== '.epub') {
    return { ok: false, message: '仅支持 .txt 与 .epub' }
  }

  try {
    const stat = await fsp.stat(filePath)
    if (!stat.isFile()) return { ok: false, message: '不是有效文件' }
    if (stat.size > MAX_IMPORT_BYTES) {
      return { ok: false, message: '文件超过 512MB，暂不支持导入' }
    }
  } catch (e) {
    return { ok: false, message: `无法读取文件：${(e as Error).message}` }
  }

  const dbPath = join(app.getPath('userData'), 'fly-novel.sqlite')
  const result = await runImportWorker(filePath, dbPath)
  if (!result.ok) return result

  // 主进程合并既有阅读进度字段，再落库（封面 data URL 在 store 层剥离进 book_covers 表）
  const existing = store.getShelf().find((b) => b.id === result.book.id)
  const lastIndex = Math.max((result.book.chapters?.length ?? 0) - 1, 0)
  const book: ShelfBook = {
    ...result.book,
    chapterIndex: existing ? Math.min(existing.chapterIndex, lastIndex) : 0,
    scrollTop: existing?.scrollTop ?? 0,
    addedAt: existing?.addedAt ?? result.book.addedAt,
    updatedAt: Date.now(),
    lastReadAt: existing?.lastReadAt ?? 0
  }
  const shelf = store.upsertShelfBook(book)
  const attached = shelf.find((b) => b.id === book.id)
  return {
    ok: true,
    book: attached ?? book,
    shelf,
    message: result.message
  }
}
