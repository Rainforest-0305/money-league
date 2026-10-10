#!/usr/bin/env bash
# moneyleague.ait 가 «덮이는지» 감시한다. 바뀌면 즉시 종료(=CTO 에게 통지).
# ⛔재빌드로 대응하지 «마라» — 상급에 올린다(규율 AJ, 2026-08-23 충돌 실사고).
#
# ⚠️★이 감시의 «한계» — 못 잡는 것을 도구 자신이 말한다(2026-08-23 기록, 기능 보강은 동결 해제 후)
#   ① 이 감시는 ★moneyleague.ait «하나»만 본다. 다른 .ait 는 «전혀» 보지 않는다.
#      ⇒ _uploaded_*.ait 가 «지워져도 못 잡는다». 그러면 「업로드된 판과 바이트 동일한 물건」이
#        손에서 사라지는데 여기서는 조용하다.
#   ② 아래 사고 시 참고 출력은 `_prev_moneyleague_*.ait` 만 훑는다.
#      ⇒ ★_uploaded_* 는 그 목록에도 «안 들어간다». 덮이는 사고가 나도
#        「_uploaded_ 는 무사한가」를 이 출력만 보고는 알 수 없다.
#   ⛔「감시가 조용하다」를 「전부 무사하다」로 읽지 마라. 이 도구가 보는 건 «한 파일»이다.
#   ★실증: 2026-08-23 사본 하나가 «말없이 사라졌다»(사후에 Partner 정리였음이 확인됐다).
#     같은 일이 _uploaded_ 에 나면 ★「업로드된 판과 바이트 동일한 물건」이 손에서 사라진다.
#   ⇒ ★담당: CTO(venture-cto) · ★시점: «동결 해제 시» — 감시 대상에 _uploaded_* 추가(두 줄).
#     (규율 Y: 「범위 밖」을 적을 때는 ★담당과 시점을 «같이» 적는다. 안 적으면 그건 부채다)
cd "$(dirname "$0")/.." || exit 9
F=moneyleague.ait
BASE="$(md5sum "$F" | cut -d' ' -f1)"
echo "[watch] 기준 md5 $BASE ($(date +%H:%M:%S))"
END=$(( $(date +%s) + 10800 ))   # 최대 3시간
while [ "$(date +%s)" -lt "$END" ]; do
  sleep 30
  if [ ! -f "$F" ]; then
    echo "[watch] ☠️파일이 «사라졌다» $(date +%H:%M:%S)"; exit 2
  fi
  NOW="$(md5sum "$F" | cut -d' ' -f1)"
  if [ "$NOW" != "$BASE" ]; then
    echo "[watch] ☠️★덮였다 $(date +%H:%M:%S)"
    echo "[watch]   기준 $BASE"
    echo "[watch]   현재 $NOW  ($(stat -c%s "$F") bytes)"
    for p in _prev_moneyleague_*.ait; do
      echo "[watch]   사본 $(md5sum "$p" | cut -d' ' -f1)  $p"
    done
    exit 1
  fi
done
echo "[watch] 3시간 동안 변경 없음 — 감시 종료 $(date +%H:%M:%S)"
