import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// ---- 가짜 R2 ----
class FakeR2 {
  constructor(){ this.m = new Map(); }
  async put(key, body, opts){
    let buf;
    if (typeof body === 'string') buf = Buffer.from(body);
    else { const chunks=[]; for await (const c of body) chunks.push(Buffer.from(c)); buf = Buffer.concat(chunks); }
    this.m.set(key, {buf, meta: opts && opts.httpMetadata || {}});
  }
  _obj(key, buf, meta){ return { body: new ReadableStream({start(c){ c.enqueue(new Uint8Array(buf)); c.close(); }}), raw: buf, size: buf.length, json: async()=>JSON.parse(buf.toString()), writeHttpMetadata(h){ if(meta.contentType) h.set('Content-Type', meta.contentType);} }; }
  async get(key, opts){
    const e = this.m.get(key); if(!e) return null;
    let buf = e.buf;
    if (opts && opts.range) buf = buf.subarray(opts.range.offset, opts.range.offset + opts.range.length);
    return this._obj(key, buf, e.meta);
  }
  async head(key){ const e=this.m.get(key); return e?{size:e.buf.length}:null; }
  async delete(key){ this.m.delete(key); }
  async list({prefix, limit}){ return {objects:[...this.m.keys()].filter(k=>k.startsWith(prefix)).slice(0, limit||1000).map(key=>({key})), truncated:false}; }
}

// ---- 가짜 Firebase 토큰 ----
const b64u = (b)=>Buffer.from(b).toString('base64url');
const kp = await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk = await webcrypto.subtle.exportKey('jwk', kp.publicKey); jwk.kid='k1'; jwk.alg='RS256';
async function token(uid='u1'){
  const h=b64u(JSON.stringify({alg:'RS256',kid:'k1'}));
  const p=b64u(JSON.stringify({sub:uid,exp:Math.floor(Date.now()/1000)+600,iss:'https://securetoken.google.com/gieoksoop',aud:'gieoksoop'}));
  const sig=Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',kp.privateKey,Buffer.from(h+'.'+p)));
  return `${h}.${p}.${sig.toString('base64url')}`;
}
globalThis.fetch = async (u)=>{ if(String(u).includes('securetoken@system')) return new Response(JSON.stringify({keys:[jwk]})); throw new Error('unexpected fetch '+u); };

const { default: worker } = await import('../src/index.js');
const env = { SHARE_BUCKET: new FakeR2(), FIREBASE_PROJECT_ID: 'gieoksoop' };

function form(manifest, photos, videos=[], posters=[]){
  const fd = new FormData();
  fd.set('manifest', JSON.stringify(manifest));
  photos.forEach((n,i)=>fd.append('photo', new File([Buffer.from('JPEG'+i)], n, {type:'image/jpeg'})));
  videos.forEach((n,i)=>fd.append('video', new File([Buffer.from('0123456789abcdef')], n, {type:'video/mp4'})));
  posters.forEach((n,i)=>fd.append('poster', new File([Buffer.from('POSTER'+i)], n, {type:'image/jpeg'})));
  return fd;
}
async function create(fd, uid='u1'){
  return worker.fetch(new Request('https://gieoksoop.com/api/share/create',{method:'POST',body:fd,headers:{Authorization:'Bearer '+await token(uid)}}), env);
}

import { zlibCrc } from './crc_helper.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function createGift(extra={}, uid='u1'){
  const man = {kind:'gift', title:'제주: 우리/셋', to_name:'수진, 민호', from_name:'인호', message:'hi',
    captions:['a','b'], dates:['2026-05-01T10:00:00','2026-05-02T10:00:00'], places:['',''],
    videos:[{duration:3, dt:'2026-05-01T12:00:00', crc: zlibCrc(Buffer.from('0123456789abcdef'))}],
    order:['p0','v0','p1'], crcs:[zlibCrc(Buffer.from('JPEG0')), zlibCrc(Buffer.from('JPEG1'))], ...extra};
  const r = await create(form(man, ['a.jpg','b.jpg'], ['c.mp4'], ['c.jpg']), uid);
  return (await r.json()).share_id;
}

