# -*- coding: utf-8 -*-
"""
-10 검수 상신 페이로드 «생성기» — 손 타이핑 단계를 «없앤다».

왜 이게 필요한가
────────────────────────────────────────────────────────────────────────────
[핸드북 실측] -9 에서 출시노트 오타 5건이 «검수 제출본에 그대로» 나갔다:
    고쳤→고쳬 · 없앱→없앨 · 바뀐→바뀜 · 대푯값→대푸값 · 캘린더→캠린더
원인은 «사람이 \\uXXXX 를 손으로 만든 것». 눈으로 검수해도 안 걸러진다.
그리고 ★REVIEWING 상태에서는 `bundle_set_release_note` 가 «거부»된다
(수정 가능 상태는 CREATED / REJECTED 뿐) ⇒ **제출하면 못 고친다.**

⇒ 그래서 이 스크립트는 문안을 «UTF-8 평문 파일»에서 읽어
  `json.dumps(ensure_ascii=True)` 로 «기계가» 이스케이프한다. 사람은 한글만 쓴다.

★규율 M(문법 아니라 «동작»으로 검증) 적용:
  이스케이프한 결과를 «다시 디코드»해서 원문과 «글자 단위로 동일»한지 확인한다.
  「입력 ≠ 출력」이면 죽는다. 이게 오타 사고의 유일한 구조적 방어다.

사용법
────────────────────────────────────────────────────────────────────────────
    python scripts/make_release_payload.py
    python scripts/make_release_payload.py --out payload.json

⛔이 스크립트는 «제출하지 않는다». 페이로드를 만들 뿐이다. 제출은 Partner 게이트다.
"""
import argparse
import json
import re
import sys
from pathlib import Path

for _st in (sys.stdout, sys.stderr):
    try:
        _st.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
NOTES = ROOT / 'scripts' / 'release_notes_v10.txt'

RELEASE_NOTES_MAX = 1000          # [핸드북 실측] 상한
PASS = FAIL = 0


def check(label, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  OK   ' + label + (('  ' + detail) if detail else ''))
    else:
        FAIL += 1
        print('  ★FAIL ' + label + (('  ' + detail) if detail else ''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    ap.add_argument('--notes')   # 대조 전용
    args = ap.parse_args()

    global NOTES
    if args.notes:
        NOTES = Path(args.notes)
    if not NOTES.exists():
        print('★출시노트 원문이 없다: ' + str(NOTES))
        return 2

    raw = NOTES.read_text(encoding='utf-8')
    # ⛔주석 줄(#)은 문안이 아니다 — 사람이 메모를 남길 수 있게 하되 제출본에선 뺀다.
    body = '\n'.join(l for l in raw.splitlines() if not l.lstrip().startswith('#'))
    text = body.strip()

    print('-10 검수 상신 페이로드 생성')
    print('  원문: ' + NOTES.name + '\n')

    # ── 1. 사람이 손으로 이스케이프하지 «않았는지» ──────────────────────
    hand = re.findall(r'\\u[0-9a-fA-F]{4}', raw)
    check('원문에 손 이스케이프(\\uXXXX)가 «없다»', not hand,
          '0건' if not hand else ('★%d건 %s — 한글로 그냥 써라' % (len(hand), hand[:3])))

    # ── 2. 길이 ────────────────────────────────────────────────────────
    check('출시노트 %d자 이내' % RELEASE_NOTES_MAX, len(text) <= RELEASE_NOTES_MAX,
          '%d자 (여유 %d)' % (len(text), RELEASE_NOTES_MAX - len(text)))
    check('출시노트가 비어 있지 않다', len(text) > 0, '%d자' % len(text))

    # ── 3. ★기계 이스케이프 + «되돌려» 대조 (규율 M) ────────────────────
    escaped = json.dumps(text, ensure_ascii=True)
    back = json.loads(escaped)
    same = (back == text)
    check('★이스케이프 → 디코드 «왕복»이 원문과 «글자 단위로» 같다', same,
          '동일' if same else '★원문 변형 — ⛔절대 제출하지 마라')
    if not same:
        for i, (a, b) in enumerate(zip(text, back)):
            if a != b:
                print('       첫 불일치 %d: 원문 %r vs 복원 %r' % (i, a, b))
                break

    # ── 4. ★featureList 는 «싣지 않는다» ───────────────────────────────
    #    이유가 «둘»이다. 어느 하나만으로도 충분하다:
    #      ⓐ [핸드북 실측] 게임은 원천 거부 — 「게임은 앱 내 기능 등록을 할 수 없어요」
    #         머니 리그는 gameInfo.gameRating 이 등록된 «게임»이다.
    #      ⓑ [추정 n=2] 주요기능을 실으면 검수가 느려진다(해오름 2h10m vs 8일)
    #    ⇒ ⓐ 가 있으므로 이건 «취향»이 아니라 «구조적 필수»다.
    payload = {'releaseNotes': text}
    check('★featureList 를 페이로드에 «넣지 않았다»', 'featureList' not in payload,
          '생략 (게임=원천 거부 · 빈 배열도 ⛔)')

    # ── 5. 흔한 사고 문자 ──────────────────────────────────────────────
    if '\t' in text:
        check('탭 문자 없음', False, '★탭이 들어 있다')
    else:
        check('탭 문자 없음', True)

    print()
    print('  ── 제출자가 «그대로 복사»할 값 ' + '─' * 30)
    print('  releaseNotes =')
    print('  ' + escaped)
    print('  ' + '─' * 58)

    if args.out:
        Path(args.out).write_text(json.dumps(payload, ensure_ascii=True, indent=2),
                                  encoding='utf-8')
        print('  기록: ' + args.out)

    print('\n결과: PASS %d · FAIL %d' % (PASS, FAIL))
    if FAIL:
        print('⛔FAIL 이 있으면 제출하지 마라. 제출 후에는 REVIEWING 이라 «못 고친다».')
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
