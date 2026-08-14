import { net } from 'electron'
import { APP_ABOUT } from '../shared/about'
import {
  compareVersions,
  normalizeVersion,
  type UpdateCheckResult
} from '../shared/updateCheck'

/**
 * 用 Electron net 发起 GET 并解析 JSON。
 * @param url 请求地址
 * @returns 解析后的对象；非 2xx 时抛错（带状态码）
 */
async function fetchJson(url: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url })
    request.setHeader('Accept', 'application/json')
    request.setHeader('User-Agent', `${APP_ABOUT.name}-updater`)
    const chunks: Buffer[] = []
    request.on('response', (response) => {
      const status = response.statusCode || 0
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text) {
          resolve({ status, data: null })
          return
        }
        try {
          resolve({ status, data: JSON.parse(text) })
        } catch (e) {
          reject(new Error(`解析更新信息失败：${(e as Error).message}`))
        }
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * 向 Gitee Releases 查询最新发行版，与当前应用版本比较。
 * 不自动下载安装，仅返回是否有更新及发行页链接。
 * @param currentVersion 当前应用版本（通常为 app.getVersion()）
 */
export async function checkGiteeUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  const current = normalizeVersion(currentVersion) || APP_ABOUT.version
  const api = `https://gitee.com/api/v5/repos/${APP_ABOUT.giteeOwner}/${APP_ABOUT.giteeRepo}/releases/latest`

  try {
    const { status, data } = await fetchJson(api)
    if (status === 404) {
      return {
        status: 'noRelease',
        currentVersion: current,
        message: '仓库尚未发布发行版，请稍后再试或前往仓库查看'
      }
    }
    if (status < 200 || status >= 300 || !data || typeof data !== 'object') {
      return {
        status: 'error',
        currentVersion: current,
        message: `检查更新失败（HTTP ${status}）`
      }
    }

    const release = data as {
      tag_name?: string
      name?: string
      body?: string
      html_url?: string
    }
    const latestRaw = release.tag_name || release.name || ''
    const latest = normalizeVersion(latestRaw)
    if (!latest) {
      return {
        status: 'noRelease',
        currentVersion: current,
        message: '最新发行版缺少有效版本号'
      }
    }

    const releaseUrl =
      release.html_url ||
      `${APP_ABOUT.releasesUrl}/tag/${encodeURIComponent(release.tag_name || latestRaw)}`

    if (compareVersions(latest, current) > 0) {
      return {
        status: 'available',
        currentVersion: current,
        latestVersion: latest,
        releaseUrl,
        releaseName: release.name || undefined,
        releaseNotes: typeof release.body === 'string' ? release.body.trim() : undefined
      }
    }

    return {
      status: 'upToDate',
      currentVersion: current,
      latestVersion: latest
    }
  } catch (e) {
    return {
      status: 'error',
      currentVersion: current,
      message: (e as Error).message || '网络错误，无法检查更新'
    }
  }
}
