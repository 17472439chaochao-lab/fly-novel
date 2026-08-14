import { isLocalBook } from '../../../shared/bookLocal'
import type { ShelfBook } from '../../../shared/types'

/**
 * 生成书架条目上的缓存状态徽章文案与样式类名。
 * @param b 书架书籍
 * @param cacheBusyId 当前正在缓存的书籍 id，无则 null
 * @param cacheProgress 缓存进度展示字符串
 * @returns text 为展示文案，cls 为 CSS 类名
 */
export function cacheLabel(
  b: ShelfBook,
  cacheBusyId: string | null,
  cacheProgress: string
): {
  text: string
  cls: string
} {
  if (isLocalBook(b)) {
    const fmt = (b.localFormat || b.kind || '本地').toString().toUpperCase()
    return { text: `本地 · ${fmt}`, cls: 'cache-badge local' }
  }
  const caching = cacheBusyId === b.id || b.cache?.status === 'caching'
  if (caching) {
    return {
      text: cacheProgress ? `缓存中 ${cacheProgress}` : '缓存中…',
      cls: 'cache-badge caching'
    }
  }
  const status = b.cache?.status || 'none'
  const cached = b.cache?.cached ?? 0
  const total = b.cache?.total ?? 0
  if (status === 'full') return { text: '已缓存', cls: 'cache-badge full' }
  if (status === 'partial') return { text: `部分缓存 ${cached}/${total}`, cls: 'cache-badge partial' }
  return { text: '未缓存', cls: 'cache-badge none' }
}
