'use strict';

/* 带宽剖面：分段常数 kbps 序列，提供积分（可交付 kbit）查询。 */

export class BandwidthProfile {
  constructor({ cells = null, cell = 0.01, duration = 8, fallbackKbps = 800 } = {}) {
    this.cell = cell;
    this.duration = duration;
    this.cells = cells ?? new Float32Array(Math.round(duration / cell));
    this.fallbackKbps = fallbackKbps;
  }

  clone() {
    return new BandwidthProfile({
      cells: new Float32Array(this.cells), cell: this.cell,
      duration: this.duration, fallbackKbps: this.fallbackKbps,
    });
  }

  set(t, kbps) {
    const idx = Math.floor(t / this.cell + 1e-9);
    if (idx >= 0 && idx < this.cells.length) this.cells[idx] = kbps;
  }

  rateAt(t) {
    const idx = Math.floor(t / this.cell + 1e-9);
    if (idx < 0) return this.cells[0];
    if (idx >= this.cells.length) return this.fallbackKbps;
    return this.cells[idx];
  }

  /* [t0,t1) 可交付 kbit。 */
  integralKbit(t0, t1) {
    let s = 0;
    let t = t0;
    while (t < t1 - 1e-9) {
      const nt = Math.min(t1, (Math.floor(t / this.cell + 1e-9) + 1) * this.cell);
      if (nt <= t) break;
      s += this.rateAt(t) * (nt - t);
      t = nt;
    }
    return s;
  }

  /* 两段带宽变化：以秒为单位的 (时刻, kbps) 序列。 */
  applySteps(steps) {
    for (const [t, kbps] of steps) this.set(t, kbps);
  }
}
