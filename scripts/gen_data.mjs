/**
 * research/sp100_tickers.csv + design/bot_roster.csv 를 클라이언트 TS 모듈로 변환한다.
 *
 *   node scripts/gen_data.mjs
 *
 * 출력:
 *   src/data/tickers.generated.ts   (100 종목: 티커/한글명/영문명/섹터/초기가/mu/sigma/브랜드색)
 *   src/data/bots.generated.ts      (210 봇 닉네임 + 전략)
 *
 * 원칙(ARCHITECTURE.md 5장): 티커·기업명·섹터만 차용하고 가격은 전부 자체 시뮬레이션.
 * 로고는 상표 회피를 위해 "이니셜 2글자 타일 + 기업 연상색"으로 대체한다(ui_spec.md 4장).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../../..'); // 05_주식투자게임/
const TICKER_CSV = resolve(projectRoot, 'research/sp100_tickers.csv');
const BOT_CSV = resolve(projectRoot, 'design/bot_roster.csv');
const OUT_DIR = resolve(here, '../src/data');

/** 한국어 통칭 — ui_spec.md 3.2 "회사명은 한국어 통칭, 티커는 보조 라벨" */
const KO_NAME = {
  NVDA: '엔비디아', AAPL: '애플', GOOGL: '알파벳', MSFT: '마이크로소프트', AMZN: '아마존',
  AVGO: '브로드컴', META: '메타', TSLA: '테슬라', 'BRK.B': '버크셔해서웨이', LLY: '일라이릴리',
  JPM: 'JP모건', MU: '마이크론', WMT: '월마트', AMD: 'AMD', V: '비자',
  XOM: '엑슨모빌', JNJ: '존슨앤드존슨', MA: '마스터카드', CSCO: '시스코', INTC: '인텔',
  ABBV: '애브비', BAC: '뱅크오브아메리카', COST: '코스트코', AMAT: '어플라이드머티어리얼즈', CVX: '셰브론',
  KO: '코카콜라', UNH: '유나이티드헬스', CAT: '캐터필러', ORCL: '오라클', GE: 'GE에어로스페이스',
  LRCX: '램리서치', PG: 'P&G', HD: '홈디포', MS: '모건스탠리', MRK: '머크',
  GS: '골드만삭스', NFLX: '넷플릭스', PM: '필립모리스', PLTR: '팔란티어', RTX: 'RTX',
  PANW: '팔로알토네트웍스', GEV: 'GE버노바', DELL: '델', WFC: '웰스파고', TXN: '텍사스인스트루먼트',
  KLAC: 'KLA', ANET: '아리스타네트웍스', AXP: '아메리칸익스프레스', C: '씨티그룹', LIN: '린데',
  TMO: '써모피셔', IBM: 'IBM', AMGN: '암젠', APH: '앰페놀', VZ: '버라이즌',
  CRWD: '크라우드스트라이크', STX: '씨게이트', MCD: '맥도날드', PEP: '펩시코', WDC: '웨스턴디지털',
  TMUS: 'T모바일', SCHW: '찰스슈왑', ABT: '애벗', NEE: '넥스트에라에너지', SNDK: '샌디스크',
  ADI: '아나로그디바이스', BLK: '블랙록', TJX: 'TJX', UNP: '유니온퍼시픽', BA: '보잉',
  WELL: '웰타워', DIS: '디즈니', GILD: '길리어드', ETN: '이튼', DE: '디어',
  T: 'AT&T', BX: '블랙스톤', QCOM: '퀄컴', CRM: '세일즈포스', BKNG: '부킹홀딩스',
  COP: '코노코필립스', UBER: '우버', PFE: '화이자', PLD: '프로로지스', DHR: '다나허',
  CB: '처브', LMT: '록히드마틴', BMY: '브리스톨마이어스', CVS: 'CVS헬스', APP: '앱러빈',
  COF: '캐피털원', SYK: '스트라이커', ISRG: '인튜이티브서지컬', PH: '파커하니핀', PGR: '프로그레시브',
  SPGI: 'S&P글로벌', VRTX: '버텍스', SBUX: '스타벅스', GLW: '코닝', ACN: '액센츄어',
};

