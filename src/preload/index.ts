import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppPrefs,
  BookCacheInfo,
  BookCacheProgress,
  BookSource,
  ReaderSettings,
  SearchBook,
  SearchProgress,
  ShelfBook,
  SourceTestResult
} from '../shared/types'
import type { UpdateCheckResult } from '../shared/updateCheck'

export type { SearchProgress }

/** 书源批量测试进度事件载荷 */
export type SourceTestProgress = {
  done: number
  total: number
  current: string
  phase: 'start' | 'progress' | 'done'
  ok?: boolean
}

const api = {
  /** 获取应用完整初始状态（书源、书架、设置、偏好等） */
  getState: () => ipcRenderer.invoke('app:getState'),
  /** 获取当前应用版本号 */
  getVersion: () => ipcRenderer.invoke('app:getVersion') as Promise<string>,
  /**
   * 检查 Gitee 发行版是否有新版本（仅提示，不自动安装）
   */
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate') as Promise<UpdateCheckResult>,
  /**
   * 用系统默认浏览器打开外链
   * @param url http(s) 地址
   */
  openExternal: (url: string) =>
    ipcRenderer.invoke('app:openExternal', url) as Promise<{ ok: boolean; message?: string }>,
  sources: {
    /** 列出全部书源 */
    list: () => ipcRenderer.invoke('sources:list') as Promise<BookSource[]>,
    /** 通过系统文件选择器导入书源文件 */
    importFile: () =>
      ipcRenderer.invoke('sources:importFile') as Promise<{
        ok: boolean
        message: string
        sources?: BookSource[]
      }>,
    /**
     * 通过订阅 URL 导入书源
     * @param url 书源 JSON 订阅地址
     */
    importUrl: (url: string) =>
      ipcRenderer.invoke('sources:importUrl', url) as Promise<{
        ok: boolean
        message: string
        sources?: BookSource[]
      }>,
    /**
     * 导出书源为 JSON 文件（可按 URL 列表限定范围）
     * @param urls 可选，限定导出的书源 URL；缺省导出全部
     */
    exportFile: (urls?: string[]) =>
      ipcRenderer.invoke('sources:exportFile', urls) as Promise<{
        ok: boolean
        message: string
        count?: number
        path?: string
      }>,
    /**
     * 启用或禁用指定书源
     * @param url 书源 URL
     * @param enabled 是否启用
     */
    toggle: (url: string, enabled: boolean) =>
      ipcRenderer.invoke('sources:toggle', url, enabled) as Promise<BookSource[]>,
    /**
     * 删除指定书源
     * @param url 书源 URL
     */
    remove: (url: string) => ipcRenderer.invoke('sources:remove', url) as Promise<BookSource[]>,
    /**
     * 用新内容更新书源（可更换 URL）
     * @param oldUrl 原书源 URL
     * @param source 更新后的书源对象
     */
    update: (oldUrl: string, source: BookSource) =>
      ipcRenderer.invoke('sources:update', oldUrl, source) as Promise<BookSource[]>,
    /**
     * 测试单个书源是否可用
     * @param url 书源 URL
     * @param keyword 可选测试关键词
     */
    test: (url: string, keyword?: string) =>
      ipcRenderer.invoke('sources:test', url, keyword) as Promise<{
        result: SourceTestResult
        sources: BookSource[]
      }>,
    /**
     * 批量测试书源
     * @param keyword 可选测试关键词
     * @param urls 可选限定测试的书源 URL 列表
     */
    testAll: (keyword?: string, urls?: string[]) =>
      ipcRenderer.invoke('sources:testAll', keyword, urls) as Promise<BookSource[]>,
    /**
     * 订阅书源测试进度事件
     * @param cb 进度回调
     * @returns 取消订阅函数
     */
    onTestProgress: (cb: (p: SourceTestProgress) => void) => {
      /** 将主进程进度事件转发给回调 */
      const listener = (_: IpcRendererEvent, p: SourceTestProgress) => cb(p)
      ipcRenderer.on('sources:test-progress', listener)
      return () => ipcRenderer.removeListener('sources:test-progress', listener)
    },
    /** 删除规则残缺或测试失败的无效书源 */
    removeInvalid: () =>
      ipcRenderer.invoke('sources:removeInvalid') as Promise<{
        sources: BookSource[]
        removed: number
      }>
  },
  books: {
    /**
     * 多书源并发搜索小说
     * @param keyword 搜索关键词
     */
    search: (keyword: string) =>
      ipcRenderer.invoke('books:search', keyword) as Promise<{
        books: SearchBook[]
        history: string[]
        sources?: BookSource[]
      }>,
    /**
     * 订阅搜索进度事件
     * @param cb 进度回调
     * @returns 取消订阅函数
     */
    onSearchProgress: (cb: (p: SearchProgress) => void) => {
      /** 将主进程搜索进度转发给回调 */
      const listener = (_: IpcRendererEvent, p: SearchProgress) => cb(p)
      ipcRenderer.on('books:search-progress', listener)
      return () => ipcRenderer.removeListener('books:search-progress', listener)
    },
    /**
     * 订阅搜索中间结果（部分命中）事件
     * @param cb 中间结果回调
     * @returns 取消订阅函数
     */
    onSearchPartial: (cb: (books: SearchBook[]) => void) => {
      /** 将主进程部分搜索结果转发给回调 */
      const listener = (_: IpcRendererEvent, books: SearchBook[]) => cb(books)
      ipcRenderer.on('books:search-partial', listener)
      return () => ipcRenderer.removeListener('books:search-partial', listener)
    },
    /** 获取搜索历史关键词列表 */
    history: () => ipcRenderer.invoke('search:history') as Promise<string[]>,
    /** 清空全部搜索历史 */
    clearHistory: () => ipcRenderer.invoke('search:clearHistory') as Promise<string[]>,
    /**
     * 删除单条搜索历史
     * @param keyword 要删除的关键词
     */
    removeHistory: (keyword: string) =>
      ipcRenderer.invoke('search:removeHistory', keyword) as Promise<string[]>,
    /**
     * 拉取书籍详情信息
     * @param origin 书源 origin
     * @param bookUrl 书籍详情页 URL
     */
    info: (origin: string, bookUrl: string) => ipcRenderer.invoke('books:info', origin, bookUrl),
    /**
     * 拉取书籍目录
     * @param origin 书源 origin
     * @param tocUrl 目录页 URL
     */
    toc: (origin: string, tocUrl: string) => ipcRenderer.invoke('books:toc', origin, tocUrl),
    /**
     * 拉取章节正文
     * @param origin 书源 origin
     * @param chapterUrl 章节 URL
     * @param bookId 可选书架书籍 ID（用于本地缓存）
     */
    content: (origin: string, chapterUrl: string, bookId?: string) =>
      ipcRenderer.invoke('books:content', origin, chapterUrl, bookId) as Promise<string>,
    /**
     * 列出某本书已缓存的章节 URL
     * @param bookId 书架书籍 ID
     */
    cachedUrls: (bookId: string) =>
      ipcRenderer.invoke('books:cachedUrls', bookId) as Promise<string[]>,
    /**
     * 预加载后续章节到本地缓存
     * @param origin 书源 origin
     * @param bookId 书架书籍 ID
     * @param chapterUrls 待预加载的章节 URL 列表
     */
    preload: (origin: string, bookId: string, chapterUrls: string[]) =>
      ipcRenderer.invoke('books:preload', origin, bookId, chapterUrls) as Promise<string[]>
  },
  shelf: {
    /** 获取书架全部书籍 */
    list: () => ipcRenderer.invoke('shelf:list') as Promise<ShelfBook[]>,
    /**
     * 新增或更新书架书籍
     * @param book 书架书籍对象
     */
    upsert: (book: ShelfBook) => ipcRenderer.invoke('shelf:upsert', book) as Promise<ShelfBook[]>,
    /**
     * 仅更新阅读进度（滚动位置、章节索引等）
     * @param id 书籍 ID
     * @param patch 进度补丁字段
     */
    patchProgress: (
      id: string,
      patch: { scrollTop?: number; chapterIndex?: number; lastReadAt?: number }
    ) =>
      ipcRenderer.invoke('shelf:patchProgress', id, patch) as Promise<ShelfBook | null>,
    /**
     * 从书架移除书籍
     * @param id 书籍 ID
     */
    remove: (id: string) => ipcRenderer.invoke('shelf:remove', id) as Promise<ShelfBook[]>,
    /** 通过系统文件选择器导入本地 TXT/EPUB */
    importLocal: () =>
      ipcRenderer.invoke('shelf:importLocal') as Promise<{
        ok: boolean
        message: string
        book?: ShelfBook
        shelf?: ShelfBook[]
      }>,
    /** 更新书架上全部在线书籍的目录与元信息 */
    updateAll: () => ipcRenderer.invoke('shelf:updateAll') as Promise<ShelfBook[]>,
    /**
     * 开始缓存指定书籍的全部章节
     * @param id 书籍 ID
     */
    cacheBook: (id: string) => ipcRenderer.invoke('shelf:cacheBook', id) as Promise<ShelfBook[]>,
    /**
     * 取消正在进行的缓存任务
     * @param id 书籍 ID
     */
    cancelCache: (id: string) => ipcRenderer.invoke('shelf:cancelCache', id) as Promise<ShelfBook[]>,
    /**
     * 将已缓存书籍导出为 TXT 文件
     * @param id 书籍 ID
     */
    exportTxt: (id: string) =>
      ipcRenderer.invoke('shelf:exportTxt', id) as Promise<{
        ok: boolean
        message: string
        path?: string
        exported?: number
        total?: number
      }>,
    /**
     * 查询书籍缓存状态
     * @param id 书籍 ID
     */
    cacheStatus: (id: string) =>
      ipcRenderer.invoke('shelf:cacheStatus', id) as Promise<BookCacheInfo | null>,
    /**
     * 订阅书架全部更新进度事件
     * @param cb 进度回调
     * @returns 取消订阅函数
     */
    onUpdateProgress: (cb: (p: SourceTestProgress) => void) => {
      /** 将主进程书架更新进度转发给回调 */
      const listener = (_: IpcRendererEvent, p: SourceTestProgress) => cb(p)
      ipcRenderer.on('shelf:update-progress', listener)
      return () => {
        ipcRenderer.removeListener('shelf:update-progress', listener)
      }
    },
    /**
     * 订阅单本缓存进度事件
     * @param cb 进度回调
     * @returns 取消订阅函数
     */
    onCacheProgress: (cb: (p: BookCacheProgress) => void) => {
      /** 将主进程缓存进度转发给回调 */
      const listener = (_: IpcRendererEvent, p: BookCacheProgress) => cb(p)
      ipcRenderer.on('shelf:cache-progress', listener)
      return () => {
        ipcRenderer.removeListener('shelf:cache-progress', listener)
      }
    }
  },
  settings: {
    /** 获取阅读器设置 */
    get: () => ipcRenderer.invoke('settings:get') as Promise<ReaderSettings>,
    /**
     * 保存阅读器设置
     * @param settings 完整阅读设置对象
     */
    save: (settings: ReaderSettings) =>
      ipcRenderer.invoke('settings:save', settings) as Promise<ReaderSettings>,
    /**
     * 添加一条正文净化规则
     * @param rule 净化匹配文本或规则
     */
    addPurify: (rule: string) =>
      ipcRenderer.invoke('settings:addPurify', rule) as Promise<ReaderSettings>,
    /**
     * 删除一条正文净化规则
     * @param rule 要删除的规则
     */
    removePurify: (rule: string) =>
      ipcRenderer.invoke('settings:removePurify', rule) as Promise<ReaderSettings>
  },
  fonts: {
    /** 列出系统可用字体名称 */
    list: () => ipcRenderer.invoke('fonts:list') as Promise<string[]>
  },
  prefs: {
    /** 获取应用偏好设置 */
    get: () => ipcRenderer.invoke('prefs:get') as Promise<AppPrefs>,
    /**
     * 部分更新应用偏好（含老板键等）
     * @param patch 偏好补丁字段
     */
    save: (patch: Partial<AppPrefs>) =>
      ipcRenderer.invoke('prefs:save', patch) as Promise<{
        prefs: AppPrefs
        bossKey: { ok: boolean; message: string }
      }>
  },
  /**
   * 订阅老板键隐藏/显示状态（隐藏时不计时、不弹护眼提醒）
   * @param cb 回调；hidden 为 true 表示已老板键隐藏
   * @returns 取消订阅函数
   */
  onBossVisibility: (cb: (payload: { hidden: boolean }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { hidden: boolean }) => cb(payload)
    ipcRenderer.on('app:boss-visibility', listener)
    return () => {
      ipcRenderer.removeListener('app:boss-visibility', listener)
    }
  }
}

contextBridge.exposeInMainWorld('fly', api)

/** 暴露给渲染进程的 FlyNovel 预加载 API 类型 */
export type FlyApi = typeof api
