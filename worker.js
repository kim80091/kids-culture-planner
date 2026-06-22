/**
 * 아이와 함께 - 문화행사 수집 + 예산 일정 플래너 (Cloudflare Worker)
 * ------------------------------------------------------------
 * 엔드포인트
 *   GET /api/events   문화행사/공연 목록 (필터: region, from, to, category, kidsOnly)
 *   GET /api/plan     예산 기반 주간 일정 생성 (weekdayBudget, weekendBudget, region, weekOffset)
 *   GET /api/precheck KOPIS / 서울시 API 키가 정상 동작하는지 점검 (stock_trio의 pre_check.py와 같은 개념)
 *
 * 필요한 환경변수 (wrangler secret 또는 wrangler.toml [vars]):
 *   KOPIS_KEY  - https://www.kopis.or.kr/por/cs/openapi/openApiInfo.do 에서 발급
 *   SEOUL_KEY  - https://data.seoul.go.kr 회원가입 후 발급 (인증키 신청 > 즉시발급)
 *
 * KV 네임스페이스 (선택, 없어도 동작은 함 - 캐싱만 안 됨):
 *   EVENTS_KV  - wrangler.toml에 바인딩
 */

// ---------------------------------------------------------------
// 공통 유틸
// ---------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function decodeEntities(str = "") {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// KST(UTC+9) 기준 날짜 계산 (Workers 기본 타임존은 UTC)
function nowKST() {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

function fmtDate(d) {
  // YYYY-MM-DD
  return d.toISOString().slice(0, 10);
}

function fmtDateCompact(d) {
  // YYYYMMDD (KOPIS용)
  return fmtDate(d).replace(/-/g, "");
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

// 외부 공공 API 중 하나가 응답 없이 멈춰도 전체 요청이 같이 죽지 않도록
// 모든 외부 fetch에는 타임아웃을 걸어서 실패를 빠르게 처리합니다.
async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 이번 주(0) / 다음 주(1) / 셋째 주(2) / 넷째 주(3) 중 선택한 한 주의 월~일 날짜 배열 생성
function buildWeekDates(weekOffset = 0) {
  const today = nowKST();
  const dow = today.getUTCDay(); // 0=일 ... 6=토
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = addDays(today, mondayOffset);

  // 이번 주말: 이번 주 토요일(+5)과 일요일(+6)만 반환
  if (weekOffset === "weekend") {
    return [
      { date: fmtDate(addDays(monday, 5)), dayOfWeek: "토", dayType: "weekend" },
      { date: fmtDate(addDays(monday, 6)), dayOfWeek: "일", dayType: "weekend" },
    ];
  }

  const startMonday = addDays(monday, weekOffset * 7);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(startMonday, i);
    const dow2 = d.getUTCDay();
    dates.push({
      date: fmtDate(d),
      dayOfWeek: ["일", "월", "화", "수", "목", "금", "토"][dow2],
      dayType: dow2 === 0 || dow2 === 6 ? "weekend" : "weekday",
    });
  }
  return dates;
}

// ---------------------------------------------------------------
// 지역 코드
// ---------------------------------------------------------------

// KOPIS signgucode
// 광역: 11=서울, 28=인천, 41=경기
// 구(gu) 단위: 서울 구코드는 11+구코드 5자리 형식
// 수정구·중원구는 성남시(경기)에 속하므로 41로 요청 후 주소 필터링
const KOPIS_REGION_CODES = {
  seoul:      ["11"],
  incheon:    ["28"],
  gyeonggi:   ["41"],
  metro:      ["11", "28", "41"],
  songpa:     ["11710"],           // 서울 송파구
  songpa_adj: ["11710", "11680", "11740", "11215", "41"], // 송파+강남+강동+광진+경기(수정/중원 포함)
};

// 수정구·중원구는 경기(41) 전체 요청 후 주소로 필터링이 필요함.
// 그 외 구단위는 결과를 그대로 씀.
// 아래 필터 맵: region → 결과에서 주소(addr/area 필드)로 추가 필터링할 구 이름 목록
// (빈 배열 = 필터 없이 전체 사용)
const REGION_GU_FILTER = {
  songpa:     ["송파구"],
  songpa_adj: ["송파구", "강남구", "강동구", "광진구", "수정구", "중원구"],
};

function resolveRegions(region) {
  return KOPIS_REGION_CODES[region] || KOPIS_REGION_CODES.metro;
}

// 한국관광공사 TourAPI 지역코드
// areaCode: 1=서울, 2=인천, 31=경기
// 서울 구 단위 sigunguCode: 송파구=25, 강남구=17, 강동구=14, 광진구=9
// 경기 성남시(수정구/중원구) → areaCode=31로 전체 요청 후 주소 필터링
const TOUR_AREA_CODES = {
  seoul:      [{ areaCode: "1" }],
  incheon:    [{ areaCode: "2" }],
  gyeonggi:   [{ areaCode: "31" }],
  metro:      [{ areaCode: "1" }, { areaCode: "2" }, { areaCode: "31" }],
  songpa:     [{ areaCode: "1", sigunguCode: "25" }],
  songpa_adj: [
    { areaCode: "1", sigunguCode: "25" }, // 송파구
    { areaCode: "1", sigunguCode: "17" }, // 강남구
    { areaCode: "1", sigunguCode: "14" }, // 강동구
    { areaCode: "1", sigunguCode: "9"  }, // 광진구
    { areaCode: "31" },                   // 경기 전체(수정/중원 포함) → 주소 필터링
  ],
};

function resolveTourAreas(region) {
  return TOUR_AREA_CODES[region] || TOUR_AREA_CODES.metro;
}

// 결과 목록을 구 이름으로 필터링 (주소 필드 기준)
function applyGuFilter(items, region) {
  const guList = REGION_GU_FILTER[region];
  if (!guList || !guList.length) return items;
  return items.filter((it) => {
    const addr = [it.place || "", it.area || "", it.addr1 || ""].join(" ");
    return guList.some((gu) => addr.includes(gu));
  });
}

// ---------------------------------------------------------------
// KOPIS (공연예술통합전산망) 연동
// 공식 가이드: https://www.kopis.or.kr/por/cs/openapi/openApiInfo.do
// 주의: 발급받은 매뉴얼 PDF 기준으로 필드명이 다를 수 있어 정상 동작하지 않으면
//       /api/precheck 결과의 rawSample로 실제 태그명을 확인 후 parseKopisList()만 수정하면 됨.
// ---------------------------------------------------------------

function splitXmlBlocks(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  const blocks = [];
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);
  return blocks;
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? decodeEntities(m[1]) : "";
}

