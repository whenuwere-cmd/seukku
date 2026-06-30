/**
 * 스꾸 OG 메타 주입 Worker
 * /s/{slug} 요청을 가로채서 스티커별 og:title / og:image / og:url 을
 * 서버단에서 index.html <head> 에 박아 반환한다. (카톡·네이버·페북 미리보기용)
 * 그 외 모든 요청은 정적 에셋(ASSETS)으로 그대로 넘긴다.
 *
 * ★ /api/upload : 유저 제작 말풍선(UGC) 업로드. 카카오 로그인 토큰 검증 →
 *   R2(seukku-ugc) PNG 저장 → seukku_user_bubbles 테이블 insert.
 * ★ /bubbles/*  : 말풍선 배경 이미지. 정적 에셋 우선, 없으면 R2 업로드분 프록시.
 */
const SB_URL  = "https://ttdvoyzzpqufyiaetvxy.supabase.co";
const SB_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0ZHZveXp6cHF1ZnlpYWV0dnh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4OTA4NzAsImV4cCI6MjA5NjQ2Njg3MH0.ij7Ok1enQKrxXxndv8CL8iu3WwXmlomsBL92lrzNz0c"; // anon (공개용)
const R2_BASE = "https://pub-bb9fc97b95e344769253b627a8327e4f.r2.dev";
const UGC_BASE = "https://pub-80e2b5d6ac024adea58164fa06d48191.r2.dev"; // ★ 유저 제작(UGC) R2 공개 URL
const SITE    = "https://seukku.cc"; // ★ 변경: 새 커스텀 도메인 (OG og:url / canonical 에 사용)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ★ 유저 제작 말풍선 업로드 API (가장 먼저 처리)
    if (url.pathname === "/api/upload") {
      return handleUpload(request, env);
    }

    // ★ 말풍선 배경 이미지: 정적 에셋(/bubbles/*.webp) 우선, 없으면 R2 업로드분 프록시.
    //   - 기존 배경(레포 /bubbles/ 폴더의 webp)은 그대로 정적 서빙.
    //   - 관리자에서 새로 올린 배경은 R2(R2_BASE)에 bubbles/{id}.{ext} 로 들어가므로
    //     정적에서 404 나면 R2 public 에서 받아 same-origin 으로 되돌려준다. (CORS 불필요)
    if (url.pathname.startsWith("/bubbles/") && request.method === "GET") {
      const a = await env.ASSETS.fetch(request);
      if (a.status === 200) return a;
      try {
        const r = await fetch(R2_BASE + url.pathname, { cf: { cacheEverything: true } });
        if (r.status === 200) {
          const h = new Headers(r.headers);
          h.set("cache-control", "public, max-age=86400");
          return new Response(r.body, { status: 200, headers: h });
        }
      } catch (e) { /* R2 실패 시 아래 정적 응답(404) 그대로 반환 */ }
      return a;
    }

    // ★ 옛 기본주소(seukku.seukku.workers.dev)로 들어온 요청만 seukku.cc 로 영구(301) 이동
    //   - 단톡방에 퍼진 옛 링크 + 검색엔진 색인을 새 도메인으로 넘긴다 (path·쿼리 그대로 유지)
    //   - dev-seukku... / {version}-seukku... 같은 preview 주소는 통과시켜 테스트 서버를 살린다
    //   - seukku.cc 자체 요청도 통과시켜 무한 리다이렉트를 막는다
    if (url.hostname === "seukku.seukku.workers.dev") {
      return Response.redirect("https://seukku.cc" + url.pathname + url.search, 301);
    }

    // ★ 추가: 사이트맵 동적 생성 (Supabase 스티커 목록 → 홈 + /s/{slug})
    if (url.pathname === "/sitemap.xml") {
      return handleSitemap();
    }

    const m = url.pathname.match(/^\/s\/([^\/]+)\/?$/);
    if (m && request.method === "GET") {
      return handleStickerOG(request, env, decodeURIComponent(m[1]), url);
    }
    // 그 외는 정적 에셋. HTML 응답이면 소유확인 메타들을 <head>에 주입.
    //   (네이버 서치어드바이저 + 구글 애드센스 소유확인용)
    const assetResp = await env.ASSETS.fetch(request);
    const ctype = assetResp.headers.get("content-type") || "";
    if (ctype.includes("text/html")) {
      return new HTMLRewriter()
        .on("head", {
          element(el) {
            el.append(
              '<meta name="naver-site-verification" content="02908478ae1d8a10018e4ce1314cbda1db0aa4ca">',
              { html: true }
            );
            el.append(
              '<meta name="google-adsense-account" content="ca-pub-6105869234292363">',
              { html: true }
            );
          }
        })
        .transform(assetResp);
    }
    return assetResp;
  }
};

