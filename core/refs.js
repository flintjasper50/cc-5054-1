'use strict';

/*
 * 引用分析：回答“这帧现在能不能丢”。
 * 预算下调时发送端想跳过某帧；若仍有存活后继引用它，拒绝丢弃，
 * 其已预留预算必须退回（由会话调用 refundBudget 完成记账）。
 */

export class ReferenceAnalyzer {
  constructor(frames) {
    this.frames = frames;
    this.alive = new Set(frames.map((f) => f.id));
    this.reason = null;
  }

  _get(id) {
    return this.frames.find((f) => f.id === id);
  }

  /* 直接或间接引用 frameId 的存活帧。 */
  liveDescendants(frameId) {
    const out = [];
    const walk = (id) => {
      for (const f of this.frames) {
        if (!this.alive.has(f.id)) continue;
        if (f.refs.includes(id)) {
          if (!out.includes(f.id)) {
            out.push(f.id);
            walk(f.id);
          }
        }
      }
    };
    walk(frameId);
    return out;
  }

  /* 关键帧没有前驱引用，任何时刻可丢。 */
  canDiscard(frameId) {
    const f = this._get(frameId);
    if (!f) return { ok: false, reason: 'unknown-frame' };
    if (!this.alive.has(frameId)) return { ok: false, reason: 'already-gone' };
    if (f.key) return { ok: true, reason: 'key-frame', descendants: [] };
    const desc = this.liveDescendants(frameId);
    if (desc.length) {
      this.reason = `frame ${frameId} 被存活后继 ${desc.join(',')} 引用`;
      return { ok: false, reason: 'referenced', descendants: desc };
    }
    return { ok: true, reason: 'no-live-reference', descendants: [] };
  }

  /*
   * 尝试丢弃：引用分析放行才真正从发送队列移除。
   * sender: Sender；ledger: BudgetLedger；t: 时刻。
   * 返回完整处置记录，供 UI 与核验使用。
   */
  tryDiscard(frameId, sender, ledger, t) {
    const f = this._get(frameId);
    const verdict = this.canDiscard(frameId);
    if (!verdict.ok) {
      return { frameId, t, action: 'reject', reason: verdict.reason, descendants: verdict.descendants ?? [], freedBytes: 0 };
    }
    const { freedBytes, packets } = sender.queue.discardFrame(frameId);
    this.alive.delete(frameId);
    f.status = 'discarded';
    f.discarded = true;
    let refundedBits = 0;
    if (ledger && f.reservedBits > 0) {
      refundedBits = ledger.refund(frameId, t, f.reservedBits, `discard:${verdict.reason}`);
      f.refundedBytes = refundedBits / 8;
    }
    return {
      frameId, t, action: 'discard', reason: verdict.reason,
      freedBytes, packets: packets.map((p) => p.pktId), refundedBits,
    };
  }

  /* 收端确认某帧不可解码（断链/过期）：它及其引用子树对后续不再有效。 */
  markDead(frameId) {
    const dead = [frameId, ...this.liveDescendants(frameId)];
    for (const id of dead) this.alive.delete(id);
    return dead;
  }
}
