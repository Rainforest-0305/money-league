/**
 * 봇 «명부(roster)».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️★현재 상태부터 읽어라 (2026-08-23 · B안). 아래 역사 설명과 «다르다»
 * ══════════════════════════════════════════════════════════════════════════
 * ★지금은 **10,000명이 0일차에 전부 만들어지고, 그 뒤로 «늘지 않는다».**
 *   원년 210 + 개장 9,790 = 10,000 = `BOT_ROSTER_CAP`.
 *   ⇒ `room = 0` ⇒ `maxCohorts = 0` ⇒ **일일 코호트 루프가 한 번도 안 돈다.**
 *   ⇒ 그래서 아래의 「하루 N명씩 들어온다」·「상한 도달 시점」·FIFO 퇴출은
 *     ★**현재 «작동하지 않는» 설명이다.** 상한을 올리면 그대로 되살아난다.
 *   근거: President 「봇 10,000개」 + 「B로 가봐」(신규 유저도 처음부터 10,000명).
 *
 * ── 아래는 «왜 이렇게 만들어졌는가»의 역사다 (구조 이해용) ────────────────
 * 원래 설계: 하루 77명씩 새 참가자가 들어온다.
 * (2026-08-20, President 지시 「하루에 77명씩 새 봇이 추가되면 좋겠어」)
 *
 * ★ 「하루」 = «실제 KST 경과일»이다. 게임일(150틱=실제 5분)이 아니다. 근거 3개:
 *   1) 봇은 저장되지 않는다(persistence.ts 주석). 매 세션 워밍업으로 새로 만들어지므로
 *      「어제보다 사람이 늘었네」는 «실제 날짜»로만 성립한다.
 *   2) 게임일 기준이면 실제 1시간 접속에 924명이 늘어난다 — 오래 켠 유저와 잠깐 켠
 *      유저의 세계가 완전히 달라진다.
 *   3) 상한 도달 시점이 예측 가능하다(30일 = 2,520명).
 *
 * ★ 저장 스키마를 «건드리지 않았다». 첫 접속일은 SAVE_KEY('ml.game') 가 아니라
 *   독립 키('ml.firstSeen')에 둔다. SAVE_VERSION 을 올리면 loadGame() 이
 *   `s.v !== SAVE_VERSION` 에서 null 을 뱉어 라이브 유저 진행이 통째로 날아간다.
 *   독립 키라 «없으면 오늘로 친다»가 유일한 마이그레이션이고, 실패해도 봇 210명으로
 *   시작할 뿐 게임은 정상 동작한다.
 *
 * ★ 상한 2,520명 = 기존 210 + 77 × 30일. 상한을 넘으면 «가장 오래된 신규 코호트»가
 *   빠진다(FIFO). 원래 설계는 「자산 하위 77명 퇴출」이었으나 봇 자산은 세션 간
 *   보존되지 않으므로 «자산 기준 퇴출»은 재현이 불가능하다. 그래서 코호트 나이로 뺀다.
 */
import { CONCEPTS, NEW_CONCEPTS, type NewConcept } from './concepts';
import type { BotDef } from './types';
import { kstDateKey } from '../daykey';

/**
 * 하루에 들어오는 새 참가자 수.
 *
 * ★2026-08-22: 77 → **300** (President 지시 「전체 봇 수도 10000개로」 · Partner 승인).
 *
 * ⚠️★2026-08-23 (B안): 이 값은 이제 **「하루에 들어오는 수」로 «쓰이지 않는다».**
 *   개장 총원이 상한과 같아져 `maxCohorts = 0` 이 되었기 때문이다(아래 STARTING_EXTRA_BOTS 참조).
 *   ⇒ ★그래도 **지우면 안 된다.** 이 값은 «cohortMix 의 길이»이고,
 *     개장 멤버 9,790명의 «콘셉트 비율»이 전적으로 그 배열에서 나온다
 *     (`mix[i % mix.length]`). 지우거나 바꾸면 ★시장 구성이 통째로 바뀐다.
 *   ⇒ 그래서 이름은 낡았지만 «역할은 살아 있다». 나중에 코호트를 되살릴 때도 그대로 쓴다.
 *
 * ⛔⛔`cohortMix()` 의 가중치 합이 이 값과 **정확히 같아야 한다.**
 *   예전에 합이 79 인데 `slice(0,77)` 로 «조용히 잘려» liquidation_hunter 가
 *   6 → 4 로 깎인 사고가 있다(상대편차 −33%). 이 값을 바꾸면 **가중치도 반드시 같이 바꿔라.**
 *   ★빌드타임 게이트: `scripts/check_roster_mix.mjs`
 */
