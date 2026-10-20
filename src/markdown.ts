import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import yaml from 'highlight.js/lib/languages/yaml'
import sql from 'highlight.js/lib/languages/sql'
import markdown from 'highlight.js/lib/languages/markdown'
import ini from 'highlight.js/lib/languages/ini'
import diff from 'highlight.js/lib/languages/diff'

// 只注册常用语言，控制体积
const langs: Record<string, any> = { javascript, typescript, python, bash, json, xml, css, yaml, sql, markdown, ini, diff }
for (const [name, def] of Object.entries(langs)) hljs.registerLanguage(name, def)
hljs.registerAliases(['js', 'jsx', 'mjs'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' })
hljs.registerAliases(['html', 'vue', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['md'], { languageName: 'markdown' })
hljs.registerAliases(['toml', 'env', 'conf'], { languageName: 'ini' })

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const md = new Marked({ gfm: true, breaks: true })
md.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0].toLowerCase()
      let html: string
      if (language && hljs.getLanguage(language)) {
        html = hljs.highlight(text, { language, ignoreIllegals: true }).value
      } else {
        html = escapeHtml(text)
      }
      const label = escapeHtml(language || 'text')
      // 复制按钮由 Chat.vue 里的事件委托处理（v-html 内容不能绑 Vue 事件）
      return `<div class="code-block"><div class="code-head"><span class="code-lang">${label}</span>` +
        `<button type="button" class="code-copy" aria-label="复制代码">复制</button></div>` +
        `<pre><code class="hljs">${html}</code></pre></div>`
    }
  }
})

export function renderMd(text: string): string {
  if (!text) return ''
  const raw = md.parse(text, { async: false }) as string
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['aria-label'] })
}

// 回复正文里用 <think>…</think> 或 <thinking>…</thinking> 包起来的段落，显示成"思考过程"折叠块。
// 只在显示时拆，原文不改（发回给模型的上下文里标签照旧保留）。
// 生成中只写了开头标签、还没收尾时，后面的内容先都算思考，不会在气泡里一闪而过。
const THINK_RE = /<(think|thinking)>([\s\S]*?)(?:<\/\1>|$)/gi
export function splitThink(text: string): { body: string; think: string } {
  if (!text || !/<think(ing)?>/i.test(text)) return { body: text, think: '' }
  const thinks: string[] = []
  const body = text.replace(THINK_RE, (_m, _tag, inner: string) => {
    const t = inner.trim()
    if (t) thinks.push(t)
    return '\n\n'
  })
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), think: thinks.join('\n\n') }
}

// 把一条回复拆成多个气泡：
// 普通文字每一行一个气泡；代码块、列表、表格、引用各自整体成一个气泡；标题跟着下一段走
export function splitBubbles(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const parts: string[] = []
  let buf: string[] = []
  let kind: 'none' | 'fence' | 'list' | 'table' | 'quote' | 'prose' = 'none'
  let pendingHeading = ''

  const flush = () => {
    const s = buf.join('\n').trim()
    if (s) {
      parts.push(pendingHeading ? pendingHeading + '\n' + s : s)
      pendingHeading = ''
    }
    buf = []
    kind = 'none'
  }
  const kindOf = (l: string) =>
    /^\s*([-*+]|\d+[.)])\s/.test(l) ? 'list'
    : /^\s*\|/.test(l) ? 'table'
    : /^\s*>/.test(l) ? 'quote'
    : 'prose'

  for (const line of lines) {
    if (kind === 'fence') {
      buf.push(line)
      if (/^\s*(```|~~~)/.test(line)) flush()
      continue
    }
    if (/^\s*(```|~~~)/.test(line)) { flush(); kind = 'fence'; buf.push(line); continue }
    if (line.trim() === '') { if (kind !== 'list') flush(); continue }
    if (/^\s{0,3}#{1,6}\s/.test(line)) { flush(); pendingHeading = line; continue }

    const k = kindOf(line)
    // 列表项下的缩进续行仍属于列表
    if (kind === 'list' && (k === 'list' || /^\s{2,}\S/.test(line))) { buf.push(line); continue }
    if (k !== 'prose' && k === kind) { buf.push(line); continue }
    flush()
    kind = k
    buf.push(line)
    if (k === 'prose') flush()
  }
  if (kind === 'fence') buf.push('```')   // 流式输出中代码块还没闭合
  flush()
  if (pendingHeading) parts.push(pendingHeading)
  return parts.length ? parts : [text]
}
