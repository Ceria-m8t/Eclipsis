// 登录过期时，接口会返回 401 并带 X-Eclipsis-Auth: required（由 nginx 加）。
// 统一拦下来跳到登录页，登录后回到当前页面。聊天记录存在本机，不受影响。
let redirecting = false

export function installAuthGuard() {
  const original = window.fetch.bind(window)
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args)
    if (res.status === 401 && res.headers.get('x-eclipsis-auth') === 'required' && !redirecting) {
      redirecting = true
      const next = location.pathname + location.search
      location.href = '/login?next=' + encodeURIComponent(next)
    }
    return res
  }
}
