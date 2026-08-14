/**
 * Quick self-check for Legado CSS/XPath/JSON rule parsing.
 * Run: npx tsx scripts/smoke-rules.ts
 */
import { getElements, getString } from '../src/main/legado/analyzeRule'

const html = `
<div class="list">
  <div class="book-item">
    <a href="/book/1.html"><span class="title">测试小说</span></a>
    <span class="author">作者：张三</span>
    <img src="/cover.jpg" />
  </div>
</div>
<ul id="list"><li><a href="/c1.html">第一章</a></li><li><a href="/c2.html">第二章</a></li></ul>
<div id="content"><p>第一段</p><br/><p>第二段</p></div>
`

const items = getElements(html, '.book-item')
console.assert(items.length === 1, 'bookList')
const name = getString(items[0], '.title@text', 'https://example.com')
console.assert(name === '测试小说', 'name=' + name)
const author = getString(items[0], '.author@text##^作者：', 'https://example.com')
console.assert(author === '张三', 'author=' + author)
const href = getString(items[0], 'a@href', 'https://example.com')
console.assert(href === 'https://example.com/book/1.html', 'href=' + href)
const chapter = getString(html, '#list li a@text', 'https://example.com')
console.assert(chapter === '第一章', 'chapter=' + chapter)
const content = getString(html, '#content@text', 'https://example.com')
console.assert(content.includes('第一段'), 'content=' + content)

const json = JSON.stringify({ data: { list: [{ title: 'JSON书', url: '/a' }] } })
const jItems = getElements(json, '$.data.list[*]')
console.assert(jItems.length === 1, 'json list')
console.assert(getString(jItems[0], '$.title') === 'JSON书', 'json title')

console.log('smoke-rules: OK')
