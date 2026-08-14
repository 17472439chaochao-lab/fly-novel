import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
  type CSSProperties,
  type ReactNode
} from 'react'

/** 虚拟列表对外暴露的命令式句柄 */
export type VirtualListHandle = {
  scrollToIndex: (index: number, align?: 'start' | 'center' | 'end') => void
}

/** 虚拟列表组件属性 */
export type VirtualListProps = {
  count: number
  /** 固定行高；行高略有差异时作为估算高度 */
  estimateSize: number
  overscan?: number
  className?: string
  style?: CSSProperties
  getItemKey?: (index: number) => string | number
  renderItem: (index: number) => ReactNode
}

/**
 * 固定行高虚拟列表：仅渲染可视区域及 overscan 范围内的行，
 * 通过绝对定位 + translateY 放置条目，并暴露 scrollToIndex。
 */
export const VirtualList = forwardRef<VirtualListHandle, VirtualListProps>(function VirtualList(
  {
    count,
    estimateSize,
    overscan = 6,
    className,
    style,
    getItemKey,
    renderItem
  },
  ref
) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    /** 同步滚动容器视口高度到 state */
    const sync = () => setViewportHeight(el.clientHeight)
    sync()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null
    ro?.observe(el)
    window.addEventListener('resize', sync)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [])

  /** 滚动时更新 scrollTop，驱动可见区间重算 */
  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
  }, [])

  const totalHeight = Math.max(0, count * estimateSize)

  const { start, end } = useMemo(() => {
    if (count <= 0 || viewportHeight <= 0) {
      return { start: 0, end: 0 }
    }
    const rawStart = Math.floor(scrollTop / estimateSize)
    const visible = Math.ceil(viewportHeight / estimateSize)
    const s = Math.max(0, rawStart - overscan)
    const e = Math.min(count, rawStart + visible + overscan)
    return { start: s, end: e }
  }, [count, estimateSize, overscan, scrollTop, viewportHeight])

  useImperativeHandle(
    ref,
    () => ({
      /**
       * 滚动到指定索引行
       * @param index 目标行索引
       * @param align 对齐方式：顶部 / 居中 / 底部
       */
      scrollToIndex(index: number, align: 'start' | 'center' | 'end' = 'center') {
        const el = scrollerRef.current
        if (!el || count <= 0) return
        const i = Math.max(0, Math.min(count - 1, index))
        const itemTop = i * estimateSize
        let next = itemTop
        if (align === 'center') {
          next = itemTop - el.clientHeight / 2 + estimateSize / 2
        } else if (align === 'end') {
          next = itemTop - el.clientHeight + estimateSize
        }
        el.scrollTop = Math.max(0, Math.min(totalHeight - el.clientHeight, next))
      }
    }),
    [count, estimateSize, totalHeight]
  )

  const items: ReactNode[] = []
  for (let i = start; i < end; i++) {
    const key = getItemKey ? getItemKey(i) : i
    items.push(
      <div
        key={key}
        className="virtual-list-item"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: estimateSize,
          transform: `translateY(${i * estimateSize}px)`
        }}
      >
        {renderItem(i)}
      </div>
    )
  }

  return (
    <div
      ref={scrollerRef}
      className={className ? `virtual-list ${className}` : 'virtual-list'}
      style={style}
      onScroll={onScroll}
    >
      <div className="virtual-list-spacer" style={{ height: totalHeight, position: 'relative' }}>
        {items}
      </div>
    </div>
  )
})
