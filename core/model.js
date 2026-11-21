'use strict';

/* 基础数据模型：帧与包。核心模块不依赖 DOM，可在 Node 与浏览器中复用。 */

let PACKET_SEQ = 1;
let FRAME_SEQ = 1;

export function resetIds() {
  PACKET_SEQ = 1;
  FRAME_SEQ = 1;
}

export function makeFrame(spec) {
  return {
    id: spec.id ?? FRAME_SEQ++,
    t: spec.t ?? 0,
    deadline: spec.deadline ?? spec.t + 0.5,
    refs: spec.refs ? [...spec.refs] : [],
    key: !!spec.key,
    qp: spec.qp ?? null,
    status: spec.status ?? 'pending',
    bytes: spec.bytes ?? 0,
    packets: [],
    fragments: 0,
    estBits: null,
    reservedBits: 0,
    settledBytes: 0,
    refundedBytes: 0,
    settled: false,
    discarded: false,
    arriveT: null,
    displayT: null,
    note: spec.note ?? '',
  };
}

export function makePacket(frameId, seq, size, t) {
  return {
    pktId: PACKET_SEQ++,
    frameId,
    seq,
    size,
    rem: size,
    state: 'queued',            // queued -> partial -> sent
    started: false,
    enqueueT: t,
    sentT: null,
    arriveT: null,
    fbT: null,
  };
}

export function fragmentSizes(total, mtu) {
  const out = [];
  for (let off = 0; off < total; off += mtu) out.push(Math.min(mtu, total - off));
  return out;
}

export function splitFrameIntoPackets(frame, mtu, t) {
  const pkts = fragmentSizes(frame.bytes, mtu).map((sz, seq) => makePacket(frame.id, seq, sz, t));
  frame.packets.push(...pkts);
  return pkts;
}

export function frameFullySent(frame) {
  return frame.packets.length > 0 && frame.packets.every((p) => p.state === 'sent');
}
