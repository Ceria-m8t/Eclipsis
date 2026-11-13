// 全局水面（她 2026-11-13 看完第一版说「想把水面改成全局的了，现在太少」）。
//
// 一层画布铺在整个外壳上，**只画波本身**：高光、焦散、粉蓝色散，平静时完全透明，看不出有东西。
// 压在内容上面但 pointer-events: none，所以底下照样能点能滚。
// 为什么不是「整页泡在水里、字跟着晃」：那需要把页面送进 WebGL，DOM 做不到。
// 字跟着晃只在自己画的那一块（记忆面板头部，mode: 'refract'）做得到。
//
// 哪些页面有水：标了 data-pond 的外壳容器。现在是地下室那几个柜子；
// 上面的家是浅色液态玻璃，不进水（她定的两个世界）。
import { Pond, pondSupported } from './pond'

let pond: Pond | null = null
let host: HTMLElement | null = null

/** 整页都在水下：在外壳上挂一层只画波的水面。重复调用只挂一次。 */
export function startGlobalPond(el: HTMLElement): boolean {
  if (pond && host === el) return true
  stopGlobalPond()
  if (!pondSupported()) return false
  host = el
  pond = new Pond({
    host: el,
    mode: 'overlay',
    touch: el,
    onLost: () => stopGlobalPond(),
  })
  // 波压在内容之上（内容自己是 z-index 2 那一层）
  Object.assign(pond.canvas.style, { zIndex: '9', position: 'absolute', inset: '0' })
  el.appendChild(pond.canvas)
  return true
}

export function stopGlobalPond(): void {
  pond?.destroy()
  pond = null
  host = null
}

export function globalPondRunning(): boolean {
  return !!pond
}
