import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 머니리그 클라이언트 — **정적 단독 빌드**(트랙 C, 2026-08-05).
 *
 * - dev 프록시(/api·/ws → :8787) 제거: 서버가 없다. 프록시가 남아 있으면
 *   dev 에서만 서버가 붙는 착시가 생기고, 코드에 서버 경로가 되살아난다.
 * - base: './' — itch.io/CrazyGames 처럼 **하위 경로에 얹히는** 정적 호스팅에서
 *   절대경로(/assets/...)는 404 가 난다. 산출물을 그대로 압축해 올릴 수 있어야 한다.
 * - dev 포트 5183 유지(다른 트랙이 5173 점유).
 */

/* ══════════════════════════════════════════════════════════════════════════
   ★ AIT_BUILD 분기 (2026-08-18, Partner 승인)
   ══════════════════════════════════════════════════════════════════════════
   문제: 2026-08-18 MS Store PWA 작업으로 public/ 에 스토어 스크린샷 12장
        (3.2MB) + PWA 아이콘 14장(1.39MB) + manifest/sw/privacy 가 들어왔다.
        Vite 는 publicDir 을 «통째로» 복사하므로 이것들이 토스 .ait 에도
        실렸다 — 압축 기준 4,597,034 B = .ait 전체의 42.9%. 토스 웹뷰에서는
        하나도 쓰이지 않는다(실측: manifest 는 런타임 요청조차 안 됨,
        서비스워커는 ReactNativeWebView 분기로 등록 자체가 안 됨).

   ★ 이 분기의 «절대 조건»: 플래그가 없을 때 동작이 이전과 «완전히 동일»해야
     한다. MS Store 빌드(`npm run build`)와 설정을 공유하고, 머니리그는
     이미 MS Store 에 라이브다. 그래서 AIT_BUILD 가 '1' 이 아니면 아래
     publicDir/플러그인은 «전혀 관여하지 않는다».
     증명: 변경 전/후 `npm run build` 산출물 58파일 md5 전건 대조.

   ★ public/ 을 복제하지 않는다. 사본을 만들면 정본이 둘이 되어 반드시
     어긋난다(폰트 2.2MB 중복). publicDir 은 «그대로 두고», 복사가 끝난 뒤
     허용목록 밖 자산만 outDir 에서 지운다.

   ⚠ 처음엔 `publicDir: false` + 허용목록 «복사» 로 짰다가 되돌렸다. 실측 결과
     vite 가 public 자산을 해석하지 못해 index.html 의 폰트 경로를
     `./fonts/pretendard.css` 로 재작성하지 «못하고» 절대경로 `/fonts/...` 로
     남겼다(빌드 경고: "doesn't exist at build time, it will remain unchanged").
     base:'./' 인 이 앱에서 절대경로는 토스 웹뷰에서 404 다. 그래서 «복사는
     그대로 시키고 뒤에서 지우는» 방식으로 바꿨다 — 검증된 index.html 산출과
     경로가 «완전히 같다».
   ────────────────────────────────────────────────────────────────────────── */
const AIT_BUILD = process.env.AIT_BUILD === '1';

/** 토스 번들에 «실제로 필요한» public 자산만. index.html 이 참조하는 것들이다. */
/**
 * ★privacy.html 추가(2026-08-22). ⛔빼지 마라 — 빼면 앱 안 방침 링크가 토스에서 404 다.
 *   이 플러그인은 허용목록 «밖»을 rmSync 로 지우므로, 예전에는 .ait 번들에
 *   privacy.html 이 «없었다». 상대경로 링크를 달려면 반드시 실려야 한다.
 *   비용 ≈ 31 KB — 이 플러그인이 아낀 4.6 MB 의 0.7 % 다.
 *   ★라이브 URL 로 보내는 방안도 있었으나, 그러면 «GH Pages 업로드(게이트)»에
 *   종속되고 오프라인에서 안 열린다. 번들 동봉이 상태가 항상 일치한다.
 */
const AIT_PUBLIC_ALLOWLIST = ['fonts', '404.html', 'privacy.html'];

/**
 * ★ 이 플러그인은 «조용히 아무것도 안 하는» 실패가 불가능하도록 만들었다.
 *   제거 대상 태그를 못 찾으면 throw 한다 — 「0건 함정」의 정확한 형태가
 *   「패턴이 안 맞아 조용히 통과」이기 때문이다.
 */
