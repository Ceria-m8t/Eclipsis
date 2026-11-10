import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../src/db.ts'
import { BlobStore } from '../src/blobs.ts'
import { saveFile, attachFiles, extractText, docxXmlToText, handleFileApi, kindOf, MAX_CHARS } from '../src/files.ts'
import { listen, close, tempDir } from './helpers.ts'

function setup() {
  const t = tempDir()
  const db = openDb(':memory:')
  const blobs = new BlobStore(db, join(t.dir, 'blobs'))
  return { t, db, blobs }
}

test('文字类文件：原样给；二进制当文字读不出就说看不到', async () => {
  const { t, db, blobs } = setup()
  try {
    const f = await saveFile(db, blobs, Buffer.from('第一行\n第二行', 'utf8'), 'note.md', 'text/markdown')
    assert.equal(f.kind, 'text')
    assert.equal(f.chars, 7)
    assert.equal(f.note, null)
    const bin = await saveFile(db, blobs, Buffer.from([0x00, 0x01, 0x02, 0x03]), 'weird.txt', 'text/plain')
    assert.equal(bin.chars, 0)
    assert.match(bin.note!, /不是纯文本/)
    // 不认识的格式：明说看不到，别让他编
    const other = await saveFile(db, blobs, Buffer.from('x'), 'book.epub', 'application/epub+zip')
    assert.equal(other.kind, 'other')
    assert.match(other.note!, /还不会读/)
  } finally { t.cleanup() }
})

test('PDF 抽文字；抽不出（扫描件）就明说看不到', async () => {
  const { t, db, blobs } = setup()
  try {
    // 用 pdftotext 的同伴工具造一个真 PDF：没有就跳过
    let pdf: Buffer
    try {
      const dir = join(t.dir, 'mk'); mkdirSync(dir, { recursive: true })
      const ps = join(dir, 'a.ps')
      writeFileSync(ps, '%!PS\n/Helvetica findfont 24 scalefont setfont 72 700 moveto (Hello Eclipsis) show showpage\n')
      execFileSync('ps2pdf', [ps, join(dir, 'a.pdf')], { timeout: 20_000 })
      pdf = (await import('node:fs')).readFileSync(join(dir, 'a.pdf'))
    } catch {
      console.log('   （没有 ps2pdf，跳过真 PDF 那一半）')
      const fake = await extractText(Buffer.from('%PDF-1.4 不是真的'), 'x.pdf', 'application/pdf')
      assert.equal(fake.text, '')
      assert.ok(fake.note)
      return
    }
    const f = await saveFile(db, blobs, pdf, '报告.pdf', 'application/pdf')
    assert.equal(f.kind, 'pdf')
    assert.ok(f.chars > 0)
    const text = db.prepare('SELECT text FROM files WHERE hash = ?').get(f.hash) as any
    assert.match(text.text, /Hello Eclipsis/)
  } finally { t.cleanup() }
})

test('docx：unzip 出 document.xml 再剥标签', async () => {
  const { t, db, blobs } = setup()
  try {
    assert.equal(docxXmlToText('<w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二</w:t><w:tab/><w:t>段</w:t></w:r></w:p>'),
      '第一段\n第二\t段')
    const dir = join(t.dir, 'dx'); mkdirSync(join(dir, 'word'), { recursive: true })
    writeFileSync(join(dir, 'word', 'document.xml'),
      '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>合同第一条</w:t></w:r></w:p><w:p><w:r><w:t>第二条 &amp; 附则</w:t></w:r></w:p></w:body></w:document>')
    // 服务器上没有 zip 命令，用 python 的 zipfile 打包（docx 就是个 zip）
    execFileSync('python3', ['-c',
      'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1],"w");z.write(sys.argv[2],"word/document.xml");z.close()',
      join(t.dir, 'a.docx'), join(dir, 'word', 'document.xml')], { timeout: 20_000 })
    const data = (await import('node:fs')).readFileSync(join(t.dir, 'a.docx'))
    const f = await saveFile(db, blobs, data, '合同.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    assert.equal(f.kind, 'docx')
    const row = db.prepare('SELECT text FROM files WHERE hash = ?').get(f.hash) as any
    assert.equal(row.text, '合同第一条\n第二条 & 附则')
  } finally { t.cleanup() }
})

test('太长的截断，并告诉他只给了前面一段', async () => {
  const { t, db, blobs } = setup()
  try {
    const f = await saveFile(db, blobs, Buffer.from('啊'.repeat(MAX_CHARS + 500), 'utf8'), 'long.txt', 'text/plain')
    assert.equal(f.chars, MAX_CHARS)
    assert.equal(f.truncated, true)
    const out = attachFiles([{ role: 'user', content: `看这个 [文件 long.txt #${f.hash.slice(0, 12)}]` }], db)
    assert.match(out.messages[0]!.content, /太长了只给前面这些/)
  } finally { t.cleanup() }
})

test('发给他之前：最近两条带文件的消息给正文，更早的只留文件名', async () => {
  const { t, db, blobs } = setup()
  try {
    const mk = async (name: string, body: string) => {
      const f = await saveFile(db, blobs, Buffer.from(body, 'utf8'), name, 'text/plain')
      return { info: f, mark: `[文件 ${name} #${f.hash.slice(0, 12)}]` }
    }
    const a = await mk('a.txt', '甲的内容')
    const b = await mk('b.txt', '乙的内容')
    const c = await mk('c.txt', '丙的内容')
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `第一份 ${a.mark}` },
      { role: 'assistant', content: '看了' },
      { role: 'user', content: `第二份 ${b.mark}` },
      { role: 'assistant', content: '也看了' },
      { role: 'user', content: `第三份 ${c.mark}` },
    ]
    const r = attachFiles(msgs, db)
    assert.deepEqual([r.attached, r.trimmed], [2, 1])
    assert.match(r.messages[1]!.content, /a\.txt（这一轮没带内容；/)
    assert.doesNotMatch(r.messages[1]!.content, /甲的内容/)
    assert.match(r.messages[3]!.content, /〔文件内容：b\.txt（文本，12B，约 4 字）〕\n乙的内容\n〔文件内容结束〕/)
    assert.match(r.messages[5]!.content, /丙的内容/)
    // 没有文件标记的请求不动
    const plain = [{ role: 'user', content: '什么都没带' }]
    assert.equal(attachFiles(plain, db).messages, plain)
    // 标记指向一个不存在的文件
    const lost = attachFiles([{ role: 'user', content: '[文件 gone.txt #aaaaaaaaaaaa]' }], db)
    assert.match(lost.messages[0]!.content, /找不到了/)
  } finally { t.cleanup() }
})

