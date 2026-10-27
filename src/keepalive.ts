// 后台保活：他在回复时循环播放一段听不见的音频，切到别的 app 时 iOS 不会立刻挂起页面，回复能收完。
// 和 Kelivo 的"后台静音保活"同一个思路。网页能撑多久由 iOS 决定，不保证。
//
// iOS 只允许在点按里第一次 play()：所以 start() 要在点击处理函数里、任何 await 之前同步调用。
// 已知代价：播放时会让别的 app 的音乐暂停（网页拿不到"和别的声音混合"的开关）。

let audio: HTMLAudioElement | null = null
let url = ''
let active = false

// 1 秒 8kHz 单声道 16 位 PCM，振幅极小的噪声：听不见，但不是纯静音（纯静音可能被系统当成没在播放）
function buildWav(): string {
  const rate = 8000, n = rate
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round((Math.random() - 0.5) * 4), true)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}

function ensureAudio(): HTMLAudioElement {
  if (audio) return audio
  url = buildWav()
  audio = new Audio(url)
  audio.loop = true
  audio.preload = 'auto'
  audio.setAttribute('playsinline', '')
  return audio
}

export function startKeepAlive(label = '正在回复…') {
  if (active) return
  active = true
  try {
    // Safari 17+：声明为"播放"类，锁屏/切走时继续
    const session = (navigator as any).audioSession
    if (session && session.type !== 'playback') session.type = 'playback'
    const a = ensureAudio()
    a.currentTime = 0
    const p = a.play()
    if (p && typeof p.catch === 'function') p.catch(() => { active = false })
    if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({ title: label, artist: 'Eclipsis' })
    }
  } catch {
    active = false
  }
}

export function stopKeepAlive() {
  if (!active) return
  active = false
  try {
    audio?.pause()
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null
    const session = (navigator as any).audioSession
    if (session) session.type = 'auto'
  } catch {}
}

export const keepAliveActive = () => active
