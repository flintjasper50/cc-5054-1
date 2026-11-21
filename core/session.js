'use strict';

/*
 * 会话编排：离散事件循环。
 * 预算决策（controller）、编码反馈归属（ledger）、发送缓冲记账（sender）
 * 三者只通过显式接口交互，本文件负责把事件按时钟喂给它们。
 */

import { makeFrame } from './model.js';
import { Sender } from './sender.js';
import { BudgetLedger } from './ledger.js';
import { ReferenceAnalyzer } from './refs.js';
import { Receiver } from './encoder.js';

export class Session {
  constructor(opts = {}) {
    this.profile = opts.profile;
    this.latency = opts.latency ?? 0.04;
    this.fps = opts.fps ?? 30;
    this.mtu = opts.mtu ?? 1200;
    this.capBytes = opts.capBytes ?? 400 * 1024;
    this.ledgerMode = opts.ledgerMode ?? 'reserved';
    this.callbackOrder = opts.callbackOrder ?? 'arrive-first'; // arrive-first | feedback-first
    this.encoder = opts.encoder;                               // SyntheticEncoder
    this.controller = opts.controller;
    this.trace = opts.trace ?? null;

    this.sender = new Sender({ latency: this.latency });
    this.ledger = new BudgetLedger(this.ledgerMode);
    this.frames = [];
    this.analyzer = new ReferenceAnalyzer(this.frames);
    this.receiver = null;
    this.clock = 0;
    this.eventQueue = [];                    // {t, kind, payload}
    this.queueSamples = [];
    this.discardLog = [];
    this.overflowLog = [];
    this.feedbackLog = [];
    this.submittedIds = new Set();
    this.chainOk = true;
    this._hookSender();
  }

  _hookSender() {
    this.sender.queue.onPacketSent = (pkt, t) => {
      this.ledger.markBytesSent(pkt.frameId, pkt.size, pkt.pktId);
      this._rec({ t, kind: 'packet-sent', pktId: pkt.pktId, frameId: pkt.frameId, size: pkt.size, arriveT: pkt.arriveT });
      this.eventQueue.push({ t: pkt.arriveT, kind: 'arrive', payload: pkt });
    };
    this.sender.queue.onPartialSent = (pkt, bytes, t) => {
      this.ledger.markPartialSent(pkt.frameId, pkt.pktId, bytes);
      this._rec({ t, kind: 'partial-sent', pktId: pkt.pktId, frameId: pkt.frameId, bytes });
    };
  }

  _rec(ev) {
    if (this.trace) {
      this.trace.rec(ev);
      if (ev.pktId != null) {
        const p = this.sender.queue.q.find((x) => x.pktId === ev.pktId)
          ?? this._allPackets().find((x) => x.pktId === ev.pktId);
        if (p) this.trace.recordPacket(p);
      }
      if (ev.frameId != null) {
        const f = this.frames.find((x) => x.id === ev.frameId);
        if (f) this.trace.recordFrame(f);
      }
    }
  }

  _allPackets() {
    return this.frames.flatMap((f) => f.packets);
  }

  addFrame(spec) {
    const f = makeFrame(spec);
    this.frames.push(f);
    this.analyzer.alive.add(f.id);
    return f;
  }

  setFramePlan(plan) {
    for (const spec of plan) this.addFrame(spec);
    this.receiver = new Receiver(this.frames, { latency: this.latency });
  }

  _drainNetwork(t) {
    let guard = 0;
    while (this.clock < t - 1e-12 && guard++ < 1e5) {
      const dt = Math.min(0.01, t - this.clock);
      const rate = this.profile.rateAt(this.clock) * 1000;
      this.sender.advance(this.clock, dt, rate);
      this.clock += dt;
    }
    if (this.clock < t - 1e-9) this.clock = t;
    this.sender.queue.checkInvariant();
  }

