'use strict';

/*
 * 速率控制器。
 * 决策规则原样保留自旧单体（AIMD 调 QP、队列水位调码率、保细节等时隙），
 * 但所有外部状态都从显式入参/查询接口拿：
 *   - 已结算帧范围由发送端提供（sender.settledRange）
 *   - 差额归属由预算账本提供（ledger.frameDelta）
 * 控制器自身不再持有发送队列，也不直接记账。
 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class RateController {
  constructor(cfg) {
    this.cfg = {
      strategy: 'fps',            // 'fps' | 'quality'
      quant: true,                // 编码器是否支持 QP 直控
      qpMax: 51,
      qpFixedPct: 0.45,
      avgKbps: 800,
      capBytes: 400 * 1024,
      ...cfg,
    };
    const m = this.cfg.qpMax;
    this.qpMin = Math.round(m * 0.2);
    this.qpStep = Math.max(1, Math.round(m / 30));
    this.qp = Math.round(m * 0.45);
    this.qpFixed = Math.round(m * this.cfg.qpFixedPct);
    this.vbr = this.cfg.avgKbps * 1000;
    this.qTarget = Math.min(this.cfg.capBytes * 0.25, this.cfg.avgKbps * 1000 * 0.5 * 0.3 / 8);
    this.estWindow = [];         // 最近 5 帧实耗 bit
    this.pendingKey = false;
    this.trace = [];
  }

  _estFallback() {
    return this.cfg.avgKbps * 1000 / 30;
  }

  estimateBits() {
    if (!this.estWindow.length) return this._estFallback();
    return this.estWindow.reduce((a, b) => a + b, 0) / this.estWindow.length;
  }

  /*
   * 决策一帧是否提交。
   * ctx: { frame, needKey, budgetBits, queueBytes, chanRateBps, settledIds:Set }
   */
  decide(ctx) {
    const { frame, needKey, budgetBits, queueBytes, chanRateBps } = ctx;
    const horizon = frame.deadline - frame.t;
    const drainAhead = chanRateBps > 0 ? (queueBytes * 8) / chanRateBps : Infinity;
    let submit = true;
    let reason = 'normal';
    let targetBits = null;

    if (this.pendingKey) {
      submit = false; reason = 'key-in-flight';
    } else if (needKey) {
      if (drainAhead > horizon * 0.4) { submit = false; reason = 'await-drain-for-idr'; }
    } else if (this.cfg.strategy === 'quality') {
      const est = this.estimateBits();
      if (est > budgetBits * 0.95) { submit = false; reason = 'quality-wait-slot'; }
    } else if (drainAhead > horizon * 0.9) {
      submit = false; reason = 'fps-hopeless-deadline';
    }

    if (submit && this.cfg.strategy === 'fps') {
      const chan = chanRateBps / 30;
      targetBits = clamp(budgetBits, 4000, Math.max(chan, 4000));
    }
    this.trace.push({
      frameId: frame.id, t: frame.t, submit, reason,
      budgetBits, targetBits, estBits: this.estimateBits(),
      queueBytes, drainAhead, settledCount: ctx.settledIds ? ctx.settledIds.size : 0,
    });
    return { submit, reason, targetBits, qp: this._qpFor(needKey) };
  }

  _qpFor(needKey) {
    let useQp = this.cfg.strategy === 'quality' ? this.qpFixed : this.qp;
    if (needKey && this.cfg.quant) useQp = Math.max(useQp, Math.round(this.cfg.qpMax * 0.7));
    return useQp;
  }

  /*
   * 编码反馈：实耗已知，更新估计窗与控制量。
   * diff 由账本给出（frameDelta），是差额归属的明确接口；
   * 控制规则仍按原实现以“实耗 / 目标”驱动。
   */
  onEncoded(frame, targetBits, diff, setBitrate) {
    const actualBits = frame.bytes * 8;
    this.estWindow.push(actualBits);
    if (this.estWindow.length > 5) this.estWindow.shift();
    if (frame.key) this.pendingKey = true;

    if (this.cfg.strategy !== 'fps') return { qp: null, vbr: null };

    if (this.cfg.quant) {
      const r = actualBits / (targetBits || actualBits);
      const before = this.qp;
      if (r > 1.25) this.qp += 2 * this.qpStep;
      else if (r > 1.05) this.qp += this.qpStep;
      else if (r < 0.5) this.qp -= 2 * this.qpStep;
      else if (r < 0.75) this.qp -= this.qpStep;
      this.qp = clamp(this.qp, this.qpMin, this.cfg.qpMax);
      return { qp: this.qp, qpBefore: before, vbr: null, ratio: r };
    }
    const queueBytes = diff?.queueBytes ?? 0;
    const before = this.vbr;
    if (queueBytes > this.qTarget) this.vbr *= 0.85;
    else if (queueBytes < this.qTarget * 0.5) this.vbr *= 1.06;
    this.vbr = clamp(this.vbr, 80_000, this.cfg.avgKbps * 1200);
    if (setBitrate) setBitrate(this.vbr);
    return { qp: null, vbr: this.vbr, vbrBefore: before };
  }

  keyLanded() { this.pendingKey = false; }

  /* 控制面板：下一帧预算视图 + 仍未结算的在途包。 */
  nextFrameView({ frame, budgetBits, queueBytes, unsettledPackets, chanRateBps }) {
    return {
      frameId: frame.id,
      deadline: frame.deadline,
      budgetBits: Math.max(0, budgetBits),
      estBits: this.estimateBits(),
      qp: this._qpFor(false),
      vbrBits: this.vbr,
      queueBytes,
      unsettledPackets: unsettledPackets.map((p) => ({
        pktId: p.pktId, frameId: p.frameId, state: p.state, rem: p.rem, size: p.size,
      })),
      drainAhead: chanRateBps > 0 ? (queueBytes * 8) / chanRateBps : Infinity,
      pendingKey: this.pendingKey,
    };
  }

  snapshot() {
    return {
      qp: this.qp, vbr: this.vbr, pendingKey: this.pendingKey,
      estWindow: [...this.estWindow], trace: this.trace.map((x) => ({ ...x })),
    };
  }

  restore(snap) {
    this.qp = snap.qp; this.vbr = snap.vbr; this.pendingKey = snap.pendingKey;
    this.estWindow = [...snap.estWindow];
    this.trace = snap.trace.map((x) => ({ ...x }));
  }
}
