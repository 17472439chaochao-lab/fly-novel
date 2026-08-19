import type { BookInfo, BookSource, Chapter, SearchBook } from '../../shared/types'
import { ensureNovelParagraphs, normalizeLineEndings } from '../../shared/novelText'
import { isSourceStructuralOk } from '../../shared/sourceValidity'
import { getElements, getString } from './analyzeRule'
import { fetchText, parseRequestUrl, resolveUrl } from './http'
import { withTimeout } from '../asyncPool'

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
 * 在途章节正文请求合并：key = `${bookSourceUrl}::${chapterUrl}`。
 * 同一 key 的并发调用共享同一个 Promise，避免整本缓存与导出 TXT 同时拉同一章发重复请求。
 * 首个调用方的 signal 透传给 fetchText 以真正中止在途 fetch；后续合并方仅用各自 signal 竞速。
 */
const inflightContent = new Map<string, Promise<string>>()

/**
 * 抓取章节正文（内部实现，不合并）。
 * 支持分页 nextContentUrl，最多 20 页。
 * @param source - 书源
 * @param chapterUrl - 章节 URL
 * @param signal - 可选中止信号，透传给 fetchText
 * @returns 合并后的小说正文
 */
async function doGetContent(
  source: BookSource,
  chapterUrl: string,
  signal?: AbortSignal
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

    const { text, finalUrl } = await fetchText(nextUrl, { headers, signal })
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
 * 抓取章节正文（支持分页 nextContentUrl，最多 20 页）。
 * 同一书源+章节URL的并发请求自动合并（in-flight coalescing），避免重复请求。
 * @param source - 书源
 * @param chapterUrl - 章节 URL
 * @param options - 可选 { signal } 中止信号
 * @returns 合并后的小说正文
 */
export function getContent(
  source: BookSource,
  chapterUrl: string,
  options?: { signal?: AbortSignal }
): Promise<string> {
  const key = `${source.bookSourceUrl}::${chapterUrl}`
  const signal = options?.signal

  // 合并：同 key 在途请求直接共享 Promise
  const existing = inflightContent.get(key)
  if (existing) {
    if (!signal) return existing
    if (signal.aborted) return Promise.reject(new Error(`请求已取消：${chapterUrl}`))
    return Promise.race([
      existing,
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error(`请求已取消：${chapterUrl}`)),
          { once: true }
        )
      })
    ])
  }

  // 首个调用方：透传 signal 给 fetchText 以真正中止在途 fetch
  const promise = doGetContent(source, chapterUrl, signal).finally(() => {
    inflightContent.delete(key)
  })
  inflightContent.set(key, promise)
  return promise
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

/** 测试关键词候选上限：超过上限会显著拖长疑似失效源的测试耗时 */
const MAX_TEST_KEYWORDS = 3
/** 单源测试总预算：疑似失效源在预算内依次尝试全部候选词 */
const TEST_BUDGET_MS = 12_000
/** 单个候选词搜索上限 */
const TEST_PER_KEY_MS = 8_000
/** 内置热门词兜底池：搜索历史缺失时的备用候选 */
const TEST_KEYWORD_FALLBACKS = ['剑来', '遮天', '斗破苍穹', '完美世界', '庆余年', '雪中悍刀行']

/**
 * 生成书源测试的关键词候选序列。
 * 优先级：显式测试词 → 规则 checkKeyWord → 最近搜索历史（用户真实在找的书）→ 内置热门词。
 * 去重并截断到 MAX_TEST_KEYWORDS 个。首个关键词搜不到时自动换词，
 * 避免「剑来」这类固定测试词搜不到就误判整源失效。
 * @param source - 书源
 * @param keyword - 用户显式传入的测试词（设置页配置）
 * @param history - 最近搜索历史（新到旧）
 * @returns 去重后的候选关键词列表
 */
export function buildTestKeywords(
  source: BookSource,
  keyword?: string,
  history: string[] = []
): string[] {
  const list: string[] = []
  const push = (k?: string): void => {
    const t = (k || '').trim()
    if (t && !list.includes(t)) list.push(t)
  }
  push(keyword)
  push(source.ruleSearch?.checkKeyWord)
  for (const h of history) {
    if (list.length >= MAX_TEST_KEYWORDS) break
    push(h)
  }
  for (const f of TEST_KEYWORD_FALLBACKS) {
    if (list.length >= MAX_TEST_KEYWORDS) break
    push(f)
  }
  return list.slice(0, MAX_TEST_KEYWORDS)
}

/**
 * 用关键词实测书源搜索是否可用。
 * 依次尝试候选词（见 buildTestKeywords），任一关键词搜到结果即判定可用；
 * 全部候选词均失败才判定不可用，避免单个关键词冷门导致的误判。
 * @param source - 书源
 * @param keyword - 可选显式测试词
 * @param history - 可选最近搜索历史，作为自动替换的关键词来源
 * @returns 是否成功、说明、命中数、耗时、结构校验结果与命中的关键词
 */
export async function testSource(
  source: BookSource,
  keyword?: string,
  history: string[] = []
): Promise<{
  ok: boolean
  message: string
  found: number
  respondMs: number
  structuralOk: boolean
  hitKeyword?: string
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

  const keys = buildTestKeywords(source, keyword, history)
  const started = Date.now()
  let lastMessage = `搜索「${keys[0]}」无结果`
  for (const key of keys) {
    const remaining = TEST_BUDGET_MS - (Date.now() - started)
    if (remaining <= 0) break
    const budget = Math.min(TEST_PER_KEY_MS, remaining)
    try {
      const books = await withTimeout(searchBooks(source, key, 1), budget, `搜索「${key}」超时`)
      if (books.length) {
        return {
          ok: true,
          message: `搜索「${key}」找到 ${books.length} 本，例如《${books[0].name}》`,
          found: books.length,
          respondMs: Date.now() - started,
          structuralOk: true,
          hitKeyword: key
        }
      }
      lastMessage = `搜索「${key}」无结果`
    } catch (e) {
      lastMessage = (e as Error).message || `搜索「${key}」失败`
    }
  }
  const tried = keys.map((k) => `「${k}」`).join('、')
  return {
    ok: false,
    message: keys.length > 1 ? `尝试 ${tried} 均失败（${lastMessage}）` : lastMessage,
    found: 0,
    respondMs: Date.now() - started,
    structuralOk: true
  }
}