  _processEvents(t) {
    this.eventQueue.sort((a, b) => a.t - b.t);
    while (this.eventQueue.length && this.eventQueue[0].t <= t + 1e-12) {
      const ev = this.eventQueue.shift();
      if (ev.kind === 'arrive') this._onArrive(ev.payload, ev.t);
    }
  }

  _onArrive(pkt, t) {
    const frame = this.frames.find((f) => f.id === pkt.frameId);
    if (!frame) return;
    const decoded = this.receiver.onPacket(pkt, t);
    for (const complete of decoded) {
      const cf = complete.frame;
      const doFeedback = () => this._deliverFeedback(cf, t);
      const doChain = () => {
        if (complete.ok) {
          if (cf.key) { this.chainOk = true; this.controller?.keyLanded(); }
          this.analyzer.alive.add(cf.id);
        } else {
          this.chainOk = false;
          this.analyzer.markDead(cf.id);
        }
      };
      // 交换回调次序：反馈记账与引用链处理谁先谁后，最终账必须一致。
      if (this.callbackOrder === 'feedback-first') { doFeedback(); doChain(); }
      else { doChain(); doFeedback(); }
    }
  }

  _deliverFeedback(frame, t, reason = 'feedback') {
    const before = this.ledger.chargedBits;
    const rec = this.ledger.settleFrame(frame, t, reason);
    this.feedbackLog.push({
      frameId: frame.id, t, reason, dup: rec.kind === 'dup-feedback',
      chargedDelta: this.ledger.chargedBits - before,
    });
    this._rec({ t, frameId: frame.id, kind: rec.kind, bits: rec.bits ?? 0, reason });
    return rec;
  }

  /* 重复一次反馈：账本幂等，不得二次扣账。 */
  duplicateFeedback(frameId, t) {
    const frame = this.frames.find((f) => f.id === frameId);
    if (!frame) return null;
    return this._deliverFeedback(frame, t, 'duplicate-feedback');
  }

  /* 编码并提交一帧（含预算预留、容量校验、入队）。 */
  submitFrame(frame, { qp = null, targetBits = null, budgetBits = 0 } = {}) {
    if (this.submittedIds.has(frame.id)) return null;
    this.submittedIds.add(frame.id);
    const jobs = this.encoder.encode({
      id: frame.id, t: frame.t, deadline: frame.deadline,
      refs: frame.refs, key: frame.key, qp,
    }, frame.t);
    return jobs.map((job) => this._ingestJob(job, { qp, targetBits }));
  }

  _ingestJob(job, { qp = null, targetBits = null } = {}) {
    const f = this.frames.find((x) => x.id === job.frame.id);
    Object.assign(f, { bytes: job.frame.bytes, packets: job.packets, fragments: job.packets.length, qp });
    f.estBits = f.bytes * 8;
    this._rec({ t: f.t, frameId: f.id, kind: 'encoded', bits: f.bytes * 8, packets: f.packets.length });

    const reserveBits = targetBits ?? f.bytes * 8;
    this.ledger.reserve(f.id, reserveBits, f.t, 'submit');
    // 预留位以账本实际占用为准（feedback 模式提交不占账，丢弃时无款可退）
    f.reservedBits = this.ledger.mode === 'reserved' ? reserveBits : 0;
    this._rec({ t: f.t, frameId: f.id, kind: 'reserve', bits: reserveBits });

    if (this.sender.queue.inFlightBytes() + f.bytes > this.capBytes) {
      this.overflowLog.push({ t: f.t, frame: f.id, bytes: f.bytes, queueBytes: this.sender.queue.inFlightBytes() });
      f.status = 'overflow';
      this.chainOk = false;
      this.analyzer.markDead(f.id);
      return { frame: f, queued: false };
    }
    this.sender.submit(f, job.packets, f.t);
    f.status = 'queued';
    return { frame: f, queued: true };
  }

