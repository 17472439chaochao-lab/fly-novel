/** 应用身份信息与开源致谢（关于页展示用）。 */
export const APP_ABOUT = {
  name: 'FlyNovel',
  version: '1.0.0',
  author: '飞鸟传说',
  qq: '17472439',
  email: '17472439chaochao@gmail.com',
  repo: 'https://gitee.com/wucc513721/fly-novel',
  /** Gitee 仓库路径，用于 Releases 版本检查 */
  giteeOwner: 'wucc513721',
  giteeRepo: 'fly-novel',
  /** 发行版列表页（无最新版 API 时的兜底打开地址） */
  releasesUrl: 'https://gitee.com/wucc513721/fly-novel/releases',
  license: 'MIT',
  tagline: '轻量小说阅读器 · 支持 Legado 书源',
  features:
    '支持本地 TXT / EPUB 小说阅读，在线小说搜索与阅读，以及导出功能。',
  opensourceNote:
    '本软件为开源项目，采用 MIT 许可证发布。欢迎学习、使用与二次开发；请在衍生作品中保留原作者信息与开源声明。',
  components: [
    { name: 'Electron', desc: '跨平台桌面应用运行时', license: 'MIT' },
    { name: 'React', desc: '界面框架', license: 'MIT' },
    { name: 'TypeScript', desc: '类型系统与编译', license: 'Apache-2.0' },
    { name: 'Vite / electron-vite', desc: '开发构建工具链', license: 'MIT' },
    { name: 'electron-builder', desc: '应用打包', license: 'MIT' },
    { name: 'better-sqlite3', desc: '本地 SQLite 数据存储', license: 'MIT' },
    { name: 'cheerio', desc: 'HTML 解析（书源规则）', license: 'MIT' },
    { name: '@xmldom/xmldom + xpath', desc: 'XML / XPath 解析', license: 'MIT' },
    { name: 'jsonpath-plus', desc: 'JSONPath 解析', license: 'MIT' },
    { name: 'iconv-lite', desc: '网页编码转换', license: 'MIT' },
    { name: 'jszip', desc: 'EPUB（ZIP）解压与解析', license: 'MIT / GPLv3' }
  ]
} as const
