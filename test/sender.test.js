'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DiscardableQueue } from '../core/sender.js';
import { makeFrame, splitFrameIntoPackets } from '../core/model.js';

test('DiscardableQueue: FIFO 发送与部分发送记账', () => {
  const q = new DiscardableQueue();
  const f = makeFrame({ id: 1, bytes: 3000 });
  const pkts = splitFrameIntoPackets(f, 1200, 0);
  q.enqueue(pkts);
  assert.equal(q.inFlightBytes(), 3000);
  assert.equal(q.bytesQueued, 3000);

  // 1000 bit/s 只能发 125 字节，首包部分发送
  const sent = q.advance(0, 1, 1000, 0.04);
  assert.equal(sent, 125);
  assert.equal(q.bytesStarted, 1075);                 // 部分包剩余仍记为 started
  assert.equal(q.bytesQueued, 3000 - 1200);
  assert.equal(q.q[0].state, 'partial');
  q.checkInvariant();

  // 高带宽一次排空
  const rest = q.advance(1, 10, 1e9, 0.04);
  assert.equal(Math.round(rest), 2875);
  assert.equal(q.q.length, 0);
  assert.equal(q.totalSent, 3000);
  assert.equal(q.inFlightBytes(), 0);
  q.checkInvariant();
});

test('DiscardableQueue: 已开始的包不可丢弃，未开始的整帧可丢', () => {
  const q = new DiscardableQueue();
  const f1 = makeFrame({ id: 1, bytes: 1200 });
  const f2 = makeFrame({ id: 2, bytes: 2400 });
  q.enqueue(splitFrameIntoPackets(f1, 1200, 0));
  q.enqueue(splitFrameIntoPackets(f2, 1200, 0));

  q.advance(0, 1, 1000, 0); // 只发了 f1 的 125B
  assert.equal(q.hasUnsent(2), true);
  const d2 = q.discardFrame(2);
  assert.equal(d2.freedBytes, 2400);
  assert.equal(q.inFlightBytes(), 1200 - 125);
  assert.equal(q.hasUnsent(2), false);

  const d1 = q.discardFrame(1);  // 已开始：不可撤
  assert.equal(d1.freedBytes, 0);
  assert.equal(q.totalDiscarded, 2400);
  q.checkInvariant();
});

test('DiscardableQueue: 零带宽不推进，快照可恢复', () => {
  const q = new DiscardableQueue();
  const f = makeFrame({ id: 7, bytes: 1500 });
  q.enqueue(splitFrameIntoPackets(f, 1200, 0));
  q.advance(0, 1, 0, 0.04);
  assert.equal(q.inFlightBytes(), 1500);
  const snap = q.snapshot();
  q.advance(1, 1, 5000 * 8, 0.04);
  assert.ok(q.totalSent > 0);
  q.restore(snap);
  assert.equal(q.inFlightBytes(), 1500);
  assert.equal(q.totalSent, 0);
  q.checkInvariant();
});

test('DiscardableQueue: 已结算帧范围只包含全部包发出的帧', () => {
  const q = new DiscardableQueue();
  const a = makeFrame({ id: 1, bytes: 1200 });
  const b = makeFrame({ id: 2, bytes: 2400 });
  q.enqueue(splitFrameIntoPackets(a, 1200, 0));
  q.enqueue(splitFrameIntoPackets(b, 1200, 0));
  q.advance(0, 10, 1e9, 0);
  assert.deepEqual([...q.settledFrameIds([a, b])].sort(), [1, 2]);

  const q2 = new DiscardableQueue();
  const c = makeFrame({ id: 3, bytes: 1200 });
  const d = makeFrame({ id: 4, bytes: 2400 });
  q2.enqueue(splitFrameIntoPackets(c, 1200, 0));
  q2.enqueue(splitFrameIntoPackets(d, 1200, 0));
  q2.advance(0, 1, 2400 * 8, 0); // c 发完，d 未开始
  assert.deepEqual([...q2.settledFrameIds([c, d])], [3]);
});

test('makePacket 序号与拆包尺寸正确', () => {
  const f = makeFrame({ id: 9, bytes: 3000 });
  const pkts = splitFrameIntoPackets(f, 1200, 0);
  assert.deepEqual(pkts.map((p) => p.size), [1200, 1200, 600]);
  assert.equal(new Set(pkts.map((p) => p.pktId)).size, 3);
});
