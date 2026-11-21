'use strict';

/*
 * 预算账本：把“预算决策”与“编码反馈归属”解耦。
 *
 * mode = 'reserved'  按提交画面预留预算：提交即占账，反馈只做差额校正。
 * mode = 'feedback'  按反馈逐笔校正：提交不占账，包被确认到达才据实计入。
 *
 * 每一笔变化都落 attribution 条目，差额归属有明确接口可审计。
 */

export class BudgetLedger {
  constructor(mode = 'reserved') {
    if (!['reserved', 'feedback'].includes(mode)) throw new Error(`未知记账模式 ${mode}`);
    this.mode = mode;
    this.attribution = [];
    this.reservedByFrame = new Map();   // frameId -> bits（仍占用中）
    this.settledByFrame = new Map();    // frameId -> bytes 已确认
    this.grantedBits = 0;               // 累计授予/预留
    this.chargedBits = 0;               // 累计实际记账
    this.refundedBits = 0;
    this.duplicateFeedback = 0;
    this.sentBitsByFrame = new Map();   // 发送端推送的已发字节（feedback 在途欠账口径）
    this._sentLoggedByPkt = new Map();  // pktId -> 已记账字节，部分+完成合并为整包一次
  }

  /* 发送端每发出一段字节就推送：部分发送与最终完成合并，保证每包只记一次整包。 */
  markBytesSent(frameId, bytes, pktId = null) {
    if (pktId != null) {
      const logged = this._sentLoggedByPkt.get(pktId) ?? 0;
      const delta = Math.max(0, bytes - logged);
      if (delta <= 0) return;
      this._sentLoggedByPkt.set(pktId, logged + delta);
      this.sentBitsByFrame.set(frameId, (this.sentBitsByFrame.get(frameId) ?? 0) + delta * 8);
    } else {
      this.sentBitsByFrame.set(frameId, (this.sentBitsByFrame.get(frameId) ?? 0) + bytes * 8);
    }
  }

  /* 部分发送：传入本时隙新发出的字节，内部按包累计并在完成时补差。 */
  markPartialSent(frameId, pktId, addedBytes) {
    const logged = this._sentLoggedByPkt.get(pktId) ?? 0;
    this.markBytesSent(frameId, logged + addedBytes, pktId);
  }

  inFlightSentBits() {
    let s = 0;
    for (const [id, bits] of this.sentBitsByFrame) {
      if (!this.settledByFrame.has(id)) s += bits;
    }
    return s;
  }

  _push(rec) {
    this.attribution.push({ seq: this.attribution.length, ...rec });
    return rec;
  }

  /* 帧提交时调用。feedback 模式只登记，不占预算。 */
  reserve(frameId, bits, t, reason = 'submit') {
    const b = Math.max(0, bits);
    if (this.mode === 'reserved') {
      this.reservedByFrame.set(frameId, (this.reservedByFrame.get(frameId) ?? 0) + b);
      this.grantedBits += b;
      this._push({ t, frameId, kind: 'reserve', bits: b, reason });
    } else {
      this._push({ t, frameId, kind: 'reserve-seen', bits: b, reason });
    }
    return b;
  }

  /* 整帧被确认（全部包到达）：据实校正。幂等，重复反馈只记一次。 */
  settleFrame(frame, t, reason = 'feedback') {
    if (frame.settled) {
      this.duplicateFeedback++;
      return this._push({ t, frameId: frame.id, kind: 'dup-feedback', bits: 0, reason });
    }
    frame.settled = true;
    frame.settledBytes = frame.bytes;
    const actualBits = frame.bytes * 8;
    const prior = this.reservedByFrame.get(frameId(frame)) ?? 0;
    let rec;
    if (this.mode === 'reserved') {
      this.reservedByFrame.delete(frameId(frame));
      const delta = actualBits - prior;            // 正=超支，负=退回
      this.chargedBits += actualBits;
      rec = this._push({
        t, frameId: frame.id, kind: 'settle', bits: actualBits,
        reservedBits: prior, deltaBits: delta, reason,
      });
    } else {
      this.chargedBits += actualBits;
      this.settledByFrame.set(frame.id, frame.bytes);
      rec = this._push({ t, frameId: frame.id, kind: 'charge', bits: actualBits, reason });
    }
    return rec;
  }

