import type { BookInfo, BookSource, Chapter, SearchBook } from '../../shared/types'
import { ensureNovelParagraphs, normalizeLineEndings } from '../../shared/novelText'
import { isSourceStructuralOk } from '../../shared/sourceValidity'
import { getElements, getString } from './analyzeRule'
import { fetchText, parseRequestUrl, resolveUrl } from './http'

export { isSourceStructuralOk }

/**
 * 解析书源头字段 JSON 为请求头对象。
 * @param header - 可选 JSON 字符串
 * @returns 请求头键值；解析失败返回空对象
 */
function parseHeader(header?: string): Record<string, string> {
  if (!header) return {}
  try {
    const obj = JSON.parse(header) as Record<string, string>
    return obj || {}
  } catch {
    return {}
  }
}

/**
 * 解码常见 HTML 实体为明文。
 * @param s - 含实体的字符串
 * @returns 解码后的文本
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/**
 * 将章节 HTML/文本转为以空行分隔的小说段落正文。
 * @param raw - 原始 HTML 或纯文本
 * @returns 规范化后的小说正文
 */
export function htmlToNovelText(raw: string): string {
  if (!raw) return ''
  let s = raw

  if (/<\/?[a-z][\s\S]*>/i.test(s)) {
    s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    s = s.replace(/<!--[\s\S]*?-->/g, '')
    s = s.replace(/<br\s*\/?>/gi, '\n')
    s = s.replace(/<\/?(p|div|section|article|tr|li|h[1-6]|blockquote)(\s[^>]*)?>/gi, '\n')
    s = s.replace(/<[^>]+>/g, '')
  }

  s = decodeEntities(s)
  s = normalizeLineEndings(s)
  s = s.replace(/\u3000{2,}/g, '\n')
  s = s.replace(/(^|\n)\u3000+/g, '$1')

  const lines = s
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((line) => line.length > 0)

  return ensureNovelParagraphs(lines.join('\n\n'))
}

/**
 * 将正文规则改为优先抽取 HTML，以保留 br/p 等结构。
 * @param rule - 原始内容规则
 * @returns 调整为 @html 的规则
 */
function contentRuleAsHtml(rule: string): string {
  const trimmed = rule.trim()
  if (!trimmed) return trimmed
  if (/@html\b/i.test(trimmed)) return trimmed
  if (/@(text|ownText|textNodes|all)\b/i.test(trimmed)) {
    return trimmed.replace(/@(text|ownText|textNodes|all)\b/gi, '@html')
  }
  if (!trimmed.includes('@')) return `${trimmed}@html`
  return trimmed
}

/**
 * 按书源搜索规则检索书籍列表。
 * @param source - 书源
 * @param key - 搜索关键词
 * @param page - 页码，默认 1
 * @returns 搜索结果书籍列表
 */
export async function searchBooks(
  source: BookSource,
  key: string,
  page = 1
): Promise<SearchBook[]> {
  if (!source.searchUrl || !source.ruleSearch?.bookList) return []

  const base = source.bookSourceUrl
  const headers = parseHeader(source.header)
  const { url, options } = parseRequestUrl(source.searchUrl, { key, page })
  const fullUrl = resolveUrl(base, url)
  const { text, finalUrl } = await fetchText(fullUrl, {
    ...options,
    headers: { ...headers, ...options.headers }
  })

  const items = getElements(text, source.ruleSearch.bookList)
  const books: SearchBook[] = []

  for (const item of items) {
    const isJsonItem = item.trim().startsWith('{') || item.trim().startsWith('[')
    const content = isJsonItem ? item : `<div id="__wrap__">${item}</div>`
    const name = getString(content, source.ruleSearch.name, finalUrl)
    const bookUrlRaw = getString(content, source.ruleSearch.bookUrl, finalUrl)
    if (!name || !bookUrlRaw) continue
    const bookUrl = resolveUrl(finalUrl, bookUrlRaw)
    books.push({
      name,
      author: getString(content, source.ruleSearch.author, finalUrl),
      bookUrl,
      coverUrl: getString(content, source.ruleSearch.coverUrl, finalUrl) || undefined,
      intro: getString(content, source.ruleSearch.intro, finalUrl) || undefined,
      kind: getString(content, source.ruleSearch.kind, finalUrl) || undefined,
      lastChapter: getString(content, source.ruleSearch.lastChapter, finalUrl) || undefined,
      wordCount: getString(content, source.ruleSearch.wordCount, finalUrl) || undefined,
      origin: source.bookSourceUrl,
      originName: source.bookSourceName
    })
  }
  return books
}

