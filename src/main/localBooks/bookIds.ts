import { createHash } from 'crypto'

/**
 * 本地书籍 ID 与章节 URL 的共享生成器。
 * 主进程（发起导入）与导入 worker（执行解析/落库）都需要，抽到独立模块避免循环依赖。
 */

/**
 * 由文件路径生成稳定的本地书籍 ID。
 * @param filePath - 本地文件绝对路径
 * @returns `local:` 前缀的哈希 ID
 */
export function localBookId(filePath: string): string {
  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 20)
  return `local:${hash}`
}

/**
 * 生成本地章节伪 URL。
 * @param bookId - 本地书籍 ID
 * @param index - 章节下标
 * @returns local:// 协议 URL
 */
export function chapterUrl(bookId: string, index: number): string {
  return `local://${bookId}/${index}`
}
