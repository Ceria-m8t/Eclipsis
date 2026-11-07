// Leto 管理面板后端：让 Erica 自己在网页上改 Agent 配置、人格、世界书，存了就生效。
// 挂在前端出口 /v1/eclipsis/leto-admin/（已有 nginx 登录保护 + 只听 127.0.0.1）。
//
// 安全：只允许读写配置文件本身 + 配置里声明过的 persona/worldbook 文件，且路径必须在 /etc/eclipsis/ 下。
// 不接受任意路径，防越权读写服务器其它文件。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { loadAgentFile } from './agent.ts'
import { probeStation } from './station-check.ts'
import { listStations, saveStation, deleteStation, switchStation, findStation, currentStation } from '../station.ts'
import type { DB } from '../db.ts'
import { loadChatContinuation } from '../wake/continuation.ts'
import { FirstTokenWatch } from '../proxy.ts'

// ── 测速（2026-11-07）：用真实大小的上下文（最近一次聊天）发一次，看多少秒开始回 ──
// 自检只用一句话，测不出"带 18 万 token 时慢不慢"（刺猬站小请求 30 秒、真实聊天超过 100 秒被 Cloudflare 掐成 524）。
// 后台跑，面板轮询结果：测速可能要两分钟，网页请求别一直挂着。收到第一个字就断开，不等它说完。
export interface SpeedResult {
  state: 'running' | 'done'
  station: string
  model: string
  contextChars: number
  messages: number
  /** 中转站开始回应（响应头）用了多久 */
  headersMs?: number
  /** 第一个字出来用了多久 */
  firstTokenMs?: number
  ok?: boolean
  detail?: string
  startedAt: number
}
const speedTests = new Map<string, SpeedResult>()

export async function runSpeedTest(r: SpeedResult, url: string, key: string, messages: any[], timeoutMs = 150_000): Promise<void> {
  const t0 = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: r.model, messages, max_tokens: 50, stream: true }),
      signal: ac.signal
    })
    r.headersMs = Date.now() - t0
    if (!res.ok) { r.ok = false; r.detail = `HTTP ${res.status}：${(await res.text()).slice(0, 200)}`; return }
    const watch = new FirstTokenWatch()
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      if (watch.feed(Buffer.from(chunk))) { r.firstTokenMs = Date.now() - t0; break }
    }
    ac.abort()
    if (r.firstTokenMs === undefined) { r.ok = false; r.detail = '回应了，但一个字都没出就结束了'; return }
    const s = r.firstTokenMs / 1000
    r.ok = s < 90
    r.detail = s < 30 ? '快，放心用' : s < 60 ? '能用，偶尔会慢' : s < 90 ? '偏慢，长聊天容易超时' : '太慢，经过 Cloudflare 会 524（它只等 100 秒）'
  } catch (e: any) {
    if (r.firstTokenMs !== undefined) return
    r.ok = false
    r.detail = ac.signal.aborted ? `${Math.round(timeoutMs / 1000)} 秒还没出字，太慢（经过 Cloudflare 一定 524）` : `连不上：${e?.cause?.message || e?.message || e}`
  } finally {
    clearTimeout(timer)
    r.state = 'done'
  }
}

