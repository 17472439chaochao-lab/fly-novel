import * as cheerio from 'cheerio'
import type { Element } from 'domhandler'
import { JSONPath } from 'jsonpath-plus'
import { DOMParser } from '@xmldom/xmldom'
import xpath from 'xpath'

export type AnalyzeMode = 'Default' | 'XPath' | 'Json' | 'Regex' | 'Js'

/**
 * 判断文本是否像 JSON 对象或数组。
 * @param text - 原始内容
 * @returns 是否为 JSON 形态
 */
function isJsonLike(text: string): boolean {
  const t = text.trim()
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))
}

/**
 * 根据规则前缀与内容形态推断解析模式。
 * @param rule - 分析规则
 * @param content - 页面或 JSON 内容
 * @returns 分析模式
 */
function detectMode(rule: string, content: string): AnalyzeMode {
  const r = rule.trim()
  if (r.startsWith('@js:') || r.startsWith('<js>')) return 'Js'
  if (r.startsWith('$.') || r.startsWith('$[') || r.startsWith('$..')) return 'Json'
  if (r.startsWith('//') || r.startsWith('./') || r.startsWith('(') || r.startsWith('/')) return 'XPath'
  if (r.startsWith(':') || r.includes('##') && !r.includes('@')) {
    /* 可能仍是带 ## 正则的 CSS，后续处理 */
  }
  if (isJsonLike(content) && (r.includes('$.') || r.startsWith('$'))) return 'Json'
  return 'Default'
}

/**
 * 拆分规则为选择器、取值类型与正则替换段。
 * 例如 `.title@text##^作者：`
 * @param rule - 原始规则
 * @returns selector、getType、regexes
 */
export function parseRuleParts(rule: string): {
  selector: string
  getType: string
  regexes: string[]
} {
  let working = rule.trim()
  const regexes: string[] = []

  const hashParts = working.split('##')
  working = hashParts[0]
  for (let i = 1; i < hashParts.length; i++) {
    regexes.push(hashParts[i])
  }

  let getType = 'text'
  let selector = working

  if (working.startsWith('text.') || working.startsWith('id.') || working.startsWith('class.')) {
    const at = working.lastIndexOf('@')
    if (at > 0) {
      selector = working.slice(0, at)
      getType = working.slice(at + 1) || 'text'
    }
    return { selector, getType, regexes }
  }

  const atIdx = working.lastIndexOf('@')
  if (atIdx > 0 && !working.startsWith('//') && !working.startsWith('$.')) {
    const maybeType = working.slice(atIdx + 1)
    if (/^(text|html|href|src|ownText|all|textNodes|content)$/i.test(maybeType.split('&&')[0])) {
      selector = working.slice(0, atIdx)
      getType = maybeType
    }
  }

  return { selector, getType, regexes }
}

/**
 * 按 ## 拆出的 pattern/replacement 对链式替换字符串。
 * @param value - 原始取值
 * @param regexes - 交替的 pattern、replacement 列表
 * @returns 替换并 trim 后的结果
 */
function applyRegexChain(value: string, regexes: string[]): string {
  let result = value
  for (let i = 0; i < regexes.length; i += 2) {
    const pattern = regexes[i]
    const replacement = regexes[i + 1] ?? ''
    if (!pattern) continue
    try {
      const re = new RegExp(pattern, 'g')
      if (replacement === '' || replacement === null) {
        result = result.replace(re, '')
      } else if (replacement.startsWith('$')) {
        result = result.replace(re, replacement)
      } else {
        result = result.replace(re, replacement)
      }
    } catch {
      /* 忽略非法正则 */
    }
  }
  return result.trim()
}

/**
 * 相对链接基于 base 转为绝对 URL。
 * @param base - 基准 URL
 * @param href - 相对或绝对链接
 * @returns 绝对 URL
 */
function absoluteUrl(base: string, href: string): string {
  if (!href) return ''
  try {
    return new URL(href, base).toString()
  } catch {
    return href
  }
}

/**
 * 从 cheerio 元素按 getType 提取字符串。
 * @param $ - cheerio API
 * @param el - 目标元素
 * @param getType - text/html/href/src 等
 * @param baseUrl - 用于解析相对链接的基准
 * @returns 提取值
 */
function getFromCheerio(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<Element>,
  getType: string,
  baseUrl: string
): string {
  const type = getType.toLowerCase()
  if (type === 'html') return el.html() || ''
  if (type === 'text' || type === 'textnodes') return el.text().replace(/\s+/g, ' ').trim()
  if (type === 'owntext') {
    return el
      .contents()
      .filter((_, node) => node.type === 'text')
      .text()
      .trim()
  }
  if (type === 'href') {
    const href = el.attr('href') || el.attr('data-href') || ''
    return absoluteUrl(baseUrl, href)
  }
  if (type === 'src') {
    const src = el.attr('src') || el.attr('data-src') || el.attr('data-original') || ''
    return absoluteUrl(baseUrl, src)
  }
  if (type === 'all') return $.html(el) || ''
  if (type && !['content'].includes(type)) {
    const attr = el.attr(type)
    if (attr != null) {
      if (type.includes('href') || type.includes('src') || type.includes('url')) {
        return absoluteUrl(baseUrl, attr)
      }
      return attr
    }
  }
  return el.text().replace(/\s+/g, ' ').trim()
}

