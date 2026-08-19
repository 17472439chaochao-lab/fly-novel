import { mapPool } from '../asyncPool'
import type {
  BookSource,
  OnlineFetchProgress,
  OnlineRepoRequest,
  SourceRepoMeta
} from '../../shared/types'
import { fetchText } from './http'
import { normalizeSources } from './engine'

/**
 * 在线书源获取：从公开维护的书源仓库拉取 Legado 书源并去重。
 * 支持三类仓库格式：
 * - json：响应直接是书源 JSON（数组或单个对象，兼容 ```json 代码块包裹）；
 * - sub：订阅列表（每行一个书源 JSON 文件的 URL，递归展开拉取）；
 * - auto：先按 JSON 解析，失败再按订阅列表展开（自定义 URL 用）。
 */

/** 内置书源仓库（社区公开维护，按需增删；主地址失败自动尝试备用地址） */
export const BUILTIN_REPOS: SourceRepoMeta[] = [
  {
    id: 'tickmao',
    name: 'Novel 书源合集',
    desc: 'tickmao/Novel 持续维护的全量 Legado 书源，GitHub 托管',
    kind: 'json',
    url: 'https://raw.githubusercontent.com/tickmao/Novel/master/sources/legado/full.json',
    alt: 'https://cdn.jsdelivr.net/gh/tickmao/Novel@master/sources/legado/full.json'
  },
  {
    id: 'xiu2',
    name: 'XIU2 书源',
    desc: 'XIU2/Yuedu 维护的 Legado 书源包（JSON 数组），GitHub 托管',
    kind: 'json',
    url: 'https://raw.githubusercontent.com/XIU2/Yuedu/master/shuyuan',
    alt: 'https://yuedu.xiu2.xyz/shuyuan'
  },
  {
    id: 'yckceo',
    name: '书源导航（yckceo）',
    desc: '书源站点 yckceo.com 提供的精选书源包',
    kind: 'json',
    url: 'https://www.yckceo.com/yuedu/shuyuan/json/id/5283.json'
  }
]

/** 单个响应体大小上限（12MB，防超大书源包与异常响应） */
const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024
/** 订阅列表最多展开的子 URL 数 */
const MAX_SUB_URLS = 120
/** 订阅展开累计字节预算（超限后剩余条目跳过，防订阅列表炸弹） */
const MAX_SUB_TOTAL_BYTES = 64 * 1024 * 1024
/** 订阅展开的并发数（按需适度，避免对书源托管站集中请求） */
const SUB_CONCURRENCY = 6
/** 仓库主体请求超时 */
const REPO_TIMEOUT_MS = 20_000
/** 订阅列表内单个书源文件请求超时 */
const SUB_TIMEOUT_MS = 12_000

/**
 * 拉取仓库地址文本，带单响应大小上限。
 * @param url - 仓库或书源文件地址
 * @param timeoutMs - 超时毫秒数
 * @returns 响应文本；超限返回 null
 */
async function fetchLimitedText(url: string, timeoutMs: number): Promise<string | null> {
  const { text } = await fetchText(url, { timeoutMs })
  const bytes = Buffer.byteLength(text, 'utf8')
  return bytes > MAX_PAYLOAD_BYTES ? null : text
}

/**
 * 依次尝试主/备地址，返回首个成功的响应文本。
 * @param meta - 仓库元数据
 * @returns 响应文本；全部失败返回 null
 */
async function fetchRepoText(meta: SourceRepoMeta): Promise<string | null> {
  const urls = meta.alt ? [meta.url, meta.alt] : [meta.url]
  for (const u of urls) {
    try {
      const text = await fetchLimitedText(u, REPO_TIMEOUT_MS)
      if (text != null) return text
    } catch {
      /* 尝试下一个地址 */
    }
  }
  return null
}

/**
 * 从响应文本解析书源列表（兼容 JSON 数组 / 单个对象 / ```json 代码块包裹）。
 * @param text - 原始响应文本
 * @returns 规范化后的书源；无效返回 null
 */
function parsePayload(text: string): BookSource[] | null {
  let body = text.trim()
  body = body.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  if (!body) return null
  try {
    const sources = normalizeSources(JSON.parse(body) as unknown)
    return sources.length ? sources : null
  } catch {
    return null
  }
}

/**
 * 从订阅列表文本提取子书源 URL（跳过空行与 # 注释）。
 * @param text - 订阅列表文本
 * @returns 去重后的 URL 列表，最多 MAX_SUB_URLS 个
 */
function extractSubUrls(text: string): string[] {
  const urls = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && /^https?:\/\//i.test(l))
  return Array.from(new Set(urls)).slice(0, MAX_SUB_URLS)
}