test('上传和下载：上传给前端标记，下载带文件名', async () => {
  const { t, db, blobs } = setup()
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleFileApi(db, blobs, req, res).then(ok => { if (!ok) { res.writeHead(404); res.end('{}') } })
  })
  const port = await listen(srv)
  try {
    const up = await fetch(`http://127.0.0.1:${port}/v1/eclipsis/chat/upload`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('说明 文档.txt') },
      body: '里面的字',
    })
    const info = await up.json() as any
    assert.equal(up.status, 200)
    assert.equal(info.name, '说明 文档.txt')
    assert.equal(info.chars, 4)
    assert.match(info.mark, /^\[文件 说明 文档\.txt #[0-9a-f]{12}\]$/)

    const dl = await fetch(`http://127.0.0.1:${port}/v1/eclipsis/file/${info.hash.slice(0, 12)}`)
    assert.equal(dl.status, 200)
    assert.equal(await dl.text(), '里面的字')
    assert.match(dl.headers.get('content-disposition') || '', /filename\*=UTF-8''/)
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/eclipsis/file/aaaaaaaaaaaa`)).status, 404)
    // 没有文件名：拒绝
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/eclipsis/chat/upload`, { method: 'POST', body: 'x' })).status, 400)
  } finally { await close(srv); t.cleanup() }
})

test('kindOf：按扩展名和 mime 认', () => {
  assert.equal(kindOf('a.PDF', ''), 'pdf')
  assert.equal(kindOf('a', 'application/pdf'), 'pdf')
  assert.equal(kindOf('a.docx', ''), 'docx')
  assert.equal(kindOf('main.ts', ''), 'text')
  assert.equal(kindOf('data.csv', ''), 'text')
  assert.equal(kindOf('a.xlsx', ''), 'other')
})

test('聊天记录接口：她发的文件拆成文件项，正文里不留标记', async () => {
  const { t, db, blobs } = setup()
  try {
    const f = await saveFile(db, blobs, Buffer.from('报告正文', 'utf8'), '周报.md', 'text/markdown')
    const { addEpisode } = await import('../src/db.ts')
    const { chatHistory } = await import('../src/chat-history.ts')
    addEpisode(db, {
      ts: '2026-11-11T07:00:00.000Z', channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message',
      content: `看看这个 [文件 周报.md #${f.hash.slice(0, 12)}]`, sourceRef: 'u1',
    })
    const it = chatHistory(db, {}).items[0]!
    assert.equal(it.content, '看看这个')
    assert.deepEqual(it.files, [{ name: '周报.md', hash: f.hash.slice(0, 12), size: 12, kind: 'text', chars: 4, note: null }])
  } finally { t.cleanup() }
})

test('经历表按她原来发的那份记：文件标记不会被换成整份正文（11-11 的 bug）', async () => {
  const { t, db, blobs } = setup()
  const { Recorder } = await import('../src/recorder.ts')
  try {
    const f = await saveFile(db, blobs, Buffer.from('文件里的四千字', 'utf8'), '长文.md', 'text/markdown')
    const mark = `[文件 长文.md #${f.hash.slice(0, 12)}]`
    const client = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: `${mark}\n看看这个` }] }
    const sent = attachFiles(structuredClone(client.messages), db).messages
    assert.match(sent[1]!.content, /文件里的四千字/, '发出去的那份带文件正文')

    const rec = new Recorder(db, blobs, {})
    const ctx = rec.start({
      tap: 'front', rid: 'r1', linked: false, path: '/v1/chat/completions', headers: { 'x-eclipsis-scene': 'chat' },
      body: { ...client, messages: sent }, clientBody: client,
    })
    assert.ok(ctx.id > 0)
    const ep = db.prepare(`SELECT content FROM episodes WHERE actor = 'erica' ORDER BY seq DESC LIMIT 1`).get() as any
    assert.equal(ep.content, `${mark}\n看看这个`, '经历表里是标记，不是文件正文')
    assert.doesNotMatch(ep.content, /文件里的四千字/)
    // 发给站的那份照旧记在 message_hashes 里（他醒来接聊天要用）
    const ex = db.prepare('SELECT message_hashes FROM exchanges WHERE rid = ?').get('r1') as any
    const hashes = JSON.parse(ex.message_hashes) as string[]
    const last = db.prepare('SELECT text FROM blobs WHERE hash = ?').get(hashes[1]!) as any
    assert.match(last.text, /文件里的四千字/)
  } finally { t.cleanup() }
})