/** 列出站上的模型名（GET /models），帮她挑默认模型 */
async function listStationModels(url: string, key: string): Promise<string[]> {
  const res = await fetch(url.replace(/\/+$/, '') + '/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d: any = await res.json()
  return (Array.isArray(d?.data) ? d.data : []).map((m: any) => String(m?.id ?? '')).filter(Boolean).sort()
}

const CONFIG_PATH = (process.env.LETO_AGENTS_FILE || '/etc/eclipsis/leto-agents.json').trim()
/** 允许读写的根目录：persona/worldbook/config 都必须在这下面 */
const ALLOWED_ROOT = '/etc/eclipsis/'

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve2, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', c => { size += c.length; if (size > 1_000_000) { reject(new Error('body 过大')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve2(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 路径必须解析到 ALLOWED_ROOT 下才放行 */
function safePath(p: string): string | null {
  const abs = resolve(p)
  return abs.startsWith(ALLOWED_ROOT) ? abs : null
}

/** 备份后写入 */
function writeWithBackup(absPath: string, content: string) {
  const dir = dirname(absPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (existsSync(absPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try { copyFileSync(absPath, `${absPath}.bak-${stamp}`) } catch { /* 备份失败不阻断 */ }
  }
  writeFileSync(absPath, content, { mode: 0o600 })
}

/** 收集配置里声明过的、允许编辑的文件路径（persona/worldbook） */
function declaredFiles(): Set<string> {
  const set = new Set<string>()
  const entries = loadAgentFile(CONFIG_PATH) || []
  for (const e of entries) {
    const id: any = (e as any).identity
    if (id && typeof id === 'object') {
      if (id.personaFile) { const s = safePath(id.personaFile); if (s) set.add(s) }
      const wb = Array.isArray(id.worldbookFile) ? id.worldbookFile : (id.worldbookFile ? [id.worldbookFile] : [])
      for (const f of wb) { const s = safePath(f); if (s) set.add(s) }
    }
  }
  return set
}

/** 返回 true 表示这里处理了。路径前缀 /v1/eclipsis/leto-admin/ */
export async function handleLetoAdmin(req: IncomingMessage, res: ServerResponse, db?: DB): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://local')
  const path = url.pathname
  const BASE = '/v1/eclipsis/leto-admin'
  if (path !== BASE && !path.startsWith(BASE + '/')) return false
  const route = path.slice(BASE.length).replace(/^\//, '')

  try {
    // 面板页面
    if (route === '' || route === 'ui') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PANEL_HTML)
      return true
    }

    // 读配置
    if (route === 'config' && req.method === 'GET') {
      const text = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : '{"agents":[]}'
      json(res, 200, { path: CONFIG_PATH, content: text })
      return true
    }
    // 写配置（校验 JSON）
    if (route === 'config' && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req))
      const content = String(body.content ?? '')
      try { JSON.parse(content) } catch (e: any) { json(res, 400, { error: `JSON 不合法：${e.message}` }); return true }
      writeWithBackup(CONFIG_PATH, content)
      json(res, 200, { ok: true, saved: CONFIG_PATH })
      return true
    }

    // 读某个声明过的文件（persona/worldbook）
    if (route === 'file' && req.method === 'GET') {
      const target = url.searchParams.get('path') || ''
      const abs = safePath(target)
      if (!abs || !declaredFiles().has(abs)) { json(res, 403, { error: '该文件不在配置声明的 persona/worldbook 里，不能读' }); return true }
      const content = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
      json(res, 200, { path: abs, content })
      return true
    }
    // 写某个声明过的文件
    if (route === 'file' && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req))
      const abs = safePath(String(body.path || ''))
      if (!abs || !declaredFiles().has(abs)) { json(res, 403, { error: '该文件不在配置声明的 persona/worldbook 里，不能写' }); return true }
      writeWithBackup(abs, String(body.content ?? ''))
      json(res, 200, { ok: true, saved: abs })
      return true
    }

    // ── 换站（2026-11-07）──
    if (route === 'stations' && req.method === 'GET') { json(res, 200, listStations()); return true }
    if (route === 'stations' && req.method === 'PUT') {
      const b = JSON.parse(await readBody(req))
      const st = saveStation({ id: b.id || undefined, name: b.name, url: b.url, key: b.key, defaultModel: b.defaultModel })
      json(res, 200, { ok: true, id: st.id })
      return true
    }
    if (route === 'stations' && req.method === 'DELETE') {
      deleteStation(String(url.searchParams.get('id') || ''))
      json(res, 200, { ok: true })
      return true
    }
    if (route === 'stations/switch' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req))
      const c = switchStation(String(b.id || ''))
      json(res, 200, { ok: true, current: { name: c.name, url: c.url, defaultModel: c.defaultModel } })
      return true
    }
    // 用存着的密钥自检 / 列模型（不用再输一遍密钥）
    if ((route === 'stations/test' || route === 'stations/models') && req.method === 'POST') {
      const b = JSON.parse(await readBody(req))
      const st = b.id ? findStation(String(b.id)) : null
      const u = st?.url ?? String(b.url || '')
      const k = st?.key ?? String(b.key || '')
      if (!u || !k) { json(res, 400, { error: '要选一个存过的站，或者填地址和密钥' }); return true }
      if (route === 'stations/models') {
        try { json(res, 200, { models: await listStationModels(u, k) }) } catch (e: any) { json(res, 200, { models: [], error: `拉不到模型列表：${e?.message || e}` }) }
        return true
      }
      const model = String(b.model || st?.defaultModel || '')
      if (!model) { json(res, 400, { error: '要选一个模型来自检（或者先给这个站填默认模型）' }); return true }
      json(res, 200, await probeStation(u, k, model))
      return true
    }
    if (route === 'stations/speed' && req.method === 'POST') {
      if (!db) { json(res, 500, { error: '没接数据库' }); return true }
      const b = JSON.parse(await readBody(req))
      const st = findStation(String(b.id || ''))
      if (!st) { json(res, 400, { error: '要选一个存过的站' }); return true }
      const model = String(b.model || st.defaultModel || '')
      if (!model) { json(res, 400, { error: '这个站还没填默认模型' }); return true }
      const cont = loadChatContinuation(db, { maxAgeHours: 24 * 30 })
      if (!cont) { json(res, 400, { error: '还没有聊天记录，拿不到真实大小的上下文' }); return true }
      const messages = [{ role: 'system', content: cont.system }, ...cont.history, { role: 'user', content: '（这是测速，不用认真回，回一个字就行）' }]
      const contextChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0)
      const testId = `t${Date.now().toString(36)}`
      const r: SpeedResult = { state: 'running', station: st.name, model, contextChars, messages: messages.length, startedAt: Date.now() }
      speedTests.set(testId, r)
      for (const [k, v] of speedTests) if (Date.now() - v.startedAt > 30 * 60_000) speedTests.delete(k)
      void runSpeedTest(r, st.url, st.key, messages)
      json(res, 200, { testId, ...r })
      return true
    }
    if (route.startsWith('stations/speed/') && req.method === 'GET') {
      const r = speedTests.get(route.slice('stations/speed/'.length))
      if (!r) { json(res, 404, { error: '找不到这次测速（可能后端重启过）' }); return true }
      json(res, 200, r)
      return true
    }
    if (route === 'stations/current' && req.method === 'GET') {
      const c = currentStation()
      json(res, 200, { name: c.name, url: c.url, defaultModel: c.defaultModel, switchedAt: c.switchedAt })
      return true
    }

    // 站点自检
    if (route === 'station-check' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const { url: u, key, model } = body
      if (!u || !key || !model) { json(res, 400, { error: '需要 url / key / model' }); return true }
      const r = await probeStation(String(u), String(key), String(model))
      json(res, 200, r)
      return true
    }

    json(res, 404, { error: 'not found' })
    return true
  } catch (e: any) {
    json(res, 500, { error: String(e?.message || e) })
    return true
  }
}