/**
 * 抓取并解析书籍详情页信息。
 * @param source - 书源
 * @param bookUrl - 书籍详情 URL
 * @returns 书籍信息（含 tocUrl 等）
 */
export async function getBookInfo(source: BookSource, bookUrl: string): Promise<BookInfo> {
  const headers = parseHeader(source.header)
  const { text, finalUrl } = await fetchText(bookUrl, { headers })
  const rule = source.ruleBookInfo

  const pick = (r?: string) => {
    try {
      return getString(text, r, finalUrl) || undefined
    } catch {
      return undefined
    }
  }

  const info: BookInfo = {
    name: pick(rule?.name) || '未知书名',
    author: pick(rule?.author) || '佚名',
    bookUrl: finalUrl,
    coverUrl: pick(rule?.coverUrl),
    intro: pick(rule?.intro),
    kind: pick(rule?.kind),
    lastChapter: pick(rule?.lastChapter),
    wordCount: pick(rule?.wordCount),
    tocUrl: pick(rule?.tocUrl) || finalUrl,
    origin: source.bookSourceUrl,
    originName: source.bookSourceName
  }

  if (info.tocUrl) info.tocUrl = resolveUrl(finalUrl, info.tocUrl)
  return info
}

/**
 * 抓取目录页并解析章节列表（支持分页 nextTocUrl，最多 30 页）。
 * @param source - 书源
 * @param tocUrl - 目录起始 URL
 * @returns 章节列表
 */
export async function getChapterList(source: BookSource, tocUrl: string): Promise<Chapter[]> {
  const headers = parseHeader(source.header)
  const rule = source.ruleToc
  if (!rule?.chapterList) return []

  const chapters: Chapter[] = []
  let nextUrl: string | null = tocUrl
  let guard = 0

  while (nextUrl && guard < 30) {
    guard += 1
    const { text, finalUrl } = await fetchText(nextUrl, { headers })
    const items = getElements(text, rule.chapterList)

    for (const item of items) {
      const isJsonItem = item.trim().startsWith('{')
      const content = isJsonItem ? item : `<div id="__wrap__">${item}</div>`
      const title = getString(content, rule.chapterName, finalUrl)
      const urlRaw = getString(content, rule.chapterUrl, finalUrl)
      const isVolume = rule.isVolume ? !!getString(content, rule.isVolume, finalUrl) : false
      if (!title) continue
      chapters.push({
        title,
        url: urlRaw ? resolveUrl(finalUrl, urlRaw) : '',
        index: chapters.length,
        isVolume
      })
    }

    if (rule.nextTocUrl) {
      const n = getString(text, rule.nextTocUrl, finalUrl)
      nextUrl = n ? resolveUrl(finalUrl, n) : null
      if (nextUrl === finalUrl) nextUrl = null
    } else {
      nextUrl = null
    }
  }

  return chapters.filter((c) => !c.isVolume || c.url)
}

/**
 * 抓取章节正文（支持分页 nextContentUrl，最多 20 页）。
 * @param source - 书源
 * @param chapterUrl - 章节 URL
 * @returns 合并后的小说正文
 */