// ============================================================
// ★ 유저 제작 말풍선 업로드
//   POST /api/upload
//   헤더: Authorization: Bearer <supabase access_token>
//   바디(JSON): { text, bubble, image(base64 dataURL) }
//   1) 토큰을 Supabase /auth/v1/user 에 되물어 검증 (방식 B)
//   2) R2(seukku-ugc) 에 PNG 저장
//   3) service_role 키로 seukku_user_bubbles insert + 프로필 upsert
// ============================================================
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, corsHeaders())
  });
}

async function handleUpload(request, env) {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }
  if (request.method !== "POST") {
    return jsonResp({ error: "method_not_allowed" }, 405);
  }

  // service_role 키 (Cloudflare Secret). 없으면 설정 누락.
  const SERVICE_KEY = env.SB_SERVICE_KEY;
  if (!SERVICE_KEY) {
    return jsonResp({ error: "server_misconfig", detail: "SB_SERVICE_KEY 미설정" }, 500);
  }

  // 1) 토큰 검증 (방식 B) — 헤더의 access_token 을 Supabase 에 되물음
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return jsonResp({ error: "no_token" }, 401);

  let user = null;
  try {
    const ur = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_KEY, Authorization: "Bearer " + token }
    });
    if (!ur.ok) return jsonResp({ error: "invalid_token" }, 401);
    user = await ur.json();
  } catch (e) {
    return jsonResp({ error: "auth_failed" }, 401);
  }
  if (!user || !user.id) return jsonResp({ error: "invalid_token" }, 401);

  // 2) 바디 파싱 + 검증
  let body;
  try { body = await request.json(); } catch (e) { return jsonResp({ error: "bad_body" }, 400); }

  const text   = String(body.text || "").trim();
  const bubble = String(body.bubble || "").trim();
  const image  = String(body.image || "");

  if (!text)             return jsonResp({ error: "empty_text" }, 400);
  if (Array.from(text).length > 10) return jsonResp({ error: "text_too_long" }, 400);
  if (!bubble)           return jsonResp({ error: "no_bubble" }, 400);
  // 허용된 말풍선 종류만
  const ALLOWED = ["yellow", "green", "blue", "pink", "limeoval", "greenoval", "pinkoval", "sunsetoval", "whiteoval", "whitebox"];
  if (ALLOWED.indexOf(bubble) === -1) return jsonResp({ error: "bad_bubble" }, 400);

  // dataURL(base64 png) → 바이너리
  const mm = image.match(/^data:image\/png;base64,(.+)$/);
  if (!mm) return jsonResp({ error: "bad_image" }, 400);
  let bytes;
  try {
    const bin = atob(mm[1]);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (e) {
    return jsonResp({ error: "decode_failed" }, 400);
  }
  // 용량 가드 (1.5MB 초과 거부 — 760x317 PNG는 한참 작음)
  if (bytes.length > 1.5 * 1024 * 1024) return jsonResp({ error: "image_too_big" }, 413);

  // 닉네임 (토큰의 메타데이터에서)
  const meta = user.user_metadata || {};
  const nickname = meta.name || meta.nickname || meta.full_name || meta.preferred_username || "스꾸유저";

  // 3) R2 저장 — ugc/{user앞8}_{시각}_{난수}.png
  const stamp = Date.now().toString(36);
  const rnd   = Math.random().toString(36).slice(2, 8);
  const key   = `ugc/${user.id.slice(0, 8)}_${stamp}_${rnd}.png`;
  try {
    await env.UGC_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" }
    });
  } catch (e) {
    return jsonResp({ error: "r2_failed", detail: String(e) }, 500);
  }

  // 4) DB insert (service_role → RLS 우회) + 프로필 upsert
  try {
    // 프로필 upsert (가입 내역 — 최초 1회 기록, 닉네임 갱신)
    await fetch(`${SB_URL}/rest/v1/seukku_profiles?on_conflict=id`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
        "content-type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({ id: user.id, nickname: nickname })
    });

    // 말풍선 insert
    const ins = await fetch(`${SB_URL}/rest/v1/seukku_user_bubbles`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
        "content-type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        user_id: user.id,
        nickname: nickname,
        text: text,
        bubble: bubble,
        image_path: key,
        status: "public"
      })
    });
    if (!ins.ok) {
      const errtxt = await ins.text();
      return jsonResp({ error: "db_failed", detail: errtxt }, 500);
    }
    const rows = await ins.json();
    const row = (rows && rows[0]) || {};
    return jsonResp({ ok: true, id: row.id, url: `${UGC_BASE}/${key}`, image_path: key });
  } catch (e) {
    return jsonResp({ error: "db_exception", detail: String(e) }, 500);
  }
}

