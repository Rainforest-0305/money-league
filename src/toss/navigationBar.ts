/**
 * 필수 SDK ④ — 내비게이션 바 (런타임부) + 종료 확인 배선처
 *
 * ── 두 조각으로 이루어져 있다. 둘 다 해야 "적용"이다 ────────────────────────
 *  (A) 선언부 — granite.config.ts 의 navigationBar { ... }. 빌드타임 고정값
 *      (뒤로가기 버튼 유무/제목/투명배경/테마). 여기(웹 코드)에는 안 들어간다.
 *  (B) 런타임부 — 이 파일. graniteEvent 'backEvent'/'homeEvent' 를 받아 처리한다.
 *      (B)를 안 하면 뒤로가기 버튼이 눌려도 «아무 일도 안 일어난다» = 반려.
 *
 * ── ★ 머니리그가 4종과 다른 결정적 지점: 이 앱에는 «화면 스택이 있다» ───────
 *  4종 게임은 history API 를 전혀 안 써서(popstate/pushState 0건) 뒤로가기가
 *  누르면 «항상» 종료 확인이었다. 머니리그는 HashRouter 를 쓰는 SPA 라
 *  /home → /stock/NVDA → /leverage/NVDA 처럼 «쌓인다».
 *  여기서 뒤로가기를 곧장 종료로 처리하면 사용자가 종목 상세 하나 보다가
 *  앱이 꺼진다 — 명백한 오작동이다.
 *  → 그래서 종료 확인 «위»에 라우터 뒤로가기 핸들러를 얹는다(tossBoot.ts).
 *    이 파일 자체는 스택만 관리하고 정책은 갖지 않는다.
 *
 * 출처: 트랙 K 네온스레드 src/toss/navigationBar.ts. 커스텀 이벤트명만
 * 'neon:nav-home' → 'ml:nav-home'.
 */
import { graniteEvent, tdsEvent, partner } from '@apps-in-toss/web-framework';
import { closeView } from './bridge';
import { isInToss, safeSync, safeBridge } from './env';

/** true 를 반환하면 소비(=다음 핸들러로 안 넘김), false/void 면 다음 핸들러로. */
export type BackHandler = () => boolean | void;

const backHandlers: BackHandler[] = [];

/**
 * 뒤로가기 핸들러 등록. ★ «나중에 등록된 것이 먼저» 호출된다.
 * 따라서 등록 순서 = 우선순위의 «역순»이다:
 *   1) 종료 확인(가장 낮은 우선순위)  → 먼저 push
 *   2) 라우터 뒤로가기                → 나중에 push
 *   3) 열려 있는 모달/시트(가장 높음) → 열릴 때 push, 닫을 때 해제
 * @returns 해제 함수
 */
export function pushBackHandler(handler: BackHandler): () => void {
  backHandlers.push(handler);
  return () => {
    const i = backHandlers.indexOf(handler);
    if (i >= 0) backHandlers.splice(i, 1);
  };
}

async function handleBack(): Promise<void> {
  for (let i = backHandlers.length - 1; i >= 0; i--) {
    let consumed = false;
    try {
      consumed = backHandlers[i]!() === true;
    } catch (err) {
      console.warn('[toss-sdk][nav] back handler threw:', err);
    }
    if (consumed) return;
  }
  console.log('[toss-sdk][nav] no handler consumed backEvent, closing view');
  await safeBridge('closeView', () => closeView(), undefined);
}

export interface NavigationBarOptions {
  accessoryButton?: { id: string; title: string; iconName: string };
  onAccessoryPress?: (id: string) => void;
}

let disposers: Array<() => void> = [];

/**
 * 내비게이션 바 런타임 연동을 시작한다.
 * @returns 해제 함수
 */
export function initNavigationBar(options: NavigationBarOptions = {}): () => void {
  if (!isInToss()) {
    /**
     * ★★ 이식 원본(트랙 K 4종)과 «의도적으로 다르다». 원본은 여기서 popstate 를
     *    바인딩해 로컬에서도 종료확인 모달을 눈으로 볼 수 있게 했다.
     *    머니리그에서는 그러면 «안 된다» — 실측으로 확인한 결함이다.
     *
     *    측정(2026-08-10, dist/web 실렌더): 이 앱은 HashRouter SPA 라 화면
     *    이동이 곧 hashchange 이고, hashchange 는 popstate 를 «발생시킨다».
     *    그래서 평범한 화면 이동마다 handleBack 이 돌았다:
     *        [nav] back at "/home"       -> exit   ← 종료 확인 모달이 떴다
     *        [nav] back at "/stock/NVDA" -> back
     *        [nav] back at "/home"       -> exit
     *    즉 사용자가 종목을 눌러 들어가기만 해도 「종료할까요?」가 뜬다.
     *
     *    4종 게임은 화면 전환이 DOM 클래스 토글이라 이 문제가 «없었다».
     *    머니리그는 라우터를 쓰므로 그대로 가져오면 웹 배포본
     *    (itch.io·GitHub Pages·MS Store 래핑)이 망가진다.
     *
     * → 토스 밖에서는 «아무것도 바인딩하지 않는다». 브라우저 기본 뒤로가기가
     *   그대로 정상 동작하고, 기존 웹 배포본과 동작이 완전히 같아진다.
     */
    console.log('[toss-sdk][nav] not in Toss — back handling left to the browser (no popstate binding)');
    return dispose;
  }

  disposers.push(
    safeSync(
      'graniteEvent.backEvent',
      () =>
        graniteEvent.addEventListener('backEvent', {
          onEvent: () => {
            console.log('[toss-sdk][nav] backEvent');
            void handleBack();
          },
          onError: (e) => console.warn('[toss-sdk][nav] backEvent error', e),
        }),
      () => {}
    )
  );

  // withHomeButton:false 라 현재는 안 뜨지만, 켜는 순간 핸들러가 없으면
  // 먹통이 되므로 미리 붙여둔다.
  disposers.push(
    safeSync(
      'graniteEvent.homeEvent',
      () =>
        graniteEvent.addEventListener('homeEvent', {
          onEvent: () => {
            console.log('[toss-sdk][nav] homeEvent');
            window.dispatchEvent(new CustomEvent('ml:nav-home'));
          },
          onError: (e) => console.warn('[toss-sdk][nav] homeEvent error', e),
        }),
      () => {}
    )
  );

  if (options.accessoryButton) {
    const { id, title, iconName } = options.accessoryButton;
    void safeBridge(
      'partner.addAccessoryButton',
      () => partner.addAccessoryButton({ id, title, icon: { name: iconName } }),
      undefined
    );
    disposers.push(
      safeSync(
        'tdsEvent.navigationAccessoryEvent',
        () =>
          tdsEvent.addEventListener('navigationAccessoryEvent', {
            onEvent: ({ id: pressedId }) => {
              console.log('[toss-sdk][nav] accessory pressed', pressedId);
              options.onAccessoryPress?.(pressedId);
            },
          }),
        () => {}
      )
    );
    disposers.push(() => {
      void safeBridge('partner.removeAccessoryButton', () => partner.removeAccessoryButton(), undefined);
    });
  }

  console.log('[toss-sdk][nav] navigation bar wired (back/home listeners active)');
  return dispose;
}

function dispose(): void {
  for (const d of disposers) {
    try {
      d();
    } catch {
      /* noop */
    }
  }
  disposers = [];
}

/** "지금 미니앱을 닫아라"가 필요할 때 쓴다(종료확인 모달의 '종료' 버튼 등). */
export async function exitMiniApp(): Promise<void> {
  await safeBridge('closeView', () => closeView(), undefined);
}
