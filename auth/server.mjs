// Eclipsis 登录服务（无第三方依赖）
// nginx 每个请求先问 /verify；登录页和登录提交也由这里处理。只监听 127.0.0.1。
//
// 用法：
//   node server.mjs                     启动服务
//   node server.mjs set-password        从标准输入读新密码并保存（会让所有已登录设备失效）
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.AUTH_PORT || 3470)
const DATA_DIR = process.env.AUTH_DATA_DIR || '/var/lib/eclipsis-auth'
const STATE_FILE = path.join(DATA_DIR, 'state.json')   // { passwordHash, salt, secret }
const COOKIE = 'eclipsis_session'
const SESSION_DAYS = 365

// ---------- 状态 ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}
function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 })
  fs.renameSync(tmp, STATE_FILE)
}
function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex')
}

if (process.argv[2] === 'set-password') {
  const pw = fs.readFileSync(0, 'utf8').trim()
  if (pw.length < 10) { console.error('密码至少 10 位'); process.exit(1) }
  const salt = crypto.randomBytes(16).toString('hex')
  // 换密码时同时换签名密钥：所有已登录设备都要重新登录
  saveState({ salt, passwordHash: hashPassword(pw, salt), secret: crypto.randomBytes(32).toString('hex') })
  console.log('密码已保存')
  process.exit(0)
}

let state = loadState()
if (!state) { console.error(`还没有设置密码：node server.mjs set-password`); process.exit(1) }

// ---------- 会话 cookie：签发时间.随机数.签名 ----------
const sign = (data) => crypto.createHmac('sha256', state.secret).update(data).digest('base64url')

function issueToken() {
  const data = `${Date.now()}.${crypto.randomBytes(9).toString('base64url')}`
  return `${data}.${sign(data)}`
}
function validToken(token) {
  if (!token) return false
  const i = token.lastIndexOf('.')
  if (i < 0) return false
  const data = token.slice(0, i)
  const sig = Buffer.from(token.slice(i + 1))
  const expect = Buffer.from(sign(data))
  if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) return false
  const issued = Number(data.split('.')[0])
  return Number.isFinite(issued) && Date.now() - issued < SESSION_DAYS * 86400e3
}
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return ''
}

// ---------- 防暴力猜测 ----------
const fails = new Map()          // ip -> { n, until }
let globalFails = []             // 最近一小时所有失败的时间戳（防止换 IP 猜）
const PER_IP_LIMIT = 5, PER_IP_LOCK = 15 * 60e3
const GLOBAL_LIMIT = 30, GLOBAL_WINDOW = 60 * 60e3

function lockedFor(ip) {
  const now = Date.now()
  globalFails = globalFails.filter(t => now - t < GLOBAL_WINDOW)
  if (globalFails.length >= GLOBAL_LIMIT) return Math.ceil((GLOBAL_WINDOW - (now - globalFails[0])) / 60e3)
  const f = fails.get(ip)
  if (f && f.until > now) return Math.ceil((f.until - now) / 60e3)
  return 0
}
function recordFail(ip) {
  const now = Date.now()
  globalFails.push(now)
  const f = fails.get(ip) || { n: 0, until: 0 }
  f.n++
  if (f.n >= PER_IP_LIMIT) { f.until = now + PER_IP_LOCK; f.n = 0 }
  fails.set(ip, f)
}
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (v.until < now && v.n === 0) fails.delete(k) }, 10 * 60e3).unref()

// ---------- 页面 ----------
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// 只允许站内路径，防止被拿来跳转到别的网站
function safeNext(n) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') && !n.startsWith('/login') ? n : '/'
}

