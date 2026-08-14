import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import * as cheerio from 'cheerio'
import type { SplitChapter } from './txtSplit'

type XmlDoc = ReturnType<DOMParser['parseFromString']>
type ManifestItem = { id: string; href: string; mediaType: string }

export type EpubMeta = {
  title: string
  author: string
  chapters: SplitChapter[]
  coverDataUrl?: string
}

/**
 * 解析 EPUB 缓冲，提取书名、作者、章节正文与可选封面。
 * @param buf - EPUB 文件二进制
 * @param fallbackTitle - 缺省书名
 * @returns EPUB 元数据与章节列表
 */
export async function parseEpubBuffer(buf: Buffer, fallbackTitle: string): Promise<EpubMeta> {
  const zip = await JSZip.loadAsync(buf)
  const containerXml = await readZipText(zip, 'META-INF/container.xml')
  if (!containerXml) throw new Error('无效的 EPUB：缺少 META-INF/container.xml')

  const containerDoc = parseXml(containerXml)
  const rootfile =
    containerDoc.getElementsByTagName('rootfile')[0]?.getAttribute('full-path') ||
    containerDoc.getElementsByTagName('rootfile')[0]?.getAttribute('fullPath')
  if (!rootfile) throw new Error('无效的 EPUB：找不到 content.opf')

  const opfPath = rootfile.replace(/\\/g, '/')
  const opfDir = dirname(opfPath)
  const opfXml = await readZipText(zip, opfPath)
  if (!opfXml) throw new Error(`无效的 EPUB：无法读取 ${opfPath}`)

  const opf = parseXml(opfXml)
  const title =
    textOfFirst(opf, ['dc:title', 'title']) || fallbackTitle || '未命名 EPUB'
  const author = textOfFirst(opf, ['dc:creator', 'creator']) || '佚名'

  const manifest = new Map<string, ManifestItem>()
  const manifestEls = opf.getElementsByTagName('item')
  for (let i = 0; i < manifestEls.length; i++) {
    const el = manifestEls[i]
    const id = el.getAttribute('id') || ''
    const href = el.getAttribute('href') || ''
    const mediaType = el.getAttribute('media-type') || el.getAttribute('mediaType') || ''
    if (id && href) {
      manifest.set(id, { id, href: resolvePath(opfDir, href), mediaType })
    }
  }

  const spineIds: string[] = []
  const itemrefs = opf.getElementsByTagName('itemref')
  for (let i = 0; i < itemrefs.length; i++) {
    const idref = itemrefs[i].getAttribute('idref')
    if (idref) spineIds.push(idref)
  }

  const tocTitles = await loadTocTitles(zip, manifest, opfDir, opf)
  const navIds = new Set<string>()
  for (let i = 0; i < manifestEls.length; i++) {
    const props = manifestEls[i].getAttribute('properties') || ''
    const id = manifestEls[i].getAttribute('id') || ''
    if (id && props.split(/\s+/).includes('nav')) navIds.add(id)
  }

  const chapters: SplitChapter[] = []
  for (const id of spineIds) {
    if (navIds.has(id)) continue
    const item = manifest.get(id)
    if (!item) continue
    if (!isHtmlMedia(item.mediaType, item.href)) continue
    const html = await readZipText(zip, item.href)
    if (!html) continue
    const content = htmlToPlainText(html)
    if (!content.trim()) continue
    const fromToc = tocTitles.get(normalizeHref(item.href))
    const titleGuess =
      fromToc ||
      extractHtmlTitle(html) ||
      basename(item.href).replace(/\.(xhtml|html|htm)$/i, '') ||
      `第 ${chapters.length + 1} 章`
    chapters.push({ title: titleGuess.slice(0, 80), content })
  }

  if (!chapters.length) {
    throw new Error('EPUB 中没有可读章节')
  }

  const coverDataUrl = await extractCoverDataUrl(zip, opf, manifest)

  return { title: title.trim(), author: author.trim(), chapters, coverDataUrl }
}

/**
 * 从 OPF/manifest 提取封面并转为 data URL。
 * @param zip - EPUB zip
 * @param opf - content.opf 文档
 * @param manifest - 清单项映射
 * @returns data URL；无封面则为 undefined
 */
