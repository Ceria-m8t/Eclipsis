// 在 Vue 页面里挂一小块 React：星域图谱（Observatory-Ridge, MIT）的组件是 React 写的。
// 这一页才加载（路由懒加载），聊天页不背这些包。
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NearFocus3D, NearFocus2D, GalaxyView } from '../../vendor/observatory-ridge/observatory-ridge.js'
import type { GSnapshot, GGraph } from './api'

export type View = '3d' | '2d' | 'galaxy'
export type Pick = { kind: 'star' } | { kind: 'belt' } | { kind: 'planet'; id: string } | { kind: 'memory'; id: string } | null

export interface Mounted { render(view: View, snap: GSnapshot, graph: GGraph | null): void; unmount(): void }

const FONT = '"Noto Serif SC", "Songti SC", serif'

export function mountRidge(el: HTMLElement, onPick: (p: Pick) => void): Mounted {
  const root: Root = createRoot(el)
  const pick = (sel: any) => {
    if (!sel) onPick(null)
    else if (sel.kind === 'star') onPick({ kind: 'star' })
    else if (sel.kind === 'belt') onPick({ kind: 'belt' })
    else if (sel.kind === 'planet' && sel.planet) onPick({ kind: 'planet', id: sel.planet.id })
  }
  return {
    render(view, snap, graph) {
      const s = snap as any
      if (view === '3d') root.render(createElement(NearFocus3D as any, { snapshot: s, onSelect: pick, fontFamily: FONT }))
      else if (view === '2d') root.render(createElement(NearFocus2D as any, { snapshot: s, onSelect: pick }))
      else root.render(createElement(GalaxyView as any, {
        graph: (graph ?? { nodes: [], edges: [] }) as any, fontFamily: FONT,
        onSelect: (m: any) => onPick(m ? { kind: 'memory', id: m.id } : null),
      }))
    },
    unmount() { root.unmount() },
  }
}

export function hasWebGL2(): boolean {
  try { return !!document.createElement('canvas').getContext('webgl2') } catch { return false }
}