  /* 预算下调时尝试跳过一帧：引用分析可拒绝并保留（退回其预算由丢弃路径处理）。 */
  requestDiscard(frameId, reason = 'budget-cut') {
    const f = this.frames.find((x) => x.id === frameId);
    if (!f) return null;
    const rec = this.analyzer.tryDiscard(frameId, this.sender, this.ledger, this.clock, reason);
    rec.requestReason = reason;
    this.discardLog.push(rec);
    this._rec({ t: this.clock, frameId, kind: rec.action === 'discard' ? 'discard' : 'discard-reject', reason: rec.reason });
    return rec;
  }

  /* 单帧决策（保留旧控制规则），返回控制器结论。 */
  decideFrame(frame) {
    if (!this.controller) return { submit: true, targetBits: frame.bytes * 8, qp: null };
    const budgetBits = Math.max(
      0,
      this.profile.integralKbit(frame.t, frame.deadline) * 1000 - this.sender.queue.inFlightBytes() * 8,
    );
    const settledIds = this.sender.settledRange(this.frames);
    return this.controller.decide({
      frame,
      needKey: !this.chainOk || frame.key,
      budgetBits,
      queueBytes: this.sender.queue.inFlightBytes(),
      chanRateBps: this.profile.rateAt(frame.t) * 1000,
      settledIds,
    });
  }

  /* 推进到某帧的采集时刻并按控制器规则处理。 */
  stepTo(frame) {
    this._drainNetwork(frame.t);
    this._processEvents(frame.t);
    this.queueSamples.push({ t: frame.t, bytes: this.sender.queue.inFlightBytes() });
    this._rec({ t: frame.t, kind: 'queue-sample', bytes: this.sender.queue.inFlightBytes() });

    const decision = this.decideFrame(frame);
    this._rec({
      t: frame.t, frameId: frame.id, kind: 'decide',
      submit: decision.submit, reason: decision.reason,
      estBits: this.controller ? this.controller.estimateBits() : frame.bytes * 8,
      budgetBits: decision.targetBits,
    });
    if (!decision.submit) {
      frame.status = 'skipped';
      return { frame, skipped: true, reason: decision.reason };
    }
    const r = this.submitFrame(frame, { qp: decision.qp, targetBits: decision.targetBits, budgetBits: decision.budgetBits });

    if (this.controller && r) {
      for (const part of r) {
        if (!part.queued) continue;
        const diff = this.ledger.frameDelta(part.frame.id);
        diff.queueBytes = this.sender.queue.inFlightBytes();
        this.controller.onEncoded(part.frame, decision.targetBits, diff, null);
      }
    }
    return { frame, skipped: false, decision, result: r };
  }

  /* 采集结束：先排空编码器手中的重排帧，再排空在途包并处理全部到达/反馈。 */
  finish(tail = 5) {
    const lastT = Math.max(...this.frames.map((f) => f.t), 0);
    if (this.encoder && this.encoder.buffered.length) {
      for (const job of this.encoder.flush()) {
        this.submittedIds.add(job.frame.id);
        this._ingestJob(job, { targetBits: job.frame.bytes * 8 });
      }
    }
    // 分段排空：发送产生到达事件，处理事件可能触发反馈，循环到队列与事件都清空
    let guard = 0;
    while ((this.sender.queue.q.length || this.eventQueue.length) && guard++ < 1000) {
      this._drainNetwork(this.clock + 0.5);
      this._processEvents(this.clock);
    }
    this.clock = Math.max(this.clock, lastT + tail);
    this.queueSamples.push({ t: this.clock, bytes: this.sender.queue.inFlightBytes() });
    this.ledger.checkInvariant();
    return this.report();
  }

  run(tail = 5) {
    for (const f of [...this.frames].sort((a, b) => a.t - b.t)) {
      if (this.submittedIds.has(f.id) || f.status === 'discarded') continue;
      this.stepTo(f);
    }
    return this.finish(tail);
  }

