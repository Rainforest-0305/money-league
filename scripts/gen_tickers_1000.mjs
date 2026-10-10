/**
 * 종목 1,000 데이터 생성 (Phase 1 · venture-cto 트랙 2026-08-22).
 *
 *   node scripts/gen_tickers_1000.mjs [--dry]
 *
 * ⛔⛔ 최우선 하드게이트 — 기존 100종목을 «글자 하나도» 바꾸지 않는다.
 *   근거[실측]: priceEngine.priceOf() 는 모르는 티커에 throw 한다(priceEngine.ts:121-125).
 *   그리고 world.holdingsValue() 가 보유종목마다 그걸 부른다(world.ts:298-301).
 *   ⇒ 기존 티커가 «하나라도» 사라지면 그걸 보유한 유저의 equity() 가 죽고 «앱이 죽는다».
 *   그래서 이 스크립트는 기존 tickers.generated.ts 를 «읽어서» 1~100위를 그대로 옮긴다.
 *   ⛔원본 CSV(research/sp100_tickers.csv)는 «이미 소실»됐다 — 재생성하려 하지 마라.
 *
 * ★데이터 출처와 라이선스
 *   - 티커·회사명·거래소: SEC EDGAR `company_tickers.json` + `company_tickers_exchange.json`
 *     → 미국 연방정부 저작물 = public domain. 귀속 의무 없음(권장만).
 *   - ⛔GICS 섹터 분류를 «복사하지 않는다» — S&P/MSCI 의 배타적 재산이자 상표다.
 *     섹터는 회사명 키워드로 «우리가» 붙인다(기존 51종 안에서만).
 *   - 시가총액 «순서»는 SEC 파일의 배열 순서를 쓴다(실측: 선두 10개가 우리 1~9위와 일치).
 *   - ★가격·mu·sigma 는 전부 «합성»이다. 기존 100종목도 그랬다
 *     [실측 원문: 05_주식투자게임/research/sp100_source.md:22-25 「전부 게임용 합성값,
 *      실제 시세/재무 데이터를 참조하지 않고 티어별 범위에서 난수 생성(seed=42)」].
 *
 * ★자산군(assetClass) 신설: stock | index | commodity | crypto
 *   지수는 가격을 «구성종목 가중합»에서 유도한다(indexBasket.ts). 여기서는 메타만 만든다.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(here, '..');
/**
 * ★읽기 원본과 «쓰기 대상»이 다르다 — 의도적이다.
 *   기존 100종목은 SRC 에서 읽어 그대로 옮기고, 결과는 OUT(신규 파일)에 쓴다.
 *   ⛔SRC 를 덮어쓰지 «않는» 이유: frontend 레인이 지금 같은 워크스페이스에서 작업 중이고
 *     화면(Stocks·TickerPicker·Onboarding·StockDetail·hooks)이 SRC 를 «직접» import 한다.
 *     한쪽만 1,000종목이 되면 그들 하네스가 깨진다.
 *   ⇒ 교체는 엔진·화면을 «같이» 돌리는 시점에 원자적으로 한다(코어 반납 후).
 */
const SRC = resolve(CLIENT, 'src/data/tickers.generated.ts');
const OUT = resolve(CLIENT, 'src/data/tickers1000.generated.ts');
const CACHE = resolve(CLIENT, 'scripts/.sec_cache');

const TARGET_TOTAL = 1000;
const UA = 'Rimi urimk0305@gmail.com';

/** ★4번째 티어를 만들 것인가. 만들면 Stocks 화면에 칩이 «하나 늘어난다»(frontend 영향). */
const ADD_SMALLCAP_TIER = true;

