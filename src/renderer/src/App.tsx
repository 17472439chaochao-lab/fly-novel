import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { filterChangeSourceCandidates, filterRelevantSearchHits, dedupeSearchBooks } from '../../shared/searchRelevance'
import { authorLabel } from '../../shared/author'
import { isLocalBook } from '../../shared/bookLocal'
import { matchChapterIndex } from '../../shared/matchChapter'
import {
  DEFAULT_PREFS,
  DEFAULT_SETTINGS,
  type AppPrefs,
  type BookSource,
  type Chapter,
  type ReaderSettings,
  type SearchBook,
  type SearchProgress,
  type ShelfBook,
  type ViewName
} from '../../shared/types'
import { ConfirmDialog, type ConfirmOutcome, type ConfirmRequest } from './components/ConfirmDialog'
import { IconClose, LoadingIcon } from './components/icons'
import { AboutView } from './views/AboutView'
import { ReaderView } from './views/ReaderView'
import { SearchView } from './views/SearchView'
import { SettingsView } from './views/SettingsView'
import { ShelfView } from './views/ShelfView'
import { SourcesView } from './views/SourcesView'
import {
  findSameNovelSearchAlts,
  findShelfDuplicates
} from './utils/shelfMatch'

/**
 * 由书源 origin 与书籍 URL 生成书架唯一 ID
 * @param origin 书源标识
 * @param bookUrl 书籍详情 URL
 */
function bookId(origin: string, bookUrl: string): string {
  return `${origin}::${bookUrl}`
}

/**
 * 应用根组件：管理导航、书架、搜索、书源、设置、阅读与换源等全局状态与 IPC 交互。
 */