/**
 * 获取单个仓库的全部书源。
 * @param meta - 仓库元数据
 * @returns 书源列表（未跨仓库去重）与错误信息
 */
async function fetchRepo(meta: SourceRepoMeta): Promise<{ sources: BookSource[]; errors: string[] }> {
  const text = await fetchRepoText(meta)
  if (text == null) {
    return { sources: [], errors: [`「${meta.name}」所有地址均不可用或超限`] }
  }

  // json / auto：先尝试整体 JSON 解析
  if (meta.kind === 'json' || meta.kind === 'auto') {
    const sources = parsePayload(text)
    if (sources) return { sources, errors: [] }
    if (meta.kind === 'json') {
      return { sources: [], errors: [`「${meta.name}」返回内容不是有效书源 JSON`] }
    }
  }

  // sub / auto（JSON 失败后）：按订阅列表展开
  const subUrls = extractSubUrls(text)
  if (!subUrls.length) {
    const hint = meta.kind === 'auto' ? '既不是 JSON 也未找到订阅 URL' : '订阅列表未找到有效 URL'
    return { sources: [], errors: [`「${meta.name}」${hint}`] }
  }

  let totalBytes = 0
  const rows = await mapPool(subUrls, SUB_CONCURRENCY, async (u) => {
    if (totalBytes > MAX_SUB_TOTAL_BYTES) return { sources: [] as BookSource[], error: '' }
    try {
      const sub = await fetchLimitedText(u, SUB_TIMEOUT_MS)
      if (sub == null) return { sources: [] as BookSource[], error: `响应超限：${u}` }
      totalBytes += Buffer.byteLength(sub, 'utf8')
      const sources = parsePayload(sub)
      return sources
        ? { sources, error: '' }
        : { sources: [] as BookSource[], error: `不是有效书源 JSON：${u}` }
    } catch (e) {
      return { sources: [] as BookSource[], error: `${(e as Error).message}` }
    }
  })

  const errors: string[] = []
  const sources: BookSource[] = []
  let subOk = 0
  for (const row of rows) {
    if (row.error) {
      errors.push(row.error)
      continue
    }
    subOk += 1
    sources.push(...row.sources)
  }
  if (subOk) errors.push(`「${meta.name}」展开 ${subUrls.length} 个子源，成功 ${subOk}，失败 ${subUrls.length - subOk}`)
  return { sources, errors }
}

/**
 * 从多个仓库在线获取书源，跨仓库按 bookSourceUrl 去重（保留先出现的）。
 * 仓库间串行执行以便推送进度并避免瞬时请求风暴；仓库内订阅展开受并发池约束。
 * @param repos - 待获取仓库（内置 id 或自定义 URL；缺省回退到全部内置仓库）
 * @param onProgress - 进度回调（可选）
 * @returns 去重后的书源、错误信息与仓库成功/失败统计
 */
export async function fetchOnlineSources(
  repos: OnlineRepoRequest[],
  onProgress?: (p: OnlineFetchProgress) => void
): Promise<{
  sources: BookSource[]
  errors: string[]
  stats: { reposOk: number; reposFail: number }
}> {
  const metas: SourceRepoMeta[] = repos
    .map((r) => {
      const builtin = BUILTIN_REPOS.find((b) => b.id === r.id)
      return {
        id: r.id,
        name: r.name || builtin?.name || r.id,
        desc: builtin?.desc || '',
        kind: r.kind || builtin?.kind || 'auto',
        url: r.url || builtin?.url || '',
        alt: r.alt || builtin?.alt
      }
    })
    .filter((m) => m.url)
    .slice(0, 20)

  const byUrl = new Map<string, BookSource>()
  const errors: string[] = []
  let reposOk = 0
  let reposFail = 0
  const total = metas.length

  for (let i = 0; i < total; i++) {
    const meta = metas[i]
    onProgress?.({ repoName: meta.name, done: i, total, found: byUrl.size, phase: 'start' })
    const { sources, errors: repoErrors } = await fetchRepo(meta)
    for (const s of sources) {
      if (s.bookSourceUrl && !byUrl.has(s.bookSourceUrl)) byUrl.set(s.bookSourceUrl, s)
    }
    errors.push(...repoErrors)
    if (sources.length) {
      reposOk += 1
      onProgress?.({ repoName: meta.name, done: i + 1, total, found: byUrl.size, phase: 'done', ok: true })
    } else {
      reposFail += 1
      onProgress?.({ repoName: meta.name, done: i + 1, total, found: byUrl.size, phase: 'done', ok: false })
    }
  }

  return { sources: Array.from(byUrl.values()), errors, stats: { reposOk, reposFail } }
}
