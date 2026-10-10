#!/usr/bin/env node
/**
 * `public/privacy.html` 정정 적용기 — ★한국어판·영문판을 «한 번에» 고친다.
 *
 *   node scripts/apply_privacy_fix.mjs           (건조 실행 — 파일을 안 고친다)
 *   node scripts/apply_privacy_fix.mjs --write   (실제 적용 — ⛔President 승인 후에만)
 *
 * ── 왜 스크립트인가 ────────────────────────────────────────────────────
 *   1. 손으로 고치면 ★ko 만 고치고 en 을 빠뜨린다. 실제로 이 문서는 같은 주장을
 *      두 언어로 «두 번» 한다 — 한쪽만 고치면 문서 안에서 서로 모순된다.
 *   2. ★**앵커를 «정확히 1건» 못 찾으면 죽는다.** 문서가 그새 바뀌었는데 조용히
 *      통과하는 것이 가장 위험하다.
 *
 * ── ⛔이 스크립트가 «판단하지 않는» 것 ─────────────────────────────────
 *   문안이 «법적으로» 옳은지는 모른다. 앵커가 맞는지와, 결과 문장이 «실측과
 *   일치»하는지만 본다. 법적 판단은 President 몫이다.
 *
 * ── 근거가 된 실측 (2026-08-22, scripts/verify_network.py 9/9 PASS) ────
 *   토스 «밖»(dist·dist_msstore 양쪽): 외부 HTTP **0건** · 데이터 반출 브릿지 **0회**
 *   토스 «안»(시뮬):                   반출 브릿지 관측 — getAnonymousKey ·
 *                                      getUserKeyForGame · get/setStorageItem
 *   ★번들에는 광고 SDK 문자열이 «들어 있다»(loadFullScreenAd 2 · static.toss.im 1).
 *     그러나 `isInToss()` 가 false 라 «실행되지 않는다» ⇒ ★포함 ≠ 통신.
 *   ★계측(eventLog·Analytics)은 소스에도 **번들에도 0건** ⇒ ⛔방침에 쓰지 않는다.
 *     (양성대조: 같은 검사에서 attachBanner 는 4건 검출 = 검사기 생존)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRIVACY = path.join(__dirname, '..', 'public', 'privacy.html');
const WRITE = process.argv.includes('--write');

/* ── 4-1 항 (신설) ─────────────────────────────────────────────────────
   ★「통신한다/안 한다」를 말로만 뒤집지 않고 «무엇이·언제·어디로» 를 표로 준다.
   ⛔없는 기능(계측)을 쓰지 않는다. 있는 것만 쓴다. */
const SEC41_KO = `  <h2>4-1. 앱인토스에서 동작하는 외부 기능</h2>
  <p>본 게임을 <b>앱인토스(토스 미니앱)에서 실행할 때</b>에 한해 아래 기능이 외부와
  통신합니다. 아래 기능은 <b>토스 앱 밖에서 실행되는 배포본에서는 동작하지 않습니다.</b></p>
  <table>
    <tr><th>기능</th><th>언제</th><th>전달되는 것</th><th>받는 곳</th></tr>
    <tr><td>광고 표시<br><span class="muted">배너 광고, 보상형 광고</span></td>
        <td>배너 광고 영역이 화면에 보일 때, 또는 <b>이용자가 보상형 광고를 직접 선택해
        볼 때</b></td><td>광고 요청에 필요한 정보(광고 지면 식별자, 기기·앱 환경 정보 등)</td>
        <td>토스 및 광고 제공사</td></tr>
    <tr><td>친구 공유 보상</td><td><b>이용자가 공유 버튼을 직접 누를 때만</b></td>
        <td>토스가 정한 공유 처리 정보</td><td>토스</td></tr>
    <tr><td>진행 상황 저장</td><td>게임 진행 중</td><td>게임 진행 데이터(닉네임, 보유 종목,
        가상 잔고 등)</td><td>토스 앱이 제공하는 기기 내 저장 영역</td></tr>
  </table>
  <p class="muted">본 게임은 위 기능을 <b>토스가 제공하는 방식</b>으로만 사용하며, 사업자(리미)가
  운영하는 수집 서버는 존재하지 않습니다. 각 기능에서 실제로 처리되는 항목과 보관 기간은
  토스 및 각 광고 제공사의 개인정보처리방침을 따릅니다.</p>

`;

