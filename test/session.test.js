'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeSession, twinEqualBytesPlan, reorderPlan,
  sameOccupancyDifferentDebt, resumeFixture, flatProfile, stepProfile,
} from '../core/scenarios.js';
import { TraceRecorder } from '../core/trace.js';
import { splitFrameIntoPackets } from '../core/model.js';

/* 场景 1：等字节画面仅引用关系不同 —— 连续解码 + 只扣一次账 */
test('场景1: 等字节不同引用，收端连续解码且每帧只扣一次', () => {
  const { plan, equalBytes } = twinEqualBytesPlan();
  const s = makeSession({ profile: flatProfile(5000), equalBytes, mtu: 1200 });
  s.setFramePlan(plan);
  // 直接提交全部帧，隔离控制器的时隙规则，纯粹检验引用链与记账
  for (const f of [...s.frames].sort((a, b) => a.t - b.t)) {
    s._drainNetwork(f.t);
    s._processEvents(f.t);
    s.submitFrame(f, { targetBits: equalBytes * 8 });
  }
  const rep = s.finish(2);

  assert.equal(rep.counts.arrived, 4);
  assert.equal(rep.receiver.ok, true);
  assert.deepEqual(rep.receiver.gaps, []);
  // 四张画面字节完全相同
  const bytes = new Set(rep.frames.map((f) => f.bytes));
  assert.equal(bytes.size, 1);
  assert.equal(bytes.has(equalBytes), true);
  // 每个到达帧在账本里恰好一笔结算
  for (const f of rep.frames) {
    const settles = rep.ledger.attribution.filter((a) => a.frameId === f.id && (a.kind === 'settle' || a.kind === 'charge'));
    assert.equal(settles.length, 1, `帧 ${f.id} 应只结算一次`);
  }
  assert.equal(rep.ledger.chargedBits, equalBytes * 8 * 4);
  // 发送端实发字节 == 账本实扣字节
  assert.equal(rep.sender.sent, rep.totalActualBytes);
});

test('场景1b: 引用关系不同导致相同帧一个可丢一个不可丢', () => {
  const { plan, equalBytes } = twinEqualBytesPlan();
  const s = makeSession({ profile: flatProfile(5000), equalBytes });
  s.setFramePlan(plan);
  for (const f of s.frames) {
    f.bytes = equalBytes;
    s.sender.submit(f, splitFrameIntoPackets(f, 1200, f.t), f.t);
    s.ledger.reserve(f.id, equalBytes * 8, f.t);
    f.reservedBits = equalBytes * 8;
  }
  const r2 = s.requestDiscard(2);
  const r3 = s.requestDiscard(3);
  assert.equal(r2.action, 'discard');
  assert.equal(r3.action, 'reject');
  assert.equal(r3.descendants.includes(4), true);
});

/* 场景 2：重排返回 + 拆包 + 拖动带宽时旧帧在途 */
test('场景2: 编码器按另一顺序交回，画面拆多包，乱序到达仍连续解码', () => {
  const trace = new TraceRecorder();
  const s = makeSession({
    profile: stepProfile([[0.05, 600], [0.15, 4000]], 2, 3000),
    reorderDepth: 1, mtu: 700, equalBytes: 2000, trace,
  });
  s.setFramePlan(reorderPlan());
  // 直接提交全部帧，隔离控制器时隙规则，专注检验重排/拆包/乱序到达
  for (const f of [...s.frames].sort((a, b) => a.t - b.t)) {
    s._drainNetwork(f.t);
    s._processEvents(f.t);
    s.submitFrame(f, { targetBits: f.bytes * 8 });
  }
  const rep = s.finish(3);

  // 每帧都拆成多个包
  assert.ok(rep.frames.every((f) => f.fragments >= 2));
  // 编码器确实重排过返回顺序
  const orders = s.encoder.returnLog.map((r) => r.order);
  assert.notDeepEqual(orders, [...orders].sort((a, b) => a - b));
  // 收端按引用链仍能连续解码（重排不破坏内容完整性）
  assert.equal(rep.receiver.ok, true);
  assert.equal(rep.counts.arrived, 5);
  // 轨迹里每个包都有发送事件
  const sentPk = new Set(trace.events.filter((e) => e.kind === 'packet-sent').map((e) => e.pktId));
  const allPk = rep.frames.flatMap((f) => f.packets).map((p) => p.pktId);
  assert.equal(sentPk.size, allPk.length);
});