test('ZIP: 사진·영상이 한 파일로 내려오고 python zipfile이 CRC까지 검증한다', async () => {
  const id = await createGift();
  const r = await worker.fetch(new Request(`https://gieoksoop.com/share/${id}/download.zip`), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'application/zip');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(String(buf.length), r.headers.get('Content-Length'));
  assert.match(r.headers.get('Content-Disposition'), /filename\*=UTF-8''/);
  const dir = mkdtempSync(join(tmpdir(), 'zip_'));
  const f = join(dir, 'g.zip'); writeFileSync(f, buf);
  const out = execFileSync('python3', ['-c', `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print("|".join("%s:%d"%(i.filename,i.file_size) for i in z.infolist()))
`, f]).toString().trim();
  assert.equal(out, '001_0501.jpg:5|002_0501.mp4:16|003_0502.jpg:5');
});

test('ZIP: 보낸 사람이 끄면 403, 예전 선물(crc 없음)은 409, 챕터는 403', async () => {
  const off = await createGift({allow_download:false});
  assert.equal((await worker.fetch(new Request(`https://gieoksoop.com/share/${off}/download.zip`), env)).status, 403);
  const man = {kind:'gift', title:'옛', captions:['a']};
  const r = await create(form(man, ['a.jpg']));
  const old = (await r.json()).share_id;
  assert.equal((await worker.fetch(new Request(`https://gieoksoop.com/share/${old}/download.zip`), env)).status, 409);
  const ch = (await (await create(form({title:'c', captions:['a']}, ['a.jpg']))).json()).share_id;
  assert.equal((await worker.fetch(new Request(`https://gieoksoop.com/share/${ch}/download.zip`), env)).status, 403);
  assert.equal((await worker.fetch(new Request(`https://gieoksoop.com/share/zzzz/download.zip`), env)).status, 404);
});

test('선물 화면: 저장 버튼은 ZIP이 가능할 때만, 마음 남기기 칸은 항상', async () => {
  const id = await createGift();
  const html = await (await worker.fetch(new Request(`https://gieoksoop.com/share/${id}`), env)).text();
  assert.ok(html.includes(`/share/${id}/download.zip`));
  assert.ok(html.includes('id="react"'));
  const off = await createGift({allow_download:false});
  const h2 = await (await worker.fetch(new Request(`https://gieoksoop.com/share/${off}`), env)).text();
  assert.ok(!h2.includes('download.zip'));
  assert.ok(h2.includes('id="react"'));
});

function react(id, body){ return worker.fetch(new Request('https://gieoksoop.com/api/share/react',{method:'POST',body:JSON.stringify({share_id:id, ...body})}), env); }
async function reactions(id, uid='u1'){ return worker.fetch(new Request(`https://gieoksoop.com/api/share/reactions?share_id=${id}`,{headers:{Authorization:'Bearer '+await token(uid)}}), env); }

test('마음 남기기: 저장되고 소유자만 읽는다, 빈 값·봇·없는 링크는 거절', async () => {
  const id = await createGift();
  assert.equal((await react(id, {name:'수진', text:'고마워 <b>', heart:true})).status, 200);
  assert.equal((await react(id, {text:'두번째'})).status, 200);
  assert.equal((await react(id, {})).status, 400);
  assert.equal((await react(id, {text:'스팸', website:'http://x'})).status, 200);   // 봇은 조용히 무시
  assert.equal((await react('nope', {text:'x'})).status, 404);
  const r = await reactions(id);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.items.length, 2);
  assert.ok(d.items.some(x => x.name === '수진' && x.heart === true && x.text.includes('고마워')));
  assert.equal((await reactions(id, 'other')).status, 403);
  const noTok = await worker.fetch(new Request(`https://gieoksoop.com/api/share/reactions?share_id=${id}`), env);
  assert.equal(noTok.status, 401);
});

test('마음 남기기: 글자 수 제한과 개수 상한', async () => {
  const id = await createGift();
  await react(id, {name:'가'.repeat(50), text:'나'.repeat(900)});
  const d = await (await reactions(id)).json();
  assert.equal(d.items[0].name.length, 20); assert.equal(d.items[0].text.length, 500);
  for (let i = 0; i < 199; i++) await env.SHARE_BUCKET.put(`shares/${id}/reactions/x${i}.json`, JSON.stringify({id:'x'+i,at:'2020'}));
  assert.equal((await react(id, {text:'넘침'})).status, 429);
});