// ── 1) 기존 100종목을 «그대로» 읽는다 ────────────────────────────────────
/**
 * ★기준 100종목 «고정 캐시».
 *
 * ⛔[실사고 2026-08-22] 이 생성기는 `SRC`(= tickers.generated.ts) 에서 기존 100종목을 읽는데,
 *   ★교체를 «한 번 하고 나면» 그 파일이 1,000종목이라 **두 번째 실행이 불가능**했다.
 *   (자가검증이 「기존 종목이 100이 아니다: 1000」으로 막아 줬다 — 그건 잘 동작했다)
 *   ⇒ 생성기가 «멱등»하지 않았다. 가격 하한 하나 고치려는데 되돌리기부터 해야 했다.
 * ⇒ 그래서 기준 100종목을 이 캐시에 «박제»한다. 이제 몇 번을 돌려도 결과가 같다.
 * ⛔이 파일을 지우거나 고치지 마라 — 라이브 유저가 보유 중인 티커의 «원본»이다.
 */
const BASE100 = resolve(CACHE, 'tickers100.base.json');

function readExisting() {
  if (existsSync(BASE100)) return JSON.parse(readFileSync(BASE100, 'utf8'));
  const src = readFileSync(SRC, 'utf8');
  const rows = [];
  // ⛔정규식 최소화: 줄 단위로 '{"rank":' 로 시작하는 JSON 객체만 집는다
  for (const line of src.split('\n')) {
    const t = line.trim().replace(/,$/, '');
    if (t.startsWith('{"rank":')) rows.push(JSON.parse(t));
  }
  return rows;
}

// ── 2) SEC 데이터 (캐시) ─────────────────────────────────────────────────
async function fetchJson(url, cacheName) {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const p = resolve(CACHE, cacheName);
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const txt = await res.text();
  writeFileSync(p, txt);
  return JSON.parse(txt);
}

/** SEC 티커 표기(BRK-B)를 우리 표기(BRK.B)로 맞춘다 */
function normTicker(t) {
  return t.replace(/-/g, '.').toUpperCase();
}

// ── 3) 결정론적 난수 (seed=42, 기존 생성기와 같은 정신) ──────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 티커 문자열에서 결정론적 시드 — 목록 순서가 바뀌어도 종목별 값이 «안 변한다» */
function seedOf(ticker) {
  let h = 42;
  for (let i = 0; i < ticker.length; i++) h = (Math.imul(h, 31) + ticker.charCodeAt(i)) >>> 0;
  return h;
}

// ── 4) 티어 밴드 — 기존 100종목 실측 밴드를 그대로 쓴다 ──────────────────
/**
 * [실측] 기존 100종목의 티어별 범위:
 *   빅테크   mu 0.120~0.142 · sigma 0.209~0.250  (n=12)
 *   성장주   mu 0.100~0.138 · sigma 0.351~0.444  (n=23)
 *   우량배당 mu 0.080~0.099 · sigma 0.150~0.200  (n=65)
 * ★밴드가 «완전히 분리»돼 있고 sigma 에 0.250->0.351 공백(폭 0.101, 관측 0개)이 있다.
 *   이게 「손으로 배정한 구간값」의 증거이며, 새 종목도 «같은 규칙»으로 만든다.
 * ★중소형은 신설 밴드다 — 시총 하위라 변동성이 더 크고 드리프트는 더 낮게 잡는다.
 */
const TIERS = {
  빅테크:   { en: 'Big tech',  mu: [0.120, 0.142], sigma: [0.209, 0.250] },
  성장주:   { en: 'Growth',    mu: [0.100, 0.138], sigma: [0.351, 0.444] },
  우량배당: { en: 'Blue chip', mu: [0.080, 0.099], sigma: [0.150, 0.200] },
  중소형:   { en: 'Small cap', mu: [0.060, 0.095], sigma: [0.300, 0.520] },
};