export default function App() {
  const [view, setView] = useState<ViewName>('shelf')
  const [sources, setSources] = useState<BookSource[]>([])
  const [shelf, setShelf] = useState<ShelfBook[]>([])
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS)
  const [prefs, setPrefs] = useState<AppPrefs>(DEFAULT_PREFS)
  const [toast, setToast] = useState('')
  const [keyword, setKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchProgress, setSearchProgress] = useState<SearchProgress | null>(null)
  const [results, setResults] = useState<SearchBook[]>([])
  const [searchHistory, setSearchHistory] = useState<string[]>([])
  const [reading, setReading] = useState<ShelfBook | null>(null)
  const readingRef = useRef<ShelfBook | null>(null)
  readingRef.current = reading
  const searchGenRef = useRef(0)
  const chapterLoadGenRef = useRef(0)
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [content, setContent] = useState('')
  const [loadingContent, setLoadingContent] = useState(false)
  const [shelfBusyId, setShelfBusyId] = useState<string | null>(null)
  const [shelfUpdatingAll, setShelfUpdatingAll] = useState(false)
  const [shelfUpdateProgress, setShelfUpdateProgress] = useState('')
  const [cacheBusyId, setCacheBusyId] = useState<string | null>(null)
  const [cacheProgress, setCacheProgress] = useState('')
  const pendingExportRef = useRef<{ id: string; name: string } | null>(null)
  const [readerCacheTick, setReaderCacheTick] = useState(0)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [changeSource, setChangeSource] = useState<{
    book: ShelfBook
    searching: boolean
    applying: boolean
    candidates: SearchBook[]
    progress: SearchProgress | null
  } | null>(null)
  const changeSourceGenRef = useRef(0)
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)

  /** 显示短暂 Toast 提示（约 2.8 秒后自动消失） */
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(''), 2800)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  /** 弹出确认对话框并返回用户选择结果 */
  const askConfirm = useCallback(
    (opts: {
      title: string
      message: string
      confirmText?: string
      cancelText?: string
      extraText?: string
      danger?: boolean
    }) =>
      new Promise<ConfirmOutcome>((resolve) => {
        setConfirmReq({ ...opts, resolve })
      }),
    []
  )

  /**
   * 关闭确认对话框并 resolve 结果
   * @param result 用户选择：确认 / 取消 / 额外操作
   */
  const closeConfirm = useCallback((result: ConfirmOutcome) => {
    setConfirmReq((prev: ConfirmRequest | null) => {
      prev?.resolve(result)
      return null
    })
  }, [])

  /**
   * 切换主界面视图；非阅读页时持久化 lastView
   * @param next 目标视图名
   */
  const goView = useCallback((next: ViewName) => {
    setView(next)
    if (next !== 'reader') {
      void window.fly.prefs.save({ lastView: next }).then((r) => setPrefs(r.prefs))
    }
  }, [])

  useEffect(() => {
    const theme = settings.theme || 'paper'
    document.documentElement.classList.remove('theme-paper', 'theme-green', 'theme-night')
    document.documentElement.classList.add(`theme-${theme}`)
  }, [settings.theme])

  useEffect(() => {
    void (async () => {
      const state = await window.fly.getState()
      setSources(state.sources)
      setShelf(state.shelf)
      setSettings(state.settings)
      setPrefs(state.prefs || DEFAULT_PREFS)
      if (state.prefs?.lastView) setView(state.prefs.lastView)
      setSearchHistory(await window.fly.books.history())
    })()
  }, [])

  /**
   * 导出指定书籍为 TXT 文件并刷新书架
   * @param bookId 书籍 ID
   * @param bookName 可选书名（用于 Toast）
   */
  const runExportTxt = useCallback(async (bookId: string, bookName?: string) => {
    showToast(`正在导出${bookName ? `《${bookName}》` : ''}…`)
    try {
      const r = await window.fly.shelf.exportTxt(bookId)
      if (r.ok) {
        setShelf(await window.fly.shelf.list())
        showToast(r.message)
      } else if (r.message !== '已取消') {
        showToast(r.message)
      }
    } catch (e) {
      showToast(`导出失败：${(e as Error).message}`)
    }
  }, [showToast])

  useEffect(() => {
    const off = window.fly.shelf.onCacheProgress((p) => {
      if (p.phase === 'start' || p.phase === 'progress') {
        setCacheBusyId(p.bookId)
        setCacheProgress(
          p.total > 0 ? `${p.cached ?? p.done}/${p.total}` : `${p.done}/${p.total}`
        )
        setShelf((prev) =>
          prev.map((b) =>
            b.id === p.bookId
              ? {
                  ...b,
                  cache: {
                    bookId: p.bookId,
                    total: p.total,
                    cached: p.cached ?? b.cache?.cached ?? 0,
                    status: 'caching'
                  }
                }
              : b
          )
        )
      } else {
        setCacheBusyId(null)
        setCacheProgress('')
        const pending = pendingExportRef.current
        if (pending && pending.id === p.bookId) {
          pendingExportRef.current = null
          if (p.phase === 'cancelled') {
            showToast('已取消缓存，导出已中止')
          } else {
            void runExportTxt(p.bookId, pending.name)
          }
        }
        void window.fly.shelf.list().then(setShelf)
      }
    })
    return () => {
      off()
    }
  }, [showToast, runExportTxt])

  const enabledCount = useMemo(
    () => sources.filter((s) => s.enabled !== false).length,
    [sources]
  )

  /** 通过系统文件选择器导入书源 */
  async function onImportFile() {
    const res = await window.fly.sources.importFile()
    showToast(res.message)
    if (res.ok && res.sources) setSources(res.sources)
  }

  /**
   * 执行多书源并发搜索（支持进度与中间结果流式更新）
   * @param raw 可选关键词；缺省使用当前输入框内容
   */
  async function runSearch(raw?: string) {
    const key = (raw ?? keyword).trim()
    if (!key || searching) return
    if (!enabledCount) {
      showToast('请先导入并启用书源')
      goView('sources')
      return
    }
    const gen = ++searchGenRef.current
    setKeyword(key)
    setSearching(true)
    setResults([])
    setSearchProgress({
      done: 0,
      total: enabledCount,
      found: 0,
      current: '',
      phase: 'start'
    })
    const offProgress = window.fly.books.onSearchProgress((p) => {
      if (gen !== searchGenRef.current) return
      setSearchProgress(p)
    })
    const offPartial = window.fly.books.onSearchPartial((books) => {
      if (gen !== searchGenRef.current) return
      const filtered = filterRelevantSearchHits(key, books)
      if (!filtered.length) return
      setResults((prev) => dedupeSearchBooks(prev.concat(filtered)))
    })
    try {
      const { books, history, sources: nextSources } = await window.fly.books.search(key)
      if (gen !== searchGenRef.current) return
      const cleaned = dedupeSearchBooks(filterRelevantSearchHits(key, books))
      setResults(cleaned)
      setSearchHistory(history)
      if (nextSources?.length) setSources(nextSources)
      else {
        const latest = await window.fly.sources.list()
        setSources(latest)
      }
      if (!cleaned.length) showToast('未搜索到结果，可换个书源或关键词')
      else showToast(`搜索完成，共 ${cleaned.length} 条结果`)
    } catch (e) {
      if (gen !== searchGenRef.current) return
      showToast(`搜索失败：${(e as Error).message}`)
    } finally {
      offProgress()
      offPartial()
      if (gen === searchGenRef.current) {
        setSearching(false)
        setSearchProgress(null)
      }
    }
  }

  /** 确认后清空全部搜索历史 */
  async function clearSearchHistory() {
    if (!searchHistory.length) return
    const result = await askConfirm({
      title: '清空搜索历史',
      message: `将清除全部 ${searchHistory.length} 条搜索记录，此操作不可撤销。`,
      confirmText: '清空',
      danger: true
    })
    if (result !== 'confirm') return
    setSearchHistory(await window.fly.books.clearHistory())
    showToast('已清空搜索历史')
  }

  /**
   * 确认后删除单条搜索历史
   * @param keyword 要删除的关键词
   */
  async function removeSearchHistoryItem(keyword: string) {
    const result = await askConfirm({
      title: '删除搜索记录',
      message: `确定删除搜索历史「${keyword}」？`,
      confirmText: '删除',
      danger: true
    })
    if (result !== 'confirm') return
    setSearchHistory(await window.fly.books.removeHistory(keyword))
  }

  /**
   * 将搜索结果加入书架；若存在同名书可选择换源或仍添加
   * @param book 搜索命中的书籍
   */
  async function addToShelf(book: SearchBook) {
    const id = bookId(book.origin, book.bookUrl)
    if (shelf.some((b) => b.id === id)) {
      showToast(`《${book.name}》已在书架`)
      return
    }

    const dups = findShelfDuplicates(shelf, book)
      .filter((b) => b.id !== id)
      .slice()
      .sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))

    if (dups.length) {
      const existing = dups[0]
      const more =
        dups.length > 1 ? `\n（书架上另有 ${dups.length - 1} 个同名源）` : ''
      const action = await askConfirm({
        title: '已在书架',
        message: `《${book.name}》已在书架（当前源：${existing.originName || '未知'}）。\n是否换到「${book.originName || '未知'}」？${more}`,
        confirmText: '仍然添加',
        cancelText: '取消',
        extraText: '换到此源'
      })
      if (action === 'cancel') return
      if (action === 'extra') {
        showToast('正在换源…')
        try {
          await replaceShelfWithSearchBook(existing, book)
          showToast(`已换源到「${book.originName}」`)
        } catch (e) {
          showToast(`换源失败：${(e as Error).message}`)
        }
        return
      }
      // 确认 → 仍作为独立书架条目添加
    }

    const now = Date.now()
    const item: ShelfBook = {
      id,
      name: book.name,
      author: book.author,
      bookUrl: book.bookUrl,
      coverUrl: book.coverUrl,
      intro: book.intro,
      kind: book.kind,
      lastChapter: book.lastChapter,
      origin: book.origin,
      originName: book.originName,
      chapterIndex: 0,
      scrollTop: 0,
      addedAt: now,
      updatedAt: now,
      lastReadAt: 0
    }
    const next = await window.fly.shelf.upsert(item)
    setShelf(next)
    showToast(`已加入书架：${book.name}`)
  }

  /**
   * 用搜索命中替换书架已有书籍（换源），尽量匹配原阅读章节
   * @param old 原书架书籍
   * @param candidate 新书源搜索命中
   */
  async function replaceShelfWithSearchBook(old: ShelfBook, candidate: SearchBook) {
    setShelfBusyId(old.id)
    try {
      const info = await window.fly.books.info(candidate.origin, candidate.bookUrl)
      const tocUrl = info.tocUrl || candidate.bookUrl
      const list = await window.fly.books.toc(candidate.origin, tocUrl)
      if (!list.filter((c: Chapter) => c.url && !c.isVolume).length) {
        throw new Error('无法获取目录')
      }
      const newBook: ShelfBook = {
        ...old,
        id: bookId(candidate.origin, candidate.bookUrl),
        name: info.name || candidate.name || old.name,
        author: info.author || candidate.author || old.author,
        bookUrl: candidate.bookUrl,
        coverUrl: info.coverUrl || candidate.coverUrl || old.coverUrl,
        intro: info.intro || candidate.intro || old.intro,
        kind: info.kind || candidate.kind || old.kind,
        lastChapter: info.lastChapter || candidate.lastChapter,
        origin: candidate.origin,
        originName: candidate.originName,
        tocUrl,
        chapters: list,
        chapterIndex: matchChapterIndex(old, list),
        updatedAt: Date.now()
      }
      await window.fly.shelf.remove(old.id)
      const next = await window.fly.shelf.upsert(newBook)
      setShelf(next)
      if (candidate.origin) {
        setSources(await window.fly.sources.list())
      }
      return newBook
    } finally {
      setShelfBusyId(null)
    }
  }

  /**
   * 更新单本在线书籍的详情与目录
   * @param book 书架书籍
   */
  async function updateShelfBook(book: ShelfBook) {
    if (isLocalBook(book)) {
      showToast('本地书籍无需更新')
      return
    }
    if (shelfBusyId || shelfUpdatingAll) return
    setShelfBusyId(book.id)
    try {
      const info = await window.fly.books.info(book.origin, book.bookUrl)
      const tocUrl = info.tocUrl || book.tocUrl || book.bookUrl
      const list = await window.fly.books.toc(book.origin, tocUrl)
      const updated: ShelfBook = {
        ...book,
        name: info.name || book.name,
        author: info.author || book.author,
        coverUrl: info.coverUrl || book.coverUrl,
        intro: info.intro || book.intro,
        lastChapter: info.lastChapter || book.lastChapter,
        tocUrl,
        chapters: list,
        chapterIndex: matchChapterIndex(book, list),
        updatedAt: Date.now()
      }
      const next = await window.fly.shelf.upsert(updated)
      setShelf(next)
      const added = Math.max(0, list.length - (book.chapters?.length || 0))
      showToast(
        added > 0
          ? `《${updated.name}》已更新，新增 ${added} 章（共 ${list.length} 章）`
          : `《${updated.name}》已更新，共 ${list.length} 章`
      )
    } catch (e) {
      showToast(`更新失败：${(e as Error).message}`)
    } finally {
      setShelfBusyId(null)
    }
  }

  /** 批量更新书架上全部在线书籍 */
  async function updateAllShelfBooks() {
    if (!shelf.length || shelfUpdatingAll || shelfBusyId) return
    setShelfUpdatingAll(true)
    setShelfUpdateProgress(`0/${shelf.length}`)
    const off = window.fly.shelf.onUpdateProgress((p) => {
      setShelfUpdateProgress(
        p.phase === 'done' ? '完成' : `${p.done}/${p.total}${p.current ? ` · ${p.current}` : ''}`
      )
    })
    try {
      const next = await window.fly.shelf.updateAll()
      setShelf(next)
      showToast(`书架更新完成（${next.length} 本）`)
    } catch (e) {
      showToast(`全部更新失败：${(e as Error).message}`)
    } finally {
      off()
      setShelfUpdatingAll(false)
      setShelfUpdateProgress('')
    }
  }

  /**
   * 打开换源对话框并搜索同名其他书源
   * @param book 当前书架书籍
   */
  async function openChangeSource(book: ShelfBook) {
    if (isLocalBook(book)) {
      showToast('本地书籍不支持换源')
      return
    }
    if (!enabledCount) {
      showToast('请先导入并启用书源')
      goView('sources')
      return
    }
    const gen = ++changeSourceGenRef.current
    setChangeSource({
      book,
      searching: true,
      applying: false,
      candidates: [],
      progress: { done: 0, total: enabledCount, found: 0, current: '', phase: 'start' }
    })

    /** 将中间搜索命中合并进换源候选列表（去重且排除当前源） */
    const mergeHits = (books: SearchBook[]) => {
      const filtered = filterChangeSourceCandidates(book, books).filter(
        (b) => !(b.origin === book.origin && b.bookUrl === book.bookUrl)
      )
      if (!filtered.length) return
      setChangeSource((prev) => {
        if (!prev || prev.book.id !== book.id || gen !== changeSourceGenRef.current) return prev
        const seen = new Set(prev.candidates.map((c) => `${c.origin}::${c.bookUrl}`))
        const next = prev.candidates.slice()
        for (const b of filtered) {
          const id = `${b.origin}::${b.bookUrl}`
          if (seen.has(id)) continue
          seen.add(id)
          next.push(b)
        }
        return { ...prev, candidates: next }
      })
    }

    const offProgress = window.fly.books.onSearchProgress((p) => {
      if (gen !== changeSourceGenRef.current) return
      setChangeSource((prev) =>
        prev && prev.book.id === book.id ? { ...prev, progress: p } : prev
      )
    })
    const offPartial = window.fly.books.onSearchPartial((books) => {
      if (gen !== changeSourceGenRef.current) return
      mergeHits(books)
    })

    try {
      const { books } = await window.fly.books.search(book.name)
      if (gen !== changeSourceGenRef.current) return
      const candidates = filterChangeSourceCandidates(book, books).filter(
        (b) => !(b.origin === book.origin && b.bookUrl === book.bookUrl)
      )
      setChangeSource({
        book,
        searching: false,
        applying: false,
        candidates,
        progress: null
      })
      if (!candidates.length) showToast('未找到可换的其他书源')
    } catch (e) {
      if (gen !== changeSourceGenRef.current) return
      setChangeSource(null)
      showToast(`换源搜索失败：${(e as Error).message}`)
    } finally {
      offProgress()
      offPartial()
    }
  }

  /**
   * 将换源对话框中选中的候选应用到书架
   * @param candidate 选中的搜索命中
   */
  async function applyChangeSource(candidate: SearchBook) {
    if (!changeSource || changeSource.applying) return
    const old = changeSource.book
    changeSourceGenRef.current += 1
    setChangeSource({
      ...changeSource,
      searching: false,
      applying: true,
      progress: null
    })
    try {
      await replaceShelfWithSearchBook(old, candidate)
      setChangeSource(null)
      showToast(`已换源到「${candidate.originName}」`)
    } catch (e) {
      setChangeSource((prev) =>
        prev
          ? { ...prev, searching: false, applying: false, progress: null }
          : null
      )
      showToast(`换源失败：${(e as Error).message}`)
    }
  }

  /** 关闭换源对话框（换源进行中时忽略） */
  function closeChangeSource() {
    if (changeSource?.applying) return
    changeSourceGenRef.current += 1
    setChangeSource(null)
  }

  /**
   * 打开书架书籍进入阅读：拉取目录与正文，失败时可移除或换源
   * @param book 书架书籍
   */
  async function openBook(book: ShelfBook) {
    const openedAt = Date.now()
    const withRead: ShelfBook = { ...book, lastReadAt: openedAt, updatedAt: openedAt }
    setReading(withRead)
    setView('reader')
    setContent('')
    setChapters(book.chapters || [])
    setLoadingContent(true)
    try {
      let tocUrl = book.tocUrl || book.bookUrl
      let infoChapters = book.chapters
      const isLocal = isLocalBook(book)
      if (!infoChapters?.length && !isLocal) {
        try {
          const info = await window.fly.books.info(book.origin, book.bookUrl)
          tocUrl = info.tocUrl || book.bookUrl
          infoChapters = await window.fly.books.toc(book.origin, tocUrl)
          const updated: ShelfBook = {
            ...withRead,
            name: info.name || book.name,
            author: info.author || book.author,
            coverUrl: info.coverUrl || book.coverUrl,
            intro: info.intro || book.intro,
            tocUrl,
            chapters: infoChapters,
            lastReadAt: openedAt,
            updatedAt: Date.now()
          }
          const next = await window.fly.shelf.upsert(updated)
          setShelf(next)
          setReading(updated)
          setChapters(infoChapters || [])
          book = updated
        } catch (infoErr) {
          // 详情规则可能损坏；仍用详情 URL 尝试拉目录
          try {
            infoChapters = await window.fly.books.toc(book.origin, book.bookUrl)
            if (!infoChapters?.length) throw infoErr
            const updated: ShelfBook = {
              ...withRead,
              tocUrl: book.bookUrl,
              chapters: infoChapters,
              lastReadAt: openedAt,
              updatedAt: Date.now()
            }
            const next = await window.fly.shelf.upsert(updated)
            setShelf(next)
            setReading(updated)
            setChapters(infoChapters)
            book = updated
          } catch {
            throw infoErr
          }
        }
      } else {
        const next = await window.fly.shelf.upsert(withRead)
        setShelf(next)
        book = withRead
      }
      if (!book.chapters?.length) {
        throw new Error(isLocal ? '本地书籍没有章节，请重新导入' : '无法获取目录')
      }

      const idx = Math.min(book.chapterIndex, Math.max((book.chapters?.length || 1) - 1, 0))
      await loadChapter(book, idx, book.chapters || infoChapters || [], { resetScroll: false })
    } catch (e) {
      const msg = (e as Error).message || '未知错误'
      setLoadingContent(false)
      setReading(null)
      setChapters([])
      setContent('')
      goView('shelf')
      showToast(`打开失败：${msg}`)
      const action = await askConfirm({
        title: '打开失败',
        message: `《${withRead.name}》打开失败：\n${msg}`,
        confirmText: '移除',
        cancelText: '保留',
        extraText: isLocalBook(withRead) ? undefined : '换源',
        danger: true
      })
      if (action === 'extra') {
        void openChangeSource(withRead)
        return
      }
      if (action !== 'confirm') return
      try {
        const next = await window.fly.shelf.remove(withRead.id)
        setShelf(next)
        showToast(`已移除《${withRead.name}》`)
      } catch (err) {
        showToast(`移除失败：${(err as Error).message}`)
      }
    }
  }

  /**
   * 探测搜索命中的详情与目录；可读时返回可入库的书架书籍
   * @param b 搜索命中
   */
  async function probeSearchBook(b: SearchBook): Promise<
    | { ok: true; item: ShelfBook }
    | { ok: false; message: string }
  > {
    try {
      let tocUrl = b.bookUrl
      let chapters: Chapter[] = []
      let infoName = b.name
      let infoAuthor = b.author
      let infoCover = b.coverUrl
      let infoIntro = b.intro
      let infoLast = b.lastChapter
      let infoKind = b.kind
      try {
        const info = await window.fly.books.info(b.origin, b.bookUrl)
        tocUrl = info.tocUrl || b.bookUrl
        infoName = info.name || b.name
        infoAuthor = info.author || b.author
        infoCover = info.coverUrl || b.coverUrl
        infoIntro = info.intro || b.intro
        infoLast = info.lastChapter || b.lastChapter
        infoKind = info.kind || b.kind
        chapters = await window.fly.books.toc(b.origin, tocUrl)
      } catch {
        chapters = await window.fly.books.toc(b.origin, b.bookUrl)
        tocUrl = b.bookUrl
      }
      const readable = chapters.filter((c) => c.url && !c.isVolume)
      if (!readable.length) {
        return { ok: false, message: '无法获取目录，书源可能失效或规则不兼容' }
      }
      const now = Date.now()
      const item: ShelfBook = {
        id: bookId(b.origin, b.bookUrl),
        name: infoName,
        author: infoAuthor,
        bookUrl: b.bookUrl,
        coverUrl: infoCover,
        intro: infoIntro,
        kind: infoKind,
        lastChapter: infoLast,
        origin: b.origin,
        originName: b.originName,
        tocUrl,
        chapters,
        chapterIndex: 0,
        scrollTop: 0,
        addedAt: now,
        updatedAt: now,
        lastReadAt: now
      }
      return { ok: true, item }
    } catch (e) {
      return { ok: false, message: (e as Error).message || '书籍不可用' }
    }
  }

  /**
   * 阅读前轻量校验搜索命中（详情 + 非空目录）；失败时可尝试同名其他源
   * @param b 搜索命中
   */
  async function readSearchBook(b: SearchBook) {
    showToast('正在校验书籍…')
    const first = await probeSearchBook(b)
    if (first.ok) {
      const next = await window.fly.shelf.upsert(first.item)
      setShelf(next)
      setSources(await window.fly.sources.list())
      const saved = next.find((x) => x.id === first.item.id) || first.item
      void openBook(saved)
      return
    }

    const alts = findSameNovelSearchAlts(results, b)
    const action = await askConfirm({
      title: '无法阅读',
      message: `《${b.name}》（${b.originName || '未知源'}）\n${first.message}`,
      confirmText: '仅加书架',
      cancelText: '取消',
      extraText: alts.length ? `尝试其他源（${alts.length}）` : undefined
    })

    if (action === 'cancel') return

    if (action === 'confirm') {
      await addToShelf(b)
      return
    }

    // 尝试当前搜索结果中的同名其他源
    for (let i = 0; i < alts.length; i++) {
      const alt = alts[i]
      showToast(`正在尝试其他源（${i + 1}/${alts.length}）：${alt.originName || '未知'}`)
      const probed = await probeSearchBook(alt)
      if (!probed.ok) continue
      const next = await window.fly.shelf.upsert(probed.item)
      setShelf(next)
      setSources(await window.fly.sources.list())
      const saved = next.find((x) => x.id === probed.item.id) || probed.item
      showToast(`已改用「${alt.originName}」`)
      void openBook(saved)
      return
    }
    showToast('同名其他源均无法获取目录')
  }

  /** 通过系统文件选择器导入本地书籍并可选立即打开 */
  async function importLocalBook() {
    const r = await window.fly.shelf.importLocal()
    if (!r.ok) {
      if (r.message !== '已取消') showToast(r.message)
      return
    }
    if (r.shelf) setShelf(r.shelf)
    showToast(r.message)
    if (r.book) void openBook(r.book)
  }

  /**
   * 加载指定章节正文，更新阅读进度，并按偏好预加载后续章节
   * @param book 当前阅读书籍
   * @param index 章节索引
   * @param list 目录列表
   * @param options.resetScroll 是否重置滚动位置
   */
  async function loadChapter(
    book: ShelfBook,
    index: number,
    list: Chapter[],
    options?: { resetScroll?: boolean }
  ) {
    const chapter = list[index]
    if (!chapter?.url) {
      setContent('（分卷或无效章节）')
      setLoadingContent(false)
      return
    }
    const resetScroll = options?.resetScroll ?? index !== book.chapterIndex
    const gen = ++chapterLoadGenRef.current
    setLoadingContent(true)
    try {
      const text = await window.fly.books.content(book.origin, chapter.url, book.id)
      if (gen !== chapterLoadGenRef.current) return
      setContent(text || '（正文为空，可能是书源规则不兼容）')
      setReaderCacheTick((n) => n + 1)
      const updated: ShelfBook = {
        ...book,
        chapterIndex: index,
        chapters: list,
        scrollTop: resetScroll ? 0 : book.scrollTop || 0,
        lastReadAt: Date.now(),
        updatedAt: Date.now()
      }
      setReading(updated)
      const next = await window.fly.shelf.upsert(updated)
      if (gen !== chapterLoadGenRef.current) return
      setShelf(next)

      const preloadN = Math.max(0, prefs.preloadCount ?? 3)
      if (preloadN > 0 && !isLocalBook(book)) {
        const upcoming = list
          .slice(index + 1)
          .filter((c) => c.url && !c.isVolume)
          .slice(0, preloadN)
          .map((c) => c.url)
        if (upcoming.length) {
          void window.fly.books.preload(book.origin, book.id, upcoming).then(() => {
            if (gen !== chapterLoadGenRef.current) return
            setReaderCacheTick((n) => n + 1)
            void window.fly.shelf.list().then(setShelf)
          })
        }
      }
    } catch (e) {
      if (gen !== chapterLoadGenRef.current) return
      setContent(`加载失败：${(e as Error).message}`)
    } finally {
      if (gen === chapterLoadGenRef.current) {
        setLoadingContent(false)
      }
    }
  }

  /**
   * 持久化当前阅读滚动位置（变化过小时跳过）
   * @param scrollTop 滚动像素
   */
  async function saveReadingScroll(scrollTop: number) {
    const current = readingRef.current
    if (!current) return
    const top = Math.max(0, Math.round(scrollTop))
    if (Math.abs((current.scrollTop || 0) - top) < 2) return
    const updated: ShelfBook = {
      ...current,
      scrollTop: top,
      updatedAt: Date.now()
    }
    readingRef.current = updated
    setReading(updated)
    try {
      const patched = await window.fly.shelf.patchProgress(current.id, { scrollTop: top })
      if (patched) {
        setShelf((prev) =>
          prev.map((b) =>
            b.id === patched.id
              ? { ...b, scrollTop: patched.scrollTop, updatedAt: patched.updatedAt }
              : b
          )
        )
      }
    } catch {
      /* 持久化失败时仍保留本地阅读位置 */
    }
  }

  /**
   * 保存阅读器设置到主进程
   * @param next 新的阅读设置
   */
  async function saveSettings(next: ReaderSettings) {
    setSettings(next)
    await window.fly.settings.save(next)
  }

  if (view === 'reader' && reading) {
    return (
      <>
        <ReaderView
          book={reading}
          chapters={chapters}
          content={content}
          loading={loadingContent}
          settings={settings}
          cacheTick={readerCacheTick}
          onBack={() => goView('shelf')}
          onSelectChapter={(i) => void loadChapter(reading, i, chapters, { resetScroll: true })}
          onPrev={() => {
            if (reading.chapterIndex > 0)
              void loadChapter(reading, reading.chapterIndex - 1, chapters, { resetScroll: true })
          }}
          onNext={() => {
            if (reading.chapterIndex < chapters.length - 1)
              void loadChapter(reading, reading.chapterIndex + 1, chapters, { resetScroll: true })
          }}
          onScrollSave={(top) => void saveReadingScroll(top)}
          onSettingsChange={(s) => void saveSettings(s)}
          onAddPurify={async (text) => {
            const next = await window.fly.settings.addPurify(text)
            setSettings(next)
            showToast(`已加入净化：${text.slice(0, 24)}${text.length > 24 ? '…' : ''}`)
          }}
        />
        {toast ? <div className="toast">{toast}</div> : null}
      </>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>FlyNovel</h1>
          <p>轻量阅读 · Legado 书源</p>
        </div>
        <nav className="nav">
          {(
            [
              ['shelf', '书架'],
              ['search', '搜书'],
              ['sources', '书源'],
              ['settings', '设置'],
              ['about', '关于']
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={view === id ? 'active' : ''}
              onClick={() => goView(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="main">
        <div className="topbar" aria-hidden="true" />
        <div className="content">
          {view === 'shelf' && (
            <ShelfView
              shelf={shelf}
              sort={prefs.shelfSort || 'lastRead'}
              busyId={shelfBusyId}
              cacheBusyId={cacheBusyId}
              cacheProgress={cacheProgress}
              updatingAll={shelfUpdatingAll}
              updateProgress={shelfUpdateProgress}
              onOpen={(b) => void openBook(b)}
              onImportLocal={() => void importLocalBook()}
              onSortChange={(shelfSort) => {
                setPrefs((p) => ({ ...p, shelfSort }))
                void window.fly.prefs.save({ shelfSort }).then((r) => setPrefs(r.prefs))
              }}
              onUpdate={(b) => void updateShelfBook(b)}
              onUpdateAll={() => void updateAllShelfBooks()}
              onChangeSource={(b) => void openChangeSource(b)}
              onCache={async (b) => {
                if (isLocalBook(b)) {
                  showToast('本地书籍无需缓存')
                  return
                }
                if (cacheBusyId) return
                setCacheBusyId(b.id)
                try {
                  const next = await window.fly.shelf.cacheBook(b.id)
                  setShelf(next)
                  const info = next.find((x) => x.id === b.id)?.cache
                  if (info?.status === 'full') showToast(`《${b.name}》已全部缓存`)
                  else showToast(`《${b.name}》缓存 ${info?.cached ?? 0}/${info?.total ?? 0}`)
                } catch (e) {
                  showToast(`缓存失败：${(e as Error).message}`)
                  setShelf(await window.fly.shelf.list())
                } finally {
                  setCacheBusyId(null)
                  setCacheProgress('')
                }
              }}
              onCancelCache={async (id) => {
                if (pendingExportRef.current?.id === id) {
                  pendingExportRef.current = null
                }
                const next = await window.fly.shelf.cancelCache(id)
                setShelf(next)
                setCacheBusyId(null)
                setCacheProgress('')
                showToast('已取消缓存')
              }}
              onExportTxt={async (b) => {
                if (isLocalBook(b)) {
                  showToast('本地书籍请直接使用原文件')
                  return
                }
                const info =
                  b.cache ||
                  (await window.fly.shelf.cacheStatus(b.id)) || {
                    bookId: b.id,
                    total: 0,
                    cached: 0,
                    status: 'none' as const
                  }
                const fullyCached =
                  info.status === 'full' ||
                  (info.total > 0 && info.cached >= info.total)

                if (fullyCached) {
                  await runExportTxt(b.id, b.name)
                  return
                }

                const cachedLabel =
                  info.total > 0 ? `（当前 ${info.cached}/${info.total}）` : ''
                const result = await askConfirm({
                  title: '需要先缓存',
                  message: `《${b.name}》尚未全部缓存${cachedLabel}。确认后将先缓存全书，缓存完成后自动导出为 TXT。`,
                  confirmText: '开始缓存并导出',
                  cancelText: '取消'
                })
                if (result !== 'confirm') return

                pendingExportRef.current = { id: b.id, name: b.name }
                showToast('缓存完成后将自动导出')

                if (cacheBusyId === b.id || info.status === 'caching') {
                  return
                }
                if (cacheBusyId) {
                  showToast('请等待当前缓存结束后再导出')
                  pendingExportRef.current = null
                  return
                }

                setCacheBusyId(b.id)
                try {
                  const next = await window.fly.shelf.cacheBook(b.id)
                  setShelf(next)
                  // 若进度监听已在完成时处理导出，则 pending 为空。
                  // 若缓存返回时未走该完成路径，则在此立即导出。
                  if (pendingExportRef.current?.id === b.id) {
                    pendingExportRef.current = null
                    await runExportTxt(b.id, b.name)
                  }
                } catch (e) {
                  pendingExportRef.current = null
                  showToast(`缓存失败：${(e as Error).message}`)
                  setShelf(await window.fly.shelf.list())
                } finally {
                  setCacheBusyId(null)
                  setCacheProgress('')
                }
              }}
              onRemove={async (id) => {
                const book = shelf.find((b) => b.id === id)
                const result = await askConfirm({
                  title: '移出书架',
                  message: book
                    ? `确定从书架移除《${book.name}》？本地缓存也会一并删除。`
                    : '确定从书架移除这本书？',
                  confirmText: '移除',
                  danger: true
                })
                if (result !== 'confirm') return
                const next = await window.fly.shelf.remove(id)
                setShelf(next)
                showToast(book ? `已移除《${book.name}》` : '已移除')
              }}
              onSearch={() => goView('search')}
            />
          )}
          {view === 'search' && (
            <SearchView
              keyword={keyword}
              setKeyword={setKeyword}
              searching={searching}
              progress={searchProgress}
              results={results}
              history={searchHistory}
              onSearch={() => void runSearch()}
              onSearchKeyword={(k) => void runSearch(k)}
              onClearHistory={() => void clearSearchHistory()}
              onRemoveHistory={(k) => void removeSearchHistoryItem(k)}
              onRead={(b) => void readSearchBook(b)}
            />
          )}
          {view === 'sources' && (
            <SourcesView
              sources={sources}
              shelf={shelf}
              testKeyword={prefs.sourceTestKeyword}
              onTestKeywordChange={(v) => {
                setPrefs((p) => ({ ...p, sourceTestKeyword: v }))
              }}
              onTestKeywordCommit={(v) => {
                void window.fly.prefs.save({ sourceTestKeyword: v }).then((r) => setPrefs(r.prefs))
              }}
              askConfirm={askConfirm}
              showToast={showToast}
              onImportFile={() => void onImportFile()}
              onSourcesChange={setSources}
            />
          )}
          {view === 'settings' && (
            <SettingsView
              settings={settings}
              prefs={prefs}
              askConfirm={askConfirm}
              onPrefsChange={async (patch) => {
                const r = await window.fly.prefs.save(patch)
                setPrefs(r.prefs)
                if (patch.bossKey !== undefined || patch.bossKeyEnabled !== undefined) {
                  showToast(r.bossKey.message)
                }
              }}
              onRemovePurify={async (rule) => {
                const next = await window.fly.settings.removePurify(rule)
                setSettings(next)
                showToast('已移除净化规则')
              }}
            />
          )}
          {view === 'about' && <AboutView />}
        </div>
      </section>
      {toast ? <div className="toast">{toast}</div> : null}
      {confirmReq ? <ConfirmDialog request={confirmReq} onClose={closeConfirm} /> : null}
      {changeSource ? (
        <div
          className="modal-backdrop"
          onClick={() => closeChangeSource()}
        >
          <div className="modal change-source-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>换源 · {changeSource.book.name}</h3>
              <button
                className="btn ghost icon-btn"
                title="关闭"
                aria-label="关闭"
                disabled={changeSource.applying}
                onClick={() => closeChangeSource()}
              >
                <IconClose />
              </button>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              当前：{changeSource.book.originName}
            </p>
            {changeSource.searching ? (
              <div className="change-source-status" role="status" aria-live="polite">
                <LoadingIcon />
                <span>
                  {changeSource.progress && changeSource.progress.total > 0
                    ? `正在搜索书源 ${changeSource.progress.done}/${changeSource.progress.total}`
                    : '正在搜索书源…'}
                  {changeSource.candidates.length
                    ? ` · 已找到 ${changeSource.candidates.length} 个，可先选择`
                    : ' · 有结果会立即显示'}
                  {changeSource.progress?.current
                    ? ` · ${changeSource.progress.current}`
                    : ''}
                </span>
              </div>
            ) : null}
            {changeSource.applying ? (
              <div className="loading">
                <LoadingIcon /> 正在换源…
              </div>
            ) : changeSource.candidates.length ? (
              <div className="change-source-list">
                {changeSource.candidates.map((c) => (
                  <button
                    key={`${c.origin}-${c.bookUrl}`}
                    className="change-source-item"
                    onClick={() => void applyChangeSource(c)}
                  >
                    {c.coverUrl ? (
                      <img className="cover" src={c.coverUrl} alt="" />
                    ) : (
                      <div className="cover placeholder">{c.name.slice(0, 1)}</div>
                    )}
                    <div className="change-source-meta">
                      <strong>{c.name}</strong>
                      <span>{authorLabel(c.author)}</span>
                      <span>书源：{c.originName || '未知'}</span>
                      <span className="muted">
                        最新：{c.lastChapter?.trim() || '暂无'}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ) : changeSource.searching ? (
              <div className="empty">正在从各书源查找…</div>
            ) : (
              <div className="empty">没有找到其他书源</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

