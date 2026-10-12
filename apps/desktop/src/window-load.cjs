// @ts-check
'use strict'
/**
 * 主窗口加载：把「导航被取代 / 主动中止」与「真正连不上本地服务」区分开。
 *
 * 背景（用户长期反馈的「StudyClaw 启动失败 ... ERR_ABORTED (-3) loading 'http://127.0.0.1:<port>/'」）：
 * `win.loadURL()` 返回的 Promise 在以下情况都会以 `ERR_ABORTED` 拒绝，而它们都**不是**
 * 启动失败：
 *   - 初始加载尚未完成时又发起了新的导航（页面自导航、崩溃重启换端口重载、菜单 reload、
 *     自动化/外部工具导航窗口）；
 *   - 窗口在加载途中被关闭或应用正在退出。
 * 旧实现把任何拒绝都当致命错误 → 弹「启动失败」并 `app.quit()`，于是用户在正常使用中也会
 * 遇到这个弹窗。这里改为：被取代/退出中直接视为完成；ERR_ABORTED 时等一次
 * `did-finish-load`（页面通常马上加载完成），只有窗口始终没有加载出页面才按真实失败上报。
 */

/** ERR_ABORTED 在 Chromium 里的数值是 -3；消息里两种形态都可能出现。 */
const ABORTED_RE = /ERR_ABORTED|\(-3\)/

/**
 * @param {object} win Electron BrowserWindow 形状的窗口（loadURL/isDestroyed/webContents）
 * @param {string} url 目标地址
 * @param {{ isSuperseded?: () => boolean, isQuitting?: () => boolean, abortGraceMs?: number }} [state]
 *   isSuperseded：本次加载是否已被更新的导航取代；isQuitting：应用是否正在退出。
 * @returns {Promise<{ ok: true } | { ok: false, error: unknown }>} `ok: false` 才是真正的启动失败。
 */
async function loadWindowUrl(win, url, state = {}) {
  const isSuperseded = state.isSuperseded ?? (() => false)
  const isQuitting = state.isQuitting ?? (() => false)
  const grace = Number.isFinite(state.abortGraceMs) ? Number(state.abortGraceMs) : 3000
  try {
    await win.loadURL(url)
    return { ok: true }
  } catch (error) {
    if (isSuperseded() || isQuitting() || win.isDestroyed()) return { ok: true }
    const message = String((error && error.message) || error)
    if (!ABORTED_RE.test(message)) return { ok: false, error }
    const loaded = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), grace)
      try {
        win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(true) })
      } catch {
        clearTimeout(timer)
        resolve(false)
      }
    })
    if (loaded || isQuitting() || win.isDestroyed()) return { ok: true }
    return { ok: false, error }
  }
}

module.exports = { loadWindowUrl, ABORTED_RE }
