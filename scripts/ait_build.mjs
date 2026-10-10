/**
 * ait build 래퍼 — AIT_BUILD=1 을 «확실히» 심어서 실행한다.
 *
 * 왜 npm script 에 env 를 인라인하지 않았나:
 *   `AIT_BUILD=1 ait build` 는 POSIX 문법이라 Windows 의 npm(cmd.exe 경유)에서
 *   깨지고, `set AIT_BUILD=1 &&` 는 그 반대로 깨진다. 이 프로젝트는 Windows 에서
 *   빌드하고 검증은 Git Bash 에서 돈다 — 둘 다 통과하는 유일한 방법이 node 래퍼다.
 *
 * ★ 이 플래그는 vite.config.ts 의 publicDir 분기를 켠다. 플래그가 없으면
 *   MS Store 빌드(`npm run build`)와 «완전히 동일»하게 동작한다.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const bin = path.resolve(
  process.cwd(),
  'node_modules/.bin',
  process.platform === 'win32' ? 'ait.cmd' : 'ait',
);
if (!existsSync(bin)) {
  console.error('[ait_build] ait CLI 를 찾지 못했다: ' + bin);
  process.exit(1);
}

console.log('[ait_build] AIT_BUILD=1 (public/ 허용목록 모드) -> ' + bin + ' build');
const r = spawnSync(bin, ['build'], {
  stdio: 'inherit',
  env: { ...process.env, AIT_BUILD: '1' },
  shell: process.platform === 'win32',
});
process.exit(r.status === null ? 1 : r.status);