export const BOTS_PER_DAY = 300;
/**
 * 개장 시점 «신규 콘셉트» 참가자 수 (원년 210명에 «더해지는» 인원).
 *
 * ★★2026-08-23: 790 → **9,790** (President 결정 「B로 가봐」 · Partner 경유).
 *   210 + 9,790 = **10,000명이 «0일차부터»** 시작 총원이다.
 *
 * ── 왜 바꿨나 ─────────────────────────────────────────────────────────
 * 「봇 10,000명」이 지시였는데 옛 구조는 0일차에 1,000명이고 **30일을 기다려야**
 * 10,000 에 닿았다. ⇒ ★신규 유저가 보는 숫자가 지시와 «달랐다».
 *
 * ── ⚠️★그 결과 «일일 신규 코호트가 사라진다» (의도된 것이다) ──────────
 * `room = BOT_ROSTER_CAP − 210 − 9790 = 0` ⇒ `maxCohorts = 0` ⇒ 아래 코호트 루프가
 * **한 번도 안 돈다.** 명부는 10,000명에서 «고정»된다.
 *   ⇒ 판단: **그게 지시에 충실하다.** 목표는 「10,000명」이지 「매일 늘어남」이 아니었다.
 *   ⇒ 성장을 살리려면 `BOT_ROSTER_CAP > 시작총원` 이어야 하는데 그건 「10,000명」을 넘는다.
 * ★확인함: `isNew` 와 `cohortDay` 는 ★화면에서 «아무도 안 쓴다»
 *   [실측 2026-08-23 · 양성대조 `.nickname` 4건 대비 두 키 모두 0건]
 *   ⇒ 「전원 cohortDay 0 · 전원 isNew=true」가 되어도 «이상하게 보이는 화면이 없다».
 *   ⛔나중에 이 두 필드로 배지를 만들려거든 «그때» 이 사실을 다시 확인하라.
 *
 * ── ★콘셉트 비율은 «오히려 정확해진다» (실측) ─────────────────────────
 * 개장 멤버는 `mix[i % 300]` 으로 «순환» 배분되므로 300 의 배수가 아니면 왜곡이 생긴다.
 * 9790 % 300 = 190 이라 왜곡 자체는 남지만, 순환 «횟수»가 많아져 희석된다:
 * ```
 * [실측 · scripts/bench/run.mjs rostermix — buildRoster 를 «불러서» 센 값]
 *   현행 790   최대 상대편차 −24.05% (liquidation_hunter 8.00% → 6.08%)
 *   B안  9790  최대 상대편차  −1.94% (liquidation_hunter 8.00% → 7.85%)
 *   ⇒ ★12.4배 «더 정확». 참고: 과거 실사고(6→4)가 −33% 였다
 * ```
 * ⇒ ★그래서 «비율 보존 배분(최대잉여법 등)으로 바꾸지 않았다». 고칠 이유가 없다 —
 *   바꾸면 시장 구성이 달라지는 «밸런스 변경»인데 얻는 게 1.94%p 미만이다.
 *
 * ★이들도 «포트폴리오 보유 상태»로 생성된다(bots.ts seedPortfolio) — 시드 현금이
 *   매수 주문으로 시장에 들어오면 영구 순매수 압력이 되기 때문이다.
 */
export const STARTING_EXTRA_BOTS = 9790;

