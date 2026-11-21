'use strict';

import {
  makeSession, twinEqualBytesPlan, reorderPlan,
  sameOccupancyDifferentDebt, resumeFixture, flatProfile, stepProfile,
} from './core/scenarios.js';
import { TraceRecorder } from './core/trace.js';
import { Session } from './core/session.js';

const $ = (id) => document.getElementById(id);
const fmtB = (bits) => `${(bits / 8).toFixed(0)} B`;
const STATUS_COLOR = {
  arrived: '#46c46a', queued: '#4da3ff', skipped: '#7c8794',
  discarded: '#f0a020', broken: '#ff9f2e', overflow: '#b95cf0', pending: '#aab4bd',
};

const state = {
  session: null, report: null, trace: null,
  paused: null, mode: 'reserved', scenario: 'twin', twinSession: null,
};

function mode() {
  return document.querySelector('input[name=mode]:checked').value;
}

/* ---------- 场景构造 ---------- */
function build(scenario, ledgerMode, trace) {
  const reorder = $('reorder').checked;
  const cb = $('cbOrder').value;
  switch (scenario) {
    case 'twin': {
      const { plan, equalBytes } = twinEqualBytesPlan();
      const s = makeSession({ profile: flatProfile(5000, 2), equalBytes, mtu: 1200, ledgerMode, callbackOrder: cb, trace });
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
        reorderDepth: reorder ? 1 : 0, mtu: 700, equalBytes: 2000, ledgerMode, callbackOrder: cb, trace,
      });
      s.setFramePlan(reorderPlan());
      for (const f of [...s.frames].sort((a, b) => a.t - b.t)) {
        s._drainNetwork(f.t); s._processEvents(f.t);
        s.submitFrame(f, { targetBits: f.bytes * 8 });
      }
      return s;
    }
    case 'modes': {
      const plan = [
        { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
        { id: 2, t: 0.1, deadline: 0.6, refs: [1] },
        { id: 3, t: 0.2, deadline: 0.7, refs: [2] },
      ];
      const s = makeSession({ profile: flatProfile(4000, 2), equalBytes: 3000, mtu: 1200, ledgerMode, callbackOrder: cb, trace });
      s.setFramePlan(plan);
      return s;
    }
    case 'replay': {
      const s = makeSession({ profile: stepProfile([[0.1, 400], [0.4, 3000]], 2, 2000), equalBytes: 2400, mtu: 1000, reorderDepth: reorder ? 1 : 0, ledgerMode, callbackOrder: cb, trace });
      s.setFramePlan([
        { id: 1, t: 0, deadline: 0.5, key: true, refs: [] },
        { id: 2, t: 0.1, deadline: 0.6, refs: [1] },
        { id: 3, t: 0.2, deadline: 0.7, refs: [2] },
        { id: 4, t: 0.3, deadline: 0.8, refs: [3] },
      ]);
      return s;
    }
    case 'debt': {
      const pair = sameOccupancyDifferentDebt();
      const s = ledgerMode === 'feedback' ? pair.feedback : pair.reserved;
      s.trace = trace;
      return s;
    }
    case 'resume': {
      const s = resumeFixture(ledgerMode).make();
      return s;
    }
    default:
      throw new Error(`未知场景 ${scenario}`);
  }
}

/* ---------- 运行 ---------- */
function run() {
  state.scenario = $('scenario').value;
  state.mode = mode();
  state.trace = new TraceRecorder();
  const s = build(state.scenario, state.mode, state.trace);
  state.session = s;

  if (state.scenario === 'modes') s.run(2);
  else if (state.scenario === 'resume') {
    for (const f of s.frames) s.submitFrame(f, { targetBits: f.bytes * 8 });
    s.finish(4);
  } else if (state.scenario === 'replay') {
    s.run(3);
  } else {
    s.finish(3);
  }
  state.report = s.report();
  state.paused = null;
  renderAll();
}

