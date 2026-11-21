'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeSession, twinEqualBytesPlan, reorderPlan,
  sameOccupancyDifferentDebt, resumeFixture, flatProfile, stepProfile,
} from '../core/scenarios.js';
import { TraceRecorder } from '../core/trace.js';

/* 复刻 lab.js 中每个场景的构造与运行路径，作为页面冒烟测试。 */
function build(scenario, ledgerMode, trace) {
  switch (scenario) {
    case 'twin': {
      const { plan, equalBytes } = twinEqualBytesPlan();
      const s = makeSession({ profile: flatProfile(5000, 2), equalBytes, mtu: 1200, ledgerMode, trace });
      s.setFramePlan(plan);
      for (const f of [...s.frames].sort((a, b) => a.t - b.t)) {
        s._drainNetwork(f.t); s._processEvents(f.t);
        s.submitFrame(f, { targetBits: equalBytes * 8 });
      }
      return s;
    }
    case 'reorder': {
      const s = makeSession({
        profile: stepProfile([[0.05, 600], [0.15, 4000]], 2, 3000),
        reorderDepth: 1, mtu: 700, equalBytes: 2000, ledgerMode, trace,
      });
      s.setFramePlan(reorderPlan());
      for (const f of [...s.frames].sort((a, b) => a.t - b.t)) {
        s._drainNetwork(f.t); s._processEvents(f.t);
        s.submitFrame(f, { targetBits: f.bytes * 8 });
      }
      return s;
    }
    case 'modes': {
      const s = makeSession({ profile: flatProfile(4000, 2), equalBytes: 3000, mtu: 1200, ledgerMode, trace });
      s.setFramePlan([
        { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
        { id: 2, t: 0.1, deadline: 0.6, refs: [1] },
        { id: 3, t: 0.2, deadline: 0.7, refs: [2] },
      ]);
      return s;
    }
    case 'replay': {
      const s = makeSession({
        profile: stepProfile([[0.1, 400], [0.4, 3000]], 2, 2000),
        equalBytes: 2400, mtu: 1000, reorderDepth: 1, ledgerMode, trace,
      });
      s.setFramePlan([
        { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
        { id: 2, t: 0.1, deadline: 0.6, refs: [1] },
        { id: 3, t: 0.2, deadline: 0.7, refs: [2] },
        { id: 4, t: 0.3, deadline: 0.8, refs: [3] },
      ]);
      return s;
    }
    case 'debt': {
      // 独立构造一对会话，避免跨用例复用已 finish 的实例
      const pair = sameOccupancyDifferentDebt();
      const s = ledgerMode === 'feedback' ? pair.feedback : pair.reserved;
      s.trace = trace;
      return s;
    }
    case 'resume': {
      const s = resumeFixture().make();
      s.trace = trace;
      return s;
    }
    default:
      throw new Error(`未知场景 ${scenario}`);
  }
}

for (const scenario of ['twin', 'reorder', 'modes', 'replay', 'debt', 'resume']) {
  for (const ledgerMode of ['reserved', 'feedback']) {
    test(`冒烟: 场景 ${scenario} / ${ledgerMode} 全路径可运行`, () => {
      const trace = new TraceRecorder();
      const s = build(scenario, ledgerMode, trace);
      if (scenario === 'modes' || scenario === 'replay') s.run(3);
      else if (scenario === 'resume') {
        for (const f of s.frames) s.submitFrame(f, { targetBits: f.bytes * 8 });
        s.finish(4);
      } else s.finish(3);
      const rep = s.report();

      assert.ok(rep.frames.length > 0);
      assert.equal(rep.sender.enqueued, rep.sender.sent + rep.sender.discarded + rep.sender.inFlight);
      // 每个被结算帧都能取出故事对象；带轨迹的场景里实耗与帧字节一致
      for (const f of rep.frames) {
        if (f.settled) {
          const story = trace.frameStory(f.id);
          assert.ok(story);
          if (story.actualBits != null) assert.equal(story.actualBits, f.bytes * 8);
        }
      }
      // 控制面板视图始终可生成
      const view = s.nextFrameView(rep.frames[rep.frames.length - 1]);
      assert.ok('budgetBits' in view && 'unsettledPackets' in view);
    });
  }
}

test('冒烟: 恢复发送（backlog 与 drained）页面路径', () => {
  for (const kind of ['backlog', 'drained']) {
    const s = resumeFixture().make();
    for (const f of s.frames) s.submitFrame(f, { targetBits: f.bytes * 8 });
    if (kind === 'drained') { s._drainNetwork(2); s._processEvents(2); }
    const snap = s.pauseState();
    assert.equal(snap.queueBytes === 0, kind === 'drained');
    s.restoreState(snap);
    const rep = s.finish(4);
    assert.equal(rep.counts.arrived, 5);
  }
});