/** 회사명 키워드 -> 기존 51 섹터 안으로만 매핑한다(새 섹터를 만들지 않는다) */
const SECTOR_RULES = [
  [['SEMICONDUCTOR', 'MICROCHIP', 'SILICON', 'WAFER'], '반도체'],
  [['SOFTWARE', 'SYSTEMS', 'TECHNOLOGIES', 'TECHNOLOGY', 'CLOUD', 'DATA'], '소프트웨어'],
  [['BANCORP', 'BANCSHARES', 'BANK', 'BANKSHARES', 'SAVINGS'], '은행'],
  [['INSURANCE', 'ASSURANCE', 'CASUALTY', 'UNDERWRITERS'], '보험'],
  [['PHARMACEUTICAL', 'PHARMA', 'THERAPEUTIC', 'MEDICINE', 'DRUG'], '제약'],
  [['BIOSCIENCE', 'BIOTECH', 'BIO', 'GENOMIC', 'GENETIC'], '바이오장비'],
  [['ENERGY', 'PETROLEUM', 'OIL', 'GAS', 'DRILLING', 'RESOURCES'], '에너지'],
  [['REALTY', 'PROPERTIES', 'REIT', 'ESTATE'], '리츠'],
  [['UTILITIES', 'ELECTRIC', 'POWER', 'UTILITY'], '유틸리티'],
  [['MINING', 'GOLD', 'STEEL', 'MATERIALS', 'CHEMICAL', 'COPPER'], '화학소재'],
  [['AIRLINES', 'AEROSPACE', 'AVIATION'], '항공기'],
  [['RESTAURANT', 'GRILL', 'FOODS', 'BRANDS'], '외식'],
  [['RETAIL', 'STORES', 'MARKET', 'SHOP'], '유통'],
  [['MEDICAL', 'HEALTH', 'CARE', 'HOSPITAL'], '헬스케어'],
  [['CAPITAL', 'FINANCIAL', 'FINANCE', 'HOLDINGS', 'PARTNERS', 'INVESTMENT'], '금융지주'],
  [['TRANSPORT', 'LOGISTICS', 'FREIGHT', 'SHIPPING', 'RAIL'], '철도'],
  [['COMMUNICATIONS', 'TELECOM', 'WIRELESS', 'BROADCAST', 'MEDIA'], '통신'],
  [['INDUSTRIES', 'MANUFACTURING', 'MACHINE', 'EQUIPMENT'], '산업기계'],
  [['AUTOMOTIVE', 'MOTORS', 'MOTOR'], '자동차'],
];
const FALLBACK_SECTOR = '기타';
const SECTOR_EN_EXTRA = { 기타: 'Other' };

/**
 * ★SIC(미국 표준산업분류) -> 기존 섹터. SIC 는 «미국 정부 분류체계 = public domain» 이다.
 *   ⛔GICS 를 쓰지 않는 이유: GICS 는 S&P/MSCI 의 배타적 재산이자 상표다(SEC 제출서류 원문 확인).
 *   출처: SEC DERA Financial Statement Data Sets 의 sub.txt(cik->sic), 4개 분기 병합.
 *   [실측] 상위 1,200 티커 중 93.2% 가 SIC 를 갖는다. 나머지는 회사명 키워드 -> 그래도 없으면 기타.
 */
