import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { authorName } from '../../../shared/author'
import { applyPurify } from '../../../shared/purify'
import { ensureNovelParagraphs } from '../../../shared/novelText'
import { cssFontFamily, platformDefaultFontFamily, primaryFontFamily } from '../../../shared/fonts'
import type { Chapter, ReaderSettings, ShelfBook } from '../../../shared/types'
import { VirtualList, type VirtualListHandle } from '../components/VirtualList'
import {
  IconBack,
  IconCheck,
  IconFilter,
  IconGear,
  IconNext,
  IconPrev,
  IconToc,
  IconTocClose
} from '../components/icons'

const CHAPTER_ROW_HEIGHT = 36

/**
 * 阅读页：侧栏虚拟目录、正文滚动与进度持久化、
 * 主题/字体/版心设置、自动滚屏，以及选中文字加入净化。
 */
export function ReaderView({
  book,
  chapters,
  content,
  loading,
  settings,
  cacheTick,
  onBack,
  onSelectChapter,
  onPrev,
  onNext,
  onScrollSave,
  onSettingsChange,
  onAddPurify
}: {
  book: ShelfBook
  chapters: Chapter[]
  content: string
  loading: boolean
  settings: ReaderSettings
  cacheTick: number
  onBack: () => void
  onSelectChapter: (i: number) => void
  onPrev: () => void
  onNext: () => void
  onScrollSave: (scrollTop: number) => void
  onSettingsChange: (s: ReaderSettings) => void
  onAddPurify: (text: string) => void
}) {
  const chapter = chapters[book.chapterIndex]
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null)
  const [tocOpen, setTocOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [systemFonts, setSystemFonts] = useState<string[]>([])
  const [fontsLoading, setFontsLoading] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [cachedUrls, setCachedUrls] = useState<Set<string>>(() => new Set())
  const [viewportWidth, setViewportWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1100
  )
  const chapterListRef = useRef<VirtualListHandle | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const skipScrollSaveRef = useRef(false)
  const pendingScrollRef = useRef(book.scrollTop || 0)
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestScrollRef = useRef(book.scrollTop || 0)
  const [autoScrolling, setAutoScrolling] = useState(false)
  const autoScrollingRef = useRef(false)
  autoScrollingRef.current = autoScrolling
  const onScrollSaveRef = useRef(onScrollSave)
  onScrollSaveRef.current = onScrollSave
  const progressLabel =
    chapters.length > 0
      ? `${Math.min(book.chapterIndex + 1, chapters.length)}/${chapters.length}`
      : '0/0'

  const paragraphs = useMemo(() => {
    const cleaned = applyPurify(content, settings.purifyRules || [])
    return ensureNovelParagraphs(cleaned)
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
  }, [content, settings.purifyRules])

  const wideLayout = isFullscreen
  const articleMaxWidth = wideLayout
    ? Math.max(settings.pageWidth, Math.min(1100, Math.floor(viewportWidth * 0.78)))
    : settings.pageWidth

  /**
   * 对章节标题应用净化规则并压缩空白
   * @param title 原始标题
   */
  function cleanTitle(title: string): string {
    return applyPurify(title, settings.purifyRules || []).replace(/\s+/g, ' ').trim() || title
  }

  /** 立即冲刷待保存的滚动位置（取消防抖定时器） */
  function flushScrollSave() {
    if (scrollSaveTimer.current) {
      clearTimeout(scrollSaveTimer.current)
      scrollSaveTimer.current = null
    }
    onScrollSaveRef.current(latestScrollRef.current)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const urls = await window.fly.books.cachedUrls(book.id)
        if (!cancelled) setCachedUrls(new Set(urls))
      } catch {
        if (!cancelled) setCachedUrls(new Set())
      }
    })()
    return () => {
      cancelled = true
    }
  }, [book.id, book.chapterIndex, content, cacheTick])

  useEffect(() => {
    /** 点击或滚动时关闭右键净化菜单 */
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [])

  useEffect(() => {
    if (!settingsOpen || systemFonts.length > 0 || fontsLoading) return
    setFontsLoading(true)
    void window.fly.fonts
      .list()
      .then((list) => setSystemFonts(list))
      .catch(() => setSystemFonts([]))
      .finally(() => setFontsLoading(false))
  }, [settingsOpen, systemFonts.length, fontsLoading])

  useEffect(() => {
    /** 同步全屏状态与视口宽度（含 macOS 红绿灯全屏近似判断） */
    const syncFullscreen = () => {
      setViewportWidth(window.innerWidth)
      const el = document.fullscreenElement
      // macOS 红绿灯全屏常扩大窗口而非使用 Fullscreen API
      const nearlyFull =
        Math.abs(window.outerWidth - screen.width) < 8 &&
        Math.abs(window.outerHeight - screen.height) < 40
      setIsFullscreen(Boolean(el) || nearlyFull)
    }
    syncFullscreen()
    window.addEventListener('resize', syncFullscreen)
    document.addEventListener('fullscreenchange', syncFullscreen)
    return () => {
      window.removeEventListener('resize', syncFullscreen)
      document.removeEventListener('fullscreenchange', syncFullscreen)
    }
  }, [])

  useEffect(() => {
    setAutoScrolling(false)
  }, [book.id, book.chapterIndex, content])

  useEffect(() => {
    if (!autoScrolling) return
    let raf = 0
    let last = performance.now()
    let acc = 0
    // 约每秒 2 行，便于阅读
    const line = (settings.fontSize || 18) * (settings.lineHeight || 1.8)
    const pxPerSec = Math.max(72, Math.round(line * 2.2))
    /** 自动滚屏动画帧：按时间累积像素并推进 scrollTop */
    const tick = (now: number) => {
      if (!autoScrollingRef.current) return
      const box = scrollRef.current
      if (!box) return
      const dt = Math.min(50, now - last)
      last = now
      // 累积小数像素——浏览器会将 scrollTop 截断为整数
      acc += (pxPerSec * dt) / 1000
      const step = acc >= 1 ? Math.floor(acc) : 0
      if (step > 0) {
        acc -= step
        box.scrollTop += step
        latestScrollRef.current = box.scrollTop
      }
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) {
        setAutoScrolling(false)
        onScrollSaveRef.current(box.scrollTop)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [autoScrolling, settings.fontSize, settings.lineHeight])

  useEffect(() => {
    if (!tocOpen) return
    chapterListRef.current?.scrollToIndex(book.chapterIndex, 'center')
  }, [book.chapterIndex, chapters.length, book.id, tocOpen])

  // 加载中记录目标滚动位置，正文渲染后再恢复
  useEffect(() => {
    if (loading) {
      pendingScrollRef.current = book.scrollTop || 0
      latestScrollRef.current = book.scrollTop || 0
    }
  }, [loading, book.id, book.chapterIndex, book.scrollTop])

  useEffect(() => {
    if (loading) return
    const el = scrollRef.current
    if (!el) return
    skipScrollSaveRef.current = true
    const top = pendingScrollRef.current || 0
    el.scrollTop = top
    latestScrollRef.current = top
    const t = window.setTimeout(() => {
      skipScrollSaveRef.current = false
    }, 80)
    return () => window.clearTimeout(t)
  }, [loading, content, book.id, book.chapterIndex])

  useEffect(() => {
    return () => {
      if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current)
      onScrollSaveRef.current(latestScrollRef.current)
    }
  }, [])

  return (
    <div
      className={`reader${tocOpen ? '' : ' toc-collapsed'}${wideLayout ? ' wide-content' : ''}`}
    >
      {!tocOpen ? (
        <button
          type="button"
          className="reader-toc-fab"
          title="显示目录"
          aria-label="显示目录"
          onClick={() => setTocOpen(true)}
        >
          <IconToc />
        </button>
      ) : null}
      <aside className="reader-toc" aria-hidden={!tocOpen}>
        <div className="reader-toc-panel">
          <header>
            <div className="reader-toc-head">
              <div>
                <h3>{book.name}</h3>
                <p>
                  {authorName(book.author)} · {progressLabel}
                </p>
              </div>
              <button
                type="button"
                className="btn ghost icon-btn toc-toggle"
                title="隐藏目录"
                aria-label="隐藏目录"
                onClick={() => setTocOpen(false)}
              >
                <IconTocClose />
              </button>
            </div>
          </header>
          <VirtualList
            ref={chapterListRef}
            className="chapter-list"
            count={chapters.length}
            estimateSize={CHAPTER_ROW_HEIGHT}
            overscan={12}
            getItemKey={(i) => `${chapters[i].url}-${i}`}
            renderItem={(i) => {
              const c = chapters[i]
              const cached = Boolean(c.url && cachedUrls.has(c.url))
              return (
                <button
                  type="button"
                  className={`${i === book.chapterIndex ? 'active' : ''}${cached ? ' cached' : ''}`}
                  onClick={() => onSelectChapter(i)}
                >
                  <span className="chapter-title">{cleanTitle(c.title)}</span>
                  {cached ? (
                    <span className="chapter-cached" title="已缓存" aria-label="已缓存">
                      <IconCheck />
                    </span>
                  ) : null}
                </button>
              )
            }}
          />
        </div>
      </aside>
      <div className="reader-body">
        <div className="reader-toolbar">
          <div className="reader-toolbar-left">
            <button
              className="btn ghost"
              onClick={() => {
                flushScrollSave()
                onBack()
              }}
            >
              <IconBack />
              返回书架
            </button>
          </div>
          <div className="actions">
            <button
              className={`btn ghost${settingsOpen ? ' active-setting' : ''}`}
              onClick={() => setSettingsOpen((v) => !v)}
              title="阅读设置"
            >
              <IconGear />
              设置
            </button>
            <button className="btn ghost" onClick={onPrev} disabled={book.chapterIndex <= 0}>
              <IconPrev />
              上一章
            </button>
            <button
              className="btn ghost"
              onClick={onNext}
              disabled={book.chapterIndex >= chapters.length - 1}
            >
              下一章
              <IconNext />
            </button>
          </div>
        </div>
        {settingsOpen ? (
          <div className="reader-settings-panel" onClick={(e) => e.stopPropagation()}>
            <div className="reader-settings-row">
              <span>主题</span>
              <div className="theme-chips">
                {(
                  [
                    ['paper', '纸感'],
                    ['green', '护眼'],
                    ['night', '夜间']
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={`theme-chip${settings.theme === id ? ' active' : ''}`}
                    onClick={() => onSettingsChange({ ...settings, theme: id })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="reader-settings-row">
              <span>字体</span>
              {(() => {
                const defaultStack = platformDefaultFontFamily()
                const stack = settings.fontFamily || defaultStack
                const primary = primaryFontFamily(stack)
                const isSystem = !settings.fontFamily || stack === defaultStack
                const selectValue = isSystem ? '__system__' : primary
                const extra =
                  !isSystem && primary && !systemFonts.includes(primary) ? [primary] : []
                const names = extra.concat(systemFonts)
                return (
                  <select
                    className="reader-font-select"
                    disabled={fontsLoading && systemFonts.length === 0}
                    value={selectValue}
                    onChange={(e) => {
                      const v = e.target.value
                      onSettingsChange({
                        ...settings,
                        fontFamily:
                          v === '__system__' ? defaultStack : cssFontFamily(v)
                      })
                    }}
                    style={{ fontFamily: stack }}
                  >
                    <option value="__system__">系统默认</option>
                    {names.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                )
              })()}
            </div>
            <div className="reader-settings-row">
              <span>字号 {settings.fontSize}px</span>
              <input
                type="range"
                min={14}
                max={28}
                value={settings.fontSize}
                onChange={(e) =>
                  onSettingsChange({ ...settings, fontSize: Number(e.target.value) })
                }
              />
            </div>
            <div className="reader-settings-row">
              <span>行距 {settings.lineHeight.toFixed(1)}</span>
              <input
                type="range"
                min={14}
                max={24}
                value={Math.round(settings.lineHeight * 10)}
                onChange={(e) =>
                  onSettingsChange({ ...settings, lineHeight: Number(e.target.value) / 10 })
                }
              />
            </div>
            <div className="reader-settings-row">
              <span>版心 {settings.pageWidth}px</span>
              <input
                type="range"
                min={520}
                max={900}
                step={20}
                value={settings.pageWidth}
                onChange={(e) =>
                  onSettingsChange({ ...settings, pageWidth: Number(e.target.value) })
                }
              />
            </div>
          </div>
        ) : null}
        <div
          className={`reader-scroll${autoScrolling ? ' auto-scrolling' : ''}`}
          ref={scrollRef}
          onClick={() => {
            if (autoScrollingRef.current) setAutoScrolling(false)
            else if (settingsOpen) setSettingsOpen(false)
          }}
          onDoubleClick={(e) => {
            e.preventDefault()
            window.getSelection()?.removeAllRanges()
            if (loading) return
            setAutoScrolling(true)
          }}
          onScroll={(e) => {
            if (skipScrollSaveRef.current) return
            const top = (e.currentTarget as HTMLDivElement).scrollTop
            latestScrollRef.current = top
            if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current)
            scrollSaveTimer.current = setTimeout(() => {
              scrollSaveTimer.current = null
              onScrollSaveRef.current(top)
            }, 350)
          }}
        >
          {loading ? (
            <div className="loading">加载正文…</div>
          ) : (
            <article
              className="reader-article"
              style={
                {
                  ['--font-size' as string]: `${settings.fontSize}px`,
                  ['--line-height' as string]: String(settings.lineHeight),
                  ['--page-width' as string]: `${articleMaxWidth}px`,
                  ['--reader-font' as string]:
                    settings.fontFamily || platformDefaultFontFamily()
                } as CSSProperties
              }
              onContextMenu={(e) => {
                if (autoScrollingRef.current) setAutoScrolling(false)
                const text = window.getSelection()?.toString().trim() || ''
                if (!text) return
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, text })
              }}
            >
              <h1>{cleanTitle(chapter?.title || book.name)}</h1>
              {paragraphs.map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </article>
          )}
        </div>
        {autoScrolling ? (
          <div className="auto-scroll-hint" aria-live="polite">
            滚屏中 · 单击停止
          </div>
        ) : null}
      </div>

      {menu ? (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              onAddPurify(menu.text)
              setMenu(null)
              window.getSelection()?.removeAllRanges()
            }}
          >
            <IconFilter />
            加入净化
          </button>
          <div className="ctx-preview">{menu.text.slice(0, 40)}{menu.text.length > 40 ? '…' : ''}</div>
        </div>
      ) : null}
    </div>
  )
}