function parseKopisList(xml) {
  const blocks = splitXmlBlocks(xml, "db");
  return blocks.map((b) => {
    const id = extractTag(b, "mt20id");
    return {
      id: `kopis-${id}`,
      source: "KOPIS",
      category: "공연",
      title: extractTag(b, "prfnm"),
      place: extractTag(b, "fcltynm"),
      startDate: extractTag(b, "prfpdfrom"),
      endDate: extractTag(b, "prfpdto"),
      area: extractTag(b, "area"),
      genre: extractTag(b, "genrenm"),
      image: extractTag(b, "poster"),
      isFree: false, // 목록 API에는 가격 정보 없음 - 상세페이지에서 확인 필요
      ageInfo: "", // 목록 API에는 연령 정보 없음 (kidstate=Y 로 1차 필터링됨)
      link: `https://www.kopis.or.kr/por/db/pblprfr/pblprfrView.do?mt20Id=${id}`,
    };
  });
}

async function fetchKopis(env, { stdate, eddate, signguCodes, kidsOnly }) {
  if (!env.KOPIS_KEY) return [];
  const all = [];
  for (const code of signguCodes) {
    const url = new URL("http://www.kopis.or.kr/openApi/restful/pblprfr");
    url.searchParams.set("service", env.KOPIS_KEY);
    url.searchParams.set("stdate", stdate);
    url.searchParams.set("eddate", eddate);
    url.searchParams.set("cpage", "1");
    url.searchParams.set("rows", "100");
    url.searchParams.set("signgucode", code);
    if (kidsOnly) url.searchParams.set("kidstate", "Y");
    try {
      const res = await fetchWithTimeout(url.toString());
      const xml = await res.text();
      all.push(...parseKopisList(xml));
    } catch (e) {
      console.error("KOPIS fetch error", code, e);
    }
  }
  return all;
}

// ---------------------------------------------------------------
// 서울시 열린데이터광장 - 문화행사정보 (culturalEventInfo)
// 공식 가이드: https://data.seoul.go.kr (서비스명 culturalEventInfo로 검색)
// ---------------------------------------------------------------

// 명시적으로 성인/청소년 관람불가로 표기된 행사만 제외 (애매하면 보여주고 USE_TRGT 원문을 노출해서 보호자가 직접 판단)
const ADULT_ONLY_PATTERN = /(성인\s*전용|청소년\s*관람\s*불가|19\s*세\s*이상|만\s*19세)/;

