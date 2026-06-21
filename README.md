아이와 문화생활 · 주간 플래너
8살 아이와 함께할 평일/주말 일정을 예산 안에서 짜주고, KOPIS·서울시 공공데이터에서
아이가 볼 수 있는 공연·전시 정보를 모아 보여주는 도구입니다.
기존 가족 대시보드(DJ_school)와 같은 구조입니다:
GitHub Pages(프론트) + Cloudflare Workers(백엔드)
```
kids-culture-planner/
├── worker.js          # Cloudflare Worker (API 연동, 캐싱, 일정 생성 로직)
├── wrangler.toml      # Worker 배포 설정
└── public/
    └── index.html     # 프론트엔드 (GitHub Pages에 그대로 올리면 됨)
```
---
1. API 키 발급 (3개, 모두 무료)
KOPIS (공연예술통합전산망)
https://www.kopis.or.kr/por/cs/openapi/openApiInfo.do 접속
회원가입 → API 신청 (보통 즉시~1일 내 승인)
발급받은 서비스키를 `KOPIS_KEY`로 사용
승인 메일에 첨부되는 API 명세 PDF는 꼭 보관 — `worker.js`의 `parseKopisList()`가
참조하는 태그명(`prfnm`, `prfpdfrom` 등)이 혹시 다르면 거기서 확인 후 수정
서울시 열린데이터광장
https://data.seoul.go.kr 회원가입
"인증키 신청" → 즉시 발급
발급받은 키를 `SEOUL_KEY`로 사용
서비스명 `culturalEventInfo` (문화행사정보) 기준으로 만들어져 있음
한국관광공사 TourAPI (체험 프로그램 - 박물관 체험·도예체험·승마체험 등)
https://www.data.go.kr 에서 "한국관광공사_국문 관광정보 서비스_GW" 검색
활용신청 (보통 자동/즉시 승인)
마이페이지에서 일반 인증키(Decoding) 값을 `TOUR_KEY`로 사용
포함 범위: 박물관·미술관·기념관·전시관 (문화시설, contentTypeId 14),
승마·도예체험 등 레포츠 (contentTypeId 28),
식물원·동물원·수목원 (TourAPI 분류상 "관광지"라 cat 코드 대신
키워드 검색으로 따로 가져옴)
이 API는 가격(usefee)·체험연령(expagerange) 필드명이 시설 종류마다 달라서,
목록에는 안 넣고 카드를 누르면 그때 상세 조회하도록 만들었습니다.
`/api/experience-detail`이 `정보 없음`만 계속 보여주면 worker.js의
`fetchTourDetail()`에 있는 `raw` 필드(원본 응답)를 한번 찍어보고
`pickField()` 후보 목록에 실제 필드명을 추가해주세요.
---
2. Worker 배포
```bash
cd kids-culture-planner
npm install -g wrangler   # 이미 설치되어 있으면 생략
wrangler login

# API 키 등록 (평문으로 wrangler.toml에 넣지 말 것)
wrangler secret put KOPIS_KEY
wrangler secret put SEOUL_KEY
wrangler secret put TOUR_KEY

wrangler deploy
```
배포가 끝나면 `https://kids-culture-planner.<본인서브도메인>.workers.dev` 형태의
주소가 나옵니다. 이 주소를 `public/index.html` 맨 아래 스크립트의
```js
const WORKER_BASE_URL = "https://kids-culture-planner.YOUR-SUBDOMAIN.workers.dev";
```
부분에 그대로 붙여넣으세요.
(선택) 캐싱용 KV 추가
호출 비용을 줄이고 싶으면:
```bash
wrangler kv namespace create EVENTS_KV
```
나온 id를 `wrangler.toml`의 주석 처리된 `[[kv_namespaces]]` 블록에 넣고 주석을 풀면
6시간 단위로 결과가 캐싱됩니다. 없어도 동작은 정상적으로 합니다.
---
3. 동작 확인 (pre-flight check)
배포 직후 아래 주소로 접속해서 두 API 키가 살아있는지 먼저 확인하세요
(stock_trio의 pre_check.py와 같은 개념입니다):
```
https://kids-culture-planner.<본인서브도메인>.workers.dev/api/precheck
```
`kopis.ok`, `seoul.ok`, `tour.ok`가 모두 `true`면 정상입니다. `false`면 `error`/`rawSample`
필드를 보고 키 또는 필드명 문제를 확인하세요.
---
4. 프론트엔드 배포 (GitHub Pages)
기존 패턴 그대로 `public/index.html`을 본인 GitHub Pages 저장소에 올리면 됩니다.
예: `kim80091.github.io/kids-culture-planner/`
---
5. 화면 구성 (탭 2개)
탭 1. 예산 추천 일정 — 평일/주말 예산을 입력하면 자동으로 한 주(또는 2~4주) 일정을
그리디 알고리즘으로 짜줍니다. (기존 기능)
탭 2. 둘러보고 담기 — 공연·전시·축제(최대 2개월치)와 박물관·미술관·체험·식물원·동물원
(상시 정보)을 카테고리별로 한 번에 보여줍니다. 마음에 드는 항목을 "담기"로 선택하면:
선택한 일정 목록에 추가되고, 날짜·예상비용을 직접 입력/수정할 수 있어요
(가격 정보가 없는 항목은 기본 0원으로 들어가니 꼭 확인 후 입력해주세요)
총 예상 비용이 자동으로 합산돼요
화면 하단의 달력(일~토, 일요일 시작, 오늘부터 한 달 범위)에 선택한 날짜로
바로 표시돼요. 달력의 일정 칩을 눌러도 선택이 취소됩니다.
선택 내용은 브라우저를 새로고침하면 초기화돼요 (서버 저장은 안 하는 v1입니다).
나중에 필요하면 Worker + KV에 사용자별로 저장하는 식으로 확장할 수 있어요.
가족 구성 & 인원수 비용 계산기
상단 "가족 구성" 카드에서 성인/청소년/어린이 인원수를 입력해두면 (localStorage에 저장돼서
다음 방문 때도 유지됩니다), "둘러보고 담기" 탭의 "선택한 일정"에서 항목별로 인원수 기반
비용 계산기를 쓸 수 있어요: 어느 항목인지 고르고 성인/청소년/어린이 단가만 입력하면
인원수만큼 자동으로 곱해서 합계를 계산해주고, "선택한 항목에 적용하기"를 누르면 그 값이
비용 칸에 들어갑니다. (요금이 "성인 5,000원 / 어린이 3,000원" 같은 텍스트로만 오는 경우가
많아서, 정확한 합계 계산은 직접 단가를 입력하는 방식으로 만들었어요.)
일정 저장 / 불러오기
탭 1(예산 추천 일정)에서 일정을 만들거나, 탭 2(둘러보고 담기)에서 항목을 담으면
각 화면 하단에 "이 일정 저장하기"가 나타납니다.
저장 이름은 자동으로 `작성날짜-테마` 형식이 됩니다 (예: `2026-06-21-전시회 나들이`).
테마를 직접 입력하지 않고 저장하면, 담긴 항목들 중 가장 많은 카테고리를 자동으로
테마로 써요.
저장된 일정은 화면 상단 "저장된 일정" 카드에서 언제든 불러오기/삭제할 수 있고,
페이지를 새로고침하거나 나중에 다시 접속해도 그대로 남아있습니다.
저장은 브라우저의 localStorage를 사용합니다. 즉, 저장한 그 기기·그 브라우저에서만
보여요. 폰에서 저장한 걸 PC에서도 보고 싶으면 Worker + KV로 서버 저장소를 따로
만들어야 하니, 필요하면 말씀해주세요.
---
6. 커스터마이징 포인트
`FILLER_CATALOG` (`worker.js` 상단부): 행사가 없는 날 채우는 무료/저비용 활동
목록입니다. 송파구 기준 기본값(올림픽공원, 석촌호수 등)이 들어있으니 동네에 맞게
자유롭게 수정하세요.
지역 범위: 현재 서울은 KOPIS(공연) + 서울시 문화행사정보(전시/체험/축제)
둘 다, 경기·인천은 KOPIS만 연결되어 있습니다. 경기데이터드림(data.gg.go.kr)
같은 지역 포털 API를 나중에 `fetchSeoulEvents`와 같은 패턴으로 추가하면
경기/인천 전시 정보도 늘릴 수 있습니다.
연령 필터: KOPIS는 `kidstate=Y`(아동 분류 공연)로 1차 필터링하고,
서울시 데이터는 "성인 전용/19세 이상" 같은 명시적 문구만 제외합니다.
애매한 행사는 숨기지 않고 `USE_TRGT`(이용대상) 원문을 카드에 그대로 보여주니
최종 판단은 직접 확인해주세요.
축제: TourAPI `searchFestival2`로 서울/인천/경기 지역의 진행 중인 축제를
날짜 범위로 가져옵니다. "문화행사 모아보기"에서 카테고리 칩 "축제"로 따로
필터링할 수 있어요.
링크: KOPIS/서울시 데이터는 공식 상세페이지 링크를 그대로 쓰고, 공식 링크가
없는 항목(축제 등)은 제목+장소로 구글 검색 링크를 자동 생성해서 카드 전체를
눌러도 항상 뭔가는 열리도록 했습니다. 카드에 "검색해서 보기"라고 뜨면 공식
링크가 아니라 검색 결과라는 뜻이에요.
예산 알고리즘: 현재는 1차 버전(그리디 - 무료 행사 우선 배정 → 남는 날은
카탈로그로 채움)입니다. stock_trio처럼 단계적으로 고도화하고 싶으면, 예를 들어
"주중에 안 쓴 예산을 주말로 이월" 같은 로직을 `buildPlan()`에 추가하면 됩니다.
---
알아두면 좋은 점
KOPIS 공연 목록 API에는 가격 정보가 없습니다. 그래서 일정 자동배정에는
무료가 확실한 행사만 넣고, 유료 공연은 "가격 확인이 필요한 후보" 섹션에
따로 보여줍니다. 가격까지 자동으로 넣고 싶으면 공연 상세 API
(`/openApi/restful/pblprfr/{mt20id}`)를 추가로 호출해야 하는데, 공연 수가
많아지면 호출량이 늘어나니 일단은 후보만 보여주는 쪽으로 만들었습니다.
서울시 오픈 API는 `http://` 엔드포인트입니다. Cloudflare Worker는 http 호출도
되지만, 혹시 막히면 `https://`로 먼저 시도해보세요.
