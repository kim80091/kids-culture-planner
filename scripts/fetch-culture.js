/**
 * scripts/fetch-culture.js
 * 한국문화예술회관연합회_공연전시정보 수집 → data/culture-events.json 저장
 * 엔드포인트: https://api.kcisa.kr/openapi/service/rest/meta2020/getKOCAperf
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const CULTURE_KEY = process.env.CULTURE_KEY;
if (!CULTURE_KEY) {
  console.error("CULTURE_KEY 환경변수가 없습니다.");
  process.exit(1);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function extract(b, tag) {
  const m = b.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/&#39;/g,"'").trim() : "";
}
function blocks(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  const r = []; let m;
  while ((m = re.exec(xml)) !== null) r.push(m[1]);
  return r;
}

function parsePeriod(p) {
  if (!p) return { startDate: "", endDate: "" };
  const m = p.match(/(\d{4}[.\-]\d{2}[.\-]\d{2}).*?(\d{4}[.\-]\d{2}[.\-]\d{2})/);
  if (m) return { startDate: m[1].replace(/\./g,"-"), endDate: m[2].replace(/\./g,"-") };
  const s = p.match(/(\d{4}[.\-]\d{2}[.\-]\d{2})/);
  if (s) return { startDate: s[1].replace(/\./g,"-"), endDate: s[1].replace(/\./g,"-") };
  return { startDate: "", endDate: "" };
}

function parseXml(xml) {
  return blocks(xml, "item").map(b => {
    const title = extract(b, "title");
    const { startDate, endDate } = parsePeriod(extract(b, "eventPeriod"));
    const charge = extract(b, "charge");
    return {
      id: `culture-koca-${title.slice(0,30)}-${startDate}`,
      source: "문화데이터광장",
      category: "공연·전시",
      title,
      place: extract(b, "venue"),
      area: "",
      startDate,
      endDate,
      image: extract(b, "referenceIdentifier"),
      isFree: /무료/.test(charge),
      fee: charge,
      ageInfo: "",
      link: extract(b, "url") || "",
    };
  }).filter(it => it.title);
}

async function fetchPage(page) {
  const p = new URLSearchParams({
    serviceKey: CULTURE_KEY,
    numOfRows: "100",
    pageNo: String(page),
  });
  const url = `https://api.kcisa.kr/openapi/service/rest/meta2020/getKOCAperf?${p}`;
  const { status, body } = await httpGet(url);
  if (status === 200 && body.includes("<item>")) return parseXml(body);
  console.log(`  페이지${page} 실패: status=${status} sample=${body.slice(0,150)}`);
  return [];
}

async function main() {
  console.log("=== 한국문화예술회관연합회 공연전시정보 수집 시작 ===");
  const all = [], seen = new Set();

  for (let page = 1; page <= 10; page++) {
    console.log(`페이지 ${page} 요청 중...`);
    const ev = await fetchPage(page).catch(e => { console.error(e.message); return []; });
    if (ev.length === 0) { console.log("더 이상 데이터 없음"); break; }
    for (const e of ev) {
      if (!seen.has(e.id)) { seen.add(e.id); all.push(e); }
    }
    console.log(`  → ${ev.length}건 수집 (누적 ${all.length}건)`);
  }

  const out = path.join(__dirname, "..", "data", "culture-events.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    updatedAt: new Date().toISOString(),
    count: all.length,
    events: all,
  }, null, 2));

  console.log(`=== 완료: 총 ${all.length}건 저장 ===`);
  if (all.length === 0) {
    console.warn("0건 - API 키/엔드포인트 확인 필요");
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
