import { app, BrowserWindow } from 'electron'

/**
 * 精简版环境判断，替代 @electron-toolkit 相关辅助。
 */
export const is = {
  /**
   * 是否为开发模式（未打包）。
   * @returns 未打包时为 true
   */
  get dev(): boolean {
    return !app.isPackaged
  }
}

/**
 * Windows 下设置应用用户模型 ID 的辅助对象。
 */
export const electronApp = {
  /**
   * 在 Windows 上设置 AppUserModelId（任务栏分组等）。
   * @param id - 用户模型 ID 字符串
   */
  setAppUserModelId(id: string): void {
    if (process.platform === 'win32') {
      app.setAppUserModelId(id)
    }
  }
}

/**
 * 窗口快捷键相关辅助。
 */
export const optimizer = {
  /**
   * 监听窗口按键：按下 F12 时切换开发者工具。
   * @param window - 目标 BrowserWindow
   */
  watchWindowShortcuts(window: BrowserWindow): void {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        window.webContents.toggleDevTools()
        event.preventDefault()
      }
    })
  }
}