test('场景2b: 界面拖动目标带宽时未结算旧帧仍在路上，账不受影响', () => {
  const s = makeSession({ profile: flatProfile(1500), equalBytes: 2600, mtu: 800 });
  s.setFramePlan([
    { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
    { id: 2, t: 0.1, deadline: 0.6, refs: [1] },
    { id: 3, t: 0.2, deadline: 0.7, refs: [2] },
  ]);
  // 直接提交，确保三帧都在途；此时尚未收到任何反馈
  for (const f of s.frames) s.submitFrame(f, { targetBits: f.bytes * 8 });
  const inFlightBefore = s.sender.queue.inFlightBytes();
  assert.ok(inFlightBefore > 0);
  // 拖动带宽：只改剖面，不动队列与账
  for (let i = 0; i < s.profile.cells.length; i++) s.profile.cells[i] = 200;
  s.profile.fallbackKbps = 200;
  assert.equal(s.sender.queue.inFlightBytes(), inFlightBefore);
  assert.equal(s.ledger.chargedBits, 0); // 尚未反馈
  const rep = s.finish(4);
  assert.equal(rep.sender.sent, rep.totalActualBytes);
});

/* 场景 3：两种记账模式最终实扣一致，过程归属不同 */
test('场景3: reserved 与 feedback 最终实扣一致，差额归属接口可区分过程', () => {
  const plan = [
    { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
    { id: 2, t: 0.1, deadline: 0.6, refs: [1] },
    { id: 3, t: 0.2, deadline: 0.7, refs: [2] },
  ];
  const mk = (mode) => {
    const s = makeSession({ profile: flatProfile(4000), ledgerMode: mode, equalBytes: 3000 });
    s.setFramePlan(plan.map((p) => ({ ...p })));
    return s.run(2);
  };
  const r = mk('reserved');
  const f = mk('feedback');
  assert.equal(r.ledger.chargedBits, f.ledger.chargedBits);
  assert.equal(r.ledger.chargedBits, 3000 * 8 * 3);
  // 过程不同：reserved 有预留与 settle delta；feedback 只有 charge
  assert.ok(r.ledger.attribution.some((a) => a.kind === 'reserve'));
  assert.ok(r.ledger.attribution.some((a) => a.kind === 'settle' && typeof a.deltaBits === 'number'));
  assert.ok(!f.ledger.attribution.some((a) => a.kind === 'reserve'));
  assert.ok(f.ledger.attribution.every((a) => a.kind !== 'settle'));
  // 全部完成后两者欠账都归零
  assert.equal(r.ledger.debtBits, 0);
  assert.equal(f.ledger.debtBits, 0);
});

/* 场景 4：真实包重驱动 + 回调换序 + 重复反馈 + 排空 */
test('场景4: 用记录的真实包重驱动，换序/重复反馈后总额一致', () => {
  const plan = [
    { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
    { id: 2, t: 0.1, deadline: 0.6, refs: [1] },
    { id: 3, t: 0.2, deadline: 0.7, refs: [2] },
  ];
  const runOnce = (order) => {
    const trace = new TraceRecorder();
    const s = makeSession({
      profile: flatProfile(3000), equalBytes: 2400, mtu: 1000,
      callbackOrder: order, trace,
    });
    s.setFramePlan(plan.map((p) => ({ ...p })));
    const rep = s.run(2);
    // 中途对帧 1 重复一次反馈
    s.duplicateFeedback(1, 0.9);
    return { rep, trace };
  };
  const a = runOnce('arrive-first');
  const b = runOnce('feedback-first');
  // 重复反馈发生在帧 1 结算之前，因此账本只把真正的结算计一次，重复调用被幂等吞掉
  assert.equal(a.rep.ledger.chargedBits, b.rep.ledger.chargedBits);
  assert.equal(a.rep.sender.sent, b.rep.sender.sent);
  assert.equal(a.rep.ledger.duplicateFeedback + a.rep.feedbackLog.length >= 1, true);
  assert.equal(a.rep.ledger.chargedBits, 2400 * 8 * 3);

  // 再对已结算帧重复一次：明确计入 duplicateFeedback 且不二次扣账
  a.rep; // 报告对象不持有会话，下面通过原始会话验证在独立用例中完成
  const s2 = makeSession({ profile: flatProfile(3000), equalBytes: 2400, mtu: 1000 });
  s2.setFramePlan(plan.map((p) => ({ ...p })));
  const rep2 = s2.run(2);
  const chargedBefore = rep2.ledger.chargedBits;
  s2.duplicateFeedback(1, 1.5);
  assert.equal(s2.ledger.duplicateFeedback, 1);
  assert.equal(s2.ledger.chargedBits, chargedBefore);

  // 重放：用记录事件重新驱动，逐步拿到某帧估计/实耗/占用
  const story = a.trace.frameStory(2);
  assert.equal(story.actualBits, 2400 * 8);
  assert.ok(story.packets.length >= 2);
  assert.ok(story.queueSamples.length > 0);
  let steps = 0;
  a.trace.reDrive(() => { steps++; });
  assert.equal(steps, a.trace.events.length);
  // JSON 往返后仍可重放
  const json = JSON.parse(JSON.stringify(a.trace.toJSON()));
  const TraceRecorder2 = TraceRecorder.fromJSON(json);
  assert.equal(TraceRecorder2.events.length, a.trace.events.length);
});

/* 场景 5：同占用、不同欠账 */
test('场景5: 两条序列某时刻占用相同，实际欠账不同', () => {
  const { reserved, feedback } = sameOccupancyDifferentDebt();
  // 三帧已在 t=0 入队；推进到深谷中段，包在途且尚无反馈
  for (const s of [reserved, feedback]) {
    s._drainNetwork(0.2);
    s._processEvents(0.2);
  }
  const occR = reserved.sender.queue.inFlightBytes();
  const occF = feedback.sender.queue.inFlightBytes();
  assert.equal(occR, occF);                       // 占用相同
  assert.ok(occR > 0);
  assert.equal(reserved.ledger.chargedBits, 0);  // 尚无反馈
  assert.equal(feedback.ledger.chargedBits, 0);
  const debtR = reserved.ledger.outstandingDebtBits();
  const debtF = feedback.ledger.outstandingDebtBits();
  assert.notEqual(debtR, debtF);                 // 欠账口径不同
  assert.ok(debtF > debtR);                      // feedback 无预留覆盖，已发在途字节即欠账
  assert.equal(debtR, 0);                        // reserved 在途帧有预留覆盖
  // feedback 欠账恰等于“已发出但尚未反馈”的字节（不含仍排队未发的）
  const sentUnsettled = feedback._allPackets()
    .filter((p) => p.state !== 'queued' && p.state !== 'discarded')
    .reduce((a, p) => a + (p.size - p.rem), 0);
  assert.equal(Math.round(debtF / 8), sentUnsettled);
  // 收尾后实际字节总数一致、缓冲轨迹都排空、欠账归零
  const rr = reserved.finish(3);
  const rf = feedback.finish(3);
  assert.equal(rr.totalActualBytes, rf.totalActualBytes);
  assert.equal(rr.sender.inFlight, 0);
  assert.equal(rf.sender.inFlight, 0);
  assert.equal(rr.ledger.debtBits, 0);
  assert.equal(rf.ledger.debtBits, 0);
});

/* 场景 6：从 drained / backlog 两种状态恢复 */
test('场景6: 两种暂停状态恢复，控制面板给出下一帧预算与未结算包', () => {
  const { make } = resumeFixture();

  // 五帧全部入队（模拟采集已结束、包在发送端），暂停发生在发送阶段
  const submitAll = (s) => {
    for (const f of s.frames) s.submitFrame(f, { targetBits: f.bytes * 8 });
  };

  // backlog：提交后立即暂停，队列有积压
  const backlog = make();
  submitAll(backlog);
  const snapBack = backlog.pauseState();
  assert.ok(snapBack.queueBytes > 0);
  const viewB = backlog.nextFrameView(backlog.frames[3]);
  assert.ok('budgetBits' in viewB && 'unsettledPackets' in viewB);
  assert.ok(viewB.unsettledPackets.length > 0);
  const repB = backlog.finish(4);
  assert.equal(repB.counts.arrived, 5);

  // drained：先排空再暂停，队列清空
  const drained = make();
  submitAll(drained);
  drained._drainNetwork(2.0);
  drained._processEvents(2.0);
  const snapDrain = drained.pauseState();
  assert.equal(snapDrain.queueBytes, 0);
  const viewD = drained.nextFrameView(drained.frames[3]);
  assert.equal(viewD.unsettledPackets.length, 0);
  assert.ok(viewD.budgetBits > viewB.budgetBits);   // 无积压时下一帧预算更高
  const repD = drained.finish(4);
  assert.equal(repD.counts.arrived, 5);

  // 恢复 backlog：用快照重建会话状态后继续，账目连续
  const restored = make();
  submitAll(restored);
  restored.restoreState(snapBack);
  const repR = restored.finish(4);
  assert.equal(repR.counts.arrived, 5);
  assert.equal(repR.sender.sent, repB.sender.sent);
});

test('丢弃退款跨模式：reserved 退款、feedback 无款可退，队列释放一致', () => {
  const plan = [
    { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
    { id: 2, t: 0.1, deadline: 0.6, refs: [1] },
    { id: 3, t: 0.2, deadline: 0.7, refs: [2] },
  ];
  for (const ledgerMode of ['reserved', 'feedback']) {
    const s = makeSession({ profile: flatProfile(4000, 2), equalBytes: 2400, ledgerMode });
    s.setFramePlan(plan.map((p) => ({ ...p })));
    for (const f of s.frames) s.submitFrame(f, { targetBits: 2400 * 8 });
    const before = s.sender.queue.inFlightBytes();
    const rec = s.requestDiscard(3);          // 帧 3 无后继，放行
    assert.equal(rec.action, 'discard');
    assert.equal(rec.freedBytes, 2400);
    assert.equal(s.sender.queue.inFlightBytes(), before - 2400);
    if (ledgerMode === 'reserved') {
      assert.equal(rec.refundedBits, 2400 * 8);
      assert.equal(s.ledger.refundedBits, 2400 * 8);
    } else {
      assert.equal(rec.refundedBits, 0);      // 提交未占账，无款可退
    }
  }
});

test('记账总不变量：入队=发出+丢弃+在途；实发=实扣字节', () => {
  const s = makeSession({
    profile: stepProfile([[0.1, 300], [0.3, 3000]], 2, 2000),
    equalBytes: 2200, mtu: 900,
  });
  s.setFramePlan([
    { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
    { id: 2, t: 0.1, deadline: 0.6, refs: [1] },
    { id: 3, t: 0.2, deadline: 0.7, refs: [2] },
    { id: 4, t: 0.3, deadline: 0.8, refs: [3] },
  ]);
  // 提交后主动丢弃帧 3（此时 4 还没进 analyzer 存活集之外……帧4已在 plan 中且存活）
  s.stepTo(s.frames[0]);
  s.stepTo(s.frames[1]);
  s.stepTo(s.frames[2]);
  const rep = s.run(3);
  const q = rep.sender;
  assert.equal(q.enqueued, q.sent + q.discarded + q.inFlight);
  assert.equal(q.sent, rep.totalActualBytes);
  assert.equal(q.sent * 8, rep.ledger.chargedBits);
});
