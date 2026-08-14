import type { Chapter, ShelfBook } from './types'

/**
 * 目录刷新或换源后，尽量保持原阅读章节位置。
 * 优先按章节 URL 匹配，其次按标题包含关系，最后钳制到有效索引。
 * @param prev 换源/刷新前的书架书籍（含 chapters、chapterIndex）
 * @param chapters 新的章节列表
 * @returns 应对齐到的章节下标（从 0 起）
 */
export function matchChapterIndex(prev: ShelfBook, chapters: Chapter[]): number {
  const current = prev.chapters?.[prev.chapterIndex]
  if (!current || !chapters.length) return 0
  const byUrl = chapters.findIndex((c) => c.url && c.url === current.url)
  if (byUrl >= 0) return byUrl
  const byTitle = chapters.findIndex(
    (c) =>
      c.title &&
      (c.title === current.title ||
        c.title.includes(current.title) ||
        current.title.includes(c.title))
  )
  if (byTitle >= 0) return byTitle
  return Math.min(prev.chapterIndex, chapters.length - 1)
}