  /* 帧被丢弃：退回其仍占用的预留预算。 */
  refund(frameId, t, bits, reason = 'discard') {
    const b = Math.max(0, bits);
    const cur = this.reservedByFrame.get(frameId) ?? 0;
    const applied = Math.min(cur, b);
    if (applied <= 0) {
      this._push({ t, frameId, kind: 'refund-denied', bits: 0, reason });
      return 0;
    }
    const left = cur - applied;
    if (left > 0) this.reservedByFrame.set(frameId, left);
    else this.reservedByFrame.delete(frameId);
    this.grantedBits -= applied;
    this.refundedBits += applied;
    this._push({ t, frameId, kind: 'refund', bits: applied, reason });
    return applied;
  }

  /* 当前仍被未结算帧占用的预算（bit）。 */
  earmarkedBits() {
    let s = 0;
    for (const v of this.reservedByFrame.values()) s += v;
    return s;
  }

  /*
   * 实际欠账（bit）：已经真实发生、但尚未被“预留额度或已到反馈”覆盖的部分。
   * reserved 模式：未结算帧占用其预留；结算帧的超支差额才是欠账。
   * feedback 模式：没有预留，反馈逐笔销账；欠账=尚未反馈的在途实耗。
   * 两种模式在全部反馈完成后欠账都归零，过程中数值不同。
   */
  debtBits() {
    return Math.max(0, this.chargedBits - this._coveredBits());
  }

  _coveredBits() {
    if (this.mode === 'feedback') {
      // 已结算（已反馈）的字节被逐笔确认覆盖；已发未反馈部分仍欠账
      let settled = 0;
      for (const bytes of this.settledByFrame.values()) settled += bytes * 8;
      return settled;
    }
    return Math.max(0, this.grantedBits - this.earmarkedBits());
  }

  /*
   * feedback 模式的“当下欠账”还包含已发未反馈的在途字节；
   * reserved 模式在途帧有预留覆盖，欠账只来自超支差额。
   */
  outstandingDebtBits() {
    if (this.mode === 'feedback') return this.inFlightSentBits();
    return this.debtBits();
  }

  frameDelta(frameId) {
    let reserved = 0, charged = 0;
    for (const a of this.attribution) {
      if (a.frameId !== frameId) continue;
      if (a.kind === 'reserve') reserved += a.bits;
      if (a.kind === 'refund') reserved -= a.bits;
      if (a.kind === 'settle') charged += a.bits;
      if (a.kind === 'charge') charged += a.bits;
    }
    return { reserved, charged, delta: charged - reserved };
  }

  checkInvariant() {
    let ear = 0;
    for (const v of this.reservedByFrame.values()) ear += v;
    if (Math.abs(ear - this.earmarkedBits()) > 1e-9) throw new Error('预留占用记账不一致');
    if (this.attribution.some((a) => a.frameId == null)) throw new Error('归属条目缺少帧 id');
    return true;
  }

  snapshot() {
    return {
      mode: this.mode,
      attribution: this.attribution.map((a) => ({ ...a })),
      reservedByFrame: [...this.reservedByFrame.entries()],
      settledByFrame: [...this.settledByFrame.entries()],
      grantedBits: this.grantedBits,
      chargedBits: this.chargedBits,
      refundedBits: this.refundedBits,
      duplicateFeedback: this.duplicateFeedback,
      sentBitsByFrame: [...this.sentBitsByFrame.entries()],
    };
  }

  restore(snap) {
    this.mode = snap.mode;
    this.attribution = snap.attribution.map((a) => ({ ...a }));
    this.reservedByFrame = new Map(snap.reservedByFrame);
    this.settledByFrame = new Map(snap.settledByFrame);
    this.grantedBits = snap.grantedBits;
    this.chargedBits = snap.chargedBits;
    this.refundedBits = snap.refundedBits;
    this.duplicateFeedback = snap.duplicateFeedback;
    this.sentBitsByFrame = new Map(snap.sentBitsByFrame ?? []);
  }
}

function frameId(f) {
  return f.id;
}