async function extractCoverDataUrl(
  zip: JSZip,
  opf: XmlDoc,
  manifest: Map<string, ManifestItem>
): Promise<string | undefined> {
  let coverItem: ManifestItem | undefined

  const items = opf.getElementsByTagName('item')
  for (let i = 0; i < items.length; i++) {
    const el = items[i]
    const props = el.getAttribute('properties') || ''
    const id = el.getAttribute('id') || ''
    if (props.split(/\s+/).includes('cover-image') && id) {
      coverItem = manifest.get(id)
      break
    }
  }

  if (!coverItem) {
    const metas = opf.getElementsByTagName('meta')
    for (let i = 0; i < metas.length; i++) {
      const name = (metas[i].getAttribute('name') || '').toLowerCase()
      const content = metas[i].getAttribute('content') || ''
      if (name === 'cover' && content && manifest.has(content)) {
        coverItem = manifest.get(content)
        break
      }
    }
  }

  if (!coverItem) {
    for (const item of Array.from(manifest.values())) {
      if (!/^image\//i.test(item.mediaType) && !/\.(jpe?g|png|gif|webp|svg)$/i.test(item.href)) {
        continue
      }
      if (/cover/i.test(item.id) || /cover/i.test(item.href)) {
        coverItem = item
        break
      }
    }
  }

  if (!coverItem) return undefined

  const file =
    zip.file(coverItem.href) ||
    (() => {
      const key = Object.keys(zip.files).find(
        (k) => k.replace(/\\/g, '/').toLowerCase() === coverItem!.href.toLowerCase()
      )
      return key ? zip.file(key) : null
    })()
  if (!file || file.dir) return undefined

  const buf = Buffer.from(await file.async('uint8array'))
  if (!buf.length || buf.length > 2_500_000) return undefined

  let mime = coverItem.mediaType || ''
  if (!mime.startsWith('image/')) {
    const ext = coverItem.href.split('.').pop()?.toLowerCase()
    mime =
      ext === 'png'
        ? 'image/png'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'webp'
            ? 'image/webp'
            : ext === 'svg'
              ? 'image/svg+xml'
              : 'image/jpeg'
  }
  return `data:${mime};base64,${buf.toString('base64')}`
}

/**
 * 从 EPUB3 nav 与 EPUB2 NCX 加载 href→标题 映射。
 * @param zip - EPUB zip
 * @param manifest - 清单
 * @param opfDir - opf 所在目录
 * @param opf - opf 文档
 * @returns 规范化 href 到标题的映射
 */
async function loadTocTitles(
  zip: JSZip,
  manifest: Map<string, ManifestItem>,
  opfDir: string,
  opf: XmlDoc
): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  const items = opf.getElementsByTagName('item')
  for (let i = 0; i < items.length; i++) {
    const el = items[i]
    const props = el.getAttribute('properties') || ''
    const href = el.getAttribute('href') || ''
    if (!href) continue
    if (props.split(/\s+/).includes('nav')) {
      const html = await readZipText(zip, resolvePath(opfDir, href))
      if (html) parseNavXhtml(html, opfDir, href, map)
    }
  }

  for (const item of Array.from(manifest.values())) {
    if (item.mediaType === 'application/x-dtbncx+xml' || /\.ncx$/i.test(item.href)) {
      const ncx = await readZipText(zip, item.href)
      if (ncx) parseNcx(ncx, dirname(item.href), map)
    }
  }

  return map
}

/**
 * 解析 EPUB3 导航 XHTML，填充目录标题映射。
 * @param html - nav 文档 HTML
 * @param opfDir - opf 目录
 * @param navHref - nav 相对路径
 * @param map - 输出映射
 */
function parseNavXhtml(
  html: string,
  opfDir: string,
  navHref: string,
  map: Map<string, string>
): void {
  const $ = cheerio.load(html)
  const navDir = dirname(resolvePath(opfDir, navHref))
  $('nav[epub\\:type="toc"] a, nav#toc a, nav.toc a, nav a').each((_, a) => {
    const href = ($(a).attr('href') || '').split('#')[0]
    const label = $(a).text().replace(/\s+/g, ' ').trim()
    if (!href || !label) return
    const full = normalizeHref(resolvePath(navDir, href))
    if (!map.has(full)) map.set(full, label.slice(0, 80))
  })
}

/**
 * 解析 EPUB2 NCX，填充目录标题映射。
 * @param ncx - NCX XML 文本
 * @param ncxDir - NCX 所在目录
 * @param map - 输出映射
 */
function parseNcx(ncx: string, ncxDir: string, map: Map<string, string>): void {
  const doc = parseXml(ncx)
  const points = doc.getElementsByTagName('navPoint')
  for (let i = 0; i < points.length; i++) {
    const np = points[i]
    const label =
      textContent(np.getElementsByTagName('text')[0]) ||
      textContent(np.getElementsByTagName('navLabel')[0])
    const content = np.getElementsByTagName('content')[0]
    const src = (content?.getAttribute('src') || '').split('#')[0]
    if (!src || !label.trim()) continue
    const full = normalizeHref(resolvePath(ncxDir, src))
    if (!map.has(full)) map.set(full, label.trim().slice(0, 80))
  }
}