function parseSeoulEvents(rows = []) {
  return rows
    .filter((r) => !ADULT_ONLY_PATTERN.test(r.USE_TRGT || ""))
    .map((r) => ({
      id: `seoul-${r.TITLE}-${r.STRTDATE}`.slice(0, 80),
      source: "서울시",
      category: r.CODENAME || "문화행사",
      title: r.TITLE,
      place: r.PLACE,
      startDate: (r.STRTDATE || "").slice(0, 10),
      endDate: (r.END_DATE || "").slice(0, 10),
      area: r.GUNAME,
      genre: r.CODENAME,
      image: r.MAIN_IMG,
      isFree: r.IS_FREE === "무료",
      fee: r.USE_FEE || "",
      ageInfo: r.USE_TRGT || "",
      link: r.ORG_LINK || r.HMPG_ADDR || "",
    }));
}

async function fetchSeoulEvents(env, { startIndex = 1, endIndex = 1000 } = {}) {
  if (!env.SEOUL_KEY) return [];
  const path = `${env.SEOUL_KEY}/json/culturalEventInfo/${startIndex}/${endIndex}/`;
  // 8088 포트가 https로는 안 열려있을 수 있어 https/http를 동시에 시도해서
  // 먼저 성공하는 쪽을 씁니다 (순차로 하면 최악의 경우 대기시간이 두 배가 됨).
  const attempts = [`https://openapi.seoul.go.kr:8088/${path}`, `http://openapi.seoul.go.kr:8088/${path}`].map(
    async (url) => {
      const res = await fetchWithTimeout(url, {}, 4000);
      const data = await res.json();
      if (!data?.culturalEventInfo) throw new Error("응답 형식이 올바르지 않음");
      return parseSeoulEvents(data.culturalEventInfo.row || []);
    }
  );
  try {
    return await Promise.any(attempts);
  } catch (e) {
    console.error("Seoul fetch error (both protocols failed)", e);
    return [];
  }
}

// precheck에서 서울시 쪽 진단 정보를 더 자세히 보기 위한 버전 (두 프로토콜 결과를 각각 보여줌)
async function precheckSeoul(env) {
  if (!env.SEOUL_KEY) return { ok: false, error: "SEOUL_KEY 환경변수가 설정되지 않았습니다" };
  const attempts = {};
  for (const proto of ["https", "http"]) {
    try {
      const url = `${proto}://openapi.seoul.go.kr:8088/${env.SEOUL_KEY}/json/culturalEventInfo/1/1/`;
      const res = await fetchWithTimeout(url);
      const text = await res.text();
      attempts[proto] = { status: res.status, sample: text.slice(0, 200) };
    } catch (e) {
      attempts[proto] = { error: String(e) };
    }
  }
  return { ok: Object.values(attempts).some((a) => a.status === 200 && !a.sample?.startsWith("error code")), attempts };
}

// ---------------------------------------------------------------
// 한국관광공사 TourAPI - 체험 프로그램 (문화시설/박물관/미술관/기념관 + 레포츠 + 식물원/동물원/수목원)
// 공식 가이드: https://www.data.go.kr 에서 "한국관광공사_국문 관광정보 서비스_GW" 검색 후 활용신청
// 주의: 버전이 자주 바뀌는 API라 BASE가 안 맞으면 KorService1 / KorService2 둘 다 시도해보세요.
// contentTypeId: 14=문화시설(박물관/미술관/기념관/전시관), 28=레포츠(승마, 도예체험, 짚라인 등)
// 식물원/동물원/수목원은 TourAPI에서 "관광지(12)"의 자연관광지로 분류되어 있어
// cat 코드 추측 대신 키워드 검색(searchKeyword2)으로 가져옵니다.
// 가격(usefee)/체험연령(expagerange) 필드는 컨텐츠타입마다 이름이 달라서
// 목록 조회에는 안 넣고, 카드를 누르면 /api/experience-detail 로 그때 가져옵니다.
// ---------------------------------------------------------------

const TOUR_API_BASE = "https://apis.data.go.kr/B551011/KorService2";
const TOUR_CONTENT_TYPES = ["14", "28", "15"]; // 문화시설(박물관/미술관/기념관), 레포츠, 공연·관람시설

// 식물원/동물원/수목원은 TourAPI 분류상 "관광지(12)"의 자연관광지로
// 분류되어 있어서 cat 코드 추측 대신 키워드 검색으로 확실하게 잡습니다.
const TOUR_KEYWORDS = ["식물원", "수목원", "동물원"];

function parseTourItems(items = []) {
  return items.map((it) => ({
    id: `tour-${it.contentid}`,
    contentid: it.contentid,
    contentTypeId: it.contenttypeid,
    source: "TourAPI",
    category: tourCategoryLabel(it.contenttypeid),
    title: it.title,
    place: [it.addr1, it.addr2].filter(Boolean).join(" "),
    area: "",
    image: it.firstimage || it.firstimage2 || "",
    tel: it.tel || "",
    mapx: it.mapx,
    mapy: it.mapy,
    feeChecked: false, // 목록 단계에서는 가격 미확인 - 카드 클릭 시 상세조회
  }));
}