const SEC41_EN = `  <h2>4-1. External Features That Run Inside Apps in Toss</h2>
  <p>The following features communicate externally <b>only when the Game runs inside Apps
  in Toss (the Toss mini app)</b>. They <b>do not operate in builds that run outside the
  Toss app.</b></p>
  <table>
    <tr><th>Feature</th><th>When</th><th>What is sent</th><th>Recipient</th></tr>
    <tr><td>Advertising<br><span class="muted">banner ads, rewarded ads</span></td>
        <td>When a banner ad area becomes visible, or when <b>you choose to watch a
        rewarded ad</b></td><td>Information needed to request an ad (ad placement
        identifier, device and app environment data, and similar)</td>
        <td>Toss and its advertising providers</td></tr>
    <tr><td>Share reward</td><td><b>Only when you tap the share button yourself</b></td>
        <td>Share-processing information defined by Toss</td><td>Toss</td></tr>
    <tr><td>Saving progress</td><td>While you play</td><td>Game progress data (nickname,
        holdings, virtual balance, and similar)</td><td>On-device storage provided by the
        Toss app</td></tr>
  </table>
  <p class="muted">The Game uses these features only in the manner provided by Toss, and the
  publisher (Rimi) operates no collection server. The items actually processed by each
  feature and their retention periods are governed by the privacy policies of Toss and the
  respective advertising providers.</p>

`;

/**
 * 승인된 교체 목록.
 * ★각 항목은 «정확히 1건» 매치돼야 한다. 0건이나 2건이면 죽는다.
 */