/**
 * 将 Legado CSS 索引语法（如 `.item.0` / id. / class.）转为 cheerio 选择器。
 * @param selector - Legado 选择器
 * @returns cheerio 可用选择器
 */
function toCheerioSelector(selector: string): string {
  if (selector.startsWith('id.')) {
    return `#${selector.slice(3)}`
  }
  if (selector.startsWith('class.')) {
    return `.${selector.slice(6)}`
  }
  return selector
}

/**
 * 在 cheerio 文档中按 Legado CSS/text. 选择器选取节点。
 * @param $ - cheerio API
 * @param root - 可选根节点；null 则从文档选
 * @param selector - 选择器字符串
 * @returns 匹配的 cheerio 集合
 */
function selectByCss($: cheerio.CheerioAPI, root: cheerio.Cheerio<Element> | null, selector: string) {
  if (selector.startsWith('text.')) {
    const needle = selector.slice(5)
    const scope = root && root.length ? root : $.root()
    const matched = scope.find('*').filter((_, el) => $(el).text().includes(needle))
    const filtered = matched.filter((_, el) => {
      return $(el).find('*').filter((__, child) => $(child).text().includes(needle)).length === 0
    })
    return filtered.length ? filtered : matched
  }

  const indexMatch = selector.match(/^(.*)\.(-?\d+)$/)
  let sel = toCheerioSelector(selector)
  let index: number | null = null
  if (indexMatch) {
    sel = toCheerioSelector(indexMatch[1])
    index = parseInt(indexMatch[2], 10)
  }

  let nodes = root ? root.find(sel) : $(sel)
  if (index != null && nodes.length > 0) {
    const i = index < 0 ? nodes.length + index : index
    nodes = nodes.eq(i)
  }
  return nodes
}

/**
 * 用 CSS/cheerio 规则从 HTML 提取字符串列表。
 * @param html - HTML 文本
 * @param rule - 分析规则
 * @param baseUrl - 链接基准
 * @param single - 是否只取首个命中
 * @returns 提取结果数组
 */
function analyzeCss(
  html: string,
  rule: string,
  baseUrl: string,
  single: boolean
): string[] {
  try {
    const { selector, getType, regexes } = parseRuleParts(rule)
    if (!selector && !getType) return []

    const $ = cheerio.load(html)
    if (!selector || selector === '@' || selector === '') {
      const val = applyRegexChain($.root().text(), regexes)
      return val ? [val] : []
    }

    const nodes = selectByCss($, null, selector)
    const out: string[] = []
    nodes.each((_, el) => {
      const v = applyRegexChain(getFromCheerio($, $(el), getType, baseUrl), regexes)
      if (v) out.push(v)
      if (single && out.length) return false
      return undefined
    })
    return out
  } catch {
    return []
  }
}

/**
 * 用 XPath 规则从 HTML 提取字符串列表。
 * @param html - HTML 文本
 * @param rule - XPath 规则
 * @param baseUrl - 链接基准
 * @param single - 是否只取首个命中
 * @returns 提取结果数组
 */
function analyzeXPath(html: string, rule: string, baseUrl: string, single: boolean): string[] {
  const { selector, getType, regexes } = parseRuleParts(rule)
  try {
    const doc = new DOMParser({ errorHandler: () => undefined }).parseFromString(html, 'text/html')
    let expr = selector
    if (rule.includes('/text()') || rule.includes('/@')) {
      expr = rule.split('##')[0]
    }
    const nodes = xpath.select(expr, doc as unknown as Node)
    const out: string[] = []
    const list = Array.isArray(nodes) ? nodes : [nodes]
    for (const n of list) {
      if (n == null) continue
      let val = ''
      if (typeof n === 'string' || typeof n === 'number' || typeof n === 'boolean') {
        val = String(n)
      } else if ((n as Node).nodeType === 2) {
        val = (n as Attr).value
        if (getType === 'href' || getType === 'src' || expr.includes('@href') || expr.includes('@src')) {
          val = absoluteUrl(baseUrl, val)
        }
      } else if ((n as Node).nodeType === 3) {
        val = (n as Text).data || ''
      } else {
        const el = n as Element
        if (getType === 'html') {
          val = el.toString()
        } else if (getType === 'href') {
          val = absoluteUrl(baseUrl, el.getAttribute?.('href') || '')
        } else if (getType === 'src') {
          val = absoluteUrl(baseUrl, el.getAttribute?.('src') || '')
        } else {
          val = el.textContent || ''
        }
      }
      val = applyRegexChain(
        getType === 'html' ? String(val) : String(val).replace(/\s+/g, ' ').trim(),
        regexes
      )
      if (val) out.push(val)
      if (single && out.length) break
    }
    return out
  } catch {
    return []
  }
}

/**
 * 用 JSONPath 从 JSON 内容提取字符串列表。
 * @param content - JSON 文本
 * @param rule - JSON 规则
 * @param single - 是否只取首个命中
 * @returns 提取结果数组
 */