export async function getContent(
  source: BookSource,
  chapterUrl: string
): Promise<string> {
  const headers = parseHeader(source.header)
  const rule = source.ruleContent
  if (!rule?.content) return ''

  const parts: string[] = []
  let nextUrl: string | null = chapterUrl
  let guard = 0
  const seen = new Set<string>()

  while (nextUrl && guard < 20) {
    guard += 1
    if (seen.has(nextUrl)) break
    seen.add(nextUrl)

    const { text, finalUrl } = await fetchText(nextUrl, { headers })
    let html = text
    if (rule.sourceRegex) {
      try {
        const re = new RegExp(rule.sourceRegex, 'i')
        const m = html.match(re)
        if (m) html = m[0]
      } catch {
        /* 忽略非法正则 */
      }
    }

    let content = getString(html, contentRuleAsHtml(rule.content), finalUrl)
    if (rule.replaceRegex) {
      const segs = rule.replaceRegex.split('\n').filter(Boolean)
      for (const seg of segs) {
        try {
          const hashParts = (`x##${seg.replace(/^##/, '')}`).split('##').slice(1)
          let result = content
          for (let i = 0; i < hashParts.length; i += 2) {
            const pattern = hashParts[i]
            const replacement = hashParts[i + 1] ?? ''
            result = result.replace(new RegExp(pattern, 'g'), replacement)
          }
          content = result
        } catch {
          /* 忽略非法替换段 */
        }
      }
    }

    parts.push(htmlToNovelText(content))

    if (rule.nextContentUrl) {
      const n = getString(html, rule.nextContentUrl, finalUrl)
      const resolved = n ? resolveUrl(finalUrl, n) : null
      nextUrl = resolved && !seen.has(resolved) ? resolved : null
    } else {
      nextUrl = null
    }
  }

  return parts.filter(Boolean).join('\n\n')
}

/**
 * 规范化导入的书源 JSON：过滤无效项，仅保留文本书源。
 * @param input - 单个或数组形式的原始对象
 * @returns 合法书源数组
 */
export function normalizeSources(input: unknown): BookSource[] {
  const list = Array.isArray(input) ? input : [input]
  const result: BookSource[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const s = item as BookSource
    if (!s.bookSourceUrl || !s.bookSourceName) continue
    if (s.bookSourceType != null && s.bookSourceType !== 0) continue
    result.push({
      ...s,
      enabled: s.enabled !== false,
      bookSourceType: 0
    })
  }
  return result
}

/**
 * 用关键词实测书源搜索是否可用。
 * @param source - 书源
 * @param keyword - 可选测试词；缺省用规则 checkKeyWord 或「剑来」
 * @returns 是否成功、说明、命中数、耗时与结构校验结果
 */
export async function testSource(
  source: BookSource,
  keyword?: string
): Promise<{
  ok: boolean
  message: string
  found: number
  respondMs: number
  structuralOk: boolean
}> {
  const structuralOk = isSourceStructuralOk(source)
  if (!structuralOk) {
    return {
      ok: false,
      message: '规则不完整（需 searchUrl / bookList / name / bookUrl）',
      found: 0,
      respondMs: 0,
      structuralOk: false
    }
  }

  const key =
    keyword?.trim() ||
    source.ruleSearch?.checkKeyWord?.trim() ||
    '剑来'
  const started = Date.now()
  try {
    const books = await searchBooks(source, key, 1)
    const respondMs = Date.now() - started
    if (!books.length) {
      return {
        ok: false,
        message: `搜索「${key}」无结果`,
        found: 0,
        respondMs,
        structuralOk: true
      }
    }
    return {
      ok: true,
      message: `搜索「${key}」找到 ${books.length} 本，例如《${books[0].name}》`,
      found: books.length,
      respondMs,
      structuralOk: true
    }
  } catch (e) {
    return {
      ok: false,
      message: (e as Error).message || '请求失败',
      found: 0,
      respondMs: Date.now() - started,
      structuralOk: true
    }
  }
}