async function fetchTourList(env, { areaCode, sigunguCode, contentTypeId }) {
  if (!env.TOUR_KEY) return [];
  try {
    const url = new URL(`${TOUR_API_BASE}/areaBasedList2`);
    url.searchParams.set("serviceKey", env.TOUR_KEY);
    url.searchParams.set("MobileOS", "ETC");
    url.searchParams.set("MobileApp", "KidsCulturePlanner");
    url.searchParams.set("_type", "json");
    url.searchParams.set("listYN", "Y");
    url.searchParams.set("arrange", "A");
    url.searchParams.set("numOfRows", "40");
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("areaCode", areaCode);
    if (sigunguCode) url.searchParams.set("sigunguCode", sigunguCode);
    url.searchParams.set("contentTypeId", contentTypeId);
    const res = await fetchWithTimeout(url.toString());
    const data = await res.json();
    const items = data?.response?.body?.items?.item || [];
    return parseTourItems(Array.isArray(items) ? items : [items]);
  } catch (e) {
    console.error("TourAPI fetch error", areaCode, contentTypeId, e);
    return [];
  }
}

async function fetchTourKeyword(env, { areaCode, keyword }) {
  if (!env.TOUR_KEY) return [];
  try {
    const url = new URL(`${TOUR_API_BASE}/searchKeyword2`);
    url.searchParams.set("serviceKey", env.TOUR_KEY);
    url.searchParams.set("MobileOS", "ETC");
    url.searchParams.set("MobileApp", "KidsCulturePlanner");
    url.searchParams.set("_type", "json");
    url.searchParams.set("listYN", "Y");
    url.searchParams.set("arrange", "A");
    url.searchParams.set("numOfRows", "20");
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("areaCode", areaCode);
    url.searchParams.set("keyword", keyword);
    const res = await fetchWithTimeout(url.toString());
    const data = await res.json();
    const items = data?.response?.body?.items?.item || [];
    return parseTourItems(Array.isArray(items) ? items : [items]);
  } catch (e) {
    console.error("TourAPI keyword fetch error", areaCode, keyword, e);
    return [];
  }
}

async function getExperiences(env, { region = "metro" }) {
  const cacheKey = `experiences:${region}`;
  if (env.EVENTS_KV) {
    const cached = await env.EVENTS_KV.get(cacheKey, "json");
    if (cached) return cached;
  }

  const areaDefs = resolveTourAreas(region);
  const calls = [];
  for (const { areaCode, sigunguCode } of areaDefs) {
    for (const contentTypeId of TOUR_CONTENT_TYPES) {
      calls.push(fetchTourList(env, { areaCode, sigunguCode, contentTypeId }));
    }
    // 식물원/동물원/수목원 키워드 검색은 sigunguCode 미지원이라 areaCode만 사용
    for (const keyword of TOUR_KEYWORDS) {
      calls.push(fetchTourKeyword(env, { areaCode, keyword }));
    }
  }
  const results = (await Promise.all(calls)).flat();

  // contentid 기준 중복 제거 후 구 필터 적용
  const seen = new Set();
  const deduped = results.filter((r) => {
    if (seen.has(r.contentid)) return false;
    seen.add(r.contentid);
    return true;
  });

  const filtered = applyGuFilter(deduped, region);

  if (env.EVENTS_KV) {
    await env.EVENTS_KV.put(cacheKey, JSON.stringify(filtered), { expirationTtl: 60 * 60 * 6 });
  }
  return filtered;
}

// 후보 필드명을 순서대로 시도해서 첫 번째로 값이 있는 걸 반환
// (TourAPI는 contentTypeId마다 usefee/expagerange류 필드 접미사가 달라서 방어적으로 처리)
function pickField(obj, candidates) {
  for (const key of candidates) {
    if (obj[key]) return obj[key];
  }
  return "";
}

function stripHtml(str = "") {
  return str.replace(/<br\s*\/?>/gi, " / ").replace(/<[^>]+>/g, "").trim();
}

