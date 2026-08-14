/**
 * 按净化规则做字面量子串删除（非正则）。
 * @param text 待净化正文
 * @param rules 要删除的子串列表
 * @returns 删除匹配片段后的文本
 */
export function applyPurify(text: string, rules: string[]): string {
  let out = text || ''
  for (const rule of rules || []) {
    const r = (rule || '').trim()
    if (!r) continue
    if (out.includes(r)) out = out.split(r).join('')
  }
  return out
}