const EDITS = [
  /* ═══════════════ 한국어판 ═══════════════ */
  /* ── ★구조화 선언 (조직 공용 검사기가 «이것만» 읽는다) ────────────────
     `_shared/check_game_privacy_sdk.mjs` 는 프로즈 스캔이 fragile 하다고
     스스로 적어 뒀다(문구 1글자만 바뀌어도 오탐). 이 한 줄이 있으면
     프로즈를 «안 읽고» 이것만 믿는다 = 100% 결정적 판정.
     ★값은 «실측»이다:
       ads=on        배너 9지면 + attachBanner 호출 [실측 src 5회]
       rewardAds=on  리워드 2지면 + show/loadAppsInTossAdMob [실측 src 각 2회]
       ★analytics=off  eventLog·Analytics 소스 0 · «번들도 0»
                       (양성대조: 같은 검사에서 attachBanner 검출 = 검사기 생존)
     ⛔전면광고(loadFullScreenAd)는 «우리가 안 부른다» — 배럴 사장품이라
       방침 본문에도 적지 않는다(적으면 과다고지). */
  {
    id: 'ko-SDK-DECLARE 선언',
    from: `<title>머니리그 개인정보처리방침 / Privacy Policy - Money League</title>`,
    to: `<title>머니리그 개인정보처리방침 / Privacy Policy - Money League</title>
<!-- SDK-DECLARE: ads=on analytics=off rewardAds=on -->`,
  },
  {
    id: 'ko-머리말',
    from: `  <p>머니리그(이하 &ldquo;본 게임&rdquo;)는 <b>서버가 없는 단독 실행 게임</b>입니다.
  게임에 필요한 모든 계산과 저장이 이용자의 기기 안에서 이루어지며, 본 게임은
  이용자의 정보를 외부로 전송하지 않습니다. 본 게임을 만든 사업자(리미)는
  이용자의 게임 데이터를 <b>수집하지도, 보관하지도, 열람하지도 않습니다.</b></p>`,
    to: `  <p>머니리그(이하 &ldquo;본 게임&rdquo;)는 <b>사업자의 운영 서버가 없는 게임</b>입니다.
  게임에 필요한 계산과 저장은 모두 이용자의 기기 안에서 이루어지며, 본 게임을 만든
  사업자(리미)는 이용자의 게임 데이터를 <b>수집하지도, 보관하지도, 열람하지도
  않습니다.</b> 다만 <b>앱인토스(토스 미니앱)에서 실행할 때</b>는 광고 표시와 친구 공유
  기능을 위해 토스 및 광고 제공사와 통신합니다(4-1항).</p>`,
  },
  {
    id: 'ko-요약',
    from: `    <li>본 게임은 외부와 네트워크 통신을 하지 않습니다(글꼴까지 앱에 동봉).</li>
    <li>인앱결제, 광고 SDK, 분석 SDK가 <b>없습니다.</b></li>
    <li>게임 안의 다른 트레이더 210명은 실제 이용자가 아니라 기기 안에서
        생성되는 <b>컴퓨터 캐릭터(봇)</b>입니다.</li>`,
    to: `    <li>사업자(리미)가 운영하는 <b>수집 서버가 없습니다.</b> 다만 앱인토스에서 실행할 때는
        광고와 친구 공유 기능이 토스 및 광고 제공사와 통신합니다(4-1항).</li>
    <li><b>인앱결제가 없습니다.</b> 이용 통계(분석) SDK도 넣지 않았습니다.</li>
    <li>게임 안의 다른 트레이더는 실제 이용자가 아니라 기기 안에서
        생성되는 <b>컴퓨터 캐릭터</b>입니다.</li>`,
  },
  {
    id: 'ko-§3-트레이더 수',
    from: `  <p>게임 안의 랭킹과 강제청산 알림에 등장하는 <b>210명의 트레이더는 실제 사람이
  아니라 기기 안에서 생성되어 자동으로 매매하는 컴퓨터 캐릭터(봇)</b>입니다. 봇의`,
    to: `  <p>게임 안의 랭킹과 강제청산 알림에 등장하는 <b>트레이더는 실제 사람이
  아니라 기기 안에서 생성되어 자동으로 매매하는 컴퓨터 캐릭터</b>입니다. 그 캐릭터의`,
  },
  {
    id: 'ko-§4-제3자 SDK',
    from: `  소셜 로그인 등 제3자 SDK를 탑재하지 않았습니다.</p>`,
    to: `  소셜 로그인 SDK와 이용 통계(분석) SDK는 탑재하지 않았습니다. 다만 <b>앱인토스
  빌드에는 광고 SDK가 포함</b>되며, 광고를 표시하는 과정에서 광고 제공사에 정보가
  전달됩니다. 무엇이 오가는지는 아래 4-1항에 적었습니다.</p>`,
  },
  {
    id: 'ko-§4-1 신설',
    from: `  <h2>5. 배포 플랫폼별 차이</h2>`,
    to: SEC41_KO + `  <h2>5. 배포 플랫폼별 차이</h2>`,
  },
  {
    id: 'ko-§5-표',
    from: `    <tr><td>Microsoft Store (Windows)</td><td>없음</td><td>기기 로컬 저장소</td><td>없음</td></tr>
    <tr><td>앱인토스(토스 미니앱)</td><td>있음(메모리에만, 자가진단용)</td>
        <td>기기 로컬 저장소 + 토스 네이티브 저장소</td><td>없음</td></tr>
    <tr><td>웹 배포(itch.io / GitHub Pages 등)</td><td>없음</td><td>브라우저 로컬 저장소</td><td>없음</td></tr>
  </table>`,
    to: `    <tr><td>Microsoft Store (Windows)</td><td>없음</td><td>기기 로컬 저장소</td><td>없음</td></tr>
    <tr><td>앱인토스(토스 미니앱)</td><td>있음</td>
        <td>기기 로컬 저장소 + 토스 네이티브 저장소</td>
        <td><b>있음</b> &mdash; 광고, 친구 공유(4-1항)</td></tr>
    <tr><td>웹 배포(GitHub Pages 등)</td><td>없음</td><td>브라우저 로컬 저장소</td><td>없음</td></tr>
  </table>
  <p class="muted">본 게임은 모든 배포 채널에 <b>같은 프로그램</b>을 올립니다. 따라서 광고
  기능을 위한 코드는 어느 배포본에도 들어 있지만, 그 기능은 <b>토스 앱 안에서 실행될 때만
  동작</b>합니다. 토스 앱 밖에서 실행되는 배포본(Microsoft Store, 웹 배포)에서는 광고와
  친구 공유가 동작하지 않으며, 외부로 나가는 통신이 발생하지 않습니다.</p>`,
  },
  {
    id: 'ko-§6-국외이전',
    from: `  <p>본 게임은 자체 서버가 없고 외부로 데이터를 전송하지 않으므로, 개인정보의 국외
  이전이 발생하지 않습니다.</p>`,
    to: `  <p>사업자(리미)는 이용자 정보를 수집하는 서버를 두지 않으며, 사업자가 국외로 이전하는
  개인정보는 없습니다.</p>
  <p>다만 앱인토스에서 광고를 표시할 때에는 광고 요청에 필요한 정보가 토스 및 광고
  제공사에 전달되며, <b>해당 사업자의 서버는 국외에 있을 수 있습니다.</b> 이때 전달되는
  항목, 이전받는 자, 보관 기간은 토스 및 각 광고 제공사의 개인정보처리방침을 따릅니다.</p>`,
  },
  {
    id: 'ko-§9-안전성',
    from: `  <p>본 게임은 데이터를 네트워크로 전송하지 않는 구조 자체를 안전성 확보 조치로
  삼습니다. 전송 구간이 존재하지 않으므로 전송 중 유출 위험이 없고, 사업자 측에
  보관되는 데이터가 없으므로 사업자 서버를 통한 유출 위험도 없습니다. 기기에
  저장된 데이터는 해당 기기의 운영체제 및 앱 샌드박스 보호를 받습니다.</p>`,
    to: `  <p>본 게임은 <b>수집을 하지 않는 구조</b> 자체를 안전성 확보 조치로 삼습니다. 사업자(리미)
  측에 보관되는 이용자 데이터가 없으므로 사업자 서버를 통한 유출 위험이 없고, 기기에
  저장된 데이터는 해당 기기의 운영체제 및 앱 샌드박스 보호를 받습니다.</p>
  <p>앱인토스에서 광고와 친구 공유 기능이 사용하는 통신은 <b>토스 앱이 제공하는 경로</b>를
  통해 이루어지며, 해당 구간의 보호 조치는 토스 및 각 광고 제공사의 정책을 따릅니다.</p>`,
  },

  /* ═══════════════ 영문판 ═══════════════ */
  {
    id: 'en-머리말',
    from: `  <p>Money League (the &ldquo;Game&rdquo;) is a <b>standalone game that runs without any
  server</b>. All game logic and all saved data stay on your device, and the Game does
  not transmit your information anywhere. The publisher (Rimi) does <b>not collect,
  store, or have access to</b> your game data.</p>`,
    to: `  <p>Money League (the &ldquo;Game&rdquo;) is a game that runs <b>without any publisher
  server</b>. All game logic and all saved data stay on your device, and the publisher
  (Rimi) does <b>not collect, store, or have access to</b> your game data. However,
  <b>when the Game runs inside Apps in Toss (the Toss mini app)</b>, the advertising and
  share features communicate with Toss and its advertising providers (section 4-1).</p>`,
  },
  {
    id: 'en-요약',
    from: `    <li>The Game makes <b>no network requests</b> (even the fonts are bundled in the app).</li>
    <li>There are <b>no in-app purchases, no advertising SDKs, and no analytics SDKs.</b></li>
    <li>The 210 other traders in the game are not real people. They are
        <b>computer-controlled characters (bots)</b> generated on your device.</li>`,
    to: `    <li>The publisher operates <b>no collection server.</b> However, inside Apps in Toss,
        the advertising and share features communicate with Toss and its advertising
        providers (section 4-1).</li>
    <li>There are <b>no in-app purchases and no analytics SDKs.</b></li>
    <li>The other traders in the game are not real people. They are
        <b>computer-controlled characters</b> generated on your device.</li>`,
  },
  {
    id: 'en-§4-제3자 SDK',
    from: `  the app</b>, so no external CDN is contacted. The Game contains no advertising networks,
  analytics tools, crash reporters, or social login SDKs.</p>`,
    to: `  the app</b>, so no external CDN is contacted. The Game contains no analytics tools, crash
  reporters, or social login SDKs. However, <b>builds for Apps in Toss include an
  advertising SDK</b>, and information is sent to advertising providers in the course of
  displaying ads. Section 4-1 sets out what is exchanged.</p>`,
  },
  {
    id: 'en-§4-1 신설',
    from: `  <h2>5. Differences by Distribution Platform</h2>`,
    to: SEC41_EN + `  <h2>5. Differences by Distribution Platform</h2>`,
  },
  {
    id: 'en-§5-표',
    from: `    <tr><td>Microsoft Store (Windows)</td><td>Not used</td><td>Device local storage</td><td>None</td></tr>
    <tr><td>Apps in Toss (Toss mini app)</td><td>Used (in memory only, for self-test)</td>
        <td>Device local storage + Toss native storage</td><td>None</td></tr>
    <tr><td>Web distribution (itch.io / GitHub Pages, etc.)</td><td>Not used</td>
        <td>Browser local storage</td><td>None</td></tr>
  </table>`,
    to: `    <tr><td>Microsoft Store (Windows)</td><td>Not used</td><td>Device local storage</td><td>None</td></tr>
    <tr><td>Apps in Toss (Toss mini app)</td><td>Used</td>
        <td>Device local storage + Toss native storage</td>
        <td><b>Yes</b> &mdash; advertising, share (section 4-1)</td></tr>
    <tr><td>Web distribution (GitHub Pages, etc.)</td><td>Not used</td>
        <td>Browser local storage</td><td>None</td></tr>
  </table>
  <p class="muted">The Game ships <b>the same program</b> to every distribution channel.
  The code for the advertising feature is therefore present in every build, but that feature
  <b>operates only when the Game runs inside the Toss app.</b> In builds that run outside the
  Toss app (Microsoft Store, web distribution), advertising and sharing do not operate and no
  outbound communication occurs.</p>`,
  },
  {
    id: 'en-§6-국외이전',
    from: `  <p>The Game has no server of its own and transmits no data externally, so no overseas
  transfer of personal information occurs.</p>`,
    to: `  <p>The publisher (Rimi) operates no server that collects user information, and the
  publisher transfers no personal information overseas.</p>
  <p>However, when ads are displayed inside Apps in Toss, the information needed to request
  an ad is sent to Toss and its advertising providers, and <b>those providers' servers may be
  located outside Korea.</b> The items transferred, the recipients, and the retention periods
  are governed by the privacy policies of Toss and the respective advertising providers.</p>`,
  },
  {
    id: 'en-§9-안전성',
    from: `  <p>The Game's security measure is its architecture: it does not transmit data over a
  network. Because no transmission occurs, there is no risk of interception in transit,
  and because the publisher stores no data, there is no risk of a breach on the
  publisher's side. Data stored on your device is protected by that device's operating
  system and application sandbox.</p>`,
    to: `  <p>The Game's security measure is its architecture: <b>it does not collect.</b> Because the
  publisher (Rimi) stores no user data, there is no risk of a breach on the publisher's side,
  and data stored on your device is protected by that device's operating system and
  application sandbox.</p>
  <p>Communication used by the advertising and share features inside Apps in Toss takes place
  <b>over paths provided by the Toss app</b>, and protection of that channel is governed by the
  policies of Toss and the respective advertising providers.</p>`,
  },
].filter((e) => !e.skip);