async function fetchTourDetail(env, { contentid, contentTypeId }) {
  if (!env.TOUR_KEY) return { ok: false, error: "TOUR_KEY 환경변수가 설정되지 않았습니다" };
  try {
    const url = new URL(`${TOUR_API_BASE}/detailIntro2`);
    url.searchParams.set("serviceKey", env.TOUR_KEY);
    url.searchParams.set("MobileOS", "ETC");
    url.searchParams.set("MobileApp", "KidsCulturePlanner");
    url.searchParams.set("_type", "json");
    url.searchParams.set("contentId", contentid);
    url.searchParams.set("contentTypeId", contentTypeId);
    const res = await fetchWithTimeout(url.toString());
    const data = await res.json();
    const item = data?.response?.body?.items?.item?.[0] || data?.response?.body?.items?.item || {};

    const fee = pickField(item, ["usefee", "usefeeleports", "usefeeculture", "usetimefestival"]);
    const ageInfo = pickField(item, ["expagerange", "expagerangeleports", "agelimit"]);
    const hours = pickField(item, ["usetime", "usetimeculture", "usetimeleports", "opentimefestival"]);
    const restDate = pickField(item, ["restdate", "restdateculture", "restdateleports"]);
    const reservation = pickField(item, ["reservation", "reservationculture", "reservationleports"]);

    return {
      ok: true,
      fee: stripHtml(fee) || "정보 없음 - 전화 문의 필요",
      ageInfo: stripHtml(ageInfo) || "정보 없음",
      hours: stripHtml(hours),
      restDate: stripHtml(restDate),
      reservation: stripHtml(reservation),
      raw: item, // 필드명이 다르면 여기서 직접 확인해서 위 pickField 목록에 추가하세요
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---------------------------------------------------------------
// 한국관광공사 TourAPI - 축제정보 (searchFestival2)
// 체험 프로그램(areaBasedList2)과 달리 축제는 날짜 범위로 바로 검색되는
// 전용 오퍼레이션이 있어서 이걸 사용합니다.
// ---------------------------------------------------------------

function parseTourFestivals(items = []) {
  return items.map((it) => ({
    id: `festival-${it.contentid}`,
    contentid: it.contentid,
    contentTypeId: it.contenttypeid || "15",
    source: "TourAPI",
    category: "축제",
    title: it.title,
    place: [it.addr1, it.addr2].filter(Boolean).join(" "),
    area: "",
    startDate: it.eventstartdate
      ? `${it.eventstartdate.slice(0, 4)}-${it.eventstartdate.slice(4, 6)}-${it.eventstartdate.slice(6, 8)}`
      : "",
    endDate: it.eventenddate
      ? `${it.eventenddate.slice(0, 4)}-${it.eventenddate.slice(4, 6)}-${it.eventenddate.slice(6, 8)}`
      : "",
    image: it.firstimage || it.firstimage2 || "",
    tel: it.tel || "",
    isFree: false, // 축제는 무료/유료가 섞여 있어 목록 단계에서는 알 수 없음
    ageInfo: "",
    link: "", // ensureLink()에서 공식 링크가 없으면 검색 링크로 채워짐
  }));
}

async function fetchTourFestivals(env, { areaCode, stdate, eddate }) {
  if (!env.TOUR_KEY) return [];
  try {
    const url = new URL(`${TOUR_API_BASE}/searchFestival2`);
    url.searchParams.set("serviceKey", env.TOUR_KEY);
    url.searchParams.set("MobileOS", "ETC");
    url.searchParams.set("MobileApp", "KidsCulturePlanner");
    url.searchParams.set("_type", "json");
    url.searchParams.set("listYN", "Y");
    url.searchParams.set("arrange", "A");
    url.searchParams.set("numOfRows", "50");
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("eventStartDate", stdate);
    url.searchParams.set("eventEndDate", eddate);
    url.searchParams.set("areaCode", areaCode);
    const res = await fetchWithTimeout(url.toString());
    const data = await res.json();
    const items = data?.response?.body?.items?.item || [];
    return parseTourFestivals(Array.isArray(items) ? items : [items]);
  } catch (e) {
    console.error("TourAPI festival fetch error", areaCode, e);
    return [];
  }
}

// ---------------------------------------------------------------
// TourAPI - contentTypeId 15 (행사·공연) areaBasedList2
// searchFestival2와 달리 날짜 파라미터 없이 해당 지역 공연·행사 전체를 가져옴.
// 날짜는 parseTourItems 결과에 없어서 getEvents 단에서 별도 필터링 불가.
// → 체험 탭(getExperiences)에 "공연·관람시설" 카테고리로 표시하는 방식 사용
// ---------------------------------------------------------------

// tourCategoryLabel 업데이트 (contentTypeId 15 추가)
// 기존 함수를 아래로 대체
function tourCategoryLabel(contentTypeId) {
  if (contentTypeId === "28") return "체험·레포츠";
  if (contentTypeId === "12") return "자연·동식물원";
  if (contentTypeId === "15") return "공연·관람시설";
  return "박물관·미술관·기념관";
}

// ---------------------------------------------------------------
// 문화데이터광장 - GitHub Actions로 매일 수집한 JSON을 읽어옴
// api.kcisa.kr은 Cloudflare Worker에서 직접 호출 불가(Cloudflare-to-Cloudflare 충돌)
// → GitHub Actions(scripts/fetch-culture.js)가 GitHub 서버에서 대신 수집 후
//   data/culture-events.json 에 저장 → Worker가 raw.githubusercontent.com으로 읽기
//
// GitHub Actions 설정:
//   저장소 Settings → Secrets → Actions → CULTURE_KEY 추가
//   (wrangler secret과 별개로 GitHub에도 따로 등록 필요)
// ---------------------------------------------------------------

const CULTURE_RAW_URL =
  "https://raw.githubusercontent.com/kim80091/kids-culture-planner/main/data/culture-events.json";

async function fetchCultureEvents(env) {
  // CULTURE_KEY가 없어도 GitHub raw 파일은 읽을 수 있음 (public repo)
  try {
    const res = await fetchWithTimeout(CULTURE_RAW_URL, {}, 6000);
    if (!res.ok) return [];
    const data = await res.json();
    const events = data?.events || [];
    return events.map((ev) => ({ ...ev, source: "문화데이터광장" }));
  } catch (e) {
    console.error("Culture raw JSON fetch error", e);
    return [];
  }
}

// 지역 → 시도명 매핑 (kcisa.kr sido 파라미터)
const CULTURE_SIDO = {
  seoul:      "서울",
  songpa:     "서울",
  songpa_adj: "서울",
  incheon:    "인천",
  gyeonggi:   "경기",
  metro:      "", // 전체(시도 미지정 = 전국)
};

// 공식 링크가 없는 항목은 제목+장소로 검색 링크를 만들어서라도 항상 눌러볼 수 있게 함
function buildSearchLink(title, place) {
  const q = encodeURIComponent([title, place].filter(Boolean).join(" "));
  return `https://www.google.com/search?q=${q}`;
}

function ensureLink(e) {
  if (e.link) return { ...e, linkType: "official" };
  return { ...e, link: buildSearchLink(e.title, e.place), linkType: "search" };
}

// ---------------------------------------------------------------
// 통합 이벤트 조회 (+ KV 캐싱, 6시간)
// ---------------------------------------------------------------

async function getEvents(env, { region = "metro", from, to, kidsOnly = true }) {
  const cacheKey = `events:${region}:${from}:${to}:${kidsOnly}`;
  if (env.EVENTS_KV) {
    const cached = await env.EVENTS_KV.get(cacheKey, "json");
    if (cached) return cached;
  }

  const signguCodes = resolveRegions(region);
  const tourAreaDefs = resolveTourAreas(region);
  const stdate = from.replace(/-/g, "");
  const eddate = to.replace(/-/g, "");
  const sido = CULTURE_SIDO[region] ?? "";

  // 서울시 이벤트는 서울이 포함된 지역에서만
  const includesSeoul = ["seoul", "metro", "songpa", "songpa_adj"].includes(region);

  const [kopisEvents, seoulEvents, festivalLists, cultureEvents] = await Promise.all([
    fetchKopis(env, { stdate, eddate, signguCodes, kidsOnly }),
    includesSeoul ? fetchSeoulEvents(env) : Promise.resolve([]),
    Promise.all(tourAreaDefs.map(({ areaCode }) => fetchTourFestivals(env, { areaCode, stdate, eddate }))),
    fetchCultureEvents(env, { sido }),
  ]);
  const festivalEvents = festivalLists.flat();

  // 서울 데이터 날짜 필터링
  const seoulFiltered = seoulEvents.filter((e) => {
    if (!e.startDate || !e.endDate) return true;
    return e.startDate <= to && e.endDate >= from;
  });

  // 문화데이터광장 날짜 필터링 + 구 단위 지역은 장소 필터 추가
  const cultureFiltered = cultureEvents.filter((e) => {
    if (!e.startDate || !e.endDate) return true;
    return e.startDate <= to && e.endDate >= from;
  });

  const merged = [...kopisEvents, ...seoulFiltered, ...festivalEvents, ...cultureFiltered]
    .map(ensureLink)
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));

  // 구 단위 지역 옵션은 주소 필터로 한 번 더 좁힘
  const filtered = applyGuFilter(merged, region);

  if (env.EVENTS_KV) {
    await env.EVENTS_KV.put(cacheKey, JSON.stringify(filtered), { expirationTtl: 60 * 60 * 6 });
  }
  return filtered;
}

// ---------------------------------------------------------------
// 기본 필러 활동 카탈로그 (예산이 남거나 행사가 없는 날 채우는 무료/저비용 활동)
// 필요에 맞게 자유롭게 수정하세요. (송파구 기준 기본값)
// ---------------------------------------------------------------

const FILLER_CATALOG = [
  { title: "동네 어린이도서관 나들이", cost: 0, category: "무료·실내" },
  { title: "올림픽공원 산책 & 자전거", cost: 0, category: "무료·야외" },
  { title: "석촌호수 나들이", cost: 0, category: "무료·야외" },
  { title: "동네 놀이터 & 보드게임", cost: 0, category: "무료·야외" },
  { title: "키즈카페", cost: 15000, category: "실내놀이" },
  { title: "보드게임카페", cost: 12000, category: "실내놀이" },
  { title: "동네 베이커리 + 산책", cost: 10000, category: "야외" },
];

// ---------------------------------------------------------------
// 예산 기반 주간 일정 생성
// ---------------------------------------------------------------

async function buildPlan(env, { weekdayBudget, weekendBudget, region, weekOffset }) {
  const dates = buildWeekDates(weekOffset);
  const from = dates[0].date;
  const to = dates[dates.length - 1].date;

  const events = await getEvents(env, { region, from, to, kidsOnly: true });

  // 비용 정보가 없는 KOPIS 공연은 "가격 확인 필요"로 별도 표시하고,
  // 플래너 자동배정에는 무료가 확실한(서울시 IS_FREE=true) 행사만 자동 포함.
  // 유료 공연은 "추천 후보"로만 보여주고 예산엔 보수적으로 0원 처리하지 않음(과소청구 방지).
  const freeOrPricedEvents = events.filter((e) => e.isFree === true);
  const reviewEvents = events.filter((e) => e.isFree !== true);

  const usedTitles = new Set();
  const weekdaySlots = dates.filter((d) => d.dayType === "weekday");
  const weekendSlots = dates.filter((d) => d.dayType === "weekend");

  function pickFor(slot, pool, remainingBudget, perDaySoftCap) {
    // 1) 해당 날짜에 진행 중인 무료 문화행사 우선
    const todays = pool.filter(
      (e) =>
        !usedTitles.has(e.title) &&
        (!e.startDate || (e.startDate <= slot.date && e.endDate >= slot.date))
    );
    if (todays.length > 0) {
      const pick = todays[0];
      usedTitles.add(pick.title);
      return { title: pick.title, cost: 0, category: pick.category, link: pick.link, source: pick.source };
    }
    // 2) 필러 카탈로그에서 소프트 캡 이내 + 예산 이내, 안 겹치는 항목
    const fillerCandidates = FILLER_CATALOG.filter(
      (f) => !usedTitles.has(f.title) && f.cost <= Math.min(perDaySoftCap, remainingBudget)
    );
    const pick = fillerCandidates[0] || FILLER_CATALOG.find((f) => f.cost === 0);
    if (pick) usedTitles.add(pick.title);
    return pick
      ? { title: pick.title, cost: pick.cost, category: pick.category, source: "카탈로그" }
      : { title: "(예산 내 활동 없음 - 무료 활동으로 채워보세요)", cost: 0, category: "-" };
  }

  const schedule = [];
  let weekdayRemain = weekdayBudget;
  let weekendRemain = weekendBudget;
  const weekdaySoftCap = weekdaySlots.length ? Math.floor(weekdayBudget / weekdaySlots.length) : 0;
  const weekendSoftCap = weekendSlots.length ? Math.floor(weekendBudget / weekendSlots.length) : 0;

  for (const slot of dates) {
    const isWeekend = slot.dayType === "weekend";
    const remain = isWeekend ? weekendRemain : weekdayRemain;
    const softCap = isWeekend ? weekendSoftCap : weekdaySoftCap;
    const item = pickFor(slot, freeOrPricedEvents, remain, softCap);
    if (isWeekend) weekendRemain = Math.max(0, weekendRemain - item.cost);
    else weekdayRemain = Math.max(0, weekdayRemain - item.cost);

    schedule.push({ ...slot, activity: item });
  }

  return {
    range: { from, to },
    budget: {
      weekdayBudget,
      weekendBudget,
      weekdayUsed: weekdayBudget - weekdayRemain,
      weekendUsed: weekendBudget - weekendRemain,
      weekdayRemain,
      weekendRemain,
    },
    schedule,
    // 가격 정보가 없어 자동배정엔 못 넣었지만 참고할 만한 유료 공연 후보 (직접 가격 확인 후 추가하세요)
    paidCandidates: reviewEvents.slice(0, 20),
  };
}

// ---------------------------------------------------------------
// 사전 점검 (pre-flight check) - API 키가 살아있는지 가볍게 확인
// ---------------------------------------------------------------

async function precheck(env) {
  const result = { kopis: { ok: false }, seoul: { ok: false }, tour: { ok: false }, culture: { ok: false } };

  if (env.KOPIS_KEY) {
    try {
      const today = fmtDateCompact(nowKST());
      const url = new URL("http://www.kopis.or.kr/openApi/restful/pblprfr");
      url.searchParams.set("service", env.KOPIS_KEY);
      url.searchParams.set("stdate", today);
      url.searchParams.set("eddate", today);
      url.searchParams.set("cpage", "1");
      url.searchParams.set("rows", "1");
      url.searchParams.set("signgucode", "11");
      const res = await fetchWithTimeout(url.toString());
      const text = await res.text();
      result.kopis = {
        ok: !text.includes("SERVICE KEY IS NOT REGISTERED") && res.status === 200,
        status: res.status,
        rawSample: text.slice(0, 300),
      };
    } catch (e) {
      result.kopis = { ok: false, error: String(e) };
    }
  } else {
    result.kopis = { ok: false, error: "KOPIS_KEY 환경변수가 설정되지 않았습니다" };
  }

  result.seoul = await precheckSeoul(env);

  if (env.TOUR_KEY) {
    try {
      const url = new URL(`${TOUR_API_BASE}/areaBasedList2`);
      url.searchParams.set("serviceKey", env.TOUR_KEY);
      url.searchParams.set("MobileOS", "ETC");
      url.searchParams.set("MobileApp", "KidsCulturePlanner");
      url.searchParams.set("_type", "json");
      url.searchParams.set("numOfRows", "1");
      url.searchParams.set("pageNo", "1");
      url.searchParams.set("areaCode", "1");
      url.searchParams.set("contentTypeId", "14");
      const res = await fetchWithTimeout(url.toString());
      const data = await res.json();
      result.tour = {
        ok: data?.response?.header?.resultCode === "0000",
        status: res.status,
        rawSample: JSON.stringify(data).slice(0, 300),
      };
    } catch (e) {
      result.tour = { ok: false, error: String(e) };
    }
  } else {
    result.tour = { ok: false, error: "TOUR_KEY 환경변수가 설정되지 않았습니다" };
  }

  // 문화데이터광장: GitHub Actions가 data/culture-events.json 을 최신으로 유지
  try {
    const res = await fetchWithTimeout(CULTURE_RAW_URL, {}, 6000);
    const data = await res.json();
    result.culture = {
      ok: Array.isArray(data?.events) && data.events.length > 0,
      count: data?.events?.length ?? 0,
      updatedAt: data?.updatedAt ?? "알 수 없음",
    };
  } catch (e) {
    result.culture = { ok: false, error: String(e) };
  }

  return result;
}

// ---------------------------------------------------------------
// 라우터
// ---------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === "/api/precheck") {
        return json(await precheck(env));
      }

      if (url.pathname === "/api/events") {
        const region = url.searchParams.get("region") || "metro";
        const from = url.searchParams.get("from") || fmtDate(nowKST());
        const to = url.searchParams.get("to") || fmtDate(addDays(nowKST(), 30));
        const kidsOnly = url.searchParams.get("kidsOnly") !== "false";
        const events = await getEvents(env, { region, from, to, kidsOnly });
        return json({ count: events.length, events });
      }

      if (url.pathname === "/api/experiences") {
        const region = url.searchParams.get("region") || "metro";
        const experiences = await getExperiences(env, { region });
        return json({ count: experiences.length, experiences });
      }

      if (url.pathname === "/api/experience-detail") {
        const contentid = url.searchParams.get("contentid");
        const contentTypeId = url.searchParams.get("contentTypeId");
        if (!contentid || !contentTypeId) {
          return json({ error: "contentid, contentTypeId 파라미터가 필요합니다" }, 400);
        }
        const detail = await fetchTourDetail(env, { contentid, contentTypeId });
        return json(detail);
      }

      if (url.pathname === "/api/plan") {
        const weekdayBudget = Number(url.searchParams.get("weekdayBudget") || 0);
        const weekendBudget = Number(url.searchParams.get("weekendBudget") || 0);
        const region = url.searchParams.get("region") || "metro";
        const weekOffsetRaw = url.searchParams.get("weekOffset") || "0";
        const weekOffset = weekOffsetRaw === "weekend" ? "weekend" : Math.min(Math.max(Number(weekOffsetRaw), 0), 3);
        const plan = await buildPlan(env, { weekdayBudget, weekendBudget, region, weekOffset });
        return json(plan);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};