/** 영문 약칭 — 목업 06 영어판이 쓰는 짧은 통칭(법인 접미사 제거) */
const EN_NAME = {
  NVDA: 'NVIDIA', AAPL: 'Apple', GOOGL: 'Alphabet', MSFT: 'Microsoft', AMZN: 'Amazon',
  AVGO: 'Broadcom', META: 'Meta', TSLA: 'Tesla', 'BRK.B': 'Berkshire', LLY: 'Eli Lilly',
  JPM: 'JPMorgan', MU: 'Micron', WMT: 'Walmart', AMD: 'AMD', V: 'Visa',
  XOM: 'ExxonMobil', JNJ: 'Johnson & Johnson', MA: 'Mastercard', CSCO: 'Cisco', INTC: 'Intel',
  ABBV: 'AbbVie', BAC: 'Bank of America', COST: 'Costco', AMAT: 'Applied Materials', CVX: 'Chevron',
  KO: 'Coca-Cola', UNH: 'UnitedHealth', CAT: 'Caterpillar', ORCL: 'Oracle', GE: 'GE Aerospace',
  LRCX: 'Lam Research', PG: 'P&G', HD: 'Home Depot', MS: 'Morgan Stanley', MRK: 'Merck',
  GS: 'Goldman Sachs', NFLX: 'Netflix', PM: 'Philip Morris', PLTR: 'Palantir', RTX: 'RTX',
  PANW: 'Palo Alto Networks', GEV: 'GE Vernova', DELL: 'Dell', WFC: 'Wells Fargo', TXN: 'Texas Instruments',
  KLAC: 'KLA', ANET: 'Arista Networks', AXP: 'American Express', C: 'Citigroup', LIN: 'Linde',
  TMO: 'Thermo Fisher', IBM: 'IBM', AMGN: 'Amgen', APH: 'Amphenol', VZ: 'Verizon',
  CRWD: 'CrowdStrike', STX: 'Seagate', MCD: "McDonald's", PEP: 'PepsiCo', WDC: 'Western Digital',
  TMUS: 'T-Mobile', SCHW: 'Charles Schwab', ABT: 'Abbott', NEE: 'NextEra Energy', SNDK: 'Sandisk',
  ADI: 'Analog Devices', BLK: 'BlackRock', TJX: 'TJX', UNP: 'Union Pacific', BA: 'Boeing',
  WELL: 'Welltower', DIS: 'Disney', GILD: 'Gilead', ETN: 'Eaton', DE: 'Deere',
  T: 'AT&T', BX: 'Blackstone', QCOM: 'Qualcomm', CRM: 'Salesforce', BKNG: 'Booking',
  COP: 'ConocoPhillips', UBER: 'Uber', PFE: 'Pfizer', PLD: 'Prologis', DHR: 'Danaher',
  CB: 'Chubb', LMT: 'Lockheed Martin', BMY: 'Bristol Myers', CVS: 'CVS Health', APP: 'AppLovin',
  COF: 'Capital One', SYK: 'Stryker', ISRG: 'Intuitive Surgical', PH: 'Parker Hannifin', PGR: 'Progressive',
  SPGI: 'S&P Global', VRTX: 'Vertex', SBUX: 'Starbucks', GLW: 'Corning', ACN: 'Accenture',
};

