// Firestore REST API 클라이언트 (Cloudflare Workers용, firebase-admin 미사용).
// 서비스 계정 키(env.FIREBASE_SERVICE_ACCOUNT_JSON)로 Google OAuth2 JWT bearer
// 플로우를 직접 구현해서 access token을 받고, Firestore REST API를 fetch로 호출한다.
// Workers 런타임에는 Node 전용 firebase-admin SDK를 쓸 수 없어서 이 방식이 표준.

let cachedToken = null;
let cachedTokenExpiry = 0;

function base64UrlEncode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signJwtRS256(header, payload, privateKeyPem) {
  const encoder = new TextEncoder();
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const keyData = pemToArrayBuffer(privateKeyPem);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    encoder.encode(signingInput)
  );
  const sigB64 = base64UrlEncode(new Uint8Array(signature));
  return `${signingInput}.${sigB64}`;
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedTokenExpiry - 60) return cachedToken;

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error("bad_service_account_json");
  }

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const assertion = await signJwtRS256(header, claims, serviceAccount.private_key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("google_token_failed: " + text);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = now + (data.expires_in || 3600);
  return cachedToken;
}

// JS 값 -> Firestore REST 문서 필드 형식으로 변환.
function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(encodeValue) } };
  }
  if (typeof v === "object") {
    return { mapValue: { fields: encodeFields(v) } };
  }
  return { stringValue: String(v) };
}

function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    fields[k] = encodeValue(v);
  }
  return fields;
}

// Firestore REST 문서 필드 -> 평범한 JS 값으로 변환.
function decodeValue(fv) {
  if (!fv) return null;
  if ("stringValue" in fv) return fv.stringValue;
  if ("integerValue" in fv) return parseInt(fv.integerValue, 10);
  if ("doubleValue" in fv) return fv.doubleValue;
  if ("booleanValue" in fv) return fv.booleanValue;
  if ("timestampValue" in fv) return new Date(fv.timestampValue);
  if ("nullValue" in fv) return null;
  if ("arrayValue" in fv) return (fv.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in fv) return decodeFields(fv.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) obj[k] = decodeValue(v);
  return obj;
}

function docBaseUrl(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

// 문서 하나 읽기. 없으면 null.
export async function firestoreGetDoc(env, path) {
  const token = await getGoogleAccessToken(env);
  const res = await fetch(`${docBaseUrl(env)}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("firestore_get_failed: " + (await res.text()));
  const data = await res.json();
  return { id: path.split("/").pop(), ...decodeFields(data.fields || {}) };
}

// 문서 부분 갱신(없으면 새로 생성). fieldsObj에 들어있는 키만 건드린다.
export async function firestorePatchDoc(env, path, fieldsObj) {
  const token = await getGoogleAccessToken(env);
  const fieldPaths = Object.keys(fieldsObj)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");
  const res = await fetch(`${docBaseUrl(env)}/${path}?${fieldPaths}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: encodeFields(fieldsObj) }),
  });
  if (!res.ok) throw new Error("firestore_patch_failed: " + (await res.text()));
  return res.json();
}

// 새 문서를 자동 ID로 컬렉션에 추가.
export async function firestoreAddDoc(env, collectionPath, fieldsObj) {
  const token = await getGoogleAccessToken(env);
  const res = await fetch(`${docBaseUrl(env)}/${collectionPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: encodeFields(fieldsObj) }),
  });
  if (!res.ok) throw new Error("firestore_add_failed: " + (await res.text()));
  const data = await res.json();
  const id = (data.name || "").split("/").pop();
  return { id, ...decodeFields(data.fields || {}) };
}

// 단순 동등 조건(equals) 하나로 컬렉션을 조회. (복합 인덱스 필요 없는 형태만 지원)
export async function firestoreQuery(env, collectionId, fieldName, op, value) {
  const token = await getGoogleAccessToken(env);
  const body = {
    structuredQuery: {
      from: [{ collectionId }],
      where: {
        fieldFilter: {
          field: { fieldPath: fieldName },
          op,
          value: encodeValue(value),
        },
      },
    },
  };
  const res = await fetch(`${docBaseUrl(env)}:runQuery`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("firestore_query_failed: " + (await res.text()));
  const rows = await res.json();
  return rows
    .filter((r) => r.document)
    .map((r) => ({
      id: r.document.name.split("/").pop(),
      ...decodeFields(r.document.fields || {}),
    }));
}

// 정기결제(cron) 대상 조회: 구독중(active) + 자동결제(auto_renew) 켜짐 + 다음 결제일이
// 이미 지난 사용자. 3개 조건을 동시에 걸어야 해서 firestoreQuery(단일 조건)로는 안 되고
// 복합(AND) 쿼리를 직접 만든다.
// 주의: Firestore가 이런 복합 쿼리에는 색인(index)을 요구할 수 있다. 처음 cron이 돌 때
// Cloudflare Worker 로그에 "The query requires an index..." 같은 에러가 보이면, 그 에러
// 메시지에 포함된 링크를 열어 색인을 만들어주면 된다(Firebase 콘솔에서 자동 생성됨).
export async function firestoreQueryDueBilling(env, nowDate, limit) {
  const token = await getGoogleAccessToken(env);
  const body = {
    structuredQuery: {
      from: [{ collectionId: "users" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "subscription_status" },
                op: "EQUAL",
                value: encodeValue("active"),
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: "auto_renew" },
                op: "EQUAL",
                value: encodeValue(true),
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: "next_billing_at" },
                op: "LESS_THAN_OR_EQUAL",
                value: encodeValue(nowDate),
              },
            },
          ],
        },
      },
      limit: limit || 200,
    },
  };
  const res = await fetch(`${docBaseUrl(env)}:runQuery`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("firestore_query_due_billing_failed: " + (await res.text()));
  const rows = await res.json();
  return rows
    .filter((r) => r.document)
    .map((r) => ({
      id: r.document.name.split("/").pop(),
      ...decodeFields(r.document.fields || {}),
    }));
}
