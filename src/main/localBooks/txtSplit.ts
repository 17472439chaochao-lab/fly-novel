import { normalizeLineEndings } from '../../shared/novelText'

/** 用正则启发式将中英文小说 TXT 自动切章。 */

export type SplitChapter = {
  title: string
  content: string
}

const CN_NUM = '[零〇一二三四五六七八九十百千万两\\d]+'

/** 行级章节标题模式（由具体到宽泛）。 */
const HEADING_RE = new RegExp(
  [
    `^[\\s\\u3000\\[【《（(]*第${CN_NUM}[章节回卷部集篇].{0,60}$`,
    '^[\\s\\u3000\\[【《（(]*(?:序章|序言|楔子|引子|前言|绪论|后记|尾声|终章|番外(?:篇)?|感言|完本感言).{0,40}$',
    '^[\\s\\u3000\\[【]*(?:Chapter|CHAPTER|Ch\\.?)\\s*[0-9IVXLCDM]+\\.?\\s*.{0,50}$',
    '^[\\s\\u3000]*\\d{1,4}[\\.、．]\\s*\\S.{0,40}$'
  ].join('|'),
  'm'
)

const MAX_HEADING_LEN = 80

/**
 * 将 TXT 全文按标题行切分为章节；命中过少时按体积切分。
 * @param raw - 原始文本
 * @param fallbackTitle - 无标题时的回退书名/章名
 * @returns 章节标题与正文列表
 */
export function splitTxtChapters(raw: string, fallbackTitle: string): SplitChapter[] {
  const text = normalizeLineEndings(raw).replace(/^\uFEFF/, '').trim()
  if (!text) return [{ title: fallbackTitle || '全文', content: '（文件为空）' }]

  const lines = text.split('\n')
  const hits: { line: number; title: string }[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.length > MAX_HEADING_LEN) continue
    if (!HEADING_RE.test(trimmed)) continue
    if (/^[…—\-·•\s\u3000]+$/.test(trimmed)) continue
    hits.push({ line: i, title: sanitizeTitle(trimmed) })
  }

  const strong = hits.filter((h) => /第.+[章节回卷部集篇]|楔子|序章|Chapter/i.test(h.title))
  const useHits = strong.length >= 3 ? strong : hits

  if (useHits.length < 2) {
    return splitBySize(text, fallbackTitle || '全文')
  }

  const chapters: SplitChapter[] = []
  if (useHits[0].line > 0) {
    const preamble = lines.slice(0, useHits[0].line).join('\n').trim()
    if (preamble.length > 80) {
      chapters.push({ title: '前言', content: preamble })
    }
  }

  for (let i = 0; i < useHits.length; i++) {
    const start = useHits[i].line + 1
    const end = i + 1 < useHits.length ? useHits[i + 1].line : lines.length
    const body = lines.slice(start, end).join('\n').trim()
    chapters.push({
      title: useHits[i].title,
      content: body || '（本章无正文）'
    })
  }

  return chapters.length ? chapters : [{ title: fallbackTitle || '全文', content: text }]
}

/**
 * 按固定体积切分长文本为多章。
 * @param text - 全文
 * @param title - 基础标题
 * @returns 切分后的章节列表
 */
function splitBySize(text: string, title: string): SplitChapter[] {
  const chunk = 12000
  if (text.length <= chunk * 1.4) {
    return [{ title, content: text }]
  }
  const parts: SplitChapter[] = []
  let i = 0
  let n = 1
  while (i < text.length) {
    let end = Math.min(i + chunk, text.length)
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end)
      if (nl > i + chunk * 0.5) end = nl
    }
    parts.push({
      title: `${title} · ${n}`,
      content: text.slice(i, end).trim() || '（空）'
    })
    i = end
    n += 1
  }
  return parts
}

/**
 * 清理章节标题首尾括号空白并截断长度。
 * @param t - 原始标题行
 * @returns 清理后的标题
 */
function sanitizeTitle(t: string): string {
  return t.replace(/^[\s\u3000\[【《（(]+|[\]】》）)\s\u3000]+$/g, '').slice(0, 80) || '未命名章节'
}

/**
 * 检测编码并解码 TXT 缓冲（UTF-8 / GB18030 / GBK / GB2312 / Big5 等）。
 * @param buf - 文件二进制
 * @returns 解码后的文本
 */
export function decodeTxtBuffer(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8')
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2)
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]
      swapped[i - 1] = buf[i]
    }
    return swapped.toString('utf16le')
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const iconv = require('iconv-lite') as typeof import('iconv-lite')

  type Cand = { text: string; score: number }
  const cands: Cand[] = []
  const utf8 = buf.toString('utf8')
  cands.push({ text: utf8, score: scoreDecodedText(utf8) })

  for (const enc of ['gb18030', 'gbk', 'gb2312', 'big5'] as const) {
    try {
      const text = iconv.decode(buf, enc)
      cands.push({ text, score: scoreDecodedText(text) })
    } catch {
      /* 跳过失败编码 */
    }
  }

  cands.sort((a, b) => b.score - a.score)
  return cands[0]?.text || utf8
}

/**
 * 为解码候选打分：更倾向 CJK 多、替换符/控制符少的结果。
 * @param s - 解码文本
 * @returns 分数，越高越好
 */
function scoreDecodedText(s: string): number {
  const sample = s.slice(0, 12000)
  if (!sample.length) return -1e9
  let cjk = 0
  let punct = 0
  let bad = 0
  let ctrl = 0
  let latin = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c === 0xfffd) {
      bad += 1
      continue
    }
    if (c < 9 || (c > 13 && c < 32)) {
      ctrl += 1
      continue
    }
    if (c >= 0x4e00 && c <= 0x9fff) cjk += 1
    else if (c >= 0x3400 && c <= 0x4dbf) cjk += 1
    else if ((c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) punct += 1
    else if ((c >= 0x41 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) latin += 1
  }
  return cjk * 3 + punct - bad * 80 - ctrl * 40 - Math.max(0, latin - cjk) * 0.5
}