/** 기업 연상색 (상표 회피 이니셜 타일 배경). 목업에 등장한 값은 그대로 유지. */
const COLOR = {
  NVDA: '#76B900', AAPL: '#1D1D1F', GOOGL: '#34A853', MSFT: '#0067B8', AMZN: '#FF9900',
  AVGO: '#CC0000', META: '#0866FF', TSLA: '#E31937', 'BRK.B': '#3A6EA5', LLY: '#D52B1E',
  JPM: '#5B6770', MU: '#0057B8', WMT: '#0071CE', AMD: '#ED1C24', V: '#1A1F71',
  XOM: '#D42E12', JNJ: '#D51900', MA: '#EB001B', CSCO: '#1BA0D7', INTC: '#0068B5',
  ABBV: '#071D49', BAC: '#012169', COST: '#E31837', AMAT: '#0072CE', CVX: '#0B2D71',
  KO: '#ED1C24', UNH: '#002677', CAT: '#FFCD11', ORCL: '#C74634', GE: '#0B6FB6',
  LRCX: '#003B4A', PG: '#004B93', HD: '#F96302', MS: '#00265D', MRK: '#00857C',
  GS: '#7399C6', NFLX: '#E50914', PM: '#005CAB', PLTR: '#101820', RTX: '#C8102E',
  PANW: '#FA582D', GEV: '#0F6B4F', DELL: '#007DB8', WFC: '#D71E28', TXN: '#CC0000',
  KLAC: '#0091CE', ANET: '#00A2C7', AXP: '#006FCF', C: '#003B70', LIN: '#0072C6',
  TMO: '#E71316', IBM: '#0F62FE', AMGN: '#0063C3', APH: '#004B8D', VZ: '#CD040B',
  CRWD: '#E01A2B', STX: '#6EBE4A', MCD: '#DA291C', PEP: '#004B93', WDC: '#0057B8',
  TMUS: '#E20074', SCHW: '#00A0DF', ABT: '#008FC7', NEE: '#0C6E4F', SNDK: '#D2001C',
  ADI: '#00539B', BLK: '#000000', TJX: '#E1251B', UNP: '#FFC72C', BA: '#0033A1',
  WELL: '#00857D', DIS: '#113CCF', GILD: '#C8102E', ETN: '#0072CE', DE: '#367C2B',
  T: '#00A8E0', BX: '#0F1C2E', QCOM: '#3253DC', CRM: '#00A1E0', BKNG: '#003580',
  COP: '#E31837', UBER: '#0E0E0E', PFE: '#0093D0', PLD: '#0072CE', DHR: '#003DA6',
  CB: '#0B3B60', LMT: '#003976', BMY: '#BE2BBB', CVS: '#CC0000', APP: '#1D2B64',
  COF: '#004977', SYK: '#FFB500', ISRG: '#005EB8', PH: '#FFB500', PGR: '#1B6BB0',
  SPGI: '#D6002A', VRTX: '#00457C', SBUX: '#00704A', GLW: '#8A1538', ACN: '#A100FF',
};

/** 섹터 한국어 -> 영어 (en 화면용). ko 값은 CSV 원문 그대로 쓴다. */
const SECTOR_EN = {
  반도체: 'Semiconductors', IT기기: 'Hardware', 인터넷: 'Internet', 소프트웨어: 'Software',
  이커머스: 'E-commerce', 자동차: 'Autos', 금융지주: 'Holding co.', 제약: 'Pharma',
  은행: 'Banking', 유통: 'Retail', 결제: 'Payments', 에너지: 'Energy', 헬스케어: 'Healthcare',
  네트워크장비: 'Networking', 반도체장비: 'Chip equipment', 음료: 'Beverages',
  헬스보험: 'Health insurance', 산업기계: 'Machinery', 항공엔진: 'Jet engines',
  생활용품: 'Household', 투자은행: 'Investment bank', 미디어: 'Media', 담배: 'Tobacco',
  방산: 'Defense', 보안SW: 'Security', 에너지설비: 'Power equipment', 화학소재: 'Chemicals',
  바이오장비: 'Life sciences', IT서비스: 'IT services', 전자부품: 'Components', 통신: 'Telecom',
  저장장치: 'Storage', 외식: 'Restaurants', 증권: 'Brokerage', 유틸리티: 'Utilities',
  자산운용: 'Asset management', 철도: 'Railroads', 항공기: 'Aerospace', 리츠: 'REIT',
  전력기기: 'Electrical', 농기계: 'Farm equipment', 여행: 'Travel', 모빌리티: 'Mobility',
  보험: 'Insurance', 헬스케어유통: 'Health retail', 광고테크: 'Ad tech', 카드금융: 'Consumer credit',
  의료기기: 'Medical devices', 금융정보: 'Financial data', 소재: 'Materials', 컨설팅: 'Consulting',
};

