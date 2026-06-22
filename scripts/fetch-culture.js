/**
 * scripts/fetch-culture.js
 * GitHub Actions에서 실행되어 문화행사 데이터를 수집하고
 * data/culture-events.json 에 저장합니다.
 *
 * 시도하는 엔드포인트 순서:
 * 1) https://www.culture.go.kr/openapi/rest/publicperformancedisplays/period
 *    (Cloudflare에서는 에러페이지를 돌려주지만 GitHub 서버에선 정상 작동할 수 있음)
 * 2) https://api.kcisa.kr/openapi/service/rest/convergence2018/conver9
 *    (공공미술 아닌 다른 행사 데이터. Cloudflare에선 막혔지만 GitHub 서버에선 접근 가능)
 *
 * 환경변수: CULTURE_KEY (GitHub Secret으로 설정)
 */

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

const CULTURE_KEY = process.env.CULTURE_KEY;
if (!CULTURE_KEY) {
  console.error("❌ CULTURE_KEY 환경변수가 없습니다. GitHub Secret을 확인하세요.");
  process.exit(1);
}

// ---------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: 15000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function today() {
  const d = new Date(Date.now() + 9 * 3600000); // KST
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function after60Days() {
  const d = new Date(Date.now() + 9 * 3600000 + 60 * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// ---------------------------------------------------------------
// 파서 - culture.go.kr XML (publicperformancedisplays)
// ---------------------------------------------------------------

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim() : "";
}

function splitBlocks(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  const blocks = [];
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);
  return blocks;
}

function parseCultureGovXml(xml) {
  // publicperformancedisplays 응답 구조
  const blocks = splitBlocks(xml, "item");
  return blocks.map((b) => {
    const title = extractTag(b, "title");
    const startDate = extractTag(b, "startDate").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    const endDate   = extractTag(b, "endDate").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    const charge    = extractTag(b, "price") || extractTag(b, "charge");
    return {
      id: `culture-${extractTag(b,"seq") || title.slice(0,20)}-${startDate}`,
      source: "문화데이터광장",
      category: extractTag(b, "subTitle") || extractTag(b,"realmName") || "공연·전시",
      title,
      place: extractTag(b, "place"),
      area:  extractTag(b, "area") || extractTag(b,"sido"),
      startDate,
      endDate,
      image: extractTag(b, "imgUrl") || extractTag(b,"thumbnail"),
      isFree: /무료/.test(charge),
      fee:  charge,
      ageInfo: extractTag(b,"realmName"),
      link: extractTag(b,"url") || extractTag(b,"homePage") || "",
    };
  }).filter((it) => it.title);
}

// ---------------------------------------------------------------
// 파서 - api.kcisa.kr conver9 XML (공공미술/공공행사)
// ---------------------------------------------------------------

function parseKcisaXml(xml) {
  const blocks = splitBlocks(xml, "item");
  return blocks.map((b) => {
    const title   = extractTag(b, "title");
    const rawPeriod = extractTag(b, "period");
    let startDate = "", endDate = "";
    if (rawPeriod) {
      const m = rawPeriod.match(/(\d{4})[.\-\/](\d{2})[.\-\/](\d{2}).*?(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})/);
      if (m) { startDate = `${m[1]}-${m[2]}-${m[3]}`; endDate = `${m[4]}-${m[5]}-${m[6]}`; }
    }
    if (!startDate) startDate = extractTag(b,"startDate").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    if (!endDate)   endDate   = extractTag(b,"endDate").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    const charge = extractTag(b,"charge") || extractTag(b,"price");
    return {
      id: `culture-kcisa-${title.slice(0,20)}-${startDate}`,
      source: "문화데이터광장",
      category: extractTag(b,"subTitle") || extractTag(b,"realmName") || "공연·전시",
      title,
      place: extractTag(b,"place") || extractTag(b,"address"),
      area:  extractTag(b,"sido"),
      startDate,
      endDate,
      image: extractTag(b,"thumbnail") || extractTag(b,"imgUrl"),
      isFree: /무료/.test(charge),
      fee:  charge,
      ageInfo: extractTag(b,"realmName"),
      link: extractTag(b,"url") || extractTag(b,"homePage") || "",
    };
  }).filter((it) => it.title);
}

// ---------------------------------------------------------------
// 수집 시도 (1순위: culture.go.kr, 2순위: kcisa.kr)
// ---------------------------------------------------------------

async function fetchCultureGov(sido = "") {
  const from = today();
  const to   = after60Days();
  const params = new URLSearchParams({
    serviceKey: CULTURE_KEY,
    from, to,
    cPage: "1", rows: "500",
    place: "", gpsxfrom: "", gpsyfrom: "", gpsxto: "", gpsyto: "",
    keyword: "", sortStdr: "1",
    ...(sido ? { sido } : {}),
  });
  // http는 307로 https 리다이렉트됨 → https로 직접 요청
  const url = `https://www.culture.go.kr/openapi/rest/publicperformancedisplays/period?${params}`;
  console.log("  시도 1: culture.go.kr →", url.slice(0, 100) + "...");
  const { status, body } = await httpGet(url);
  if (status === 200 && body.includes("<item>")) {
    const events = parseCultureGovXml(body);
    console.log(`  ✅ culture.go.kr 성공: ${events.length}건`);
    return events;
  }
  console.log(`  ❌ culture.go.kr 실패: status=${status}, sample=${body.slice(0,80)}`);
  return null;
}

async function fetchKcisa(sido = "") {
  const params = new URLSearchParams({
    serviceKey: CULTURE_KEY,
    numOfRows: "500",
    pageNo: "1",
    ...(sido ? { sido } : {}),
  });
  const url = `https://api.kcisa.kr/openapi/service/rest/convergence2018/conver9?${params}`;
  console.log("  시도 2: api.kcisa.kr →", url.slice(0, 100) + "...");
  const { status, body } = await httpGet(url);
  if (status === 200 && body.includes("<item>")) {
    const events = parseKcisaXml(body);
    console.log(`  ✅ kcisa.kr 성공: ${events.length}건`);
    return events;
  }
  console.log(`  ❌ kcisa.kr 실패: status=${status}, sample=${body.slice(0,80)}`);
  return null;
}

// ---------------------------------------------------------------
// 메인
// ---------------------------------------------------------------

async function main() {
  console.log("=== 문화행사 데이터 수집 시작 ===");
  const regions = ["서울", "경기", "인천"];
  const allEvents = [];
  const seen = new Set();

  for (const sido of regions) {
    console.log(`\n[${sido}] 수집 중...`);
    let events = await fetchCultureGov(sido).catch((e) => { console.error(e.message); return null; });
    if (events) {
      for (const ev of events) {
        if (!seen.has(ev.id)) {
          seen.add(ev.id);
          allEvents.push(ev);
        }
      }
    }
  }

  const outPath = path.join(__dirname, "..", "data", "culture-events.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    count: allEvents.length,
    events: allEvents,
  }, null, 2), "utf8");

  if (allEvents.length === 0) {
    console.warn("⚠️  수집된 행사가 0건입니다. API 키와 엔드포인트를 확인하세요.");
    // exit 0 - Actions 실패 표시 안 함 (데이터 없어도 앱은 동작)
  } else {
    console.log(`\n=== 완료: 총 ${allEvents.length}건 → ${outPath} 저장 ===`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
