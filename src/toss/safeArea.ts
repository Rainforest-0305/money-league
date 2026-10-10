/**
 * 필수 SDK ② — Safe Area
 *
 * 게임 체크리스트 명문:
 *   「Safe Area 영역을 침범하지 않아요. iOS의 Dynamic Island 영역도 포함해요」
 *
 * ── 구현 방식 ───────────────────────────────────────────────────────────────
 *  SafeAreaInsets.get()            상수 브릿지. 즉시 현재 inset 반환.
 *  SafeAreaInsets.subscribe({...}) 이벤트 브릿지. 회전 등으로 값이 바뀌면 다시 온다.
 *  둘 다 @apps-in-toss/web-framework 공개 export 다(이 프로젝트 node_modules
 *  dist/index.js 재실측: SafeAreaInsets 11건 노출).
 *
 *  받은 값을 :root 의 CSS 변수로 꽂는다: --sa-top / --sa-right / --sa-bottom / --sa-left
 *
 * ── ★ 머니리그 고유: 기존 env() 사용처를 «폴백 형태»로 바꿔야 한다 ──────────
 *  이 앱은 CSS/인라인스타일 13곳에서 env(safe-area-inset-*) 를 «직접» 쓴다
 *  (styles/app.css 9곳 + OrderSheet/LeverageOrder/OptionOrder/Onboarding 4곳).
 *  토스 WebView 는 네이티브 내비게이션 바 «아래»에 얹히므로 env() 가 0 을
 *  주거나 실제 안전영역과 어긋날 수 있다. 그래서 전부
 *      var(--sa-top, env(safe-area-inset-top))
 *  형태로 바꿔 둔다 — 이 변수가 없으면(토스 밖) 자동으로 env() 폴백이 걸린다.
 *  즉 이 SDK 가 없어도 웹 배포본의 동작은 «완전히 동일»하다.
 *
 * ── 반환 타입 주의 (조용히 실패하는 함정) ───────────────────────────────────
 *  web-bridge 의 top/bottom/left/right 는 **단위 없는 숫자**다. 그대로 CSS 에
 *  넣으면 무효값이라 padding 이 «에러 없이» 0 이 된다. 반드시 px 를 붙여야
 *  한다. 네이티브 값이 문자열('44'/'44px')로 올 가능성도 배제 못 해
 *  toCssLength() 가 두 경우를 모두 흡수한다.
 *
 * 출처: 트랙 K 네온스레드 src/toss/safeArea.ts. 로직 무변경.
 */
import { SafeAreaInsets } from '@apps-in-toss/web-framework';
import { safeSync, hasConstant } from './env';

export interface Insets {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

function toCssLength(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  if (/[a-z%)]$/i.test(s)) return s; // 이미 단위가 붙어 있으면 그대로 사용
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return `${n}px`;
}

/**
 * ★★상단 인셋은 «토스 안»에서 0 이다 — 이중 계상 제거 (2026-08-20, President 직접 지적).
 *
 * ── 무엇이 문제였나 ────────────────────────────────────────────────────────
 * 토스 미니앱은 ★네이티브 내비게이션 바가 «앱 밖»에 있고, 우리 WebView 는 그 «아래»에서
 * 시작한다. 즉 노치/다이나믹아일랜드 영역은 ★호스트가 이미 먹었다.
 * 그런데 `SafeAreaInsets.get()` 이 주는 top 은 «기기» 안전영역(아이폰 47~59px)이라,
 * 그 값을 --sa-top 에 꽂으면 app.css 의 .appbar 가 ★같은 높이를 «한 번 더» 더한다.
 *   토스 헤더(~56) + 이중 인셋(~59) + 앱바 54 + 화면 상단 패딩(~20) ≈ ★189px 가 빈다.
 *   President 실기기 지적: 「상단에 빈 공간 없애주면 안 돼? 공간이 낭비되잖아」(약 180px)
 *
 * ── 왜 «top 만» 인가 ──────────────────────────────────────────────────────
 * 좌·우·하단은 호스트가 대신 먹어주지 않는다. 특히 ★bottom 을 0 으로 만들면 하단 탭바가
 * 홈 인디케이터에 물린다 — 그건 더 큰 사고다. 그래서 ★top 만 0, 나머지는 SDK 값 그대로.
 *
 * ── 왜 「토스 안」 조건이 붙나 ─────────────────────────────────────────────
 * 이 앱은 itch.io · GitHub Pages · MS Store(PWA 래핑) 로도 나간다. 거기엔 네이티브 바가
 * «없어서» 상단 인셋이 진짜로 필요하다. 그래서 토스 밖에서는 --sa-top 을 아예 «설정하지
 * 않고», CSS 의 `var(--sa-top, env(safe-area-inset-top))` 폴백이 그대로 돌게 둔다.
 * (감지는 이 파일이 이미 import 하고 있던 hasConstant 를 재사용한다. 새로 만들지 않았다.)
 *
 * ⛔되돌리지 마라. 되돌리면 상단 ~180px 가 «다시» 빈다.
 *    「안전영역을 왜 뺐지?」 싶으면 이 주석을 먼저 읽어라 — 뺀 게 아니라 «호스트가 이미
 *    처리한 것을 두 번 더하던 것»을 멈춘 것이다.
 */
function apply(insets: Partial<Record<keyof Insets, unknown>>): void {
  const root = document.documentElement;
  const map: Array<[keyof Insets, string]> = [
    ['top', '--sa-top'],
    ['right', '--sa-right'],
    ['bottom', '--sa-bottom'],
    ['left', '--sa-left'],
  ];
  const hostOwnsTop = hasConstant('getSafeAreaInsets'); // = 토스 WebView 안
  for (const [key, cssVar] of map) {
    if (key === 'top' && hostOwnsTop) {
      root.style.setProperty(cssVar, '0px');
      continue;
    }
    const v = toCssLength(insets[key]);
    if (v != null) root.style.setProperty(cssVar, v);
  }
}

let unsubscribe: (() => void) | null = null;

/**
 * Safe Area 를 CSS 변수에 반영하고, 변경 구독을 건다.
 * @returns 구독 해제 함수
 */
export function initSafeArea(): () => void {
  if (hasConstant('getSafeAreaInsets')) {
    const initial = safeSync<Record<string, unknown> | null>(
      'SafeAreaInsets.get',
      () => SafeAreaInsets.get() as unknown as Record<string, unknown>,
      null
    );
    if (initial) {
      apply(initial);
      console.log('[toss-sdk][safeArea] initial insets =', initial);
    }
  } else {
    // 상수 핸들러가 없으면(토스 밖) CSS 의 env() 폴백을 그대로 유지한다.
    console.log('[toss-sdk][safeArea] constant bridge unavailable, using CSS env() fallback');
  }

  unsubscribe = safeSync(
    'SafeAreaInsets.subscribe',
    () =>
      SafeAreaInsets.subscribe({
        onEvent: (next) => {
          apply(next);
          console.log('[toss-sdk][safeArea] insets changed =', next);
        },
      }),
    () => {}
  );

  return () => {
    unsubscribe?.();
    unsubscribe = null;
  };
}
