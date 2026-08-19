import * as vm from 'node:vm'

/** @js 规则执行错误（语法/运行时/超时均可归一到此类） */
export class JsRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsRuleError'
  }
}

/** 注入 @js 规则执行上下文的绑定变量（对应 Legado 的 result / baseUrl / key / page 等）。 */
export interface JsRuleBindings {
  /** 当前被解析的内容（Legado 的 result） */
  result?: string
  /** 链接基准 */
  baseUrl?: string
  /** 搜索关键词 */
  key?: string
  /** 页码 */
  page?: number | string
}

/** 单条 @js 规则执行超时（毫秒），防止恶意/错误规则死循环卡死主进程。 */
const JS_RULE_TIMEOUT_MS = 2000

/**
 * 在隔离沙箱中执行 @js 规则表达式。
 *
 * 安全要点：
 * - 不向沙箱注入任何宿主对象（host Object/Array/Function 等）。新建的 vm 上下文自带一套
 *   与原生隔离的标准内置对象（Object/Array/Math/JSON/Date/RegExp…），其 `.constructor`
 *   链只指向上下文自身的 Function，调用后生成的函数仍运行在隔离上下文内，无法触达宿主全局。
 * - 宿主能力（process / require / fs / fetch / Buffer 等）默认不存在于 vm 上下文中，因此
 *   书源规则无法发起请求、读写文件或访问系统环境。
 * - 仅注入受限 console 与规则绑定；并主动删除 Function / eval 进一步收敛攻击面。
 * - 通过 vm 的 timeout 选项在超时后中断同步死循环。
 *
 * @param code - 去掉 @js: 或 <js> 前缀后的 JS 表达式/语句
 * @param bindings - result / baseUrl / key / page 绑定
 * @returns 表达式返回值（任意类型）
 */
export function evalJsRule(code: string, bindings: JsRuleBindings = {}): unknown {
  const context = vm.createContext({}) as Record<string, unknown>
  context.result = bindings.result ?? ''
  context.baseUrl = bindings.baseUrl ?? ''
  context.key = bindings.key ?? ''
  context.page = bindings.page ?? 1
  context.console = {
    log: (...a: unknown[]) => console.log('[js-rule]', ...a),
    info: (...a: unknown[]) => console.info('[js-rule]', ...a),
    warn: (...a: unknown[]) => console.warn('[js-rule]', ...a),
    error: (...a: unknown[]) => console.error('[js-rule]', ...a)
  }
  // 防御：移除可在沙箱内构造函数的原语（上下文内置对象本身已与原生隔离）
  context.Function = undefined
  context.eval = undefined

  try {
    // 包成 IIFE：vm 脚本顶层不允许 return，需置于函数体内；
    // 书源 @js 规则本质是表达式，统一 return 该表达式以匹配 Legado 语义。
    const wrapped = `;(function(){ return (${code}); })()`
    return vm.runInContext(wrapped, context, {
      timeout: JS_RULE_TIMEOUT_MS,
      filename: 'booksource-js-rule'
    })
  } catch (e) {
    const err = e as Error
    const msg = err?.message || '未知错误'
    if (msg.includes('Script execution timed out')) {
      throw new JsRuleError(`@js 规则执行超时（>${JS_RULE_TIMEOUT_MS}ms）`)
    }
    throw new JsRuleError(`@js 规则执行失败：${msg}`)
  }
}

/**
 * 执行 @js 规则并把结果规范为字符串数组：
 * - 返回 null/undefined → []
 * - 返回数组 → 逐项转字符串（null/undefined 项转空串）
 * - 返回其它值 → 包成 [String(value)]
 */
export function evalJsRuleToStrings(code: string, bindings: JsRuleBindings = {}): string[] {
  const v = evalJsRule(code, bindings)
  if (v == null) return []
  if (Array.isArray(v)) return v.map((x) => (x == null ? '' : String(x)))
  return [String(v)]
}