/* ---------- 控制面板 ---------- */
function renderControl() {
  const s = state.session;
  const nextFrame = s.frames.find((f) => f.status === 'pending' || f.status === 'queued') ?? s.frames[s.frames.length - 1];
  const view = s.nextFrameView(nextFrame);
  const rows = [
    `下一帧 id=${view.frameId}  deadline=${view.deadline?.toFixed(3)}s`,
    `预算 budgetBits=${Math.round(view.budgetBits)} bit（${fmtB(view.budgetBits)}）`,
    `估计 estBits=${Math.round(view.estBits ?? 0)} bit`,
    `QP=${view.qp ?? '-'}  VBR=${view.vbrBits ? Math.round(view.vbrBits) : '-'} bit/s`,
    `队列占用=${(view.queueBytes / 1024).toFixed(1)} KB  排空时延=${isFinite(view.drainAhead) ? view.drainAhead.toFixed(3) : '∞'}s`,
    `未结算包 ${view.unsettledPackets.length} 个：` +
      view.unsettledPackets.slice(0, 8).map((p) => `#${p.pktId}(帧${p.frameId},${p.state},${p.rem}B)`).join(' '),
  ];
  $('controlView').innerHTML = rows.join('<br>');
}

/* ---------- 账本 ---------- */
function renderLedger() {
  const l = state.report.ledger;
  const send = state.report.sender;
  const invariant = send.enqueued === send.sent + send.discarded + send.inFlight;
  const rows = [
    `模式：${l.mode === 'reserved' ? '按提交画面预留' : '按反馈逐笔校正'}`,
    `累计授予 granted=${Math.round(l.grantedBits)} bit  实扣 charged=${Math.round(l.chargedBits)} bit`,
    `退款 refunded=${Math.round(l.refundedBits)} bit  挂账 earmarked=${Math.round(l.earmarkedBits)} bit`,
    `欠账 debt=${Math.round(l.debtBits)} bit  在途欠账 outstanding=${Math.round(l.outstandingDebtBits)} bit`,
    `重复反馈被吞：${l.duplicateFeedback} 次（幂等，不二次扣账）`,
    `发送端：入队 ${send.enqueued}B = 发出 ${send.sent}B + 丢弃 ${send.discarded}B + 在途 ${send.inFlight}B  ${invariant ? '✓' : '✗'}`,
    `实发字节 ${send.sent}B  vs  实扣折算 ${Math.round(l.chargedBits / 8)}B`,
  ];
  $('ledgerView').innerHTML = rows.join('<br>');
}

/* ---------- 逐帧故事 ---------- */
function renderFrameSelector() {
  const sel = $('frameSel');
  sel.innerHTML = state.session.frames.map((f) => `<option value="${f.id}">帧 ${f.id}（${f.status}）</option>`).join('');
}

