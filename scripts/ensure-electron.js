#!/usr/bin/env node
/**
 * Ensure Electron binary exists after npm install.
 * Uses npmmirror when official download fails / is incomplete.
 * On macOS, renames Electron.app → FlyNovel.app so Dock tooltip shows FlyNovel.
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { createWriteStream } = require('fs')
const https = require('https')
const os = require('os')

const APP_BUNDLE = 'FlyNovel.app'
const electronDir = path.join(__dirname, '..', 'node_modules', 'electron')
const pathTxt = path.join(electronDir, 'path.txt')
const distDir = path.join(electronDir, 'dist')
const binaryRel =
  process.platform === 'darwin'
    ? `${APP_BUNDLE}/Contents/MacOS/Electron`
    : process.platform === 'win32'
      ? 'electron.exe'
      : 'electron'
const binaryAbs = path.join(distDir, binaryRel)

function ok() {
  return fs.existsSync(pathTxt) && fs.existsSync(binaryAbs)
}

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close()
          fs.unlinkSync(dest)
          download(res.headers.location, dest).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`))
          return
        }
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
      })
      .on('error', reject)
  })
}

function setPlist(plist, key, value) {
  try {
    execSync(`/usr/libexec/PlistBuddy -c "Set :${key} ${value}" "${plist}"`, { stdio: 'ignore' })
  } catch {
    try {
      execSync(`/usr/libexec/PlistBuddy -c "Add :${key} string ${value}" "${plist}"`, {
        stdio: 'ignore'
      })
    } catch {
      /* ignore */
    }
  }
}

function patchMacBundle() {
  if (process.platform !== 'darwin') return

  const stock = path.join(distDir, 'Electron.app')
  const renamed = path.join(distDir, APP_BUNDLE)

  // Rename so Dock tooltip / app switcher use FlyNovel instead of Electron
  if (fs.existsSync(stock) && !fs.existsSync(renamed)) {
    fs.renameSync(stock, renamed)
  } else if (fs.existsSync(stock) && fs.existsSync(renamed)) {
    // Prefer renamed; drop leftover stock bundle
    fs.rmSync(stock, { recursive: true, force: true })
  }

  const appRoot = fs.existsSync(renamed) ? renamed : stock
  if (!fs.existsSync(appRoot)) return

  const plist = path.join(appRoot, 'Contents', 'Info.plist')
  if (!fs.existsSync(plist)) return

  setPlist(plist, 'CFBundleName', 'FlyNovel')
  setPlist(plist, 'CFBundleDisplayName', 'FlyNovel')
  setPlist(plist, 'CFBundleIdentifier', 'com.flynovel.app.dev')

  // Optional: replace Dock icon with project icns during development
  const iconSrc = path.join(__dirname, '..', 'build', 'icon.icns')
  const iconDest = path.join(appRoot, 'Contents', 'Resources', 'electron.icns')
  if (fs.existsSync(iconSrc) && fs.existsSync(path.dirname(iconDest))) {
    try {
      fs.copyFileSync(iconSrc, iconDest)
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  if (ok()) {
    fs.writeFileSync(pathTxt, binaryRel)
    patchMacBundle()
    // path may change after rename
    fs.writeFileSync(pathTxt, binaryRel)
    return
  }

  // Also recover if only stock Electron.app exists after rename path mismatch
  const stockBin = path.join(distDir, 'Electron.app/Contents/MacOS/Electron')
  if (fs.existsSync(stockBin)) {
    patchMacBundle()
    fs.writeFileSync(pathTxt, binaryRel)
    if (ok()) return
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8'))
  const version = pkg.version
  const platform = process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const zipName = `electron-v${version}-${platform === 'darwin' ? 'darwin' : platform}-${arch}.zip`
  const mirror = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
  const url = `${mirror.replace(/\/?$/, '/')}${version}/${zipName}`

  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'electron')
  const cached = path.join(cacheDir, zipName)
  const tmpZip = path.join(electronDir, zipName)

  let zipPath = cached
  if (!fs.existsSync(cached)) {
    console.log(`[ensure-electron] downloading ${url}`)
    fs.mkdirSync(cacheDir, { recursive: true })
    await download(url, tmpZip)
    try {
      fs.copyFileSync(tmpZip, cached)
    } catch {
      // ignore cache copy failure
    }
    zipPath = tmpZip
  } else {
    console.log(`[ensure-electron] using cache ${cached}`)
  }

  fs.rmSync(distDir, { recursive: true, force: true })
  fs.mkdirSync(distDir, { recursive: true })
  execSync(`unzip -qo "${zipPath}" -d "${distDir}"`)
  if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip)

  patchMacBundle()
  fs.writeFileSync(pathTxt, binaryRel)

  if (!ok()) {
    console.error('[ensure-electron] failed to install Electron binary')
    process.exit(1)
  }
  console.log(`[ensure-electron] Electron binary ready (${binaryRel})`)
}

main().catch((err) => {
  console.error('[ensure-electron]', err)
  process.exit(1)
})
