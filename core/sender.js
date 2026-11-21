'use strict';

/*
 * 发送端：可丢弃队列 + 发送缓冲记账。
 * 只负责“字节在队列里处于什么状态、何时真正发出去”，
 * 不做预算决策，也不决定帧能否丢弃（那是引用分析的职责）。
 */

export class DiscardableQueue {
  constructor() {
    this.q = [];                         // 严格 FIFO 的包队列
    this.sentPackets = [];               // 已离队（发出）的包，保留历史供恢复与轨迹核验
    this.bytesQueued = 0;                // 未开始发送（可丢弃）
    this.bytesStarted = 0;               // 已开始未发完（不可丢弃）
    this.totalEnqueued = 0;
    this.totalSent = 0;
    this.totalDiscarded = 0;
    this.onPacketSent = null;            // (pkt, t) => void，由会话登记到达事件
    this.onPartialSent = null;
  }

  enqueue(packets) {
    for (const p of packets) {
      if (p.state !== 'queued') throw new Error(`包 ${p.pktId} 不在可入队状态`);
      this.q.push(p);
      this.bytesQueued += p.size;
      this.totalEnqueued += p.size;
    }
  }

  /* 在 [t, t+dt) 内以 rateBps 排空队首；返回实际发出的字节数。 */
  advance(t, dt, rateBps, lat) {
    let sent = 0;
    let now = t;
    const end = t + dt;
    while (this.q.length && now < end - 1e-12) {
      if (rateBps <= 0) break;
      const pkt = this.q[0];
      if (!pkt.started) {
        pkt.started = true;
        this.bytesQueued -= pkt.rem;
        this.bytesStarted += pkt.rem;
      }
      const needS = (pkt.rem * 8) / rateBps;
      const remain = end - now;
      if (needS <= remain + 1e-12) {
        now += needS;
        sent += pkt.rem;
        this.bytesStarted -= pkt.rem;
        pkt.rem = 0;
        pkt.state = 'sent';
        pkt.sentT = now;
        pkt.arriveT = now + lat;
        this.q.shift();
        this.sentPackets.push(pkt);
        this.totalSent += pkt.size;
        if (this.onPacketSent) this.onPacketSent(pkt, now);
      } else {
        const bits = rateBps * remain;
        const b = bits / 8;
        pkt.rem -= b;
        this.bytesStarted -= b;
        sent += b;
        now = end;
        pkt.state = 'partial';
        if (this.onPartialSent) this.onPartialSent(pkt, b, now);
        break;
      }
    }
    return sent;
  }
  /* 某帧仍有在队未启动的包。 */
  hasUnsent(frameId) {
    return this.q.some((p) => p.frameId === frameId && !p.started);
  }

  pendingFrameIds() {
    return [...new Set(this.q.map((p) => p.frameId))];
  }

  /* 已结算帧范围：所有包均已发出（sent）的帧 id，按完成先后给出最小集合视图。 */
  settledFrameIds(frames) {
    const done = new Set();
    for (const f of frames) {
      if (f.packets.length && f.packets.every((p) => p.state === 'sent')) done.add(f.id);
    }
    return done;
  }

  /*
   * 丢弃一帧的未启动包。已开始/已发出的包不可撤。
   * 返回 { freedBytes, packets }；没有可丢弃内容时 freedBytes=0。
   */
  discardFrame(frameId) {
    const drop = [];
    let freed = 0;
    this.q = this.q.filter((p) => {
      if (p.frameId === frameId && !p.started) {
        drop.push(p);
        freed += p.rem;
        p.state = 'discarded';
        return false;
      }
      return true;
    });
    this.bytesQueued -= freed;
    this.totalDiscarded += freed;
    return { freedBytes: freed, packets: drop };
  }

  inFlightBytes() {
    return this.bytesQueued + this.bytesStarted;
  }

  checkInvariant() {
    let bq = 0, bs = 0;
    for (const p of this.q) {
      if (p.started) bs += p.rem;
      else bq += p.rem;
    }
    if (Math.abs(bq - this.bytesQueued) > 1e-9) throw new Error('queued 记账不一致');
    if (Math.abs(bs - this.bytesStarted) > 1e-9) throw new Error('started 记账不一致');
    return true;
  }

  snapshot() {
    return {
      q: this.q.map((p) => ({ ...p })),
      sentPackets: this.sentPackets.map((p) => ({ ...p })),
      bytesQueued: this.bytesQueued,
      bytesStarted: this.bytesStarted,
      totalEnqueued: this.totalEnqueued,
      totalSent: this.totalSent,
      totalDiscarded: this.totalDiscarded,
    };
  }

  restore(snap) {
    this.q = snap.q.map((p) => ({ ...p }));
    this.sentPackets = (snap.sentPackets ?? []).map((p) => ({ ...p }));
    this.bytesQueued = snap.bytesQueued;
    this.bytesStarted = snap.bytesStarted;
    this.totalEnqueued = snap.totalEnqueued;
    this.totalSent = snap.totalSent;
    this.totalDiscarded = snap.totalDiscarded;
  }
}

export class Sender {
  constructor({ latency = 0.04 } = {}) {
    this.latency = latency;
    this.queue = new DiscardableQueue();
  }

  submit(frame, packets, t) {
    for (const p of packets) p.enqueueT = t;
    this.queue.enqueue(packets);
    frame.fragments = packets.length;
  }

  advance(t, dt, rateBps) {
    return this.queue.advance(t, dt, rateBps, this.latency);
  }

  /* 控制器查询接口：已结算帧范围（交给发送端维护的语义）。 */
  settledRange(frames) {
    return this.queue.settledFrameIds(frames);
  }

  snapshot() {
    return { latency: this.latency, queue: this.queue.snapshot() };
  }

  restore(snap) {
    this.latency = snap.latency;
    this.queue.restore(snap.queue);
  }
}