/**
 * 명부 상한 — ★2026-08-22: 3,310 → **10,000** (President 지시 · Partner 승인).
 *   ⚠️★2026-08-23 (B안) 이후로는 이게 «상한»이자 «상시 총원»이다:
 *     원년 210 + 개장 9,790 = 10,000 을 **0일차에 전부** 만든다.
 *     (옛 설명 「1,000 시작 + 300/일 × 30일」은 «더 이상 사실이 아니다» — 그렇게 두면
 *      다음 사람이 낡은 설명을 믿는다. roster.ts:239 에서 이미 한 번 그 사고가 났다)
 *
 * ★옛 주석은 「워밍업 때문에 상한을 못 올린다」였다. **그 제약이 해소됐다**:
 *   1) **P1 구조 수정**(전 계정 스캔 5종 → 포지션 보유 계정 색인) — 인계문서 Y-4 P1
 *   2) **워밍업 3,000 → 1,500** (constants.ts WARMUP_TICKS)
 *
 * [실측 · 조건: 종목 1,000 · 현재 1,000종목 데이터셋 · P1 적용 후 · seed 6 · 프로세스 분리]
 * ```
 *              워밍업    틱       catchup300   heap     랭킹
 *   봇  3,310  1.252s   0.608ms  187ms        11.4MB   3.13ms
 *   봇 10,000  1.563s   1.015ms  273ms        26.0MB   11.94ms
 *   ★결정론 값 동일(pxMean 1.035 · pxMax 1.278) — 봇 수가 «시장을 바꾸지 않는다»
 * ```
 * ★저장본은 봇 수와 «무관»하다 — `SavedGame` 에 봇 필드가 0건이다(봇은 저장되지 않는다).
 *
 * ⚠️★유일하게 «체감»이 바뀌는 것: 봇 잡음이 0.0383% → 0.1366%(3.6배)로 커진다.
 *   내 주문이 만드는 가격변화 «자체»는 봇 수와 무관하지만(2.4978% vs 2.5002%),
 *   시드 $10,000 전액 주문은 잡음 대비 0.90배 → **0.25배**가 되어 «알아보기 어려워진다».
 *   ⇒ 「가격이 안 움직인다」가 아니라 「내가 움직인 걸 못 알아본다」다. 표시로 푸는 문제다.
 */
export const BOT_ROSTER_CAP = 10000;
/** 첫 접속일 저장 키 — 게임 세이브와 «분리»돼 있다(위 주석 참조) */
export const FIRST_SEEN_KEY = 'ml.firstSeen';

/**
 * KST 날짜키 'YYYY-MM-DD'.
 *
 * ★★2026-08-22: 여기 있던 «복사본»을 지우고 정본(`lib/daykey.ts`)의 별칭으로 바꿨다.
 *   [실측] 지우기 전 두 함수 본문은 공백 정규화 후 «문자 단위로 동일»했다 — 사고는 없었다.
 *   ⇒ 이제 두 벌이 «구조적으로» 존재할 수 없다. 이름만 역사적 이유로 남긴다.
 * ⛔`daykey.ts` 는 import 가 0개라 순환참조가 생기지 않는다 — 복사본을 둔 이유가 사라졌다.
 */
export const kstDayKey = kstDateKey;

