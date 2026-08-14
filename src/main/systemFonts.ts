import { getFonts } from 'font-list'

const SKIP =
  /emoji|symbol|braille|dingbat|ornament|webdings|wingdings|marlett|mt extra|ms outlook|bookshelf symbol|holomdl|lastresort|adobe blank|\.sf|\.apple/i

let cached: string[] | null = null

/**
 * 规范化字体族名称（去空白与首尾引号）。
 * @param raw - 原始字体名
 * @returns 规范化后的名称
 */
function normalizeName(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '')
}

/**
 * 列出本机已安装的字体族名称，供阅读设置字体选择器使用。
 * @returns 按中文 locale 排序后的字体族名称数组；失败时返回空数组
 */
export async function listSystemFontFamilies(): Promise<string[]> {
  if (cached) return cached
  try {
    const fonts = await getFonts({ disableQuoting: true })
    const set = new Set<string>()
    for (const raw of fonts) {
      const name = normalizeName(raw)
      if (!name || name.startsWith('.')) continue
      if (SKIP.test(name)) continue
      set.add(name)
    }
    cached = Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'))
    return cached
  } catch (err) {
    console.error('[fonts] list failed', err)
    return []
  }
}
