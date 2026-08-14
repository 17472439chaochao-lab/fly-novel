import { isLocalBook } from '../../../shared/bookLocal'
import type { ShelfBook } from '../../../shared/types'

/**
 * 书架封面展示组件：优先显示网络封面图；
 * 本地 TXT/EPUB 显示格式徽章；否则用书名首字占位。
 */
export function ShelfCover({ book }: { book: ShelfBook }) {
  if (book.coverUrl) {
    return <img className="cover" src={book.coverUrl} alt="" />
  }
  const local = isLocalBook(book)
  const fmt = (book.localFormat || '').toLowerCase()
  if (local && fmt === 'txt') {
    return <div className="cover format-cover txt">TXT</div>
  }
  if (local && (fmt === 'epub' || book.kind?.toUpperCase() === 'EPUB')) {
    return <div className="cover format-cover epub">EPUB</div>
  }
  return <div className="cover placeholder">{book.name.slice(0, 1)}</div>
}
