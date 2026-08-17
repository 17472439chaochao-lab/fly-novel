import { useMemo, useState } from 'react'
import { isLocalBook } from '../../../shared/bookLocal'
import { isSourceStructuralOk } from '../../../shared/sourceValidity'
import {
  sourceMatchLabel,
  sourceMatchStrength,
  sourceMatchTier,
  sourceSpeedLabel,
  sourceSpeedTag,
  type BookSource,
  type ShelfBook
} from '../../../shared/types'
import {
  IconBroom,
  IconCheck,
  IconClose,
  IconEdit,
  IconExport,
  IconImport,
  IconLink,
  IconTest,
  IconTrash,
  LoadingIcon
} from '../components/icons'

/**
 * 书源管理页：筛选/统计书源，支持文件与 URL 导入、
 * 启用切换、单测/批量测试、编辑 JSON、删除无效源等。
 */
export function SourcesView({
  sources,
  shelf,
  testKeyword,
  onTestKeywordChange,
  onTestKeywordCommit,
  askConfirm,
  showToast,
  onImportFile,
  onSourcesChange
}: {
  sources: BookSource[]
  shelf: ShelfBook[]
  testKeyword: string
  onTestKeywordChange: (v: string) => void
  onTestKeywordCommit: (v: string) => void
  askConfirm: (opts: {
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    extraText?: string
    danger?: boolean
  }) => Promise<'confirm' | 'cancel' | 'extra'>
  showToast: (msg: string) => void
  onImportFile: () => void
  onSourcesChange: (s: BookSource[]) => void
}) {
  const [testingUrl, setTestingUrl] = useState<string | null>(null)
  const [testingAll, setTestingAll] = useState(false)
  const [testProgress, setTestProgress] = useState('')
  const [editing, setEditing] = useState<BookSource | null>(null)
  const [editName, setEditName] = useState('')
  const [editText, setEditText] = useState('')
  const [importUrl, setImportUrl] = useState('')
  const [importingUrl, setImportingUrl] = useState(false)
  const [filter, setFilter] = useState<
    'all' | 'enabled' | 'disabled' | 'ok' | 'fail' | 'structuralBad' | 'untested'
  >('all')

  const shelfCountByOrigin = useMemo(() => {
    const map = new Map<string, number>()
    for (const b of shelf) {
      if (isLocalBook(b) || !b.origin) continue
      map.set(b.origin, (map.get(b.origin) || 0) + 1)
    }
    return map
  }, [shelf])

  const stats = useMemo(() => {
    const total = sources.length
    const enabled = sources.filter((s) => s.enabled !== false).length
    const disabled = total - enabled
    const ok = sources.filter((s) => s.flyTestStatus === 'ok').length
    const fail = sources.filter((s) => s.flyTestStatus === 'fail').length
    const structuralBad = sources.filter((s) => !isSourceStructuralOk(s)).length
    const invalid = sources.filter((s) => {
      if (!isSourceStructuralOk(s)) return true
      return s.flyTestStatus === 'fail'
    }).length
    const untested = sources.filter((s) => !s.flyTestStatus || s.flyTestStatus === 'untested').length
    return { total, enabled, disabled, ok, fail, structuralBad, invalid, untested }
  }, [sources])

  const filteredSources = useMemo(() => {
    const list = sources.filter((s) => {
      switch (filter) {
        case 'enabled':
          return s.enabled !== false
        case 'disabled':
          return s.enabled === false
        case 'ok':
          return s.flyTestStatus === 'ok'
        case 'fail':
          return s.flyTestStatus === 'fail'
        case 'structuralBad':
          return !isSourceStructuralOk(s)
        case 'untested':
          return !s.flyTestStatus || s.flyTestStatus === 'untested'
        default:
          return true
      }
    })
    return list.slice().sort((a, b) => {
      const d =
        sourceMatchStrength(b, shelfCountByOrigin) - sourceMatchStrength(a, shelfCountByOrigin)
      if (d !== 0) return d
      return (a.bookSourceName || '').localeCompare(b.bookSourceName || '', 'zh')
    })
  }, [sources, filter, shelfCountByOrigin])

  /**
   * 切换书源启用状态
   * @param url 书源 URL
   * @param enabled 目标启用状态
   */
  async function onToggle(url: string, enabled: boolean) {
    onSourcesChange(await window.fly.sources.toggle(url, enabled))
  }

  /** 通过订阅 URL 导入书源 */
  async function onImportFromUrl() {
    if (!importUrl.trim() || importingUrl) return
    setImportingUrl(true)
    try {
      const res = await window.fly.sources.importUrl(importUrl.trim())
      showToast(res.message)
      if (res.ok && res.sources) {
        onSourcesChange(res.sources)
        if (res.message.includes('新增')) setImportUrl('')
      }
    } catch (e) {
      showToast(`URL 导入失败：${(e as Error).message}`)
    } finally {
      setImportingUrl(false)
    }
  }

  /**
   * 确认后删除单个书源
   * @param url 书源 URL
   */
  async function onRemove(url: string) {
    const target = sources.find((s) => s.bookSourceUrl === url)
    const name = target?.bookSourceName || url
    const result = await askConfirm({
      title: '删除书源',
      message: `确定删除书源「${name}」？删除后不可恢复。`,
      confirmText: '删除',
      danger: true
    })
    if (result !== 'confirm') return
    onSourcesChange(await window.fly.sources.remove(url))
    showToast('已删除书源')
  }

  /**
   * 测试单个书源可用性
   * @param url 书源 URL
   */
  async function onTestOne(url: string) {
    setTestingUrl(url)
    try {
      const { result, sources: next } = await window.fly.sources.test(url, testKeyword)
      onSourcesChange(next)
      showToast(result.ok ? `可用：${result.message}` : `失效：${result.message}`)
    } catch (e) {
      showToast(`测试失败：${(e as Error).message}`)
    } finally {
      setTestingUrl(null)
    }
  }

  /** 批量测试当前筛选条件下的全部书源 */
  async function onTestCurrent() {
    if (!filteredSources.length || testingAll) return
    const urls = filteredSources.map((s) => s.bookSourceUrl)
    const filterLabel = filterItems.find((f) => f.id === filter)?.label || '当前'
    setTestingAll(true)
    setTestProgress(`0/${urls.length}`)
    const off = window.fly.sources.onTestProgress((p) => {
      setTestProgress(
        p.phase === 'done'
          ? '完成'
          : `${p.done}/${p.total}${p.current ? ` · ${p.current}` : ''}`
      )
    })
    try {
      const next = await window.fly.sources.testAll(testKeyword, urls)
      onSourcesChange(next)
      const tested = next.filter((s) => urls.includes(s.bookSourceUrl))
      const ok = tested.filter((s) => s.flyTestStatus === 'ok').length
      const fail = tested.filter((s) => s.flyTestStatus === 'fail').length
      showToast(`「${filterLabel}」测试完成：可用 ${ok}，失效 ${fail}`)
    } catch (e) {
      showToast(`批量测试失败：${(e as Error).message}`)
    } finally {
      off()
      setTestingAll(false)
      setTestProgress('')
    }
  }

  /** 确认后删除规则残缺或测试失败的无效书源 */
  async function onRemoveInvalid() {
    if (!stats.invalid) {
      showToast('当前没有可清理的无效书源（需先测试，或存在规则残缺）')
      return
    }
    const result = await askConfirm({
      title: '删除无效书源',
      message: `将删除 ${stats.invalid} 个无效书源（规则残缺或测试失败），此操作不可撤销。`,
      confirmText: '全部删除',
      danger: true
    })
    if (result !== 'confirm') return
    const { sources: next, removed } = await window.fly.sources.removeInvalid()
    onSourcesChange(next)
    showToast(removed ? `已删除 ${removed} 个无效书源` : '没有删除任何书源')
  }

  /** 将当前筛选下的书源导出为 JSON 文件 */
  async function onExportCurrent() {
    if (!filteredSources.length) {
      showToast('当前没有可导出的书源')
      return
    }
    const res = await window.fly.sources.exportFile(filteredSources.map((s) => s.bookSourceUrl))
    if (res.message !== '已取消') showToast(res.message)
  }

  /**
   * 打开书源编辑弹窗并填充名称与 JSON
   * @param s 待编辑书源
   */
  function openEdit(s: BookSource) {
    setEditing(s)
    setEditName(s.bookSourceName || '')
    const { bookSourceName: _name, ...rest } = s
    setEditText(JSON.stringify(rest, null, 2))
  }

  /** 校验并保存编辑中的书源 JSON */
  async function saveEdit() {
    if (!editing) return
    const name = editName.trim()
    if (!name) {
      showToast('书源名称不能为空')
      return
    }
    try {
      const parsed = JSON.parse(editText) as BookSource
      parsed.bookSourceName = name
      if (!parsed.bookSourceUrl?.trim()) {
        showToast('书源 URL 不能为空')
        return
      }
      const next = await window.fly.sources.update(editing.bookSourceUrl, parsed)
      onSourcesChange(next)
      setEditing(null)
      showToast('书源已保存')
    } catch (e) {
      showToast(`保存失败：${(e as Error).message}`)
    }
  }

  /**
   * 根据结构完整性与测试状态生成状态徽章文案与样式类
   * @param s 书源对象
   */
  function statusLabel(s: BookSource) {
    if (!isSourceStructuralOk(s)) {
      return { text: '规则残缺', cls: 'badge bad' }
    }
    if (s.flyTestStatus === 'ok') return { text: '可用', cls: 'badge ok' }
    if (s.flyTestStatus === 'fail') return { text: '失效', cls: 'badge bad' }
    return { text: '未测试', cls: 'badge mute' }
  }

  const filterItems = [
    { id: 'all' as const, label: '全部', count: stats.total },
    { id: 'enabled' as const, label: '启用', count: stats.enabled },
    { id: 'disabled' as const, label: '禁用', count: stats.disabled },
    { id: 'ok' as const, label: '可用', count: stats.ok },
    { id: 'fail' as const, label: '失效', count: stats.fail },
    { id: 'structuralBad' as const, label: '残缺', count: stats.structuralBad },
    { id: 'untested' as const, label: '未测', count: stats.untested }
  ]

  return (
    <div>
      <div className="panel-head">
        <div>
          <h2>书源管理</h2>
          <p>匹配度高的书源会优先参与搜索（含书架常用源），不单看速度标签</p>
        </div>
        <button className="btn" onClick={onImportFile}>
          <IconImport />
          从文件导入
        </button>
      </div>

      <div className="stats-bar" role="tablist" aria-label="书源筛选">
        {filterItems.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            className={`stats-chip${filter === item.id ? ' active' : ''}`}
            onClick={() => setFilter(item.id)}
          >
            {item.label} <b>{item.count}</b>
          </button>
        ))}
      </div>

      <div className="source-toolbar">
        <input
          className="test-keyword"
          value={testKeyword}
          onChange={(e) => onTestKeywordChange(e.target.value)}
          onBlur={(e) => onTestKeywordCommit(e.target.value)}
          placeholder="测试关键词"
          disabled={testingAll || !!testingUrl}
        />
        <button
          className="btn ghost"
          disabled={!filteredSources.length || testingAll}
          title="测试当前顶部筛选分类中的书源"
          onClick={() => void onTestCurrent()}
        >
          {testingAll ? (
            <>
              <LoadingIcon /> 测试中 {testProgress}
            </>
          ) : (
            <>
              <IconTest />
              测试当前（{filteredSources.length}）
            </>
          )}
        </button>
        <button
          className="btn ghost"
          disabled={!stats.invalid || testingAll}
          onClick={() => void onRemoveInvalid()}
        >
          <IconBroom />
          删除无效（{stats.invalid}）
        </button>
        <button
          className="btn ghost"
          disabled={!filteredSources.length || testingAll}
          title="导出当前顶部筛选分类中的书源为 JSON"
          onClick={() => void onExportCurrent()}
        >
          <IconExport />
          导出（{filteredSources.length}）
        </button>
      </div>

      <div className="import-url-row">
        <input
          value={importUrl}
          onChange={(e) => setImportUrl(e.target.value)}
          placeholder="书源订阅 URL，例如 https://example.com/sources.json"
          disabled={importingUrl}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onImportFromUrl()
          }}
        />
        <button
          className="btn ghost"
          disabled={!importUrl.trim() || importingUrl}
          onClick={() => void onImportFromUrl()}
        >
          {importingUrl ? <LoadingIcon /> : <IconLink />}
          {importingUrl ? '导入中' : '从 URL 导入'}
        </button>
      </div>

      {!sources.length ? (
        <div className="empty">尚未导入书源</div>
      ) : !filteredSources.length ? (
        <div className="empty">当前筛选下没有书源</div>
      ) : (
        <div className="source-list" style={{ marginTop: 18 }}>
          {filteredSources.map((s) => {
            const st = statusLabel(s)
            const busy = testingUrl === s.bookSourceUrl
            const speedTag = sourceSpeedTag(s)
            const speedLabel = sourceSpeedLabel(s)
            const matchScore = sourceMatchStrength(s, shelfCountByOrigin)
            const matchTier = sourceMatchTier(matchScore)
            const matchLabel = sourceMatchLabel(matchScore)
            return (
              <div className="source-row" key={s.bookSourceUrl}>
                <div className="info">
                  <strong>
                    {s.bookSourceName} <span className={st.cls}>{st.text}</span>
                    {speedLabel && speedTag ? (
                      <span className={`badge speed-${speedTag}`} title="根据测试响应速度自动标记">
                        {speedLabel}
                      </span>
                    ) : null}
                    {matchLabel && matchTier ? (
                      <span
                        className={`badge match-${matchTier}`}
                        title={`搜索匹配度 ${Math.round(matchScore)}（含书架使用加权），越高搜索越优先`}
                      >
                        {matchLabel}
                        {matchScore >= 1 ? ` ${Math.round(matchScore)}` : ''}
                      </span>
                    ) : null}
                  </strong>
                  <span>
                    {s.bookSourceGroup ? `${s.bookSourceGroup} · ` : ''}
                    {s.bookSourceUrl}
                  </span>
                  {s.flyTestMessage ? (
                    <span className="test-msg">
                      {s.flyRespondMs != null ? `${s.flyRespondMs}ms · ` : ''}
                      {s.flyTestMessage}
                    </span>
                  ) : null}
                </div>
                <div className="row-actions">
                  <button
                    className={`switch ${s.enabled !== false ? 'on' : ''}`}
                    onClick={() => void onToggle(s.bookSourceUrl, s.enabled === false)}
                    aria-label="启用"
                    disabled={testingAll}
                  >
                    <i />
                  </button>
                  <button
                    className="btn ghost"
                    disabled={testingAll || busy}
                    onClick={() => void onTestOne(s.bookSourceUrl)}
                  >
                    {busy ? <LoadingIcon /> : <IconTest />}
                    {busy ? '测试中' : '测试'}
                  </button>
                  <button className="btn ghost" disabled={testingAll} onClick={() => openEdit(s)}>
                    <IconEdit />
                    编辑
                  </button>
                  <button
                    className="btn ghost"
                    disabled={testingAll}
                    onClick={() => void onRemove(s.bookSourceUrl)}
                  >
                    <IconTrash />
                    删除
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing ? (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>编辑书源</h3>
              <button className="btn ghost icon-btn" title="关闭" onClick={() => setEditing(null)}>
                <IconClose />
              </button>
            </div>
            <div className="edit-name-field">
              <label htmlFor="edit-source-name">书源名称</label>
              <input
                id="edit-source-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="输入书源名称"
                autoFocus
              />
            </div>
            <textarea
              className="modal-editor"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              spellCheck={false}
            />
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setEditing(null)}>
                <IconClose />
                取消
              </button>
              <button className="btn" onClick={() => void saveEdit()}>
                <IconCheck />
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
