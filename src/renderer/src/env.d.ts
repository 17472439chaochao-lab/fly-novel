import type { FlyApi } from '../../preload/index'

declare global {
  interface Window {
    /** 预加载脚本通过 contextBridge 暴露的 FlyNovel IPC API */
    fly: FlyApi
  }
}

export {}
