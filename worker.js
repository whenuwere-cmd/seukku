/**
 * 스꾸 OG 메타 주입 Worker
 * /s/{slug} 요청을 가로채서 스티커별 og:title / og:image / og:url 을
 * 서버단에서 index.html <head> 에 박아 반환한다. (카톡·네이버·페북 미리보기용)
 * 그 외 모든 요청은 정적 에셋(ASSETS)으로 그대로 넘긴다.
 */
const SB_URL  = "https://ttdvoyzzpqufyiaetvxy.supabase.co";
const SB_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0ZHZveXp6cHF1ZnlpYWV0dnh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4OTA4NzAsImV4cCI6MjA5NjQ2Njg3MH0.ij7Ok1enQKrxXxndv8CL8iu3WwXmlomsBL92lrzNz0c"; // anon (공개용)
const R2_BASE = "https://pub-bb9fc97b95e344769253b627a8327e4f.r2.dev";
const SITE    = "https://seukku.cc"; // ★ 변경: 새 커스텀 도메인 (OG og:url / canonical 에 사용)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