const TIER_EN = { 빅테크: 'Big tech', 성장주: 'Growth', 우량배당: 'Blue chip' };

/** 따옴표를 인식하는 최소 CSV 파서 */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function initials(ticker) {
  return ticker.replace(/[^A-Z]/g, '').slice(0, 2);
}

// ── 종목 ──────────────────────────────────────────────────────────────────
const tRows = parseCsv(readFileSync(TICKER_CSV, 'utf8')).slice(1);
if (tRows.length !== 100) throw new Error(`expected 100 tickers, got ${tRows.length}`);

const missing = [];
const tickers = tRows.map(([rank, ticker, companyName, sector, tier, price, mu, sigma]) => {
  if (!KO_NAME[ticker] || !EN_NAME[ticker] || !COLOR[ticker]) missing.push(ticker);
  if (!SECTOR_EN[sector]) missing.push(`sector:${sector}`);
  return {
    rank: Number(rank),
    ticker,
    legalName: companyName,
    nameKo: KO_NAME[ticker] ?? companyName,
    nameEn: EN_NAME[ticker] ?? companyName,
    sectorKo: sector,
    sectorEn: SECTOR_EN[sector] ?? sector,
    tierKo: tier,
    tierEn: TIER_EN[tier] ?? tier,
    initials: initials(ticker),
    color: COLOR[ticker] ?? '#4E5968',
    initialPrice: Number(price),
    mu: Number(mu),
    sigma: Number(sigma),
  };
});
if (missing.length) throw new Error(`missing mapping: ${[...new Set(missing)].join(', ')}`);

// ── 봇 ────────────────────────────────────────────────────────────────────
const bRows = parseCsv(readFileSync(BOT_CSV, 'utf8')).slice(1);
if (bRows.length !== 210) throw new Error(`expected 210 bots, got ${bRows.length}`);
const bots = bRows.map(([botId, nickname, strategy]) => ({ botId, nickname, strategy }));

/**
 * [G6 정정 2026-08-05 · 트랙 C] 영문 게이머 닉 32개(≈15%) 혼합.
 *
 * design/ARCHITECTURE.md:108-111 정본:
 *   "닉네임은 한국어권이 봤을 때 자연스러운 실제 유저풍 ... + 일부 영문 게이머 닉 혼합"
 * 그런데 원본 design/bot_roster.csv 는 210개 **전부 한글**이었다(실측 0/210 — 스펙 미준수).
 * 그래서 영어 UI 랭킹이 전부 한글로 보였다.
 *
 * 원본 CSV 는 읽기 전용이라 손대지 않고 여기서 덮어쓴다(G6: 선행 결함은 개조본에서 정리).
 * - 총 210개 유지 (EXPECTED_BOT_COUNT, 요건 #14 하드 숫자)
 * - 5개 아키타입에 고르게 분산: momentum 7 / mean_reversion 7 / whale 6 / noise 6 /
 *   derivatives_heavy 6  (각 42개 안에서 균등 간격으로 선택 — 랭킹에서 뭉쳐 보이지 않게)
 * - botId 는 절대 바꾸지 않는다. nickname 만 교체한다.
 * - `Bot001` 류 기계 패턴 금지(스펙 명시).
 */