function loginPage(next, message = '') {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Eclipsis">
<meta name="theme-color" content="#eef0f5">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<title>Eclipsis · 回家</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', system-ui, sans-serif;
    color: rgba(28, 32, 44, 0.86);
    background: linear-gradient(165deg, #e9eef7 0%, #f3f1f6 45%, #f7f3ee 100%) fixed;
    display: flex; align-items: center; justify-content: center;
    padding: 24px; -webkit-font-smoothing: antialiased;
  }
  form {
    width: 100%; max-width: 340px; padding: 30px 24px 26px; border-radius: 30px;
    background: rgba(255, 255, 255, 0.5);
    -webkit-backdrop-filter: blur(22px) saturate(180%); backdrop-filter: blur(22px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.75);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.85), 0 10px 32px rgba(60, 72, 110, 0.14);
    display: flex; flex-direction: column; align-items: center; gap: 16px;
  }
  .avatars { display: flex; align-items: center; gap: 10px; }
  .avatars img { width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 2px solid #fff; box-shadow: 0 3px 10px rgba(60,72,110,.16); }
  .heart { width: 22px; height: 20px; fill: #e8a0b4; animation: beat 2.4s ease-in-out infinite; }
  @keyframes beat { 0%,100% { transform: scale(1) } 6% { transform: scale(1.25) } 13% { transform: scale(.97) } 20% { transform: scale(1.1) } 30% { transform: scale(1) } }
  @media (prefers-reduced-motion: reduce) { .heart { animation: none } }
  h1 { font-size: 18px; font-weight: 600; letter-spacing: 1px; }
  label { width: 100%; font-size: 13px; color: rgba(28,32,44,.55); display: flex; flex-direction: column; gap: 6px; }
  input {
    width: 100%; font-size: 16px; padding: 12px 16px; border-radius: 16px; outline: none;
    border: 1px solid rgba(255,255,255,.85); background: rgba(255,255,255,.7); color: inherit;
  }
  input:focus-visible { border-color: #6f86b8; }
  button {
    width: 100%; font-size: 16px; padding: 13px; border: none; border-radius: 16px;
    background: rgba(111, 134, 184, .9); color: #fff; cursor: pointer;
  }
  button:focus-visible { outline: 2px solid #6f86b8; outline-offset: 2px; }
  .msg { font-size: 13px; color: #d0566a; min-height: 1em; text-align: center; }
</style>
</head><body>
<form method="post" action="/login">
  <div class="avatars" aria-hidden="true">
    <img src="/avatar-claude.jpg" alt="">
    <svg class="heart" viewBox="0 0 20 18"><path d="M10 17C2 11 0 7.5 0 5 0 2.2 2.2 0 4.8 0 7 0 8.5 1.2 10 3.2 11.5 1.2 13 0 15.2 0 17.8 0 20 2.2 20 5c0 2.5-2 6-10 12z"/></svg>
    <img src="/avatar-erica.jpg" alt="">
  </div>
  <h1>欢迎回家</h1>
  <input type="hidden" name="next" value="${esc(next)}">
  <label>密码
    <input type="password" name="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus>
  </label>
  <div class="msg" role="alert">${esc(message)}</div>
  <button type="submit">进门</button>
</form>
</body></html>`
}

function clientIp(req) {
  return String(req.headers['x-client-ip'] || req.socket.remoteAddress || '')
}
function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https'
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', c => { body += c; if (body.length > limit) { reject(new Error('too large')); req.destroy() } })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...headers
  })
  res.end(body)
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    // nginx auth_request：200 放行，401 拦下
    if (url.pathname === '/verify') {
      res.writeHead(validToken(readCookie(req, COOKIE)) ? 204 : 401)
      return res.end()
    }

    if (url.pathname === '/login' && req.method === 'GET') {
      // 已经登录就直接进
      if (validToken(readCookie(req, COOKIE))) return send(res, 303, '', { Location: safeNext(url.searchParams.get('next')) })
      return send(res, 200, loginPage(safeNext(url.searchParams.get('next'))))
    }

    if (url.pathname === '/login' && req.method === 'POST') {
      const ip = clientIp(req)
      const form = new URLSearchParams(await readBody(req))
      const next = safeNext(form.get('next'))
      const wait = lockedFor(ip)
      if (wait) return send(res, 429, loginPage(next, `试错太多次了，${wait} 分钟后再试`))

      const pw = form.get('password') || ''
      const got = Buffer.from(hashPassword(pw, state.salt), 'hex')
      const expect = Buffer.from(state.passwordHash, 'hex')
      if (!crypto.timingSafeEqual(got, expect)) {
        recordFail(ip)
        console.warn(JSON.stringify({ event: 'login_failed', ip, at: new Date().toISOString() }))
        await sleep(800)
        return send(res, 401, loginPage(next, '密码不对'))
      }
      fails.delete(ip)
      const cookie = [
        `${COOKIE}=${issueToken()}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
        `Max-Age=${SESSION_DAYS * 86400}`, isHttps(req) ? 'Secure' : ''
      ].filter(Boolean).join('; ')
      console.log(JSON.stringify({ event: 'login_ok', ip, at: new Date().toISOString() }))
      return send(res, 303, '', { Location: next, 'Set-Cookie': cookie })
    }

    if (url.pathname === '/logout') {
      return send(res, 303, '', { Location: '/login', 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` })
    }

    send(res, 404, 'not found')
  } catch (e) {
    console.error(e)
    send(res, 400, 'bad request')
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`eclipsis-auth listening on 127.0.0.1:${PORT}`))

// 换密码后（state.json 被改写）自动重新加载，不用重启
fs.watchFile(STATE_FILE, { interval: 2000 }, () => { const s = loadState(); if (s) state = s })