const SIC_EXACT = {
  3674: '반도체', 3559: '반도체장비', 3827: '반도체장비', 3829: '반도체장비',
  3571: 'IT기기', 3572: '저장장치', 3576: '네트워크장비', 3661: '네트워크장비',
  3663: '네트워크장비', 3669: '네트워크장비', 3670: '전자부품', 3672: '전자부품',
  3678: '전자부품', 3679: '전자부품', 3612: '전력기기', 3613: '전력기기',
  7372: '소프트웨어', 7370: 'IT서비스', 7371: 'IT서비스', 7373: 'IT서비스',
  7374: 'IT서비스', 7379: 'IT서비스', 7389: 'IT서비스', 7359: 'IT서비스',
  2834: '제약', 2836: '바이오장비', 8731: '바이오장비', 3826: '바이오장비',
  3841: '의료기기', 3845: '의료기기', 5122: '헬스케어유통',
  1311: '에너지', 1381: '에너지', 1389: '에너지', 2911: '에너지', 4922: '에너지',
  3533: '에너지설비', 1731: '에너지설비',
  6020: '은행', 6021: '은행', 6022: '은행', 6035: '은행', 6036: '은행',
  6211: '증권', 6282: '자산운용', 6199: '금융지주', 6770: '금융지주', 6141: '카드금융',
  6311: '보험', 6321: '헬스보험', 6324: '헬스보험', 6331: '보험', 6411: '보험',
  6798: '리츠', 6500: '리츠', 6512: '리츠',
  7011: '여행', 5812: '외식',
  4011: '철도', 4213: '모빌리티', 4512: '항공기', 4513: '모빌리티',
  3711: '자동차', 3714: '자동차', 3721: '항공기', 3724: '항공엔진', 3728: '항공기',
  3480: '방산', 3760: '방산', 3812: '방산',
  4813: '통신', 4812: '통신', 4899: '통신', 4832: '미디어', 4833: '미디어',
  7812: '미디어', 7990: '미디어', 7311: '광고테크',
  4911: '유틸리티', 4931: '유틸리티', 4941: '유틸리티', 4924: '유틸리티',
  2080: '음료', 2086: '음료', 2000: '식품', 2011: '식품', 2090: '식품',
  2840: '생활용품', 2844: '생활용품', 3944: '생활용품',
  2820: '화학소재', 2821: '화학소재', 2860: '화학소재', 2890: '화학소재', 2800: '화학소재',
  3312: '소재', 3330: '소재', 1000: '소재', 1040: '소재', 1220: '소재',
  8742: '컨설팅', 8711: '컨설팅', 7320: '금융정보',
  8000: '헬스케어', 8011: '헬스케어', 8060: '헬스케어', 8090: '헬스케어',
};
/** SIC 대분류(앞 2자리) 폴백 */
const SIC_GROUP = {
  10: '소재', 12: '소재', 13: '에너지', 14: '소재', 15: '산업기계', 16: '산업기계', 17: '에너지설비',
  20: '식품', 21: '생활용품', 22: '생활용품', 23: '생활용품', 24: '소재', 25: '생활용품',
  26: '소재', 27: '미디어', 28: '화학소재', 29: '에너지', 30: '화학소재', 31: '생활용품',
  32: '소재', 33: '소재', 34: '산업기계', 35: '산업기계', 36: '전자부품', 37: '자동차',
  38: '의료기기', 39: '생활용품', 40: '철도', 41: '모빌리티', 42: '모빌리티', 44: '모빌리티',
  45: '항공기', 47: '여행', 48: '통신', 49: '유틸리티', 50: '유통', 51: '유통',
  52: '유통', 53: '유통', 54: '유통', 55: '유통', 56: '유통', 57: '유통', 58: '외식', 59: '유통',
  60: '은행', 61: '금융지주', 62: '증권', 63: '보험', 64: '보험', 65: '리츠', 67: '금융지주',
  70: '여행', 72: '생활용품', 73: 'IT서비스', 75: '모빌리티', 78: '미디어', 79: '미디어',
  80: '헬스케어', 82: '컨설팅', 83: '헬스케어', 87: '컨설팅', 89: '컨설팅',
};

function sectorFor(name, sic) {
  if (sic) {
    const n = Number(sic);
    if (SIC_EXACT[n]) return SIC_EXACT[n];
    const g = SIC_GROUP[Math.floor(n / 100)];
    if (g) return g;
  }
  const up = name.toUpperCase();
  for (const [keys, sec] of SECTOR_RULES) {
    for (const k of keys) if (up.includes(k)) return sec;
  }
  return FALLBACK_SECTOR;
}

function initials(ticker) {
  return ticker.replace(/[^A-Z]/g, '').slice(0, 2) || 'XX';
}

/**
 * SEC 법인명 -> 화면용 «통칭».
 * ★SEC 는 전부 대문자 법인명이다("AGREE REALTY CORP", "ALPHABET INC /DE/").
 *   그대로 쓰면 화면이 고함치는 것처럼 보이고 한국어 화면에서 특히 튄다.
 * ⇒ ① 주(州) 표기(/DE/ 등)와 법인 접미사를 떼고 ② Title Case 로 바꾼다.
 * ★단 «약어»(2~4글자 전부 대문자, 예: IBM·AMD·KLA·RTX)는 그대로 둔다 — 소문자로 바꾸면 틀린다.
 */
