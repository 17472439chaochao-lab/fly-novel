/**
 * 打包后瘦身：清理 better-sqlite3 编译残留，并去掉未使用的 Chromium 语言包。
 */
const fs = require('fs')
const path = require('path')

/** 需要保留的 Electron / Chromium 语言（中英） */
const KEEP_LANG = new Set([
  'en',
  'en-US',
  'en_US',
  'en-GB',
  'en_GB',
  'zh-CN',
  'zh_CN',
  'zh-TW',
  'zh_TW',
  'zh-Hans',
  'zh_Hans',
  'zh-Hant',
  'zh_Hant'
])

/**
 * 递归删除路径（忽略不存在）。
 * @param {string} target
 */
function rm(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

/**
 * 规范化语言标识，便于匹配 pak / lproj 文件名。
 * @param {string} name
 */
function normalizeLang(name) {
  return name.replace(/\.pak$/i, '').replace(/\.lproj$/i, '').replace(/_/g, '-')
}

/**
 * 判断是否应保留该语言资源。
 * @param {string} fileName
 */
function shouldKeepLang(fileName) {
  const base = normalizeLang(fileName)
  if (KEEP_LANG.has(base) || KEEP_LANG.has(base.replace(/-/g, '_'))) return true
  // 允许前缀匹配：en ↔ en-US
  for (const keep of KEEP_LANG) {
    const k = keep.replace(/_/g, '-')
    if (base === k || base.startsWith(`${k}-`) || k.startsWith(`${base}-`)) return true
  }
  return false
}

/**
 * 清理 better-sqlite3 中运行时不需要的源码与编译中间产物。
 * @param {string} appOutDir
 */
function cleanBetterSqlite3(appOutDir) {
  const roots = [
    path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3'),
    path.join(
      appOutDir,
      'FlyNovel.app',
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3'
    )
  ]

  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const rel of ['deps', 'src', 'bin', path.join('build', 'Release', 'obj')]) {
      rm(path.join(root, rel))
    }
    rm(path.join(root, 'build', 'Release', 'test_extension.node'))
  }
}

/**
 * 删除未使用的 Chromium 语言包（Windows/Linux 的 locales/*.pak，macOS 的 *.lproj）。
 * @param {string} appOutDir
 * @param {string} platform
 */
function cleanLocales(appOutDir, platform) {
  const localeDirs = []

  if (platform === 'darwin') {
    localeDirs.push(
      path.join(
        appOutDir,
        'FlyNovel.app',
        'Contents',
        'Frameworks',
        'Electron Framework.framework',
        'Versions',
        'A',
        'Resources'
      )
    )
    localeDirs.push(path.join(appOutDir, 'FlyNovel.app', 'Contents', 'Resources'))
  } else {
    localeDirs.push(path.join(appOutDir, 'locales'))
  }

  for (const dir of localeDirs) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const isLocale =
        name.endsWith('.pak') ||
        name.endsWith('.lproj') ||
        (platform === 'darwin' && name.endsWith('.lproj'))
      if (!isLocale) continue
      if (shouldKeepLang(name)) continue
      rm(path.join(dir, name))
    }
  }
}

/**
 * electron-builder afterPack 钩子。
 * @param {import('electron-builder').AfterPackContext} context
 */
exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir
  const platform = context.electronPlatformName

  cleanBetterSqlite3(appOutDir)
  cleanLocales(appOutDir, platform)
}