// ── 面板页面（单文件，无构建）──
const PANEL_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leto Agent 面板</title>
<style>
 body{font-family:-apple-system,system-ui,sans-serif;max-width:860px;margin:0 auto;padding:16px;background:#faf8f5;color:#2a2a2a}
 h1{font-size:18px} h2{font-size:15px;margin-top:24px}
 textarea{width:100%;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5;border:1px solid #d8d2c8;border-radius:8px;padding:10px;background:#fff}
 .config{height:320px} .file{height:260px}
 button{font-size:14px;padding:8px 16px;border:0;border-radius:8px;background:#7a6a55;color:#fff;cursor:pointer;margin:4px 4px 4px 0}
 button.ghost{background:#e8e2d8;color:#5a5048}
 .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
 input{font-size:13px;padding:6px 8px;border:1px solid #d8d2c8;border-radius:6px}
 .msg{padding:8px 12px;border-radius:8px;margin:8px 0;font-size:13px;display:none}
 .ok{background:#e6f0e0;color:#2d5016} .err{background:#f3e0e0;color:#7a1f1f}
 .hint{color:#8a8178;font-size:12px;line-height:1.6}
 select{font-size:13px;padding:6px;border-radius:6px;border:1px solid #d8d2c8}
 .st{border:1px solid #e3ddd3;border-radius:10px;padding:10px 12px;margin:8px 0;background:#fff}
 .st.on{border-color:#7a6a55;box-shadow:0 0 0 1px #7a6a55}
 .st b{font-size:14px} .st .tag{font-size:12px;background:#7a6a55;color:#fff;border-radius:6px;padding:1px 6px;margin-left:6px}
 .st button{font-size:13px;padding:5px 12px}
 .row input{flex:1 1 160px;min-width:0} .row select{flex:1 1 220px;min-width:0;max-width:100%}
</style></head><body>
<h1>Leto Agent 面板</h1>
<p class="hint">改完点保存就生效（应答器每次醒来重读）。会自动备份旧版（.bak-时间）。令牌和站点密钥只在这个登录后的页面显示。</p>
<div id="msg" class="msg"></div>

<h2>0. 换站</h2>
<p class="hint">存几个常用的中转站，点「切过去」立刻生效，不用重启。聊天、Wake、小克的 Leto、心潮一起换；哈基米和 ds 用下面 Agent 配置里自己的站，不受影响。<br>
切过去以后：在 Kelivo 里重新选一下模型（不同站的模型名不一样）。还没在新站聊过时，Wake / 小克 / 心潮先用这个站的「默认模型」。</p>
<div id="stCur" class="hint"></div>
<div id="stList"></div>
<p class="hint" style="margin-top:12px"><b>新建 / 修改</b>（点某个站的「修改」会填到这里；密钥留空 = 不改）</p>
<div class="row">
 <input id="stName" placeholder="名字，如 神秘破甲" size="14">
 <input id="stUrl" placeholder="地址，如 https://xxx/v1" size="30">
 <input id="stKey" placeholder="密钥" size="22" autocomplete="off">
</div>
<div class="row">
 <input id="stModel" placeholder="默认模型名（可以手打，也可以从下面选）" size="30">
 <button class="ghost" onclick="stFetchModels()">拉模型列表</button>
</div>
<div class="row" id="stModelRow" style="display:none">
 <select id="stModelSel" onchange="if(this.value)document.getElementById('stModel').value=this.value"></select>
 <button onclick="stSave()">保存这个站</button>
 <button class="ghost" onclick="stClear()">清空</button>
</div>
<div id="stOut" class="hint"></div>

<h2>1. Agent 配置（leto-agents.json）</h2>
<p class="hint">每个 AI 的 token、站点(upstream)、人格文件、世界书文件、enabled、工具。改完保存。</p>
<textarea id="config" class="config" spellcheck="false"></textarea>
<div class="row"><button onclick="loadConfig()">重新载入</button><button onclick="saveConfig()">保存配置</button></div>

<h2>2. 人格 / 世界书文件</h2>
<p class="hint">选配置里声明过的文件来改（personaFile / worldbookFile）。</p>
<div class="row">
 <select id="fileSel"></select>
 <button class="ghost" onclick="loadFile()">载入</button>
 <button onclick="saveFile()">保存文件</button>
</div>
<textarea id="fileBody" class="file" spellcheck="false"></textarea>

<h2>3. 站点自检</h2>
<p class="hint">换站后验：连得上 / 模型在 / 转不转工具。转工具才能给 Leto 用。</p>
<div class="row">
 <input id="su" placeholder="站点 url，如 https://xxx/v1" size="34">
 <input id="sk" placeholder="密钥" size="20">
 <input id="sm" placeholder="模型名" size="20">
 <button onclick="check()">自检</button>
</div>
<div id="checkout" class="hint"></div>

<script>
const B='/api/eclipsis/leto-admin'
const msg=(t,ok)=>{const m=document.getElementById('msg');m.textContent=t;m.className='msg '+(ok?'ok':'err');m.style.display='block';setTimeout(()=>m.style.display='none',4000)}
async function loadConfig(){
 const r=await fetch(B+'/config');const d=await r.json()
 document.getElementById('config').value=d.content||''
 refreshFiles()
}
async function saveConfig(){
 const content=document.getElementById('config').value
 const r=await fetch(B+'/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content})})
 const d=await r.json()
 if(r.ok){msg('配置已保存',true);refreshFiles()}else msg(d.error||'保存失败',false)
}
function refreshFiles(){
 let files=[]
 try{
  const c=JSON.parse(document.getElementById('config').value)
  for(const a of (c.agents||[])){const id=a.identity
   if(id&&typeof id==='object'){if(id.personaFile)files.push(id.personaFile);
    const wb=Array.isArray(id.worldbookFile)?id.worldbookFile:(id.worldbookFile?[id.worldbookFile]:[]);for(const f of wb)files.push(f)}}
 }catch(e){}
 const sel=document.getElementById('fileSel');sel.innerHTML=''
 for(const f of files){const o=document.createElement('option');o.value=f;o.textContent=f;sel.appendChild(o)}
}
async function loadFile(){
 const path=document.getElementById('fileSel').value;if(!path){msg('先在下拉里选一个文件',false);return}
 const r=await fetch(B+'/file?path='+encodeURIComponent(path));const d=await r.json()
 if(r.ok){const c=d.content||'';document.getElementById('fileBody').value=c;msg(c.length?('已载入 '+c.length+' 字：'+path):('这个文件是空的（还没写过内容）：'+path),true)}
 else msg(d.error||'读失败',false)
}
async function saveFile(){
 const path=document.getElementById('fileSel').value;if(!path)return
 const content=document.getElementById('fileBody').value
 const r=await fetch(B+'/file',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({path,content})})
 const d=await r.json()
 if(r.ok)msg('文件已保存：'+path,true);else msg(d.error||'保存失败',false)
}
async function check(){
 const url=document.getElementById('su').value,key=document.getElementById('sk').value,model=document.getElementById('sm').value
 document.getElementById('checkout').textContent='自检中…'
 const r=await fetch(B+'/station-check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,key,model})})
 const d=await r.json()
 if(!r.ok){document.getElementById('checkout').textContent=d.error||'失败';return}
 document.getElementById('checkout').innerHTML='连得上: '+(d.reachable?'是':'否')+' ｜ 模型在: '+(d.modelOk?'是':'否')+' ｜ 转工具: '+(d.toolsOk?'是':'否')+'<br>'+(d.ok?'✅ 可用':'❌ '+d.detail)
}
// ── 换站 ──
let stEditing=''
const esc=t=>String(t??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const $=id=>document.getElementById(id)
async function stLoad(){
 const r=await fetch(B+'/stations');const d=await r.json()
 if(!r.ok){$('stCur').textContent=d.error||'读不到';return}
 const c=d.current
 $('stCur').innerHTML='现在用的：<b>'+esc(c.name)+'</b>　'+esc(c.url||'（没配）')+(c.defaultModel?'　默认模型 '+esc(c.defaultModel):'')+(d.switchedAt?'　· '+esc(new Date(d.switchedAt).toLocaleString())+' 切的':'')
 $('stList').innerHTML=d.stations.length?d.stations.map(s=>{const on=s.id===d.active,a='data-id="'+esc(s.id)+'"'
  return '<div class="st'+(on?' on':'')+'"><b>'+esc(s.name)+'</b>'+(on?'<span class="tag">正在用</span>':'')+
  '<div class="hint">'+esc(s.url)+'　密钥 '+esc(s.key)+'　默认模型 '+esc(s.defaultModel||'（没填）')+'</div><div class="row">'+
  (on?'':'<button '+a+' onclick="stSwitch(this.dataset.id)">切过去</button>')+
  '<button class="ghost" '+a+' onclick="stTest(this.dataset.id)">自检</button><button class="ghost" '+a+' onclick="stSpeed(this.dataset.id)">测速</button><button class="ghost" '+a+' onclick="stEdit(this.dataset.id)">修改</button>'+
  (on?'':'<button class="ghost" '+a+' onclick="stDel(this.dataset.id)">删除</button>')+'</div></div>'}).join('')
  :'<p class="hint">还没存过站。现在用的是 backend.env 里那个；存第一个站时它会一起存进来，叫「原来的站」。</p>'
 window._st=d.stations
}
function stClear(){stEditing='';for(const k of ['stName','stUrl','stKey','stModel'])$(k).value='';$('stKey').placeholder='密钥';$('stModelRow').style.display='none';$('stModelSel').innerHTML=''}
function stEdit(id){const s=(window._st||[]).find(x=>x.id===id);if(!s)return;stEditing=id;$('stName').value=s.name;$('stUrl').value=s.url;$('stKey').value='';$('stKey').placeholder='密钥（留空 = 不改）';$('stModel').value=s.defaultModel||'';$('stName').focus()}
async function stSave(){
 const body={id:stEditing||undefined,name:$('stName').value,url:$('stUrl').value,key:$('stKey').value,defaultModel:$('stModel').value}
 const r=await fetch(B+'/stations',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json()
 if(r.ok){msg('已保存',true);stClear();stLoad()}else msg(d.error||'保存失败',false)
}
async function stFetchModels(){
 const body=($('stKey').value||!stEditing)?{url:$('stUrl').value,key:$('stKey').value}:{id:stEditing}
 $('stOut').textContent='拉模型列表中…'
 const r=await fetch(B+'/stations/models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json()
 if(!r.ok||d.error){$('stOut').textContent=d.error||'失败';return}
 const cur=$('stModel').value
 $('stModelSel').innerHTML='<option value="">— 选一个模型（'+d.models.length+' 个）—</option>'+d.models.map(m=>'<option value="'+esc(m)+'"'+(m===cur?' selected':'')+'>'+esc(m)+'</option>').join('')
 $('stModelRow').style.display=d.models.length?'flex':'none'
 $('stOut').textContent='拉到 '+d.models.length+' 个模型，在下面的下拉框里选。'
}
async function stTest(id){
 const s=(window._st||[]).find(x=>x.id===id)
 let model=s&&s.defaultModel
 if(!model){model=prompt('这个站还没填默认模型。用哪个模型自检？');if(!model)return}
 $('stOut').textContent='自检「'+(s?s.name:'')+'」中（最多 90 秒）…'
 const r=await fetch(B+'/stations/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,model})});const d=await r.json()
 if(!r.ok){$('stOut').textContent=d.error||'失败';return}
 $('stOut').innerHTML='「'+esc(s?s.name:'')+'」连得上: '+(d.reachable?'是':'否')+' ｜ 模型在: '+(d.modelOk?'是':'否')+' ｜ 转工具: '+(d.toolsOk?'是':'否')+'<br>'+(d.ok?'✅ 可以用（醒来和 Leto 要转工具，这个站转）':'❌ '+esc(d.detail))
}
async function stSpeed(id){
 const s=(window._st||[]).find(x=>x.id===id);if(!s)return
 let model=s.defaultModel
 if(!model){model=prompt('这个站还没填默认模型。用哪个模型测速？');if(!model)return}
 if(!confirm('用你们最近一次聊天的完整上下文测一次「'+s.name+'」，看多少秒开始回。\\n会花掉差不多一次聊天的额度。测吗？'))return
 const r=await fetch(B+'/stations/speed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,model})});const d=await r.json()
 if(!r.ok){$('stOut').textContent=d.error||'失败';return}
 const show=x=>{const sec=v=>v===undefined?'—':(v/1000).toFixed(1)+' 秒'
  const head='「'+esc(x.station)+'」测速（上下文 '+Math.round(x.contextChars/10000)+' 万字、'+x.messages+' 条）'
  if(x.state==='running'){$('stOut').textContent=head+'：测着呢，已经 '+Math.round((Date.now()-x.startedAt)/1000)+' 秒…';return false}
  $('stOut').innerHTML=head+'<br>开始回应 '+sec(x.headersMs)+' ｜ 出第一个字 '+sec(x.firstTokenMs)+'<br>'+(x.ok?'✅ ':'❌ ')+esc(x.detail);return true}
 show(d)
 const timer=setInterval(async()=>{const q=await fetch(B+'/stations/speed/'+d.testId);const x=await q.json();if(!q.ok){clearInterval(timer);$('stOut').textContent=x.error||'失败';return}if(show(x))clearInterval(timer)},2000)
}
async function stSwitch(id){
 const name=((window._st||[]).find(x=>x.id===id)||{}).name||''
 if(!confirm('切到「'+name+'」？聊天、Wake、小克的 Leto、心潮会立刻改用这个站。'))return
 const r=await fetch(B+'/stations/switch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});const d=await r.json()
 if(r.ok){msg('已切到「'+name+'」。记得在 Kelivo 里重新选一下模型',true);stLoad()}else msg(d.error||'切换失败',false)
}
async function stDel(id){
 const name=((window._st||[]).find(x=>x.id===id)||{}).name||''
 if(!confirm('删掉「'+name+'」？'))return
 const r=await fetch(B+'/stations?id='+encodeURIComponent(id),{method:'DELETE'});const d=await r.json()
 if(r.ok){msg('已删除',true);stLoad()}else msg(d.error||'删除失败',false)
}
stLoad()
loadConfig()
</script></body></html>`