/* ── 실행 ────────────────────────────────────────────────────────────── */
/*
 * ★★[실측으로 잡은 함정] 이 문서는 ★CRLF 다(실측: CRLF 396 · 단독 LF 0).
 *   그런데 앵커 문자열은 `\n` 이라 ★«여러 줄» 앵커가 통째로 안 맞는다.
 *   ⇒ 처음 건조 실행에서 «한 줄 앵커는 OK, 여러 줄 앵커는 0건»이 나왔다 —
 *     일부가 통과해서 「스크립트는 도는데」로 보였다. ★가장 헷갈리는 형태다.
 * ⇒ 대조는 «줄바꿈을 normalize 한 사본»에서 하고, 기록할 때 원본 방식을 되돌린다.
 *   ⛔파일 전체를 LF 로 저장하지 마라 — diff 가 통째로 뒤집힌다.
 */
const rawOrig = readFileSync(PRIVACY, 'utf8');
const WAS_CRLF = rawOrig.includes('\r\n');
const orig = WAS_CRLF ? rawOrig.split('\r\n').join('\n') : rawOrig;
let out = orig;
const problems = [];

console.log('개인정보처리방침 정정 적용 ' + (WRITE ? '★[실제 기록]' : '[건조 실행 — 파일을 안 고친다]'));
console.log('  대상: public/privacy.html');
console.log(`  항목: ${EDITS.length}건 (ko ${EDITS.filter((e) => e.id.startsWith('ko')).length} · en ${EDITS.filter((e) => e.id.startsWith('en')).length})`);
console.log('');