const ENGLISH_NICKS = {
  // momentum (7)
  BOT004: 'gap_up_gary', BOT010: 'moonshot_kr', BOT016: 'BreakoutBoi', BOT022: 'RocketRider',
  BOT028: 'pumpchaser', BOT034: 'AllGasNoBrake', BOT040: 'FOMO_Fuel',
  // mean_reversion (7)
  BOT046: 'DipDoctor', BOT052: 'buy_the_blood', BOT058: 'SnapBackSam', BOT064: 'contrarian_kr',
  BOT070: 'KnifeCatcher', BOT076: 'WaitForRed', BOT082: 'RubberBandit',
  // whale (6)
  BOT088: 'TheWhaleHunter', BOT095: 'BigSizeOnly', BOT102: 'deep_pockets', BOT109: 'BigTicketBob',
  BOT116: 'heavy_bags_kr', BOT123: 'BlueChipBaron',
  // noise (6)
  BOT130: 'TickScalper', BOT137: 'OneTickWonder', BOT144: 'paperhands_kr', BOT151: 'ScalpSnack',
  BOT158: 'jitter_jack', BOT165: 'MicroFlipper',
  // derivatives_heavy (6)
  BOT172: 'DiamondHandz', BOT179: 'MarginMonster', BOT186: 'x20_degen', BOT193: 'LeverLord',
  BOT200: 'LiqLineDancer', BOT207: 'FullSendFred',
};

let engApplied = 0;
for (const b of bots) {
  const en = ENGLISH_NICKS[b.botId];
  if (en) {
    b.nickname = en;
    engApplied++;
  }
}
if (engApplied !== Object.keys(ENGLISH_NICKS).length) {
  throw new Error(`english nick mismatch: applied ${engApplied}, expected ${Object.keys(ENGLISH_NICKS).length}`);
}
if (new Set(bots.map((b) => b.nickname)).size !== bots.length) {
  throw new Error('duplicate bot nickname after english mix');
}
{
  // 아키타입별 분산이 무너지지 않았는지 (한 전략만 영문이 되면 랭킹에서 편중돼 보인다)
  const per = {};
  for (const b of bots) if (!/[가-힣]/.test(b.nickname)) per[b.strategy] = (per[b.strategy] ?? 0) + 1;
  const counts = Object.values(per);
  if (Object.keys(per).length !== 5 || Math.max(...counts) - Math.min(...counts) > 1) {
    throw new Error(`english nicks not evenly spread: ${JSON.stringify(per)}`);
  }
}

mkdirSync(OUT_DIR, { recursive: true });

const header = (src) => `/* 자동 생성 파일 — 직접 수정하지 말 것.
 * 원본: ${src}
 * 재생성: npm run gen:data  (scripts/gen_data.mjs)
 */\n`;

writeFileSync(
  resolve(OUT_DIR, 'tickers.generated.ts'),
  header('research/sp100_tickers.csv') +
    `import type { TickerMeta } from './types';\n\nexport const TICKERS: TickerMeta[] = ${JSON.stringify(tickers, null, 0)
      .replace(/\},\{/g, '},\n  {')
      .replace(/^\[/, '[\n  ')
      .replace(/\]$/, ',\n]')};\n`,
  'utf8'
);

writeFileSync(
  resolve(OUT_DIR, 'bots.generated.ts'),
  header('design/bot_roster.csv (+ 영문 게이머 닉 32개 혼합 — gen_data.mjs 의 ENGLISH_NICKS)') +
    `import type { BotMeta } from './types';\n\nexport const BOTS: BotMeta[] = ${JSON.stringify(bots, null, 0)
      .replace(/\},\{/g, '},\n  {')
      .replace(/^\[/, '[\n  ')
      .replace(/\]$/, ',\n]')};\n`,
  'utf8'
);

console.log(
  `generated: ${tickers.length} tickers, ${bots.length} bots (영문 닉 ${engApplied}) -> src/data/`
);