/**
 * 将章节 HTML 转为纯文本（保留段落换行）。
 * @param html - 章节 HTML
 * @returns 纯文本正文
 */
function htmlToPlainText(html: string): string {
  const $ = cheerio.load(html)
  $('script, style, noscript').remove()
  $('br').replaceWith('\n')
  $('p, div, h1, h2, h3, h4, h5, h6, li, tr, section, article').each((_, el) => {
    $(el).append('\n')
  })
  return $.root()
    .text()
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 从 HTML 中猜测章节标题（h1/h2/title）。
 * @param html - 章节 HTML
 * @returns 标题字符串（可能为空）
 */
function extractHtmlTitle(html: string): string {
  const $ = cheerio.load(html)
  const t =
    $('h1').first().text().trim() ||
    $('h2').first().text().trim() ||
    $('title').first().text().trim()
  return t.replace(/\s+/g, ' ').slice(0, 80)
}

/**
 * 判断 manifest 项是否为可读 HTML 章节。
 * @param mediaType - MIME 类型
 * @param href - 资源路径
 * @returns 是否为 HTML 类资源
 */
function isHtmlMedia(mediaType: string, href: string): boolean {
  if (/html|xml/i.test(mediaType) && !/ncx|opf|svg/i.test(mediaType)) return true
  return /\.(xhtml|html|htm)$/i.test(href)
}

/**
 * 从 zip 中读取文本文件（支持大小写不敏感回退）。
 * @param zip - JSZip 实例
 * @param path - zip 内路径
 * @returns 文本内容；不存在返回 null
 */
async function readZipText(zip: JSZip, path: string): Promise<string | null> {
  const normalized = path.replace(/^\/+/, '')
  let file = zip.file(normalized)
  if (!file) {
    const key = Object.keys(zip.files).find(
      (k) => k.replace(/\\/g, '/').toLowerCase() === normalized.toLowerCase()
    )
    if (key) file = zip.file(key)
  }
  if (!file || file.dir) return null
  return file.async('text')
}

/**
 * 将 XML 字符串解析为 DOM 文档。
 * @param xml - XML 文本
 * @returns XML 文档
 */
function parseXml(xml: string): XmlDoc {
  return new DOMParser().parseFromString(xml, 'text/xml')
}

/**
 * 按候选标签名取第一个非空文本内容。
 * @param doc - XML 文档
 * @param tags - 标签名列表（可含前缀）
 * @returns 文本；未找到返回空串
 */
function textOfFirst(doc: XmlDoc, tags: string[]): string {
  for (const tag of tags) {
    const els = doc.getElementsByTagName(tag)
    if (els.length && textContent(els[0]).trim()) return textContent(els[0]).trim()
    const local = tag.includes(':') ? tag.split(':')[1] : tag
    const all = doc.getElementsByTagName('*')
    for (let i = 0; i < all.length; i++) {
      const n = all[i]
      if (
        (n.localName === local || n.nodeName === tag || n.nodeName.endsWith(':' + local)) &&
        textContent(n).trim()
      ) {
        return textContent(n).trim()
      }
    }
  }
  return ''
}

/**
 * 读取节点文本并压缩空白。
 * @param node - DOM 节点
 * @returns 文本
 */
function textContent(node: { textContent?: string | null } | undefined | null): string {
  if (!node) return ''
  return (node.textContent || '').replace(/\s+/g, ' ').trim()
}

/**
 * 取路径的目录部分。
 * @param p - 路径
 * @returns 目录；无斜杠则为空串
 */
function dirname(p: string): string {
  const n = p.replace(/\\/g, '/')
  const i = n.lastIndexOf('/')
  return i >= 0 ? n.slice(0, i) : ''
}

/**
 * 取路径的文件名部分。
 * @param p - 路径
 * @returns 文件名
 */
function basename(p: string): string {
  const n = p.replace(/\\/g, '/')
  const i = n.lastIndexOf('/')
  return i >= 0 ? n.slice(i + 1) : n
}

/**
 * 将相对路径基于目录解析为 zip 内规范化路径。
 * @param baseDir - 基准目录
 * @param rel - 相对路径
 * @returns 规范化相对路径
 */
function resolvePath(baseDir: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!baseDir) return cleaned
  const parts = [...baseDir.split('/').filter(Boolean), ...cleaned.split('/')]
  const out: string[] = []
  for (const part of parts) {
    if (part === '.' || !part) continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/**
 * 规范化 href 以便与目录映射比对（小写、去前导斜杠）。
 * @param href - 资源路径
 * @returns 规范化字符串
 */
function normalizeHref(href: string): string {
  return href.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
}
