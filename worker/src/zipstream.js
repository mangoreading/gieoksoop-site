// 선물 받는 사람의 "한꺼번에 저장" — 사진·영상을 ZIP 하나로 이어서 내려준다 (2026.10).
//
// 압축은 하지 않는다(STORE): 사진·영상은 이미 압축돼 있어서 줄어들지 않고, Worker의 CPU를 쓰지 않는다.
// ZIP 머리글에는 파일의 CRC32와 크기가 먼저 들어가야 하는데, CRC32를 Worker가 계산하면 CPU 시간이 크다.
// 그래서 PC 앱이 올리기 전에 계산해서 manifest에 넣어 보내고(photos[].crc, size), 여기서는 그 값을 그대로 쓴다.
// 크기를 미리 아니까 전체 길이(Content-Length)도 미리 정할 수 있고, R2에서 읽는 대로 바로 흘려보낸다(메모리에 모으지 않음).
// 4GB를 넘지 않는 것만 다룬다(선물은 최대 90MB, ZIP64 미지원).

const enc = new TextEncoder();

function u16(v, n) { v.push(n & 255, (n >>> 8) & 255); }
function u32(v, n) { v.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255); }

function dosTime(d) { return ((d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)) & 0xffff; }
function dosDate(d) { return ((Math.max(0, d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()) & 0xffff; }

// entries: [{name, size, crc}] — name은 UTF-8(한글 가능), crc는 부호 없는 32비트 정수
export function planZip(entries, when = new Date()) {
  const t = dosTime(when), dt = dosDate(when);
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const h = [];
    u32(h, 0x04034b50); u16(h, 20); u16(h, 0x0800); u16(h, 0); u16(h, t); u16(h, dt);
    u32(h, e.crc >>> 0); u32(h, e.size); u32(h, e.size); u16(h, name.length); u16(h, 0);
    const local = new Uint8Array(h.length + name.length);
    local.set(h, 0); local.set(name, h.length);
    locals.push(local);

    const c = [];
    u32(c, 0x02014b50); u16(c, 20); u16(c, 20); u16(c, 0x0800); u16(c, 0); u16(c, t); u16(c, dt);
    u32(c, e.crc >>> 0); u32(c, e.size); u32(c, e.size); u16(c, name.length); u16(c, 0); u16(c, 0);
    u16(c, 0); u16(c, 0); u32(c, 0); u32(c, offset);
    const cen = new Uint8Array(c.length + name.length);
    cen.set(c, 0); cen.set(name, c.length);
    central.push(cen);

    offset += local.length + e.size;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const end = [];
  u32(end, 0x06054b50); u16(end, 0); u16(end, 0); u16(end, entries.length); u16(end, entries.length);
  u32(end, cdSize); u32(end, offset); u16(end, 0);
  const tail = new Uint8Array(cdSize + end.length);
  let p = 0;
  for (const x of central) { tail.set(x, p); p += x.length; }
  tail.set(end, p);
  return { locals, tail, total: offset + tail.length };
}

// getBody(entry) → R2 객체({body: ReadableStream}) 또는 null. 없으면 스트림을 오류로 끝낸다(깨진 ZIP을 정상처럼 보내지 않기 위해).
export function zipStream(entries, plan, getBody) {
  let i = 0, reader = null, tailSent = false;
  return new ReadableStream({
    // pull은 데이터를 한 덩어리 넣거나 닫을 때까지 안에서 계속 돈다(아무것도 넣지 않고 끝나면 스트림이 멈춘다).
    async pull(controller) {
      for (;;) {
        if (reader) {
          const { done, value } = await reader.read();
          if (done) { reader = null; i++; continue; }
          controller.enqueue(value);
          return;
        }
        if (i < entries.length) {
          const obj = await getBody(entries[i]);
          if (!obj || !obj.body) throw new Error("missing_object");
          controller.enqueue(plan.locals[i]);
          reader = obj.body.getReader();
          return;
        }
        if (!tailSent) { controller.enqueue(plan.tail); tailSent = true; return; }
        controller.close();
        return;
      }
    },
    cancel() { try { reader && reader.cancel(); } catch (e) { /* ignore */ } },
  });
}

// ZIP 안 파일 이름: 001_0704.jpg 처럼 보여주는 순서 + 날짜. 키의 확장자를 따른다.
export function entryName(p, idx) {
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(String(p.key || ""));
  const ext = (m ? m[1] : (p.type === "video" ? "mp4" : "jpg")).toLowerCase();
  const d = String(p.dt || "");
  const md = /^\d{4}-(\d{2})-(\d{2})/.exec(d);
  return `${String(idx + 1).padStart(3, "0")}${md ? "_" + md[1] + md[2] : ""}.${ext}`;
}
