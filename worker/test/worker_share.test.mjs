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
  _obj(key, buf, meta){ return { body: buf, size: buf.length, json: async()=>JSON.parse(buf.toString()), writeHttpMetadata(h){ if(meta.contentType) h.set('Content-Type', meta.contentType);} }; }
  async get(key, opts){
    const e = this.m.get(key); if(!e) return null;
    let buf = e.buf;
    if (opts && opts.range) buf = buf.subarray(opts.range.offset, opts.range.offset + opts.range.length);
    return this._obj(key, buf, e.meta);
  }
  async head(key){ const e=this.m.get(key); return e?{size:e.buf.length}:null; }
  async delete(key){ this.m.delete(key); }
  async list({prefix}){ return {objects:[...this.m.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})), truncated:false}; }
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

test('선물 공유: 사진+영상+편지가 저장되고 order대로 정렬된다', async () => {
  const man = {kind:'gift', title:'제주', to_name:'수진', from_name:'인호', message:'안녕\n<b>x</b>',
    captions:['a','b'], dates:['2026-05-01T10:00:00','2026-05-02T10:00:00'], places:['',''],
    videos:[{duration:6.2, dt:'2026-05-01T12:00:00', caption:'파도'}], order:['p0','v0','p1']};
  const r = await create(form(man, ['a.jpg','b.jpg'], ['c.mp4'], ['c.jpg']));
  assert.equal(r.status, 200);
  const {share_id} = await r.json();
  const mf = JSON.parse((await env.SHARE_BUCKET.get(`shares/${share_id}/manifest.json`)).body.toString());
  assert.equal(mf.kind, 'gift'); assert.equal(mf.to_name, '수진');
  assert.deepEqual(mf.photos.map(p=>p.type), ['photo','video','photo']);
  assert.ok(mf.photos[1].poster.includes('poster'));
  assert.equal(mf.photos[1].duration, 6.2);
});

test('이전 방식(사진만, kind 없음)도 그대로 동작', async () => {
  const r = await create(form({title:'챕터', captions:['x']}, ['a.jpg']));
  assert.equal(r.status, 200);
  const {share_id} = await r.json();
  const mf = JSON.parse((await env.SHARE_BUCKET.get(`shares/${share_id}/manifest.json`)).body.toString());
  assert.equal(mf.kind, 'chapter'); assert.equal(mf.photos.length, 1);
});

test('사진도 영상도 없으면 400, 토큰 없으면 401', async () => {
  assert.equal((await create(form({title:'x'}, []))).status, 400);
  const r = await worker.fetch(new Request('https://gieoksoop.com/api/share/create',{method:'POST',body:form({}, ['a.jpg'])}), env);
  assert.equal(r.status, 401);
});

test('너무 큰 영상은 413', async () => {
  const fd = new FormData(); fd.set('manifest','{}');
  fd.append('video', new File([new Uint8Array(61*1024*1024)], 'big.mp4', {type:'video/mp4'}));
  const r = await create(fd); assert.equal(r.status, 413);
});

test('공유 페이지 HTML: 이스케이프·noindex·OG', async () => {
  const man = {kind:'gift', title:'<img src=x onerror=alert(1)>', to_name:'수진', from_name:'인호', message:'</script><script>alert(1)</script>', captions:[''], dates:[''], places:['']};
  const r = await create(form(man, ['a.jpg']));
  const {share_id} = await r.json();
  const v = await worker.fetch(new Request(`https://gieoksoop.com/share/${share_id}`), env);
  assert.equal(v.status, 200);
  assert.equal(v.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  const html = await v.text();
  assert.ok(!html.includes('<img src=x onerror'));
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(html.includes('property="og:image" content="https://gieoksoop.com/share/'));
  assert.ok(html.includes('robots'));
});

test('Range 요청: 206과 Content-Range', async () => {
  const man = {kind:'gift', title:'t', videos:[{duration:3}], order:['v0']};
  const r = await create(form(man, ['a.jpg'], ['c.mp4'], ['c.jpg']));
  const {share_id} = await r.json();
  const mf = JSON.parse((await env.SHARE_BUCKET.get(`shares/${share_id}/manifest.json`)).body.toString());
  const vkey = mf.photos.find(p=>p.type==='video').key;
  const url = `https://gieoksoop.com/share/${share_id}/photo/${vkey}`;
  const a = await worker.fetch(new Request(url,{headers:{Range:'bytes=2-5'}}), env);
  assert.equal(a.status, 206);
  assert.equal(a.headers.get('Content-Range'), 'bytes 2-5/16');
  assert.equal(Buffer.from(await a.arrayBuffer()).toString(), '2345');
  const b = await worker.fetch(new Request(url,{headers:{Range:'bytes=-4'}}), env);
  assert.equal(b.headers.get('Content-Range'), 'bytes 12-15/16');
  const c = await worker.fetch(new Request(url,{headers:{Range:'bytes=100-'}}), env);
  assert.equal(c.status, 416);
  const d = await worker.fetch(new Request(url), env);
  assert.equal(d.status, 200); assert.equal(d.headers.get('Accept-Ranges'), 'bytes');
});

test('경로 조작 키는 404', async () => {
  const r = await worker.fetch(new Request('https://gieoksoop.com/share/abc/photo/..%2Fmanifest.json'), env);
  assert.equal(r.status, 404);
});

test('다른 사람이 남의 share_id로 덮어쓰기 불가(새 id 발급)', async () => {
  const r1 = await create(form({title:'a'}, ['a.jpg']), 'owner');
  const id1 = (await r1.json()).share_id;
  const r2 = await create(form({title:'b', existing_share_id:id1}, ['a.jpg']), 'other');
  const id2 = (await r2.json()).share_id;
  assert.notEqual(id1, id2);
  const r3 = await create(form({title:'c', existing_share_id:id1}, ['a.jpg']), 'owner');
  assert.equal((await r3.json()).share_id, id1);
});

test('얼굴 위치(focus)와 표지(cover_ref) 저장, 이상한 값은 버린다', async () => {
  const man = {kind:'gift', title:'t', captions:['','',''], dates:['','',''], places:['','',''],
    focus:[[0.3,0.4],[5,-2],['x',null]], cover_ref:'p1'};
  const r = await create(form(man, ['a.jpg','b.jpg','c.jpg']));
  const {share_id} = await r.json();
  const mf = JSON.parse((await env.SHARE_BUCKET.get(`shares/${share_id}/manifest.json`)).body.toString());
  assert.equal(mf.photos[0].fx, 0.3); assert.equal(mf.photos[0].fy, 0.4);
  assert.equal(mf.photos[1].fx, 1); assert.equal(mf.photos[1].fy, 0);       // 범위 밖은 0~1로 자른다
  assert.equal(mf.photos[2].fx, undefined);                                    // 숫자가 아니면 없음
  assert.equal(mf.cover, mf.photos[1].key);
  const v = await worker.fetch(new Request(`https://gieoksoop.com/share/${share_id}`), env);
  const html = await v.text();
  assert.ok(html.includes('object-position:30.0% 40.0%'));
  assert.ok(html.includes('/fonts/share/share-sans.woff2'));
  assert.ok(!html.includes('googleapis') && !html.includes('jsdelivr'));
});

test('잘못된 cover_ref는 무시', async () => {
  const r = await create(form({title:'t', cover_ref:'p9'}, ['a.jpg']));
  const {share_id} = await r.json();
  const mf = JSON.parse((await env.SHARE_BUCKET.get(`shares/${share_id}/manifest.json`)).body.toString());
  assert.equal(mf.cover, '');
});
