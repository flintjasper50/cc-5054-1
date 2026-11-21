'use strict';

/*
 * 合成编码器：不依赖 WebCodecs 的确定性编码器，供 Node 测试与实验室页面复用。
 * 支持：
 *   - 固定字节画面（equalBytes），用于构造“字节相同、引用关系不同”的对照
 *   - 重排返回（reorderDepth>0）：编码器按提交顺序编码，却按另一顺序交回含重排帧的包
 *   - 单画面拆多个包（mtu）
 */

import { makeFrame, splitFrameIntoPackets } from './model.js';

export class SyntheticEncoder {
  constructor({ mtu = 1200, reorderDepth = 0, equalBytes = null } = {}) {
    this.mtu = mtu;
    this.reorderDepth = reorderDepth;
    this.equalBytes = equalBytes;
    this.buffered = [];          // 已编码但按重排规则暂不交回的帧
    this.seq = 0;
    this.returnLog = [];
  }

  sizeFor(frame) {
    if (this.equalBytes != null) return this.equalBytes;
    if (frame.bytes > 0) return frame.bytes;
    const base = frame.key ? 9000 : 3200;
    const noise = ((frame.id * 2654435761) >>> 0) % 900;
    return base + noise;
  }

  /* 同步生成一帧的包；返回时机受 reorderDepth 影响。 */
  encode(spec, t) {
    const frame = makeFrame({ ...spec, t });
    frame.bytes = this.sizeFor(frame);
    frame.estBits = frame.bytes * 8;
    const packets = splitFrameIntoPackets(frame, this.mtu, t);
    const job = { order: this.seq++, frame, packets };
    this.buffered.push(job);
    return this._release();
  }

  _release() {
    const out = [];
    // 重排窗口：偶序作业与紧随其后的作业成对交换交回顺序（next 先、head 后）
    while (this.buffered.length > this.reorderDepth) {
      const head = this.buffered[0];
      const next = this.buffered[1];
      if (this.reorderDepth > 0 && next && head.order % 2 === 0) {
        this.buffered.splice(0, 2);
        for (const job of [next, head]) {
          this.returnLog.push({ order: job.order, frameId: job.frame.id, t: job.frame.t });
          out.push(job);
        }
      } else {
        const job = this.buffered.shift();
        this.returnLog.push({ order: job.order, frameId: job.frame.id, t: job.frame.t });
        out.push(job);
      }
    }
    return out;
  }

  flush() {
    const out = [];
    while (this.buffered.length) {
      const job = this.buffered.shift();
      this.returnLog.push({ order: job.order, frameId: job.frame.id, t: job.frame.t });
      out.push(job);
    }
    return out;
  }
}

/*
 * 收端：按到达顺序确认包，整帧到齐后进入按序汇聚缓冲。
 * 编码器可能重排交回，解码器按 id 顺序取出帧再判断引用链，
 * 乱序到达本身被记录，但不立即判为断链。
 */
export class Receiver {
  constructor(frames, { latency = 0.04 } = {}) {
    this.frames = frames;
    this.latency = latency;
    this.decoded = new Map();       // frameId -> {frame, displayT}
    this.broken = new Set();
    this.arrivals = [];             // 真实到达（可能乱序）
    this.gapReport = [];
    this.complete = new Map();      // frameId -> t，整帧到齐但可能尚未按序解码
    this.reorderWaits = [];         // {frameId, waitedFrom, decodedAt}
  }

  _get(id) {
    return this.frames.find((f) => f.id === id);
  }

  /* 一个包到达（可能乱序、可能属于拆分帧）。返回本次新到齐的帧 id 列表。 */
  onPacket(pkt, t) {
    pkt.fbT = t;
    const frame = this._get(pkt.frameId);
    if (!frame || frame.discarded) return [];
    const allHere = frame.packets.length > 0 && frame.packets.every((p) => p.arriveT != null && p.arriveT <= t + 1e-12);
    if (!allHere || this.complete.has(frame.id)) return [];
    this.complete.set(frame.id, t);
    this.arrivals.push({ frameId: frame.id, ok: null, t });
    return this._pump(t);
  }

  /* 按帧 id 顺序解码：前驱未到齐则等待（重排缓冲），到齐后立即汇聚。 */
  _pump(t) {
    const out = [];
    const ready = (id) => this.complete.has(id);
    for (const f of [...this.frames].sort((a, b) => a.id - b.id)) {
      if (this.decoded.has(f.id) || this.broken.has(f.id)) continue;
      if (!ready(f.id)) break;
      const arrivedAt = this.complete.get(f.id);
      if (arrivedAt < t - 1e-9) this.reorderWaits.push({ frameId: f.id, waitedFrom: arrivedAt, decodedAt: t });
      out.push(this._decode(f, t));
    }
    return out;
  }

  _decode(frame, t) {
    const missingRefs = frame.key ? [] : frame.refs.filter((r) => !this.decoded.has(r));
    if (missingRefs.length) {
      this.broken.add(frame.id);
      frame.status = 'broken';
      this.gapReport.push({ frameId: frame.id, t, missingRefs });
      this.arrivals.push({ frameId: frame.id, ok: false, t, missingRefs });
      return { frame, ok: false, missingRefs };
    }
    frame.status = 'arrived';
    frame.arriveT = this.complete.get(frame.id);
    frame.displayT = t;
    this.decoded.set(frame.id, { frame, displayT: t });
    this.arrivals.push({ frameId: frame.id, ok: true, t });
    return { frame, ok: true, missingRefs: [] };
  }

  continuousDecode() {
    const ordered = [...this.decoded.keys()].sort((a, b) => a - b);
    const gaps = [];
    for (let k = 1; k < ordered.length; k++) {
      if (ordered[k] !== ordered[k - 1] + 1) gaps.push([ordered[k - 1], ordered[k]]);
    }
    return { ok: this.gapReport.length === 0, decoded: ordered, gaps, broken: [...this.broken] };
  }

  goodBytes() {
    let s = 0;
    for (const { frame } of this.decoded.values()) s += frame.bytes;
    return s;
  }
}