function analyzeJson(content: string, rule: string, single: boolean): string[] {
  const { selector, regexes } = parseRuleParts(rule)
  try {
    const data = JSON.parse(content)
    const path = selector.startsWith('$') ? selector : `$.${selector}`
    const found = JSONPath({ path, json: data }) as unknown[]
    const out: string[] = []
    for (const item of found) {
      if (item == null) continue
      const val = applyRegexChain(typeof item === 'object' ? JSON.stringify(item) : String(item), regexes)
      if (val) out.push(val)
      if (single && out.length) break
    }
    return out
  } catch {
    return []
  }
}

/**
 * 获取列表规则（bookList / chapterList）匹配的元素。
 * 返回每个匹配元素的 HTML 片段，供嵌套字段再抽取。
 * @param content - 页面或 JSON 内容
 * @param rule - 列表规则
 * @returns 元素字符串数组
 */
export function getElements(content: string, rule: string | undefined): string[] {
  if (!rule) return []
  const mode = detectMode(rule, content)
  if (mode === 'Json') {
    try {
      const data = JSON.parse(content)
      const { selector } = parseRuleParts(rule)
      const path = selector.startsWith('$') ? selector : `$.${selector}`
      const found = JSONPath({ path, json: data }) as unknown[]
      return found.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    } catch {
      return []
    }
  }
  if (mode === 'XPath') {
    try {
      const doc = new DOMParser({ errorHandler: () => undefined }).parseFromString(content, 'text/html')
      const { selector } = parseRuleParts(rule)
      const nodes = xpath.select(selector, doc as unknown as Node)
      const list = Array.isArray(nodes) ? nodes : [nodes]
      return list
        .filter((n) => n && typeof n === 'object')
        .map((n) => (n as Element).toString())
    } catch {
      return []
    }
  }
  const $ = cheerio.load(content)
  const { selector } = parseRuleParts(rule)
  const nodes = selectByCss($, null, selector)
  const out: string[] = []
  nodes.each((_, el) => {
    out.push($.html(el) || '')
  })
  return out
}

/**
 * 按规则提取单个字符串（取列表首项）。
 * @param content - 内容
 * @param rule - 分析规则
 * @param baseUrl - 链接基准，默认空
 * @param single - 是否单值模式，默认 true
 * @returns 首个命中字符串；无则空串
 */
export function getString(content: string, rule: string | undefined, baseUrl = '', single = true): string {
  const list = getStringList(content, rule, baseUrl, single)
  return list[0] || ''
}

/**
 * 规范化规则内嵌的 mustache / 前缀标记为可解析规则。
 * @param inner - `{{...}}` 内部文本
 * @returns 规范化后的规则
 */
function normalizeEmbeddedRule(inner: string): string {
  let r = inner.trim()
  if (!r) return r
  if (r.startsWith('@@')) return r.slice(2).trim()
  if (r.startsWith('@css:')) return r.slice(5).trim()
  if (r.startsWith('@xpath:')) return r.slice(7).trim()
  if (r.startsWith('@json:')) return r.slice(6).trim()
  if (r.startsWith('@.')) return r.slice(1).trim()
  return r
}

/**
 * 展开 Legado `{{rule}}` 插值段并拼接（多用于简介等字段）。
 * @param content - 页面内容
 * @param rule - 含 mustache 的规则
 * @param baseUrl - 链接基准
 * @returns 拼接后的字符串
 */
function expandMustacheRule(content: string, rule: string, baseUrl: string): string {
  return rule.replace(/\{\{([\s\S]*?)\}\}/g, (_m, inner: string) => {
    try {
      return getString(content, normalizeEmbeddedRule(inner), baseUrl) || ''
    } catch {
      return ''
    }
  })
}

/**
 * 按规则提取字符串列表；支持 mustache、`||` 备选与多种模式。
 * @param content - 页面或 JSON 内容
 * @param rule - 分析规则
 * @param baseUrl - 链接基准
 * @param single - 是否只取首个命中
 * @returns 字符串数组
 */
export function getStringList(
  content: string,
  rule: string | undefined,
  baseUrl = '',
  single = false
): string[] {
  if (!rule || !content) return []
  const trimmed = rule.trim()
  if (!trimmed) return []

  if (trimmed.includes('{{')) {
    try {
      const expanded = expandMustacheRule(content, trimmed, baseUrl).trim()
      return expanded ? [expanded] : []
    } catch {
      return []
    }
  }

  const alternatives = trimmed.split('||')
  for (const alt of alternatives) {
    try {
      const mode = detectMode(alt, content)
      let result: string[] = []
      if (mode === 'Json' || (isJsonLike(content) && alt.trim().startsWith('$'))) {
        result = analyzeJson(content, alt, single)
      } else if (mode === 'XPath') {
        result = analyzeXPath(content, alt, baseUrl, single)
      } else if (mode === 'Js') {
        result = []
      } else {
        result = analyzeCss(content, alt, baseUrl, single)
      }
      if (result.length) return result
    } catch {
      /* 非法选择器等则尝试下一备选 */
    }
  }
  return []
}

export { absoluteUrl, applyRegexChain }
