import iconv from 'iconv-lite'

export interface FetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  charset?: string
  /** 请求超时毫秒数（默认 15000）。 */
  timeoutMs?: number
  /** 调用方中止信号；与内部超时控制器合并，任一触发即中止在途 fetch。 */
  signal?: AbortSignal
}

/**
 * 非 2xx 响应错误：携带 HTTP 状态码，便于上层按源/字段优雅兜底。
 * 3xx 已由 fetch 的 redirect:'follow' 处理，不会触发本错误。
 */
export class HttpError extends Error {
  status: number
  constructor(status: number, statusText: string, url: string) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}：${url}`)
    this.name = 'HttpError'
    this.status = status
  }
}

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * 合并多个 AbortSignal：任一信号中止时返回的 signal 也中止，但不影响原信号本身。
 * 用于把调用方的中止信号与内部超时控制器叠加，使在途 fetch 可被任一方中止。
 * @param signals 待合并的信号（可含 undefined）
 * @returns 合并后的新信号；若只有一个有效信号则直接返回它
 */
function mergeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const defined = signals.filter((s): s is AbortSignal => !!s)
  if (defined.length <= 1) return defined[0] ?? new AbortController().signal
  const merged = new AbortController()
  const onAbort = () => merged.abort()
  for (const s of defined) {
    if (s.aborted) {
      merged.abort()
      break
    }
    s.addEventListener('abort', onAbort, { once: true })
  }
  return merged.signal
}

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
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
  const signal = mergeSignals(timeoutController.signal, options.signal)

  const init: RequestInit = {
    method: (options.method || 'GET').toUpperCase(),
    headers,
    redirect: 'follow',
    signal
  }

  if (options.body && init.method !== 'GET' && init.method !== 'HEAD') {
    init.body = options.body
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
  }

  try {
    const res = await fetch(url, init)
    if (!res.ok) {
      throw new HttpError(res.status, res.statusText || '', res.url || url)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const charset = options.charset || detectCharset(res.headers.get('content-type'), buf)
    const text = iconv.decode(buf, charset || 'utf-8')
    return { text, finalUrl: res.url || url }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      if (options.signal?.aborted) throw new Error(`请求已取消：${url}`)
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
 * 安全求值 `{{(...)}}` 内的算术表达式：仅允许数字与 + - * / 括号，绑定 page/key。
 * 不使用 `new Function` / `eval`，从根本上消除代码执行原语；任何非算术内容（如含 key 字符串）返回 null。
 * @param expr - 括号表达式内部文本（已剥离外层括号）
 * @param page - 当前页码
 * @param key - 搜索关键词
 * @returns 求值结果字符串；非法或含字符串绑定时返回 null
 */
function evalArithmeticExpr(expr: string, page: number, key: string): string | null {
  type Token =
    | { t: 'num'; v: number }
    | { t: 'str'; v: string }
    | { t: 'op'; v: string }

  const tokens: Token[] = []
  let i = 0
  while (i < expr.length) {
    const c = expr[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++
      const num = Number(expr.slice(i, j))
      if (Number.isNaN(num)) return null
      tokens.push({ t: 'num', v: num })
      i = j
      continue
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i
      while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j++
      const word = expr.slice(i, j)
      i = j
      if (word === 'page') tokens.push({ t: 'num', v: page })
      else if (word === 'key') tokens.push({ t: 'str', v: key })
      else return null
      continue
    }
    if ('+-*/()'.includes(c)) {
      tokens.push({ t: 'op', v: c })
      i++
      continue
    }
    return null
  }
  if (!tokens.length) return null
  // 含字符串绑定（key）的算术无意义，按原逻辑返回 null
  if (tokens.some((tk) => tk.t === 'str')) return null

  let pos = 0
  const peek = (): Token | undefined => tokens[pos]
  const parseExpr = (): number => {
    let v = parseTerm()
    while (peek() && peek()!.t === 'op' && (peek()!.v === '+' || peek()!.v === '-')) {
      const op = (tokens[pos++] as { v: string }).v
      const rhs = parseTerm()
      v = op === '+' ? v + rhs : v - rhs
    }
    return v
  }
  const parseTerm = (): number => {
    let v = parseFactor()
    while (peek() && peek()!.t === 'op' && (peek()!.v === '*' || peek()!.v === '/')) {
      const op = (tokens[pos++] as { v: string }).v
      const rhs = parseFactor()
      if (op === '*') v = v * rhs
      else {
        if (rhs === 0) return NaN
        v = v / rhs
      }
    }
    return v
  }
  const parseFactor = (): number => {
    const tk = peek()
    if (!tk) return NaN
    if (tk.t === 'op' && tk.v === '-') {
      pos++
      return -parseFactor()
    }
    if (tk.t === 'op' && tk.v === '+') {
      pos++
      return parseFactor()
    }
    if (tk.t === 'op' && tk.v === '(') {
      pos++
      const v = parseExpr()
      if (peek()?.t === 'op' && peek()?.v === ')') pos++
      else return NaN
      return v
    }
    if (tk.t === 'num') {
      pos++
      return tk.v
    }
    return NaN
  }

  const result = parseExpr()
  if (Number.isNaN(result) || !Number.isFinite(result) || pos !== tokens.length) return null
  return String(result)
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
    const page = Number(vars.page ?? 1)
    const key = String(vars.key ?? '')
    return evalArithmeticExpr(expr, page, key) ?? ''
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