async function handleStickerOG(request, env, slug, url) {
  // 1) index.html 원본(정적 에셋) 가져오기
  const assetRes = await env.ASSETS.fetch(new Request(url.origin + "/index.html", request));
  try {
    // 2) 슬러그로 스티커 조회 (Supabase REST) — 정확 일치만 채택
    let sticker = null;
    const q = `${SB_URL}/rest/v1/stickers?select=name,image_path,category` +
              `&image_path=ilike.*${encodeURIComponent(slug)}*&limit=10`;
    const r = await fetch(q, { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } });
    if (r.ok) {
      const rows = await r.json();
      sticker = (rows || []).find(function (row) {
        const seg = String(row.image_path).split("/").pop().replace(/\.[^.\/]+$/, "");
        return seg === slug;
      });
    }
    // 못 찾으면 원본 그대로 반환 (= 사이트 기본 OG)
    if (!sticker) return assetRes;
    const name    = sticker.name || slug;
    const title   = `${name} · 스꾸 seukku`;
    const desc    = `${name} 스티커를 스꾸에서 저장 없이 바로 복사하세요. 인스타 스토리·카톡 꾸미기용 무료 스티커.`;
    const img     = `${R2_BASE}/${sticker.image_path}`;
    const pageUrl = `${SITE}/s/${encodeURIComponent(slug)}`;
    // 3) HTMLRewriter로 head 태그 교체
    //    ★ 원본 응답(assetRes)을 그대로 transform → 헤더·인코딩 보존 (본문 깨짐/흰 화면 방지)
    return new HTMLRewriter()
      .on("title",                            { element(el){ el.setInnerContent(title); } })
      .on('meta[property="og:title"]',        { element(el){ el.setAttribute("content", title); } })
      .on('meta[property="og:description"]',  { element(el){ el.setAttribute("content", desc); } })
      .on('meta[property="og:image"]',        { element(el){ el.setAttribute("content", img); } })
      .on('meta[property="og:url"]',          { element(el){ el.setAttribute("content", pageUrl); } })
      .on('meta[property="og:type"]',         { element(el){ el.setAttribute("content", "article"); } })
      .on('meta[name="twitter:title"]',       { element(el){ el.setAttribute("content", title); } })
      .on('meta[name="twitter:description"]', { element(el){ el.setAttribute("content", desc); } })
      .on('meta[name="twitter:image"]',       { element(el){ el.setAttribute("content", img); } })
      .on('meta[name="description"]',         { element(el){ el.setAttribute("content", desc); } })
      .on('link[rel="canonical"]',            { element(el){ el.setAttribute("href", pageUrl); } })
      .transform(assetRes);
  } catch (e) {
    // OG 주입 중 무슨 일이 있어도 페이지는 무조건 뜨게 (원본 index.html 반환)
    return assetRes;
  }
}

// ★ 추가: 사이트맵(/sitemap.xml) 동적 생성
//   Supabase stickers 테이블에서 전체 목록을 읽어 홈 + 각 스티커 딥링크(/s/{slug})를 XML로 반환.
//   스티커가 추가돼도 자동 반영되므로 별도 파일 관리가 필요 없다.
async function handleSitemap() {
  const locs = [SITE + "/"];
  try {
    const q = `${SB_URL}/rest/v1/stickers?select=image_path&limit=5000`;
    const r = await fetch(q, { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } });
    if (r.ok) {
      const rows = await r.json();
      const seen = new Set();
      for (const row of (rows || [])) {
        if (!row.image_path) continue;
        const slug = String(row.image_path).split("/").pop().replace(/\.[^.\/]+$/, "");
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        locs.push(`${SITE}/s/${encodeURIComponent(slug)}`);
      }
    }
  } catch (e) { /* 실패해도 최소 홈은 반환 */ }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    locs.map(function (u) { return `  <url><loc>${u}</loc></url>`; }).join("\n") +
    `\n</urlset>\n`;
  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600"
    }
  });
}
