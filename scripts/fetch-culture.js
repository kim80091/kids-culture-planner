/**
 * scripts/fetch-culture.js
 * culture.go.kr 공연전시정보 수집 → data/culture-events.json 저장
 * 리다이렉트(307)를 자동으로 따라갑니다.
 */

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

const CULTURE_KEY = process.env.CULTURE_KEY;
if (!CULTURE_KEY) {
  console.error("CULTURE_KEY 환경변수가 없습니다.");
  process.exit(1);
}

// 리다이렉트 자동 추적 (최대 5회)
function httpGet(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("too many redirects"));
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: 20000 }, (res) => {
      // 301/302/307/308 리다이렉트 처리
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        console.log(`  리다이렉트 → ${next.slice(0, 80)}`);
        res.resume();
        return resolve(httpGet(next, redirectCount + 1));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function today() {
  return new Date(Date.now() + 9*3600000).toISOString().slice(0,10).replace(/-/g,"");
}
function after60() {
  return new Date(Date.now() + 9*3600000 + 60*86400000).toISOString().slice(0,10).replace(/-/g,"");
}

function extract(b, tag) {
  const m = b.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").trim() : "";
}
function blocks(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  const r = []; let m;
  while ((m = re.exec(xml)) !== null) r.push(m[1]);
  return r;
}

function parseXml(xml) {
  return blocks(xml, "item").map(b => {
    const title = extract(b, "title");
    const sd = extract(b, "startDate").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    const ed = extract(b, "endDate").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    const fee = extract(b, "price") || extract(b, "charge");
    return {
      id: `culture-${extract(b,"seq")||title.slice(0,20)}-${sd}`,
      source: "문화데이터광장",
      category: extract(b,"subTitle") || extract(b,"realmName") || "공연·전시",
      title,
      place: extract(b,"place"),
      area: extract(b,"area") || extract(b,"sido"),
      startDate: sd,
      endDate: ed,
      image: extract(b,"imgUrl") || extract(b,"thumbnail"),
      isFree: /무료/.test(fee),
      fee,
      ageInfo: extract(b,"realmName"),
      link: extract(b,"url") || extract(b,"homePage") || "",
    };
  }).filter(it => it.title);
}

async function fetchSido(sido) {
  const p = new URLSearchParams({
    serviceKey: CULTURE_KEY,
    from: today(), to: after60(),
    cPage: "1", rows: "500",
    place: "", gpsxfrom: "", gpsyfrom: "", gpsxto: "", gpsyto: "",
    keyword: "", sortStdr: "1",
    sido,
  });
  const url = `http://www.culture.go.kr/openapi/rest/publicperformancedisplays/period?${p}`;
  console.log(`[${sido}] 요청 중...`);
  const { status, body } = await httpGet(url);
  if (status === 200 && body.includes("<item>")) {
    const ev = parseXml(body);
    console.log(`[${sido}] ✅ ${ev.length}건`);
    return ev;
  }
  console.log(`[${sido}] ❌ status=${status} sample=${body.slice(0,100)}`);
  return [];
}

async function main() {
  console.log("=== 문화행사 수집 시작 ===");
  const all = [], seen = new Set();
  for (const sido of ["서울", "경기", "인천"]) {
    const ev = await fetchSido(sido).catch(e => { console.error(e.message); return []; });
    for (const e of ev) {
      if (!seen.has(e.id)) { seen.add(e.id); all.push(e); }
    }
  }
  const out = path.join(__dirname, "..", "data", "culture-events.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ updatedAt: new Date().toISOString(), count: all.length, events: all }, null, 2));
  console.log(`=== 완료: 총 ${all.length}건 저장 ===`);
  if (all.length === 0) console.warn("0건 - API 키/엔드포인트 확인 필요");
}

main().catch(e => { console.error(e); process.exit(1); });
