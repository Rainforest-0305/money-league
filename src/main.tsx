/**
 * 엔트리. 하는 일은 «순서 보장» 하나뿐이다.
 *
 *   1) CSS 를 먼저 붙인다(첫 페인트가 스타일 없이 뜨지 않게)
 *   2) primeAppStorage() — 네이티브 Storage 미러 → localStorage 역주입
 *   3) 그 «다음»에야 앱 모듈(bootstrap.tsx)을 동적 import
 *
 * ★ 3번이 동적 import 인 이유(정적 import 로 바꾸면 조용히 깨진다):
 *   ES 모듈의 정적 import 는 «호이스팅»되어 이 파일의 어떤 코드보다 먼저
 *   평가된다. bootstrap.tsx → store.ts 체인이 그렇게 먼저 평가되면
 *   store 생성자가 localStorage 를 읽는 시점이 프라이밍보다 «앞»이 되어,
 *   ITP 로 localStorage 가 비워진 기기에서 미러 복구가 «한 박자 늦는다» —
 *   사용자는 진행 상황을 잃은 화면을 본 뒤에야 값이 채워진다.
 *
 * ★ 이 파일에 top-level await 를 쓰지 않는 이유:
 *   vite.config.ts 의 build.target 이 'es2020' 이라 top-level await 가
 *   지원되지 않는다(빌드 에러). 그래서 then 체인으로 쓴다.
 *
 * ★ 토스 «밖»(itch.io·GitHub Pages·MS Store 래핑)에서는 primeAppStorage() 가
 *   즉시 반환한다 — 네이티브 미러가 존재할 수 없으므로. 기존 웹 배포본의
 *   동작·성능은 그대로다.
 */
import './styles/tokens.css';
import './styles/app.css';
import { primeAppStorage } from './toss/storage';

primeAppStorage()
  .catch((err) => {
    // 프라이밍 실패는 «신규 시작»으로 이어질 뿐 앱을 막지 않는다.
    console.warn('[toss-sdk][storage] prime failed, continuing without restore:', err);
  })
  .finally(() => {
    void import('./bootstrap');
  });