for (const e of EDITS) {
  const n = out.split(e.from).length - 1;
  if (n !== 1) {
    problems.push(`[${e.id}] 앵커가 «정확히 1건»이 아니다 (찾은 수: ${n})`);
    console.log('  ★FAIL  ' + e.id + '  (매치 ' + n + '건)');
    continue;
  }
  out = out.replace(e.from, e.to);
  console.log('  OK    ' + e.id);
}

if (problems.length) {
  console.error('\nFAILED: ' + problems.length + '건 — ⛔조용히 넘기지 않는다.');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

/* ── ★결과 «문서»가 실측과 모순되지 않는지 재검 ──────────────────────
   ⛔치환이 성공한 것과 «결과가 참인 것»은 다르다. 남으면 안 되는 문장을 직접 센다. */
const MUST_BE_GONE = [
  ['ko', '외부와 네트워크 통신을 하지 않습니다'],
  ['ko', '외부로 데이터를 전송하지 않으므로'],
  ['ko', '전송 구간이 존재하지 않으므로'],
  ['ko', '210명의 트레이더'],
  ['en', 'no network requests'],
  ['en', 'no advertising SDKs'],
  ['en', 'transmits no data externally'],
  ['en', 'The 210 other traders'],
];
/* ★반대로 «반드시 남아야» 하는 것 — 계측은 실제로 «없으니» 그 문장은 참이다 */
const MUST_REMAIN = [['en', 'no analytics SDKs'], ['ko', '이용 통계(분석) SDK']];

let post = 0;
for (const [lang, s] of MUST_BE_GONE) {
  if (out.includes(s)) {
    console.error(`  ★잔존 [${lang}] "${s}"`);
    post++;
  }
}
for (const [lang, s] of MUST_REMAIN) {
  if (!out.includes(s)) {
    console.error(`  ★누락 [${lang}] "${s}" 가 결과에 없다`);
    post++;
  }
}
console.log(post === 0 ? '\n결과 재검: OK (없어야 할 문장 8종 전멸 · 남아야 할 문장 2종 생존)' : `\n결과 재검 ★실패 ${post}건`);
if (post) process.exit(1);

if (WRITE) {
  writeFileSync(PRIVACY, WAS_CRLF ? out.split('\n').join('\r\n') : out, 'utf8');
  console.log('기록 완료(줄바꿈 ' + (WAS_CRLF ? 'CRLF 유지' : 'LF') + ').');
  console.log('★이제 반드시 돌려라: node scripts/check_privacy_keys.mjs');
} else {
  console.log('(건조 실행이라 파일은 그대로다. 적용하려면 --write · ⛔President 승인 후)');
  console.log('\n★남는 수작업: §2 표에 저장키 4행 추가(ml.journal·ml.traderwatch·ml.quotesession·ml.firstSeen)');
  console.log('  · §10 동의 · §12 개정이력 · 시행일 갱신 — 구조 «추가»라 치환으로 하면 위험하다');
}