  /* 从两种状态恢复：drained（队列已空）与 backlog（旧帧仍在途）。 */
  pauseState() {
    return {
      clock: this.clock,
      chainOk: this.chainOk,
      sender: this.sender.snapshot(),
      ledger: this.ledger.snapshot(),
      controller: this.controller ? this.controller.snapshot() : null,
      eventQueue: this.eventQueue.map((e) => ({
        t: e.t, kind: e.kind, pktId: e.payload.pktId,
        frameId: e.payload.frameId, seq: e.payload.seq,
      })),
      queueBytes: this.sender.queue.inFlightBytes(),
      unsettled: this._unsettledPackets(),
    };
  }

  /* 恢复发送：重建发送端、账本、控制器与尚未触发的到达事件，账目不丢历史。 */
  restoreState(snap) {
    this.sender.restore(snap.sender);
    this._hookSender();   // restore 会清空队列回调，恢复后必须重新挂钩
    this.ledger.restore(snap.ledger);
    if (this.controller && snap.controller) this.controller.restore(snap.controller);
    this.clock = snap.clock;
    this.chainOk = snap.chainOk;
    // 恢复出的包按“帧 id + 帧内 seq”回写（不同会话的全局 pktId 不保证一致）
    const indexKey = (p) => `${p.frameId}:${p.seq}`;
    const liveByKey = new Map();
    for (const p of [...this.sender.queue.q, ...this.sender.queue.sentPackets]) {
      liveByKey.set(indexKey(p), p);
    }
    for (const f of this.frames) {
      f.packets = f.packets.map((p) => liveByKey.get(indexKey(p)) ?? p);
    }
    const allByKey = new Map(this._allPackets().map((p) => [indexKey(p), p]));
    this.eventQueue = (snap.eventQueue ?? [])
      .map((e) => {
        const payload = allByKey.get(`${e.frameId}:${e.seq}`);
        return payload ? { t: e.t, kind: e.kind, payload } : null;
      })
      .filter(Boolean);
  }

  _unsettledPackets() {
    const settled = this.sender.settledRange(this.frames);
    return this._allPackets().filter((p) => !settled.has(p.frameId));
  }

  nextFrameView(frame) {
    const budgetBits = Math.max(
      0,
      this.profile.integralKbit(frame.t, frame.deadline) * 1000 - this.sender.queue.inFlightBytes() * 8,
    );
    if (!this.controller) {
      return {
        frameId: frame.id, budgetBits, queueBytes: this.sender.queue.inFlightBytes(),
        unsettledPackets: this._unsettledPackets().map((p) => ({ ...p })),
      };
    }
    return this.controller.nextFrameView({
      frame, budgetBits,
      queueBytes: this.sender.queue.inFlightBytes(),
      unsettledPackets: this._unsettledPackets(),
      chanRateBps: this.profile.rateAt(frame.t) * 1000,
    });
  }

  report() {
    const totalActualBytes = this.frames.reduce((a, f) => a + (f.settled ? f.bytes : 0), 0);
    const counts = {};
    for (const f of this.frames) counts[f.status] = (counts[f.status] || 0) + 1;
    return {
      frames: this.frames,
      queueSamples: this.queueSamples,
      discardLog: this.discardLog,
      overflowLog: this.overflowLog,
      feedbackLog: this.feedbackLog,
      ledger: {
        mode: this.ledger.mode,
        grantedBits: this.ledger.grantedBits,
        chargedBits: this.ledger.chargedBits,
        refundedBits: this.ledger.refundedBits,
        earmarkedBits: this.ledger.earmarkedBits(),
        debtBits: this.ledger.debtBits(),
        outstandingDebtBits: this.ledger.outstandingDebtBits(),
        duplicateFeedback: this.ledger.duplicateFeedback,
        attribution: this.ledger.attribution,
      },
      sender: {
        enqueued: this.sender.queue.totalEnqueued,
        sent: this.sender.queue.totalSent,
        discarded: this.sender.queue.totalDiscarded,
        inFlight: this.sender.queue.inFlightBytes(),
      },
      receiver: this.receiver ? this.receiver.continuousDecode() : null,
      goodBytes: this.receiver ? this.receiver.goodBytes() : 0,
      totalActualBytes,
      counts,
      Tend: this.clock,
    };
  }
}
