'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReferenceAnalyzer } from '../core/refs.js';
import { makeSession, twinEqualBytesPlan } from '../core/scenarios.js';
import { makeFrame, splitFrameIntoPackets } from '../core/model.js';
import { BudgetLedger } from '../core/ledger.js';

test('引用分析：无存活后继引用时允许丢弃', () => {
  const frames = [
    makeFrame({ id: 1, key: true, refs: [] }),
    makeFrame({ id: 2, refs: [1] }),
    makeFrame({ id: 3, refs: [1] }),
  ];
  const a = new ReferenceAnalyzer(frames);
  assert.deepEqual(a.liveDescendants(2), []);
  assert.equal(a.canDiscard(2).ok, true);
});

test('引用分析：被存活后继引用时拒绝丢弃', () => {
  const frames = [
    makeFrame({ id: 1, key: true, refs: [] }),
    makeFrame({ id: 3, refs: [1] }),
    makeFrame({ id: 4, refs: [3] }),
  ];
  const a = new ReferenceAnalyzer(frames);
  const v = a.canDiscard(3);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'referenced');
  assert.deepEqual(v.descendants, [4]);
  // 关键帧总是可丢
  assert.equal(a.canDiscard(1).ok, true);
});

test('tryDiscard：放行则释放队列并退回预留；拒绝则预算不动', () => {
  const s = makeSession({});
  s.setFramePlan([
    { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
    { id: 2, t: 0.1, deadline: 0.6, refs: [1] },
    { id: 3, t: 0.2, deadline: 0.7, refs: [2] },
  ]);
  for (const f of s.frames) {
    f.bytes = 2400;
    const pkts = splitFrameIntoPackets(f, 1200, f.t);
    s.sender.submit(f, pkts, f.t);
    s.ledger.reserve(f.id, 2400 * 8, f.t);
    f.reservedBits = 2400 * 8;
  }
  const before = s.sender.queue.inFlightBytes();

  // 帧 2 被帧 3 引用：拒绝，预算与队列不变
  const reject = s.requestDiscard(2);
  assert.equal(reject.action, 'reject');
  assert.equal(s.sender.queue.inFlightBytes(), before);
  assert.equal(s.ledger.earmarkedBits(), 2400 * 8 * 3);

  // 帧 3 无后继：丢弃并退款
  const ok = s.requestDiscard(3);
  assert.equal(ok.action, 'discard');
  assert.equal(ok.freedBytes, 2400);
  assert.equal(ok.refundedBits, 2400 * 8);
  assert.equal(s.sender.queue.inFlightBytes(), before - 2400);
  assert.equal(s.ledger.earmarkedBits(), 2400 * 8 * 2);
  s.ledger.checkInvariant();
  s.sender.queue.checkInvariant();
});

test('markDead：断链帧的引用子树一并失效', () => {
  const frames = [
    makeFrame({ id: 1, key: true, refs: [] }),
    makeFrame({ id: 2, refs: [1] }),
    makeFrame({ id: 3, refs: [2] }),
    makeFrame({ id: 9, refs: [1] }),
  ];
  const a = new ReferenceAnalyzer(frames);
  const dead = a.markDead(2);
  assert.deepEqual(dead.sort(), [2, 3]);
  assert.equal(a.alive.has(9), true);
});

test('等字节对照：两画面字节相同仅引用不同，丢弃决策相反', () => {
  const { plan, equalBytes } = twinEqualBytesPlan();
  const frames = plan.map((p) => makeFrame({ ...p, bytes: equalBytes }));
  const a = new ReferenceAnalyzer(frames);
  assert.equal(a.canDiscard(2).ok, true);    // 2 无后继
  assert.equal(a.canDiscard(3).ok, false);   // 3 被 4 引用
  assert.equal(frames[1].bytes, frames[2].bytes);
});