function renderStory() {
  const id = +$('frameSel').value;
  const story = state.trace.frameStory(id);
  const cv = $('story');
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#141a20'; ctx.fillRect(0, 0, cv.width, cv.height);
  const samples = story.queueSamples.length ? story.queueSamples : [{ t: 0, bytes: 0 }];
  const maxQ = Math.max(1, ...samples.map((x) => x.bytes));
  ctx.strokeStyle = '#4da3ff'; ctx.beginPath();
  samples.forEach((x, i) => {
    const px = i / Math.max(1, samples.length - 1) * (cv.width - 60) + 50;
    const py = cv.height - 20 - x.bytes / maxQ * (cv.height - 50);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.stroke();
  const est = story.estimate ?? 0, act = story.actualBits ?? 0, res = story.reserve ?? 0;
  const maxV = Math.max(1, est, act, res);
  const bars = [['估计', est, '#ffd166'], ['实耗', act, '#46c46a'], ['预留', res, '#b95cf0']];
  bars.forEach(([name, v, color], i) => {
    const bx = 60 + i * 90, bh = v / maxV * 120;
    ctx.fillStyle = color; ctx.fillRect(bx, cv.height - 20 - bh, 60, bh);
    ctx.fillStyle = '#dbe4ec'; ctx.font = '11px sans-serif';
    ctx.fillText(`${name} ${Math.round(v / 8)}B`, bx, cv.height - 4);
  });
  $('storyText').textContent =
    `帧 ${id}：包 ${story.packets.length} 个` +
    story.packets.map((p) => `#${p.pktId}@${p.t.toFixed(3)}s→${p.arriveT.toFixed(3)}s`).join('  ') +
    (story.settle ? ` ｜ 结算 delta=${Math.round(story.settle.deltaBits ?? story.settle.bits)} bit` : '') +
    (story.refund ? ` ｜ 退款 ${Math.round(story.refund.bits / 8)}B` : '');
}

/* ---------- 时间轴 ---------- */
function renderTimeline() {
  const cv = $('timeline');
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#141a20'; ctx.fillRect(0, 0, cv.width, cv.height);
  const s = state.session;
  const T = Math.max(0.1, s.clock);
  const X = (t) => 40 + t / T * (cv.width - 60);
  const frames = s.frames;
  const rowH = 26;
  frames.forEach((f, i) => {
    const y = 18 + i * rowH;
    ctx.fillStyle = STATUS_COLOR[f.status] ?? '#888';
    ctx.fillText(`帧${f.id}`, 4, y + 9);
    f.packets.forEach((p) => {
      const x0 = X(p.enqueueT ?? f.t);
      const x1 = X(p.arriveT ?? T);
      ctx.fillStyle = p.state === 'sent' ? '#46c46a' : p.state === 'partial' ? '#ffd166' : '#4da3ff';
      ctx.fillRect(x0, y, Math.max(2, x1 - x0), 12);
    });
    if (f.discarded) {
      ctx.fillStyle = '#f0a020';
      ctx.fillText('丢弃', X(f.t), y + 9);
    }
  });
  ctx.strokeStyle = '#f0524a';
  ctx.beginPath(); ctx.moveTo(X(T), 0); ctx.lineTo(X(T), cv.height); ctx.stroke();
  $('legend').innerHTML = Object.entries(STATUS_COLOR)
    .map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join('');
}

/* ---------- 收端解码与日志 ---------- */
function renderDecode() {
  const r = state.report;
  const dec = r.receiver;
  const lines = [
    `连续解码：${dec.ok ? '✓ 无断裂' : '✗ 存在断裂'}  解码帧 [${dec.decoded.join(', ')}]  断链 [${dec.broken.join(', ')}]`,
    `帧状态计数：${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join('  ')}`,
  ];
  if (state.session.receiver.reorderWaits.length) {
    lines.push('重排等待：' + state.session.receiver.reorderWaits.map((w) => `帧${w.frameId}`).join(' '));
  }
  if (r.discardLog.length) {
    lines.push('丢弃处置：' + r.discardLog.map((d) => `帧${d.frameId}:${d.action}(${d.reason})`).join('  '));
  }
  $('decodeView').innerHTML = lines.join('<br>');
}

function renderAll() {
  renderControl();
  renderLedger();
  renderFrameSelector();
  renderStory();
  renderTimeline();
  renderDecode();
}

/* ---------- 交互 ---------- */
$('run').onclick = run;
$('frameSel').onchange = renderStory;
$('scenario').onchange = () => { $('reorder').checked = $('scenario').value === 'reorder'; };

$('applyBw').onclick = () => {
  const s = state.session;
  const kbps = +$('bwKbps').value;
  for (let i = 0; i < s.profile.cells.length; i++) s.profile.cells[i] = kbps;
  s.profile.fallbackKbps = kbps;
  state.report = s.finish(3);
  renderAll();
};

$('dupFb').onclick = () => {
  const s = state.session;
  const f = s.frames.find((x) => x.settled);
  if (f) s.duplicateFeedback(f.id, s.clock);
  state.report = s.report();
  renderLedger();
};

$('pauseBacklog').onclick = () => {
  state.paused = state.session.pauseState();
  $('controlView').innerHTML += `<br><b>已暂停（backlog）：占用 ${(state.paused.queueBytes / 1024).toFixed(1)} KB，未结算包 ${state.paused.unsettled.length} 个</b>`;
};

$('pauseDrain').onclick = () => {
  const s = state.session;
  s._drainNetwork(s.clock + 2);
  s._processEvents(s.clock);
  state.paused = s.pauseState();
  $('controlView').innerHTML += `<br><b>已暂停（drained）：占用 0 KB，未结算包 0 个</b>`;
};

$('resume').onclick = () => {
  if (!state.paused) { alert('请先暂停'); return; }
  const s = state.session;
  s.restoreState(state.paused);
  state.report = s.finish(4);
  renderAll();
};

run();