function aitPublicAllowlist(): Plugin {
  let outDir = 'dist';
  let root = process.cwd();
  return {
    name: 'ait-public-allowlist',
    apply: 'build',
    enforce: 'post',
    configResolved(cfg) {
      outDir = cfg.build.outDir;
      root = cfg.root;
    },
    transformIndexHtml(html) {
      /* MS Store 전용 태그를 뺀다. 파일이 번들에 없는데 참조만 남으면
         런타임 404 가 난다. 각 제거는 «1건 정확히» 매치돼야 한다. */
      const drops: Array<[string, RegExp]> = [
        ['manifest link', /[ \t]*<link[^>]*rel="manifest"[^>]*>\r?\n?/g],
        ['apple-touch-icon link', /[ \t]*<link[^>]*rel="apple-touch-icon"[^>]*>\r?\n?/g],
        ['service worker 등록 script', /[ \t]*<script>[\s\S]*?serviceWorker[\s\S]*?<\/script>\r?\n?/g],
      ];
      let out = html;
      for (const [label, re] of drops) {
        const hits = out.match(re);
        if (!hits || hits.length !== 1) {
          throw new Error(
            `[ait-public-allowlist] index.html 에서 "${label}" 를 정확히 1건 찾지 못했다 ` +
            `(찾은 수: ${hits ? hits.length : 0}). 조용히 넘기지 않는다 — 패턴을 고쳐라.`,
          );
        }
        out = out.replace(re, '');
      }
      return out.replace(
        '</head>',
        '  <!-- [ait build] MS Store 전용 태그(manifest·apple-touch-icon·SW 등록) 제거됨 -->\n  </head>',
      );
    },
    closeBundle() {
      const src = path.resolve(root, 'public');
      const dst = path.resolve(root, outDir);

      /* 허용목록 자산이 «실제로» 있는지 먼저 확인 — 없으면 폰트가 통째로
         빠진 채 조용히 빌드가 끝난다. */
      for (const name of AIT_PUBLIC_ALLOWLIST) {
        if (!fs.existsSync(path.join(src, name))) {
          throw new Error(`[ait-public-allowlist] 허용목록 자산이 없다: ${name}`);
        }
        if (!fs.existsSync(path.join(dst, name))) {
          throw new Error(`[ait-public-allowlist] 허용목록 자산이 복사되지 않았다: ${name}`);
        }
      }

      /* public/ 에 «있지만» 허용목록엔 없는 것 = 토스에서 안 쓰는 자산.
         목록을 public/ 에서 «유도»하므로 나중에 뭐가 추가돼도 자동으로 걸린다. */
      const dropped: string[] = [];
      let freed = 0;
      const bytesOf = (p: string): number => {
        const st = fs.statSync(p);
        if (!st.isDirectory()) return st.size;
        return fs
          .readdirSync(p)
          .reduce((a, c) => a + bytesOf(path.join(p, c)), 0);
      };
      for (const name of fs.readdirSync(src)) {
        if (AIT_PUBLIC_ALLOWLIST.includes(name)) continue;
        const target = path.join(dst, name);
        if (!fs.existsSync(target)) continue;
        freed += bytesOf(target);
        fs.rmSync(target, { recursive: true, force: true });
        dropped.push(name);
      }

      /* 지웠다고 «말만» 하지 않는다 — 실제로 사라졌는지 확인한다. */
      const survivors = dropped.filter((n) => fs.existsSync(path.join(dst, n)));
      if (survivors.length) {
        throw new Error(`[ait-public-allowlist] 삭제 실패: ${survivors.join(', ')}`);
      }
      this.info?.(
        `[ait-public-allowlist] 제외 ${dropped.length}건 (${freed.toLocaleString()} B): ` +
          `${dropped.join(', ')} / 유지: ${AIT_PUBLIC_ALLOWLIST.join(', ')}`,
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), ...(AIT_BUILD ? [aitPublicAllowlist()] : [])],
  server: {
    port: 5183,
    strictPort: true,
  },
  build: { target: 'es2020', sourcemap: false, assetsInlineLimit: 4096 },
});