const LEGAL_SUFFIX = new Set([
  'INC', 'INC.', 'CORP', 'CORP.', 'CORPORATION', 'CO', 'CO.', 'COMPANY', 'LTD', 'LTD.',
  'LIMITED', 'PLC', 'LLC', 'LP', 'L.P.', 'NV', 'N.V.', 'SA', 'S.A.', 'AG', 'THE',
  'HOLDINGS', 'HOLDING', 'GROUP', 'CLASS', 'COMMON', 'STOCK', 'SHARES', 'TRUST', '&',
]);
const KEEP_UPPER = new Set(['IBM', 'AMD', 'KLA', 'RTX', 'GE', 'AT&T', 'CVS', 'TJX', 'PNC', 'USA', 'US', 'UK', 'AI', 'IT', 'PLC']);

function displayName(raw, ticker) {
  // ★티커와 «같은 낱말»이면 약어다 — 대문자 유지 (ASML·HSBC·IBM·SAP …).
  //   SEC 이름은 전부 대문자라 「대문자니까 약어」로는 구분할 수 없다. 티커 대조가 유일한 신호다.
  const tkUp = String(ticker ?? '').replace(/[^A-Z]/gi, '').toUpperCase();
  let s = String(raw).replace(/\/[A-Z]{2}\/?/g, ' ').replace(/[,]/g, ' ');
  const words = s.split(/\s+/).filter(Boolean);
  // 뒤에서부터 법인 접미사 제거 (단, 전부 지워지면 되돌린다)
  while (words.length > 1 && LEGAL_SUFFIX.has(words[words.length - 1].toUpperCase())) words.pop();
  const out = words.map((w) => {
    const u = w.toUpperCase();
    if (KEEP_UPPER.has(u)) return u;
    if (tkUp && u === tkUp) return u;
    if (u.length <= 4 && /^[A-Z&.]+$/.test(w) && !/[aeiouAEIOU]/.test(w)) return u; // 모음 없는 약어
    return u.charAt(0) + u.slice(1).toLowerCase();
  });
  const name = out.join(' ').trim();
  return name || String(raw);
}

/** 티커에서 결정론적 색 — 기존 종목은 원래 색을 유지하므로 신규에만 쓴다 */
function colorFor(ticker) {
  const r = mulberry32(seedOf(ticker) ^ 0x9e3779b9);
  const palette = ['#4E5968', '#3182F6', '#F04452', '#00A661', '#8B5CF6', '#F59E0B',
                   '#0EA5E9', '#EC4899', '#14B8A6', '#6366F1', '#EF4444', '#84CC16'];
  return palette[Math.floor(r() * palette.length)];
}

// ── 5) 비주식 자산 6종 ───────────────────────────────────────────────────
/**
 * ★sigma·mu 근거 (리서치 실측, 원자료 직접 계산):
 *   금   LBMA Gold PM 58.4년 실측 sigma 19.2% -> 게임 17% / mu 6%
 *        (교차검증: World Gold Council 「30-year annualized volatility 15.44%」)
 *        ⛔평균회귀 넣지 마라 — 실측 회귀 기울기 +0.05 (회귀가 «없다»)
 *   원유 EIA Cushing WTI 40.6년 실측 42.8% -> 43% / mu 3%
 *        ★평균회귀는 Pindyck(1999) 「half-life around five years」 — 게임 시간척도에선
 *          사실상 랜덤워크다. 연출용으로만 쓰고 강한 OU 를 넣지 마라.
 *        ⚠️WTI 는 2020-04-20 종가가 −$36.98(음수)다. 엔진은 MIN_PRICE 를 쓰므로 재현 불가·재현 금지.
 *   BTC  Coinbase 11.1년 실측 67.2% -> 60% / mu 20%
 *        (mu_log 50.7% 를 그대로 쓰면 「사면 무조건 이김」이 된다)
 *   ETH  Coinbase 10.3년 실측 93.5% -> 85% / mu 20% (최근 5년 CAGR −5.69%)
 *   지수 2종: ★sigma 는 «구성종목 가중합»에서 실현되는 값이라 여기 값은 «옵션 산식용 선언값»이다.
 *        분산효과로 개별종목보다 낮다. 선언값과 실현값이 어긋나면 옵션이 조용히 틀린다
 *        ⇒ scripts/bench/indexvol.ts 로 실현 sigma 를 재서 대조할 것. 현재는 [추정]이다.
 */
