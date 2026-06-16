/**
 * 스꾸 OG 메타 주입 Worker
 * /s/{slug} 요청을 가로채서 스티커별 og:title / og:image / og:url 을
 * 서버단에서 index.html <head> 에 박아 반환한다. (카톡·네이버·페북 미리보기용)
 * 그 외 모든 요청은 정적 에셋(ASSETS)으로 그대로 넘긴다.
 */

const SB_URL  = "https://ttdvoyzzpqufyiaetvxy.supabase.co";
const SB_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0ZHZveXp6cHF1ZnlpYWV0dnh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4OTA4NzAsImV4cCI6MjA5NjQ2Njg3MH0.ij7Ok1enQKrxXxndv8CL8iu3WwXmlomsBL92lrzNz0c"; // anon (공개용)
const R2_BASE = "https://pub-bb9fc97b95e344769253b627a8327e4f.r2.dev";
const SITE    = "https://seukku.seukku.workers.dev"; // ★ seukku.com 붙으면 여기 교체

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/s\/([^\/]+)\/?$/);
    if (m && request.method === "GET") {
      return handleStickerOG(request, env, decodeURIComponent(m[1]), url);
    }
    // 그 외는 정적 에셋 그대로
    return env.ASSETS.fetch(request);
  }
};

async function handleStickerOG(request, env, slug, url) {
  // 1) index.html 원본(정적 에셋) 가져오기
  const assetRes = await env.ASSETS.fetch(new Request(url.origin + "/index.html", request));

  // 2) 슬러그로 스티커 조회 (Supabase REST) — 정확 일치만 채택
  let sticker = null;
  try {
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
  } catch (e) { /* 조회 실패 시 기본 OG로 폴백 */ }

  // 못 찾으면 원본 그대로 반환 (= 사이트 기본 OG)
  if (!sticker) return assetRes;

  const name    = sticker.name || slug;
  const title   = `${name} · 스꾸 seukku`;
  const desc    = `${name} 스티커를 스꾸에서 저장 없이 바로 복사하세요. 인스타 스토리·카톡 꾸미기용 무료 스티커.`;
  const img     = `${R2_BASE}/${sticker.image_path}`;
  const pageUrl = `${SITE}/s/${encodeURIComponent(slug)}`;

  // 3) HTMLRewriter로 head 태그 교체 (없는 셀렉터는 그냥 무시됨 → 안전)
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
    .transform(new Response(assetRes.body, {
      status: assetRes.status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" }
    }));
}
