/**
 * 재현 가능한 PRNG — 서버 `build/server/src/rng.ts` 이식본(동일 알고리즘).
 *
 * mulberry32 + Marsaglia polar(Box-Muller polar form).
 * 구 mockWorld.ts:56-62 는 극좌표가 아닌 단순 Box-Muller(cos 형)였고 spare 를
 * 버려 난수 소비량이 달랐다. 봇 210개의 행동 분포를 서버와 같은 통계로 맞추려면
 * 난수 생성기까지 같아야 하므로 서버 쪽으로 통일한다.
 */
export class Rng {
  private s: number;
  private spare: number | null = null;

  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0;
  }

  /** uniform [0,1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** N(0,1) — Box-Muller (polar) */
  gauss(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u: number;
    let v: number;
    let s: number;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    return u * mul;
  }

  /** [min, max) 실수 */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** [0, n) 정수 */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  bool(p: number): boolean {
    return this.next() < p;
  }
}
