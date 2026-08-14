import iconv from 'iconv-lite'

export interface FetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  charset?: string
  /** 请求超时毫秒数（默认 15000）。 */
  timeoutMs?: number
}

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * 发起 HTTP 请求并将响应体按字符集解码为文本。
 * @param url - 请求地址
 * @param options - 方法、头、body、字符集与超时等选项
 * @returns 解码后的文本与最终跳转 URL
 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<{ text: string; finalUrl: string }> {
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    Accept: 'text/html,application/json,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...options.headers
  }

  const timeoutMs = options.timeoutMs ?? 15000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const init: RequestInit = {
    method: (options.method || 'GET').toUpperCase(),
    headers,
    redirect: 'follow',
    signal: controller.signal
  }

  if (options.body && init.method !== 'GET' && init.method !== 'HEAD') {
    init.body = options.body
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
  }

  try {
    const res = await fetch(url, init)
    const buf = Buffer.from(await res.arrayBuffer())
    const charset = options.charset || detectCharset(res.headers.get('content-type'), buf)
    const text = iconv.decode(buf, charset || 'utf-8')
    return { text, finalUrl: res.url || url }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`请求超时（${timeoutMs}ms）：${url}`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从 Content-Type 或 HTML meta 检测字符集。
 * @param contentType - 响应 Content-Type 头
 * @param buf - 响应体缓冲
 * @returns 规范化字符集名，默认 utf-8
 */
function detectCharset(contentType: string | null, buf: Buffer): string {
  if (contentType) {
    const m = contentType.match(/charset=([^\s;]+)/i)
    if (m) return normalizeCharset(m[1])
  }
  const head = buf.slice(0, 2048).toString('latin1')
  const meta = head.match(/charset=["']?([^\s"'/>]+)/i)
  if (meta) return normalizeCharset(meta[1])
  return 'utf-8'
}

/**
 * 规范化常见中文编码别名。
 * @param c - 原始字符集名
 * @returns 可用于 iconv 的名称
 */
function normalizeCharset(c: string): string {
  const lower = c.toLowerCase().replace(/['"]/g, '')
  if (lower === 'gb2312' || lower === 'gbk' || lower === 'gb18030') return 'gbk'
  return lower
}

/**
 * 解析 Legado searchUrl / 请求 URL。
 * 支持 `/path?q={{key}}` 以及 `/path,{"method":"POST",...}` 形式。
 * @param raw - 原始规则字符串
 * @param vars - 模板变量（如 key、page）
 * @returns 解析后的 URL 与 FetchOptions
 */
export function parseRequestUrl(
  raw: string,
  vars: Record<string, string | number>
): { url: string; options: FetchOptions } {
  let filled = raw
  for (const [k, v] of Object.entries(vars)) {
    filled = filled.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), encodeURIComponent(String(v)))
  }

  filled = filled.replace(/\{\{\(([^}]+)\)\}\}/g, (_, expr: string) => {
    try {
      const page = Number(vars.page ?? 1)
      const key = String(vars.key ?? '')
      const safe = expr.replace(/page/g, String(page)).replace(/key/g, JSON.stringify(key))
      if (!/^[\d\s+\-*/().]+$/.test(safe.replace(/"/g, ''))) {
        const numExpr = expr.replace(/page/g, String(page))
        if (/^[\d\s+\-*/().]+$/.test(numExpr)) {
          // eslint-disable-next-line no-new-func
          return String(Function(`"use strict"; return (${numExpr});`)())
        }
        return ''
      }
      // eslint-disable-next-line no-new-func
      return String(Function(`"use strict"; return (${safe});`)())
    } catch {
      return ''
    }
  })

  const comma = findOptionsComma(filled)
  if (comma === -1) {
    return { url: filled, options: {} }
  }

  const urlPart = filled.slice(0, comma)
  const optPart = filled.slice(comma + 1)
  try {
    const opt = JSON.parse(optPart) as {
      method?: string
      body?: string
      charset?: string
      headers?: Record<string, string>
      webView?: boolean
    }
    let body = opt.body || ''
    for (const [k, v] of Object.entries(vars)) {
      body = body.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
      body = body.replace(new RegExp(encodeURIComponent(`{{${k}}}`), 'g'), String(v))
    }
    return {
      url: urlPart,
      options: {
        method: opt.method,
        body,
        charset: opt.charset,
        headers: opt.headers
      }
    }
  } catch {
    return { url: filled, options: {} }
  }
}

/**
 * 定位 URL 与 JSON 选项之间的 `,{` 分隔位置。
 * @param s - 已填充变量的请求串
 * @returns 逗号下标；未找到为 -1
 */
function findOptionsComma(s: string): number {
  const idx = s.indexOf(',{')
  return idx
}

/**
 * 相对路径基于 base 解析为绝对 URL。
 * @param base - 基准 URL
 * @param path - 相对或绝对路径
 * @returns 绝对 URL；失败时返回原 path
 */
export function resolveUrl(base: string, path: string): string {
  if (!path) return base
  if (/^https?:\/\//i.test(path)) return path
  try {
    return new URL(path, base).toString()
  } catch {
    return path
  }
}
