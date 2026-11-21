'use strict';

/* 确定性场景构造：所有序列均可在 Node 与浏览器实验室中直接运行。 */

import { Session } from './session.js';
import { BandwidthProfile } from './network.js';
import { SyntheticEncoder } from './encoder.js';
import { RateController } from './controller.js';

export function flatProfile(kbps = 2000, duration = 4) {
  const p = new BandwidthProfile({ duration });
  for (let i = 0; i < p.cells.length; i++) p.cells[i] = kbps;
  p.fallbackKbps = kbps;
  return p;
}

export function stepProfile(steps, duration = 4, base = 2000) {
  const p = flatProfile(base, duration);
  let cur = base;
  const marks = [...steps].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < p.cells.length; i++) {
    const t = i * p.cell;
    for (const [st, kbps] of marks) if (t >= st) cur = kbps;
    p.cells[i] = cur;
  }
  p.fallbackKbps = cur;
  return p;
}

function baseController(strategy = 'fps') {
  return new RateController({
    strategy, quant: true, qpMax: 51, qpFixedPct: 0.45, avgKbps: 800, capBytes: 400 * 1024,
  });
}

export function makeSession({
  profile, ledgerMode = 'reserved', strategy = 'fps', mtu = 1200,
  reorderDepth = 0, equalBytes = null, callbackOrder = 'arrive-first', trace = null,
  capBytes = 400 * 1024, latency = 0.04,
} = {}) {
  const encoder = new SyntheticEncoder({ mtu, reorderDepth, equalBytes });
  const controller = baseController(strategy);
  return new Session({
    profile: profile ?? flatProfile(), latency, mtu, capBytes, ledgerMode,
    callbackOrder, encoder, controller, trace,
  });
}

/* 场景 1：两张等字节画面，仅引用关系不同。 */
export function twinEqualBytesPlan(equalBytes = 3000) {
  const plan = [
    { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
    { id: 2, t: 1 / 30, deadline: 0.6, refs: [1] },
    { id: 3, t: 2 / 30, deadline: 0.7, refs: [1] },   // 链 A：3 引用 1，2 可丢
    { id: 4, t: 3 / 30, deadline: 0.8, refs: [3] },   // 链 B：4 引用 3，3 不可丢
  ];
  return { plan, equalBytes };
}

/* 场景 2：含重排帧的包 + 一画面拆多包。 */
export function reorderPlan() {
  return [
    { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
    { id: 2, t: 1 / 30, deadline: 0.6, refs: [1] },
    { id: 3, t: 2 / 30, deadline: 0.7, refs: [2] },
    { id: 4, t: 3 / 30, deadline: 0.8, refs: [3] },
    { id: 5, t: 4 / 30, deadline: 0.9, refs: [4] },
  ];
}

/* 场景 5：两段带宽变化后，占用相同、实际欠账不同的两条短序列。 */
export function sameOccupancyDifferentDebt() {
  const build = (ledgerMode) => {
    const s = makeSession({
      profile: stepProfile([[0.15, 100], [1.0, 2000]], 2, 100),
      ledgerMode, equalBytes: 2400, mtu: 1200, latency: 0.04,
    });
    s.setFramePlan([
      { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
      { id: 2, t: 0.3, deadline: 0.8, refs: [1] },
      { id: 3, t: 0.6, deadline: 1.1, refs: [2] },
    ]);
    // 三帧在 t=0 一次性入队，低谷带宽让包长时间在途且无反馈
    for (const f of s.frames) s.submitFrame(f, { targetBits: 2400 * 8 });
    return s;
  };
  return { reserved: build('reserved'), feedback: build('feedback') };
}

/* 场景 6：在同一时刻暂停，分别从 drained / backlog 恢复。 */
export function resumeFixture(ledgerMode = 'reserved') {
  const make = () => {
    const s = makeSession({
      profile: stepProfile([[0.4, 200]], 2, 1500),
      equalBytes: 2600, mtu: 800, ledgerMode,
    });
    s.setFramePlan([
      { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
      { id: 2, t: 0.1, deadline: 0.6, refs: [1] },
      { id: 3, t: 0.2, deadline: 0.7, refs: [2] },
      { id: 4, t: 0.5, deadline: 1.0, refs: [3] },
      { id: 5, t: 0.6, deadline: 1.1, refs: [4] },
    ]);
    return s;
  };
  return { make };
}

export const SCENARIO_NAMES = {
  twin: '等字节画面·引用关系对照',
  reorder: '重排返回·拆包·拖动带宽',
  modes: '预留预算 vs 逐笔反馈',
  replay: '真实包重驱动控制器',
  debt: '同占用·不同欠账',
  resume: '两种状态恢复发送',
};
