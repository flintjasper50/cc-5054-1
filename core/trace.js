'use strict';

/*
 * 轨迹记录与重放：
 * 记录真实发生过的包（入队/发出/到达/反馈）与控制决策，
 * 允许用记录的真实包重新驱动控制器（不重新编码），逐步展示某帧的
 * 估计、实耗与传输占用。
 */

export class TraceRecorder {
  constructor() {
    this.events = [];
    this.packets = new Map();      // pktId -> 包快照
    this.frames = new Map();       // frameId -> 帧静态信息
  }

  rec(ev) {
    this.events.push({ idx: this.events.length, ...ev });
  }

  recordPacket(pkt) {
    if (!this.packets.has(pkt.pktId)) {
      this.packets.set(pkt.pktId, {
        pktId: pkt.pktId, frameId: pkt.frameId, seq: pkt.seq, size: pkt.size,
      });
    }
  }

  recordFrame(frame) {
    if (!this.frames.has(frame.id)) {
      this.frames.set(frame.id, {
        id: frame.id, t: frame.t, deadline: frame.deadline,
        refs: [...frame.refs], key: frame.key, bytes: frame.bytes,
      });
    }
  }

  toJSON() {
    return {
      events: this.events,
      packets: [...this.packets.values()],
      frames: [...this.frames.values()],
    };
  }

  static fromJSON(json) {
    const tr = new TraceRecorder();
    tr.events = json.events.map((e) => ({ ...e }));
    tr.packets = new Map(json.packets.map((p) => [p.pktId, { ...p }]));
    tr.frames = new Map(json.frames.map((f) => [f.id, { ...f, refs: [...f.refs] }]));
    return tr;
  }

  /* 逐事件重放：按记录顺序把事件交给 handler，返回每步状态。 */
  reDrive(handler) {
    const out = [];
    for (const ev of this.events) {
      const r = handler(ev) ?? {};
      out.push({ ev, ...r });
    }
    return out;
  }

  frameStory(frameId) {
    const story = {
      frame: this.frames.get(frameId) ?? null,
      estimate: null, actualBits: null, reserve: null,
      packets: [], settle: null, refund: null, queueSamples: [],
    };
    for (const ev of this.events) {
      if (ev.frameId === frameId) {
        if (ev.kind === 'decide') story.estimate = ev.estBits;
        if (ev.kind === 'reserve') story.reserve = ev.bits;
        if (ev.kind === 'encoded') story.actualBits = ev.bits;
        if (ev.kind === 'settle' || ev.kind === 'charge') story.settle = ev;
        if (ev.kind === 'refund') story.refund = ev;
      }
      if (ev.kind === 'packet-sent' && ev.frameId === frameId) {
        story.packets.push({ pktId: ev.pktId, t: ev.t, size: ev.size, arriveT: ev.arriveT });
      }
      if (ev.kind === 'queue-sample') story.queueSamples.push({ t: ev.t, bytes: ev.bytes });
    }
    return story;
  }
}