function dayNumber(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return NaN;
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * 첫 접속 KST 날짜키. 없으면 오늘로 기록한다.
 * localStorage 가 없는 환경(프라이빗 모드·구형 웹뷰)에서도 죽지 않는다 — 오늘로 친다.
 */
export function firstSeenDayKey(now = Date.now()): string {
  const today = kstDayKey(now);
  try {
    const ls = window.localStorage;
    if (!ls) return today;
    const saved = ls.getItem(FIRST_SEEN_KEY);
    if (saved && !Number.isNaN(dayNumber(saved))) return saved;
    ls.setItem(FIRST_SEEN_KEY, today);
    return today;
  } catch {
    return today;
  }
}

/** 첫 접속일로부터 지난 KST 일수 (0 이상). 시계를 되돌려도 음수가 되지 않는다. */
export function elapsedDays(now = Date.now()): number {
  const first = dayNumber(firstSeenDayKey(now));
  const today = dayNumber(kstDayKey(now));
  if (Number.isNaN(first) || Number.isNaN(today)) return 0;
  return Math.max(0, today - first);
}

// ── 닉네임 ──────────────────────────────────────────────────────────────
/**
 * 콘셉트마다 «어울리는» 닉네임 풀. 커뮤니티 말투를 따른다(진지한 금융 용어가 아니다).
 * 조합(접두 × 접미)으로 만들고, 다 쓰면 숫자를 붙인다.
 *
 * ★★「봇」·「bot」 이라는 낱말을 넣지 마라 — President 지시(2026-08-20).
 *   유저에게 그대로 보이는 이름이고, ★이 생성기가 «개장 멤버 9,790개»를 한 번에 찍어낸다(B안 이후).
 *   한 번 들어가면 «모든 신규 유저»에게 그대로 나온다. 풀을 고쳤으면 반드시
 *   «1,000개 이상 생성해 전수 검사»를 다시 돌려라(샘플 몇 개로 끝내지 마라).
 */
const NICK_POOLS: Record<NewConcept, { pre: string[]; suf: string[] }> = {
  blue_chip: {
    pre: ['든든한', '1등만', '정석', '안전제일', '대장주', '묵직한', '왕도', '기본기', 'BlueChip', 'SteadyKim', '우직한', '한결같은', '정공법', '믿음직한', '뚝심의', '원칙주의', '대형주', '품격있는', 'SolidLee', 'BigCapJo'],
    suf: ['투자자', '장인', '아저씨', '고수', '파수꾼', '주주', '대감', '매니저', 'Holder', 'Club', '신봉자', '생활', '원칙', '스타일', '한길', '수집가', '어르신', '선생', 'Keeper', 'Line'],
  },
  dip_buyer: {
    pre: ['싸지면', '줍줍', '떨어질때만', '바닥에서', '할인구역', '눌림목', '반값에', '세일중', 'DipKing', 'BuyTheDip', '빠지면', '내릴때', '저점에', '폭락날', '조정오면', '싼맛에', '기다렸다', '값빠진', 'LowBuy', 'SaleHunt'],
    suf: ['삽니다', '줍는사람', '전문', '헌터', '요정', '러버', '수집가', '대기중', 'Hunter', 'Crew', '장인', '매수', '타이밍', '기다림', '주의자', '스타일', '한스푼', '노리기', 'Picker', 'Zone'],
  },
  all_in: {
    pre: ['한방에', '올인', '몰빵', '전재산', '풀매수', '단하나', '외길', '집중포화', 'AllIn', 'YoloKim', '전부다', '단일종목', '한종목만', '다걸기', '한큐에', '올인원', '풀베팅', '단칼에', 'OneShot', 'MaxBet'],
    suf: ['갑니다', '인생', '스타일', '주의자', '한종목', '승부사', '뚝심', '결단', 'Warrior', 'Only', '한판', '정신', '철학', '뚝배기', '투자', '기질', '한방', '신념', 'Player', 'Mode'],
  },
  diversifier: {
    pre: ['골고루', '나눠담기', '분산의', '균등하게', '조금씩', '스무개', '바구니', '안전분산', 'SpreadIt', 'EvenLee', '두루두루', '쪼개서', '여러개', '고르게', '폭넓게', '분할매수', '흩뿌리기', '다품종', 'WideNet', 'SplitPark'],
    suf: ['담아요', '신봉자', '미학', '전문가', '습관', '지킴이', '살림꾼', '설계자', 'Basket', 'Mix', '방식', '원칙', '스타일', '장인', '취향', '루틴', '고집', '철학', 'Blend', 'Grid'],
  },
  day_trader: {
    pre: ['샀다팔았다', '초단타', '5분이면', '번개', '빠른손', '치고빠지기', '오늘만', '단타의', 'FastHands', 'ScalpJoo', '하루안에', '짧게짧게', '즉시청산', '회전율', '빠르게', '당일치기', '칼같이', '순간포착', 'QuickFlip', 'DayCut'],
    suf: ['반복', '장인', '충분', '트레이더', '중독', '달인', '삽니다', '정석', 'Scalper', 'Flip', '스타일', '기질', '습관', '승부', '한판', '전문', '루틴', '생활', 'Rapid', 'Turn'],
  },
  hodler: {
    pre: ['사면안팔아', '존버', '십년후', '묻어두기', '팔줄모름', '뚝심', '기다림', '느긋한', 'HodlPark', 'NeverSell', '평생보유', '안팝니다', '묵혀두기', '오래오래', '장기전', '참는자', '버티기', '기다리는', 'LongHold', 'KeepIt'],
    suf: ['정신', '중', '봅니다', '전문', '주의', '투자자', '미학', '한길', 'Forever', 'Club', '스타일', '철학', '기질', '생활', '고집', '루틴', '신념', '한결', 'SteadyOne', 'Line'],
  },
  short_seller: {
    pre: ['내릴것같은데', '공매도', '하락에', '거품이야', '떨어져라', '역발상', '숏치는', '비관론', 'ShortSeo', 'BearMode', '과열이다', '하락베팅', '내림세', '반대편', '고평가', '조정온다', '숏포지션', '거품경계', 'DownBet', 'ShortCut'],
    suf: ['겁니다', '전문', '베팅', '한표', '스타일', '사냥꾼', '곰돌이', '주의자', 'Bear', 'Squad', '기질', '철학', '신념', '한판', '노선', '장인', '취향', '루틴', 'ShortSide', 'Side'],
  },
  low_vol: {
    pre: ['안흔들리는', '조용한', '심심한', '잔잔한', '저변동', '평온한', '무던한', '느린', 'CalmYoon', 'SlowRide', '고요한', '안정적', '잔잔하게', '편안한', '덜움직이는', '차분한', '묵직하게', '순한', 'QuietAhn', 'MildWay'],
    suf: ['주식만', '포트폴리오', '투자', '취향', '스타일', '생활', '한잔', '루틴', 'Steady', 'Fund', '방식', '철학', '습관', '고집', '노선', '신념', '한결', '성향', 'CalmBase', 'Base'],
  },
  liquidation_hunter: {
    pre: ['청산각', '위험감지', '무너질때', '벼랑끝', '기다렸다', '흔들릴때', '취약지점', '역습의',
          '빈틈노려', '경계경보', '기회는위기', '피냄새', '한방노림', '틈새공략', '반대편에', '방심금물',
          'HunterKo', 'EdgeCase', 'SnapPoint', 'CounterJo'],
    suf: ['사냥꾼', '전문', '스타일', '기질', '노선', '한판', '감각', '타이밍',
          '포착', '노림수', '철학', '루틴', '승부', '취향', '한수', '기다림',
          'Hunter', 'Sniper', 'Edge', 'Watch'],
  },
};

/**
 * 콘셉트별 «순차» 조합으로 만든다.
 * ★난수로 뽑으면 생일 문제 때문에 20x20=400 조합을 다 쓰기 훨씬 전에 충돌이 나서
 *   「든든한투자자4」 같은 숫자 꼬리가 금방 붙는다. 순차면 400명까지 꼬리가 없다.
 *   생성 순서가 결정적이라 순차 카운터도 결정적이다(같은 날짜 = 같은 명부).
 */
function makeNickname(concept: NewConcept, seq: number, used: Set<string>): string {
  const { pre, suf } = NICK_POOLS[concept];
  const base = `${pre[seq % pre.length]}${suf[Math.floor(seq / pre.length) % suf.length]}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; n < 999; n++) {
    const cand = `${base}${n}`;
    if (!used.has(cand)) {
      used.add(cand);
      return cand;
    }
  }
  const fallback = `${base}_${seq}`;
  used.add(fallback);
  return fallback;
}

// ── 명부 ────────────────────────────────────────────────────────────────
/** 신규 봇은 BotStrategy(기존 5종) 밖의 값을 갖는다 — 그래서 별도 타입이다 */
export interface RosterBot {
  botId: string;
  nickname: string;
  concept: NewConcept | string;
  /** 참가 코호트(첫 접속일로부터 며칠째). 0 = 원년 멤버(기존 210) */
  cohortDay: number;
}

export interface BotMeta {
  botId: string;
  nickname: string;
  concept: string;
  /** i18n 키 접두 — 화면 문구는 locales 에서 온다. 여기서 문자열을 만들지 않는다 */
  i18nKey: string;
  cohortDay: number;
  isNew: boolean;
}

const META = new Map<string, BotMeta>();

/**
 * 참가자 메타 조회 — 화면(랭킹 배지·프로필 한 줄)이 쓴다.
 *
 * ★ 화면이 `data/bots.generated` 를 직접 import 해서 botId -> strategy 를 찾으면
 *   «런타임에 합류한 봇»은 그 정적 배열에 없어 배지가 사라진다.
 *   그래서 조회는 반드시 이 함수를 거쳐야 한다.
 */
export function botMeta(accountId: string): BotMeta | undefined {
  return META.get(accountId);
}

/** 등록된 전체 참가자 수 (플레이어 제외) */
export function rosterSize(): number {
  return META.size;
}

/**
 * 하루치 77명의 콘셉트 배분.
 *
 * ★ 균등(77/8)이 아니라 short_seller 를 2배로 넣는다 [실측 근거]:
 *   봇 전체 순롱 비율이 82%(현물에 숏이 없어서다). 균등 배분으로는 30일 뒤에도
 *   85.99% 로 «오히려 올라갔다» — 신규 봇 대부분이 현물 롱이기 때문이다.
 *   숏 자본을 늘려야 균형에 다가간다. 그래도 기존 5종의 현물 자본(9,800만)이
 *   뿌리라 «완전 균형»은 신규 봇만으로 도달할 수 없다(보고서 참조).
 */
function cohortMix(): NewConcept[] {
  /**
   * ★합계는 «정확히» BOTS_PER_DAY(300) 여야 한다. 31+31+35+35+31+27+55+31+24 = 300.
   * ★예전에 합이 79 였는데 slice(0,77) 로 «조용히 잘려» 뒤쪽 liquidation_hunter 가
   *   6 -> 4 로 깎였다(실측). 사냥꾼은 «과열 억제» 역할이라 33% 적으면 그 기능도 그만큼 약하다.
   *   ⇒ 콘셉트를 추가/변경하면 «반드시» 이 합을 다시 맞춰라. 아래 단언 + ★빌드타임 게이트(scripts/check_roster_mix.mjs)가 잡는다.
   */
  /*
   * ★2026-08-22: BOTS_PER_DAY 77 → 300 에 맞춰 «비율을 유지한 채» 재배분했다.
   *   배수 300/77 ≈ 3.896. 합 = 31+31+35+35+31+27+55+31+24 = ★정확히 300.
   *   옛 값(합 77): 8·8·9·9·8·7·14·8·6
   *   ⇒ short_seller 18.2%→18.3% · liquidation_hunter 7.8%→8.0% 로 «비율 보존».
   * ⛔합을 다시 맞추지 않으면 뒤쪽 콘셉트가 조용히 잘리거나 채워진다(아래 단언이 잡는다).
   */
  const weights: Record<NewConcept, number> = {
    blue_chip: 31,
    dip_buyer: 31,
    all_in: 35,
    diversifier: 35,
    day_trader: 31,
    hodler: 27,
    short_seller: 55,
    low_vol: 31,
    liquidation_hunter: 24,
  };
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total !== BOTS_PER_DAY) {
    // ★조용히 자르지 «않는다». 눈에 띄게 남기고 보정한다 —
    //   라이브 앱을 throw 로 죽이는 것보다 낫지만, 로그 없이 넘어가면 또 놓친다.
    console.error(
      `[roster] cohortMix 가중치 합 ${total} != BOTS_PER_DAY ${BOTS_PER_DAY}. ` +
        `뒤쪽 콘셉트가 잘리거나 채워진다 — weights 를 고쳐라.`
    );
  }
  const out: NewConcept[] = [];
  for (const c of NEW_CONCEPTS) for (let i = 0; i < weights[c]; i++) out.push(c);
  while (out.length < BOTS_PER_DAY) out.push(NEW_CONCEPTS[out.length % NEW_CONCEPTS.length]);
  return out.slice(0, BOTS_PER_DAY);
}

/**
 * 기존 210명 + 코호트 신규 봇 명부를 만든다.
 *
 * @param baseBots data.ts 가 읽어온 기존 210명 (변경하지 않는다)
 * @param days     첫 접속일로부터 지난 KST 일수
 */
export function buildRoster(baseBots: BotDef[], days: number, startingExtra = 0): RosterBot[] {
  META.clear();
  const out: RosterBot[] = [];
  const used = new Set<string>();

  for (const b of baseBots) {
    used.add(b.nickname);
    out.push({ botId: b.botId, nickname: b.nickname, concept: b.strategy, cohortDay: 0 });
    META.set(b.botId, {
      botId: b.botId,
      nickname: b.nickname,
      concept: b.strategy,
      i18nKey: `traders.concept.${b.strategy}`,
      cohortDay: 0,
      isNew: false,
    });
  }

  const mix = cohortMix();
  // 콘셉트별 순차 카운터 — 닉네임 조합을 400개까지 꼬리 없이 쓴다
  const seqOf: Partial<Record<NewConcept, number>> = {};
  const nextSeq = (c: NewConcept) => (seqOf[c] = (seqOf[c] ?? 0) + 1) - 1;

  /** 한 명 만들어 명부와 META 에 넣는다 */
  const add = (botId: string, concept: NewConcept, cohortDay: number) => {
    const nickname = makeNickname(concept, nextSeq(concept), used);
    out.push({ botId, nickname, concept, cohortDay });
    META.set(botId, {
      botId,
      nickname,
      concept,
      i18nKey: CONCEPTS[concept].i18nKey,
      cohortDay,
      isNew: true,
    });
  };

  // ── 개장 멤버 (cohortDay 0) — 원년 210명과 «같은 날» 시작한 참가자들 ──
  for (let i = 0; i < startingExtra; i++) add(`SB${String(i).padStart(4, '0')}`, mix[i % mix.length], 0);

  const room = Math.max(0, BOT_ROSTER_CAP - baseBots.length - startingExtra);
  const maxCohorts = Math.floor(room / BOTS_PER_DAY);
  // 상한을 넘으면 «가장 오래된 일일 코호트»부터 빠진다(FIFO).
  // 원년 210명과 개장 멤버는 빠지지 않는다 — 유저가 계속 봐온 참가자들이다.
  //
  // ⚠️★2026-08-23 (B안) 이후의 «실제» 상태: 개장 총원(210+9,790)이 상한과 «같아서»
  //   room = 0 · maxCohorts = 0 이다. ⇒ firstDay = days + 1 이 되어 **아래 루프가 안 돈다.**
  //   ⇒ FIFO 퇴출도 «일어나지 않는다» — 뺄 코호트가 애초에 없기 때문이다.
  //   ⛔이 코드를 「죽었으니 지우자」고 하지 마라. 상한을 올리는 순간 «그대로» 되살아난다.
  //     그리고 지우면 그때 FIFO 를 처음부터 다시 설계해야 한다.
  const firstDay = Math.max(1, days - maxCohorts + 1);
  for (let day = firstDay; day <= days; day++) {
    // ★난수를 쓰지 않는다 — 콘셉트별 순차 카운터라 «같은 날짜면 같은 명부»가 저절로 보장된다
    for (let i = 0; i < BOTS_PER_DAY; i++) {
      add(`NB${String(day).padStart(3, '0')}${String(i).padStart(3, '0')}`, mix[i], day);
    }
  }
  return out;
}