const NON_STOCK = [
  { ticker: 'GOLD',  nameKo: '금',        nameEn: 'Gold',        assetClass: 'commodity', sectorKo: '원자재', sectorEn: 'Commodities', tierKo: '원자재', tierEn: 'Commodity', price: 2650,  mu: 0.06, sigma: 0.17, color: '#D4AF37', initials: 'AU' },
  { ticker: 'WTI',   nameKo: '원유',      nameEn: 'Crude Oil',   assetClass: 'commodity', sectorKo: '원자재', sectorEn: 'Commodities', tierKo: '원자재', tierEn: 'Commodity', price: 72,    mu: 0.03, sigma: 0.43, color: '#3D3D3D', initials: 'WT' },
  { ticker: 'BTC',   nameKo: '비트코인',  nameEn: 'Bitcoin',     assetClass: 'crypto',    sectorKo: '가상자산', sectorEn: 'Crypto',    tierKo: '가상자산', tierEn: 'Crypto',  price: 68000, mu: 0.20, sigma: 0.60, color: '#F7931A', initials: 'BT' },
  { ticker: 'ETH',   nameKo: '이더리움',  nameEn: 'Ethereum',    assetClass: 'crypto',    sectorKo: '가상자산', sectorEn: 'Crypto',    tierKo: '가상자산', tierEn: 'Crypto',  price: 2400,  mu: 0.20, sigma: 0.85, color: '#627EEA', initials: 'ET' },
  { ticker: 'SPX',   nameKo: 'S&P 500',   nameEn: 'S&P 500',     assetClass: 'index',     sectorKo: '지수',   sectorEn: 'Index',       tierKo: '지수',   tierEn: 'Index',     price: 5800,  mu: 0.09, sigma: 0.16, color: '#1F4E79', initials: 'SP' },
  { ticker: 'NDX',   nameKo: '나스닥 100', nameEn: 'Nasdaq 100', assetClass: 'index',     sectorKo: '지수',   sectorEn: 'Index',       tierKo: '지수',   tierEn: 'Index',     price: 20500, mu: 0.11, sigma: 0.21, color: '#0096D6', initials: 'ND' },
];

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  const dry = process.argv.includes('--dry');
  const existing = readExisting();
  if (existing.length !== 100) throw new Error(`기존 종목이 100이 아니다: ${existing.length}`);
  const have = new Set(existing.map((r) => r.ticker));
  const sectorEnOf = new Map(existing.map((r) => [r.sectorKo, r.sectorEn]));
  sectorEnOf.set(FALLBACK_SECTOR, SECTOR_EN_EXTRA[FALLBACK_SECTOR]);
  for (const a of NON_STOCK) sectorEnOf.set(a.sectorKo, a.sectorEn);

  /**
   * ★cik -> SIC 캐시. scripts/.sec_cache/cik_sic.json 에 «파생 결과만» 둔다.
   *   원본은 SEC DERA 분기 ZIP 4개(합 358MB)라 레포에 넣지 않는다.
   *   재생성이 필요하면 sub.txt 의 (cik, sic) 를 병합해 이 파일을 다시 만들어라.
   */
  const sicPath = resolve(CACHE, 'cik_sic.json');
  const cikSic = existsSync(sicPath) ? JSON.parse(readFileSync(sicPath, 'utf8')) : {};
  if (!Object.keys(cikSic).length) console.warn('[warn] cik_sic.json 이 없다 — 섹터가 키워드 폴백으로만 붙는다');

  const ct = await fetchJson('https://www.sec.gov/files/company_tickers.json', 'company_tickers.json');
  const ex = await fetchJson('https://www.sec.gov/files/company_tickers_exchange.json', 'exch.json');
  const exIdx = { ticker: ex.fields.indexOf('ticker'), exchange: ex.fields.indexOf('exchange') };
  const exchangeOf = new Map(ex.data.map((r) => [normTicker(String(r[exIdx.ticker] ?? '')), r[exIdx.exchange]]));

  const secList = Object.values(ct); // ★배열 순서 = 시총 내림차순 (실측: 선두가 우리 1~9위와 일치)
  const needStocks = TARGET_TOTAL - existing.length - NON_STOCK.length; // 1000 - 100 - 6 = 894

  const added = [];
  let rank = 101;
  for (const row of secList) {
    if (added.length >= needStocks) break;
    const tk = normTicker(String(row.ticker ?? ''));
    if (!tk || have.has(tk)) continue;
    const exch = exchangeOf.get(tk);
    if (exch !== 'Nasdaq' && exch !== 'NYSE') continue; // ⛔OTC·null·CBOE 제외
    if (tk.length > 6) continue;
    have.add(tk);

    const rawName = String(row.title ?? tk);
    const name = displayName(rawName, tk);
    const rnd = mulberry32(seedOf(tk));
    // 티어: 시총 순위대로 — 상위는 기존 분포를 따르고 하위는 중소형
    let tierKo;
    if (!ADD_SMALLCAP_TIER) tierKo = rank <= 200 ? '성장주' : '우량배당';
    else if (rank <= 180) tierKo = rnd() < 0.35 ? '빅테크' : '성장주';
    else if (rank <= 420) tierKo = rnd() < 0.5 ? '성장주' : '우량배당';
    else tierKo = rnd() < 0.75 ? '중소형' : '우량배당';
    const band = TIERS[tierKo];
    const pick = ([lo, hi]) => lo + rnd() * (hi - lo);
    const sectorKo = sectorFor(name, cikSic[String(row.cik_str)]);

    added.push({
      rank: rank++,
      ticker: tk,
      legalName: rawName,   // ★출처 추적용 SEC 원문(대문자 법인명)
      nameKo: name,         // ⚠️한국어 통칭이 없다 — 정리한 영문 통칭을 쓴다(신규 894종목 한정)
      nameEn: name,
      sectorKo,
      sectorEn: sectorEnOf.get(sectorKo) ?? sectorKo,
      tierKo,
      tierEn: TIERS[tierKo].en,
      initials: initials(tk),
      color: colorFor(tk),
      /**
       * ★가격 하한 $35 — «임의로 정한 값이 아니다».
       *   `check_strikes.mjs` 는 행사가 사다리를 배수 0.5~2.0 으로 스윕하며 검사한다:
       *     MAX_STEP_PCT = 0.05  (간격/현재가 <= 5%)
       *     niceStep() 하한 = 0.5
       *   ⇒ 0.5x 스윕에서 0.5 / (P x 0.5) <= 0.05  =>  ★P >= 20 이 수학적 하한이다.
       *   ⇒ 여유를 두고 기존 100종목의 실제 최저가($34.48)에 맞춰 35 로 잡는다.
       * ⛔[실사고 2026-08-22] 처음에 하한을 $5 로 두었더니 저가주에서 사다리 간격이
       *   8.2% 까지 벌어져 `check:all` 이 EXIT 1 로 죽었다. 데이터가 «검사기를 깨뜨린» 것이다.
       */
      initialPrice: Math.round((35 + rnd() * 365) * 100) / 100,
      mu: Math.round(pick(band.mu) * 1000) / 1000,
      sigma: Math.round(pick(band.sigma) * 1000) / 1000,
      assetClass: 'stock',
      exchange: exch,
    });
  }

  if (added.length !== needStocks) throw new Error(`신규 주식 ${added.length} != ${needStocks}`);

  const nonStock = NON_STOCK.map((a, i) => ({
    rank: existing.length + added.length + i + 1,
    ticker: a.ticker,
    legalName: a.nameEn,
    nameKo: a.nameKo,
    nameEn: a.nameEn,
    sectorKo: a.sectorKo,
    sectorEn: a.sectorEn,
    tierKo: a.tierKo,
    tierEn: a.tierEn,
    initials: a.initials,
    color: a.color,
    initialPrice: a.price,
    mu: a.mu,
    sigma: a.sigma,
    assetClass: a.assetClass,
    exchange: '-',
  }));

  // 기존 100 은 «그대로» + assetClass 만 붙인다
  // ★기존 100종목에도 exchange 를 «붙이기만» 한다 — 기존 필드는 그대로다(자가검증이 대조한다)
  const kept = existing.map((r) => ({
    ...r,
    assetClass: 'stock',
    exchange: exchangeOf.get(r.ticker) ?? 'NYSE',
  }));
  const all = [...kept, ...added, ...nonStock];

  // ── 자가검증 ──
  const errs = [];
  if (all.length !== TARGET_TOTAL) errs.push(`총 ${all.length} != ${TARGET_TOTAL}`);
  const seen = new Set();
  for (const r of all) {
    if (seen.has(r.ticker)) errs.push(`중복 티커 ${r.ticker}`);
    seen.add(r.ticker);
  }
  for (let i = 0; i < kept.length; i++) {
    const a = existing[i], b = all[i];
    for (const k of ['rank', 'ticker', 'nameKo', 'nameEn', 'sectorKo', 'tierKo', 'initialPrice', 'mu', 'sigma', 'color']) {
      if (a[k] !== b[k]) errs.push(`⛔기존 종목 변조: ${a.ticker}.${k} ${a[k]} -> ${b[k]}`);
    }
  }
  for (let i = 0; i < all.length; i++) if (all[i].rank !== i + 1) errs.push(`rank 불연속 @${i}: ${all[i].rank}`);
  if (errs.length) {
    console.error('[FAIL] 자가검증 실패:');
    for (const e of errs.slice(0, 20)) console.error('  ' + e);
    process.exit(1);
  }

  // ── 통계 ──
  const cnt = (f) => all.reduce((m, r) => (m[f(r)] = (m[f(r)] || 0) + 1, m), {});
  console.log(`총 ${all.length}종목 = 기존 ${kept.length} + 신규주식 ${added.length} + 비주식 ${nonStock.length}`);
  console.log('assetClass:', JSON.stringify(cnt((r) => r.assetClass)));
  console.log('tier      :', JSON.stringify(cnt((r) => r.tierKo)));
  const secCnt = cnt((r) => r.sectorKo);
  console.log(`섹터 ${Object.keys(secCnt).length}종 · 「${FALLBACK_SECTOR}」 ${secCnt[FALLBACK_SECTOR] ?? 0}개 (${(((secCnt[FALLBACK_SECTOR] ?? 0) / all.length) * 100).toFixed(1)}%)`);
  console.log('★기존 100종목 무변조 확인 · 티커 중복 0 · rank 연속 1~1000');

  if (dry) { console.log('\n--dry: 파일을 쓰지 않았다'); return; }

  const header = `/* 자동 생성 파일 — 직접 수정하지 말 것.
 * 생성기: scripts/gen_tickers_1000.mjs   (재생성: node scripts/gen_tickers_1000.mjs)
 * 생성일: ${new Date().toISOString().slice(0, 10)}
 *
 * ★1~100위는 «기존 파일에서 그대로 옮긴 것»이다. 원본 CSV(research/sp100_tickers.csv)는 소실됐다.
 *   ⛔기존 티커를 지우거나 이름을 바꾸면 그걸 보유한 라이브 유저의 equity() 가 throw 하고 앱이 죽는다
 *     (priceEngine.priceOf 는 모르는 티커에 throw · world.holdingsValue 가 그걸 부른다).
 * ★101~994위: SEC EDGAR company_tickers.json (public domain) 의 시총 내림차순에서
 *   Nasdaq·NYSE 상장분만. ⛔GICS 분류는 복사하지 않았다(S&P/MSCI 재산) — 섹터는 회사명 키워드로 자체 부여.
 * ★995~1000위: 비주식 자산 6종(금·원유·비트코인·이더리움·지수 2종).
 * ★가격·mu·sigma 는 «전부 합성»이다 — 기존 100종목도 그랬다(research/sp100_source.md).
 */
import type { TickerMeta } from './types';

export const TICKERS: TickerMeta[] = [
`;
  const body = all.map((r) => '  ' + JSON.stringify(r) + ',').join('\n');
  writeFileSync(OUT, header + body + '\n];\n');
  console.log(`\n[OK] ${OUT} 기록`);
}

main().catch((e) => { console.error(e); process.exit(1); });
