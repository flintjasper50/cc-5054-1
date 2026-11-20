'use strict';

/* ================= 常量 ================= */
const FPS = 30;
const DUR = 8;                       // 会话时长 s
const N = FPS * DUR;                 // 总帧数
const CUT_T = 4.0;                   // 切镜时刻
const W = 640, H = 360;
const MTU = 1200;                    // 字节/包
const BASE_LAT = 0.040;              // 固定单向传播时延 s
const CELL = 0.01;                   // 带宽剖面时间分辨率 s
const CELLS = Math.round(DUR / CELL);
const SEED = 20261120;

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================= 确定性源画面 ================= */
const srcGen = (() => {
  const objs = [];
  const r = mulberry32(SEED);
  for (let k = 0; k < 14; k++) {
    objs.push({
      x0: r(), y0: r(),
      vx: (r() * 2 - 1) * 0.22, vy: (r() * 2 - 1) * 0.18,
      rad: 14 + r() * 26, hue: r() * 360,
    });
  }
  const bounce = (p) => { p = ((p % 2) + 2) % 2; return p < 1 ? p : 2 - p; };
  const staticSpeckle = [];
  for (let k = 0; k < 240; k++) staticSpeckle.push([r() * W, r() * H]);

  return function draw(ctx, i) {
    const t = i / FPS;
    const scene = t < CUT_T ? 0 : 1;
    const g = ctx.createLinearGradient(0, 0, W, H);
    if (scene === 0) { g.addColorStop(0, '#0b1e3a'); g.addColorStop(1, '#123c2b'); }
    else { g.addColorStop(0, '#3a0b1e'); g.addColorStop(1, '#2b3a12'); }
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    const off = (t * 60) % 40;
    ctx.beginPath();
    for (let x = -40 + off; x < W + 40; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = -40 + off; y < H + 40; y += 40) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    for (const o of objs) {
      const x = bounce(o.x0 + o.vx * t) * (W - 2 * o.rad) + o.rad;
      const y = bounce(o.y0 + o.vy * t) * (H - 2 * o.rad) + o.rad;
      ctx.fillStyle = `hsla(${(o.hue + scene * 140) % 360},72%,55%,0.85)`;
      ctx.beginPath(); ctx.arc(x, y, o.rad, 0, 7); ctx.fill();
    }

    const rr = mulberry32((SEED ^ Math.imul(i + 1, 2654435761)) >>> 0);
    for (let k = 0; k < 160; k++) {
      const v = Math.floor(rr() * 200 + 30);
      ctx.fillStyle = `rgba(${v},${v},${v},${0.25 + rr() * 0.5})`;
      ctx.fillRect(rr() * W, rr() * H, 2, 2);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (const p of staticSpeckle) ctx.fillRect(p[0], p[1], 2, 2);

    ctx.fillStyle = '#fff';
    ctx.font = '16px ui-monospace, monospace';
    ctx.fillText(`#${String(i).padStart(3, '0')}  t=${t.toFixed(2)}s  ${scene ? 'SCENE-B' : 'SCENE-A'}`, 10, 22);
  };
})();

/* ================= 编码器选择 ================= */
let codecSel = null;   // {key, codec, quant:boolean, qpMax, encExtra(qp)}
async function pickCodec() {
  const cands = [
    { key: 'avc', codec: 'avc1.42001f', qpMax: 51, extra: { avc: { format: 'annexb' } } },
    { key: 'vp9', codec: 'vp09.00.10.08', qpMax: 63, extra: {} },
    { key: 'av1', codec: 'av01.0.04M.08', qpMax: 255, extra: {} },
  ];
  for (const c of cands) {
    for (const mode of ['quantizer', 'variable']) {
      const cfg = {
        codec: c.codec, width: W, height: H, framerate: FPS,
        latencyMode: 'realtime', bitrateMode: mode, ...c.extra,
      };
      if (mode === 'variable') cfg.bitrate = 800_000;
      try {
        const sup = await VideoEncoder.isConfigSupported(cfg);
        if (sup.supported) return { ...c, quant: mode === 'quantizer', baseConfig: cfg };
      } catch (e) { /* try next */ }
    }
  }
  return null;
}

/* ================= 编码器封装 ================= */
class Enc {
  async open(sel, avgKbps) {
    this.sel = sel;
    this.waiters = [];
    this.enc = new VideoEncoder({
      output: (chunk) => {
        const buf = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(buf);
        const w = this.waiters.shift();
        if (w) w({ data: buf, type: chunk.type, bytes: chunk.byteLength });
      },
      error: (e) => { this.fatal = e; },
    });
    this.cfg = { ...sel.baseConfig };
    if (!sel.quant) this.cfg.bitrate = avgKbps * 1000;
    this.enc.configure(this.cfg);
  }
  setBitrate(bits) {
    if (this.sel.quant) return;
    this.cfg = { ...this.cfg, bitrate: Math.round(bits) };
    this.enc.configure(this.cfg);
  }
  encode(vf, qp, key) {
    return new Promise((res, rej) => {
      if (this.fatal) return rej(this.fatal);
      const timer = setTimeout(() => rej(new Error('编码器输出超时')), 15000);
      this.waiters.push((v) => { clearTimeout(timer); res(v); });
      const opts = { keyFrame: !!key };
      if (this.sel.quant) opts[this.sel.key] = { quantizer: qp };
      try { this.enc.encode(vf, opts); } catch (e) { clearTimeout(timer); this.waiters.pop(); rej(e); }
    });
  }
}

/* ================= 带宽剖面 ================= */
const cells = new Float32Array(CELLS);   // kbps
function profileAvg() {
  let s = 0; for (let i = 0; i < CELLS; i++) s += cells[i];
  return s / CELLS;
}
function presetA(avg) {           // 切镜前蓄量：前高后低
  for (let i = 0; i < CELLS; i++) cells[i] = (i * CELL < CUT_T ? 1.3 : 0.7) * avg;
}
function presetB(avg) {           // 切镜时断流 0.6s，其余略抬高，均值相同
  for (let i = 0; i < CELLS; i++) {
    const t = i * CELL;
    cells[i] = (t >= CUT_T && t < CUT_T + 0.6) ? 0 : avg / (1 - 0.6 / DUR);
  }
}
function normalizeTo(avg) {
  const cur = profileAvg();
  if (cur <= 0) return;
  const k = avg / cur;
  for (let i = 0; i < CELLS; i++) cells[i] *= k;
}
const rateAt = (t, avgKbps) => {
  const idx = Math.floor(t / CELL + 1e-9);
  if (idx < 0) return cells[0];
  if (idx >= CELLS) return avgKbps;      // 片尾之后按均值恢复服务，保证队列可排空
  return cells[idx];
};
function integralKbit(t0, t1, avgKbps) { // [t0,t1] 可交付的 kbit
  let s = 0;
  for (let t = t0; t < t1 - 1e-9; ) {
    const nt = Math.min(t1, (Math.floor(t / CELL + 1e-9) + 1) * CELL);
    if (nt <= t) break;                  // 数值兜底，防死循环
    s += rateAt(t, avgKbps) * (nt - t);
    t = nt;
  }
  return s;
}

/* ================= 仿真 ================= */
async function runSession(params, onProgress) {
  const { strategy, budget, capBytes, qpFixedPct, avgKbps } = params;
  const enc = new Enc();
  await enc.open(codecSel, avgKbps);

  const qpMax = codecSel.qpMax;
  const qpMin = Math.round(qpMax * 0.2);
  const qpStep = Math.max(1, Math.round(qpMax / 30));
  let qp = Math.round(qpMax * 0.45);
  const qpFixed = Math.round(qpMax * qpFixedPct);
  let vbr = avgKbps * 1000;                              // 动态码率回退模式的当前码率
  const qTarget = Math.min(capBytes * 0.25, avgKbps * 1000 * budget * 0.3 / 8);  // 队列水位目标

  const frames = [];
  for (let i = 0; i < N; i++) {
    frames.push({
      i, t: i / FPS, deadline: i / FPS + budget,
      status: 'pending', submitted: false, qp: null, key: false,
      bytes: 0, data: null, ctype: null, packets: [],
      arriveT: null, displayT: null,
    });
  }

  let vc = 0;                    // 虚拟时钟
  let queue = [];                // {frameId, rem, total, started, doneT, arriveT}
  let queueBytes = 0, peakQueue = 0;
  let chainOk = true;            // 解码端参考链是否完好
  let pendingKey = false;        // 关键帧已发未达，避免重复 IDR
  const violations = [];
  const received = [];           // 可解码块 {data,type,ts,displayT,frameId}
  const queueSamples = [];
  const estWindow = [];

  function drainTo(t) {
    while (queue.length && vc < t - 1e-12) {
      const rate = rateAt(vc, avgKbps) * 1000;   // bit/s
      const cellEnd = (Math.floor(vc / CELL + 1e-9) + 1) * CELL;
      let limit = Math.min(t, cellEnd);
      if (limit <= vc) limit = Math.min(t, vc + CELL);   // 浮点兜底
      if (limit <= vc) break;
      if (rate <= 0) { vc = limit; continue; }
      const pkt = queue[0];
      pkt.started = true;
      const need = pkt.rem * 8 / rate;
      if (vc + need <= limit + 1e-12) {
        vc += need;
        pkt.doneT = vc; pkt.arriveT = vc + BASE_LAT;
        queueBytes -= pkt.rem;
        queue.shift();
      } else {
        const bits = rate * (limit - vc);
        pkt.rem -= bits / 8; queueBytes -= bits / 8;
        vc = limit;
      }
    }
    if (!queue.length) vc = t;
  }

  function discardUnsent(f) {
    let freed = 0;
    queue = queue.filter((p) => {
      if (p.frameId === f.i && !p.started) { freed += p.rem; return false; }
      return true;
    });
    queueBytes -= freed;
  }

  function applyEvents(t) {
    for (;;) {
      let best = null, bestT = Infinity, bestKind = null;
      for (const f of frames) {
        if (f.status !== 'pending' || !f.submitted) continue;
        const last = f.packets.length ? f.packets[f.packets.length - 1] : null;
        if (last && last.arriveT != null && last.arriveT <= t && last.arriveT < bestT) {
          best = f; bestT = last.arriveT; bestKind = 'arr';
        }
        if ((!last || last.arriveT == null) && f.deadline <= t && f.deadline < bestT) {
          best = f; bestT = f.deadline; bestKind = 'exp';
        }
      }
      if (!best) break;
      if (bestKind === 'arr' && bestT <= best.deadline) {
        best.arriveT = bestT;
        if (best.ctype === 'key') { chainOk = true; pendingKey = false; }
        if (chainOk) {
          best.status = 'arrived';
          best.displayT = bestT;
          received.push({ data: best.data, type: best.ctype, ts: Math.round(best.i * 1e6 / FPS), displayT: bestT, frameId: best.i });
        } else {
          best.status = 'broken';
        }
      } else {
        best.status = 'expired';
        chainOk = false;
        discardUnsent(best);
      }
    }
  }

  const genCanvas = document.createElement('canvas');
  genCanvas.width = W; genCanvas.height = H;
  const gctx = genCanvas.getContext('2d');

  for (let i = 0; i < N; i++) {
    const f = frames[i];
    const t = f.t;
    drainTo(t);
    applyEvents(t);
    queueSamples.push({ t, bytes: queueBytes });

    const needKey = !chainOk || i === 0;
    const budgetBits = Math.max(0, integralKbit(t, f.deadline, avgKbps) * 1000 - queueBytes * 8);
    const chanRate = rateAt(t, avgKbps) * 1000;          // bit/s
    const drainAhead = chanRate > 0 ? queueBytes * 8 / chanRate : Infinity;  // 排空现有队列所需秒数

    let submit = true;
    if (pendingKey) {
      submit = false;                                    // IDR 在途，等它落地
    } else if (needKey) {
      // 恢复用 IDR：队列足够空才发，否则等下一时隙
      if (drainAhead > (f.deadline - t) * 0.4) submit = false;
    } else if (strategy === 'quality') {
      const est = estWindow.length
        ? estWindow.reduce((a, b) => a + b, 0) / estWindow.length
        : avgKbps * 1000 / FPS;
      if (est > budgetBits * 0.95) submit = false;       // 等下一时隙
    } else {
      // 保帧率：但队列已无望在期限内送达时弃帧
      if (drainAhead > (f.deadline - t) * 0.9) submit = false;
    }
    if (strategy === 'fps') {
      const chan = chanRate / FPS;                          // 稳态每帧比特
      f._target = clamp(budgetBits, 4000, Math.max(chan, 4000));
    }

    if (!submit) { f.status = 'skipped'; continue; }

    srcGen(gctx, i);
    const vf = new VideoFrame(genCanvas, { timestamp: Math.round(i * 1e6 / FPS), duration: 1e6 / FPS });
    let useQp = strategy === 'quality' ? qpFixed : qp;
    if (needKey && codecSel.quant) useQp = Math.max(useQp, Math.round(qpMax * 0.7));  // 恢复 IDR 压小体积
    const chunk = await enc.encode(vf, useQp, needKey);
    vf.close();

    f.submitted = true;
    f.qp = codecSel.quant ? useQp : null;
    f.bytes = chunk.bytes;
    f.data = chunk.data;
    f.ctype = chunk.type;
    f.key = chunk.type === 'key';
    if (f.key) pendingKey = true;
    estWindow.push(chunk.bytes * 8);
    if (estWindow.length > 5) estWindow.shift();

    if (queueBytes + chunk.bytes > capBytes) {       // 缓冲溢出：整帧丢弃并记录违约
      violations.push({ t, frame: i, bytes: chunk.bytes, queueBytes });
      f.status = 'overflow';
      chainOk = false;
    } else {
      for (let off = 0; off < chunk.bytes; off += MTU) {
        const sz = Math.min(MTU, chunk.bytes - off);
        queue.push({ frameId: i, rem: sz, total: sz, started: false, doneT: null, arriveT: null });
        f.packets.push(queue[queue.length - 1]);
        queueBytes += sz;
      }
      peakQueue = Math.max(peakQueue, queueBytes);
    }

    if (strategy === 'fps') {
      if (codecSel.quant) {                              // AIMD 调 QP
        const r = chunk.bytes * 8 / f._target;
        if (r > 1.25) qp += 2 * qpStep;
        else if (r > 1.05) qp += qpStep;
        else if (r < 0.5) qp -= 2 * qpStep;
        else if (r < 0.75) qp -= qpStep;
        qp = clamp(qp, qpMin, qpMax);
      } else {                                           // 队列反馈调码率
        if (queueBytes > qTarget) vbr *= 0.85;
        else if (queueBytes < qTarget * 0.5) vbr *= 1.06;
        vbr = clamp(vbr, 80_000, avgKbps * 1200);
        enc.setBitrate(vbr);
      }
    }

    if (i % 20 === 0) { onProgress(i); await new Promise((r) => setTimeout(r, 0)); }
  }

  drainTo(DUR + 60);           // 排空尾部仍在途的包
  applyEvents(Infinity);

  /* ---------- 指标 ---------- */
  const displayed = frames.filter((f) => f.displayT != null).sort((a, b) => a.displayT - b.displayT);
  let lastArrive = 0;
  for (const f of frames) for (const p of f.packets) if (p.arriveT) lastArrive = Math.max(lastArrive, p.arriveT);
  const lastDisplay = displayed.length ? displayed[displayed.length - 1].displayT : 0;
  const Tend = Math.max(lastArrive, lastDisplay, frames[N - 1].deadline);

  let maxStall = 0, prev = 0;
  for (const f of displayed) { maxStall = Math.max(maxStall, f.displayT - prev); prev = f.displayT; }
  maxStall = Math.max(maxStall, Tend - prev);      // 尾部在途包计入卡顿

  const delays = displayed.map((f) => f.displayT - f.t);
  const firstMiss = frames.find((f) => f.status === 'expired' || f.status === 'overflow') || null;
  const counts = {};
  for (const f of frames) counts[f.status] = (counts[f.status] || 0) + 1;
  const goodBytes = received.reduce((a, c) => a + c.data.byteLength, 0);

  return {
    frames, received, violations, queueSamples, Tend, capBytes,
    metrics: {
      firstMiss, maxStall, counts, peakQueue,
      maxDelay: delays.length ? Math.max(...delays) : 0,
      avgDelay: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : 0,
      tailInFlight: lastArrive > 0 ? Math.max(0, lastArrive - frames[N - 1].t) : 0,
      goodputKbps: goodBytes * 8 / Tend / 1000,
    },
  };
}

/* ================= 回放器 ================= */
class Player {
  constructor(session) {
    this.s = session;
    this.dec = null;
    this.feedIdx = 0;
    this.flushed = false;
    this.decoded = [];          // {ts, displayT, frame}
    this.ts2display = new Map();
    for (const c of session.received) this.ts2display.set(c.ts, c.displayT);
    this.cur = null;
  }
  async init() {
    this.dec = new VideoDecoder({
      output: (frame) => {
        this.decoded.push({ ts: frame.timestamp, displayT: this.ts2display.get(frame.timestamp), frame });
      },
      error: (e) => console.error('decoder', e),
    });
    this.dec.configure({ codec: codecSel.codec, optimizeForLatency: true });
  }
  async reset() { await this.dec.reset(); this.dec.configure({ codec: codecSel.codec, optimizeForLatency: true }); this.feedIdx = 0; this.flushed = false; this.clearDecoded(); }
  clearDecoded() { for (const d of this.decoded) d.frame.close(); this.decoded = []; this.cur = null; }
  feedTo(t) {
    const ahead = t + 0.6;
    while (this.feedIdx < this.s.received.length && this.s.received[this.feedIdx].displayT <= ahead) {
      const c = this.s.received[this.feedIdx++];
      this.dec.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.ts, data: c.data }));
    }
    if (this.feedIdx >= this.s.received.length && !this.flushed) { this.flushed = true; this.dec.flush().catch(() => {}); }
  }
  render(t, ctx) {
    this.feedTo(t);
    // 丢弃远早于播放头的已解码帧，但始终保留最新一帧 ≤t（卡顿时它就是冻结画面）
    while (this.decoded.length >= 2 && this.decoded[1].displayT <= t) this.decoded.shift().frame.close();
    let best = null;
    for (const d of this.decoded) if (d.displayT <= t && (!best || d.displayT > best.displayT)) best = d;
    if (best) { ctx.drawImage(best.frame, 0, 0, W, H); this.cur = best; }
    return best;
  }
}

/* ================= UI ================= */
const srcCanvas = $('srcCanvas'), decCanvas = $('decCanvas');
const srcCtx = srcCanvas.getContext('2d');
const decCtx = decCanvas.getContext('2d');
const chart = $('chart'), chartCtx = chart.getContext('2d');
const profCanvas = $('profile'), profCtx = profCanvas.getContext('2d');

let session = null, player = null;
let playing = false, playhead = 0, lastRaf = 0;

function drawProfileEditor() {
  const w = profCanvas.width, h = profCanvas.height;
  const avg = +$('avgKbps').value;
  const maxR = avg * 2.5;
  profCtx.fillStyle = '#141a20'; profCtx.fillRect(0, 0, w, h);
  // 切镜标记
  profCtx.fillStyle = 'rgba(255,255,255,0.08)';
  profCtx.fillRect(CUT_T / DUR * w, 0, 1.5, h);
  profCtx.beginPath();
  for (let i = 0; i < CELLS; i++) {
    const x = i / CELLS * w, y = h - clamp(cells[i] / maxR, 0, 1) * (h - 6) - 2;
    i ? profCtx.lineTo(x, y) : profCtx.moveTo(x, y);
  }
  profCtx.strokeStyle = '#4da3ff'; profCtx.lineWidth = 1.5; profCtx.stroke();
  const a = profileAvg();
  const y = h - clamp(a / maxR, 0, 1) * (h - 6) - 2;
  profCtx.setLineDash([4, 3]); profCtx.strokeStyle = '#ffd166';
  profCtx.beginPath(); profCtx.moveTo(0, y); profCtx.lineTo(w, y); profCtx.stroke();
  profCtx.setLineDash([]);
  $('profileAvg').textContent = `当前剖面均值：${a.toFixed(0)} kbps（两预设均值相同）`;
}

function profileEdit(ev) {
  const r = profCanvas.getBoundingClientRect();
  const x = clamp((ev.clientX - r.left) / r.width, 0, 1);
  const y = clamp((ev.clientY - r.top) / r.height, 0, 1);
  const avg = +$('avgKbps').value;
  const idx = clamp(Math.floor(x * CELLS), 0, CELLS - 1);
  cells[idx] = (1 - y) * avg * 2.5;
  drawProfileEditor();
  if (session) drawChart();
}

const STATUS_COLOR = { arrived: '#46c46a', expired: '#f0524a', broken: '#ff9f2e', overflow: '#b95cf0', skipped: '#7c8794', pending: '#aab4bd' };

function drawChart() {
  const w = chart.width, h = chart.height;
  chartCtx.fillStyle = '#141a20'; chartCtx.fillRect(0, 0, w, h);
  if (!session) return;
  const T = session.Tend;
  const X = (t) => t / T * w;

  // 带宽带
  const bwH = 52;
  let maxR = 0;
  for (let i = 0; i < CELLS; i++) maxR = Math.max(maxR, cells[i]);
  chartCtx.beginPath();
  for (let i = 0; i < CELLS; i++) {
    const x = i / CELLS * w, y = bwH - cells[i] / maxR * (bwH - 8);
    i ? chartCtx.lineTo(x, y) : chartCtx.moveTo(x, y);
  }
  chartCtx.strokeStyle = '#4da3ff'; chartCtx.lineWidth = 1.2; chartCtx.stroke();
  chartCtx.fillStyle = '#8b98a5'; chartCtx.font = '10px sans-serif';
  chartCtx.fillText(`带宽 (峰值 ${maxR.toFixed(0)} kbps)`, 4, 11);

  // 队列占用带
  const qY = 58, qH = 42;
  const capBytes = session.capBytes;
  chartCtx.beginPath(); chartCtx.moveTo(0, qY + qH);
  for (const s of session.queueSamples) chartCtx.lineTo(X(s.t), qY + qH - clamp(s.bytes / capBytes, 0, 1.4) / 1.4 * qH);
  chartCtx.lineTo(X(T), qY + qH); chartCtx.closePath();
  chartCtx.fillStyle = 'rgba(77,163,255,0.35)'; chartCtx.fill();
  chartCtx.strokeStyle = '#f0524a'; chartCtx.setLineDash([3, 3]);
  chartCtx.beginPath(); chartCtx.moveTo(0, qY); chartCtx.lineTo(w, qY); chartCtx.stroke(); chartCtx.setLineDash([]);
  chartCtx.fillStyle = '#8b98a5'; chartCtx.fillText('发送队列占用（虚线=容量）', 4, qY + 10);

  // 帧条带
  const fY = 106, fH = h - fY - 8;
  let maxB = 1;
  for (const f of session.frames) maxB = Math.max(maxB, f.bytes);
  const bw_ = Math.max(1, w / N - 0.6);
  for (const f of session.frames) {
    const x = X(f.t);
    const bh = f.bytes ? Math.log2(1 + f.bytes) / Math.log2(1 + maxB) * (fH - 14) : 0;
    chartCtx.fillStyle = STATUS_COLOR[f.status] || '#888';
    if (f.status === 'skipped') chartCtx.fillRect(x, fY + fH - 3, bw_, 3);
    else if (f.submitted) chartCtx.fillRect(x, fY + fH - bh, bw_, bh);
    if (f.key && f.submitted) {
      chartCtx.strokeStyle = '#41c8d4'; chartCtx.lineWidth = 1;
      chartCtx.strokeRect(x - 0.5, fY + fH - bh - 2, bw_ + 1, bh + 3);
    }
    if (f.status === 'expired' || f.status === 'overflow') {
      chartCtx.fillStyle = STATUS_COLOR[f.status];
      chartCtx.beginPath();
      chartCtx.moveTo(x, fY + 2); chartCtx.lineTo(x + 4, fY + 9); chartCtx.lineTo(x - 4, fY + 9);
      chartCtx.closePath(); chartCtx.fill();
    }
  }
  // 首个错过期限的帧：旗帜标注
  const fm = session.metrics.firstMiss;
  if (fm) {
    const x = X(fm.t);
    chartCtx.strokeStyle = '#f0524a'; chartCtx.lineWidth = 1.5;
    chartCtx.beginPath(); chartCtx.moveTo(x, fY - 2); chartCtx.lineTo(x, h - 4); chartCtx.stroke();
    chartCtx.fillStyle = '#f0524a';
    chartCtx.beginPath(); chartCtx.moveTo(x, fY - 2); chartCtx.lineTo(x + 26, fY + 3); chartCtx.lineTo(x, fY + 8); chartCtx.closePath(); chartCtx.fill();
    chartCtx.fillText(`首帧 miss #${fm.i}`, Math.min(x + 30, w - 90), fY + 6);
  }
  // 切镜线
  chartCtx.strokeStyle = 'rgba(255,255,255,0.35)';
  chartCtx.beginPath(); chartCtx.moveTo(X(CUT_T), 0); chartCtx.lineTo(X(CUT_T), h); chartCtx.stroke();
  chartCtx.fillStyle = '#8b98a5'; chartCtx.fillText('切镜', X(CUT_T) + 3, 11);

  // 播放头
  if (playhead > 0) {
    chartCtx.strokeStyle = '#ffd166'; chartCtx.lineWidth = 1.5;
    chartCtx.beginPath(); chartCtx.moveTo(X(playhead), 0); chartCtx.lineTo(X(playhead), h); chartCtx.stroke();
  }
}

function renderStats() {
  const m = session.metrics;
  const c = m.counts;
  const el = $('stats');
  const rows = [
    ['首个错过期限的帧', m.firstMiss ? `#${m.firstMiss.i} @ ${m.firstMiss.t.toFixed(2)}s` : '无', m.firstMiss ? 'bad' : 'good'],
    ['最长卡顿（含尾部在途）', `${(m.maxStall * 1000).toFixed(0)} ms`, m.maxStall > 2 / FPS ? 'bad' : 'good'],
    ['帧时延 max / avg', `${(m.maxDelay * 1000).toFixed(0)} / ${(m.avgDelay * 1000).toFixed(0)} ms`, ''],
    ['尾包在途时延', `${(m.tailInFlight * 1000).toFixed(0)} ms`, m.tailInFlight > 0.5 ? 'bad' : ''],
    ['如期呈现 / 总帧数', `${c.arrived || 0} / ${N}`, ''],
    ['过期 / 断链 / 溢出 / 弃帧', `${c.expired || 0} / ${c.broken || 0} / ${c.overflow || 0} / ${c.skipped || 0}`, (c.expired || c.overflow) ? 'bad' : ''],
    ['缓冲峰值 / 容量', `${(m.peakQueue / 1024).toFixed(0)} / ${(session.capBytes / 1024).toFixed(0)} KB`, m.peakQueue > session.capBytes ? 'bad' : 'good'],
    ['有效码率（可解码）', `${m.goodputKbps.toFixed(0)} kbps`, ''],
  ];
  el.innerHTML = rows.map(([k, v, cls]) =>
    `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  const v = $('violations');
  if (!session.violations.length) {
    v.innerHTML = `<div class="ok-line">✓ 缓冲核验通过：全程未溢出（峰值 ${(m.peakQueue / 1024).toFixed(0)} KB ≤ 容量）</div>`;
  } else {
    v.innerHTML = `<div class="bad-line">✗ 缓冲溢出违约 ${session.violations.length} 次：</div>` +
      session.violations.slice(0, 20).map((x) =>
        `<div class="bad-line">t=${x.t.toFixed(2)}s 帧#${x.frame} 写入 ${(x.bytes / 1024).toFixed(1)}KB 时队列已 ${(x.queueBytes / 1024).toFixed(0)}KB</div>`).join('');
  }
}
function capBytesVal() { return +$('capKb').value * 1024; }

function renderFrame(t) {
  const i = clamp(Math.floor(t * FPS), 0, N - 1);
  srcGen(srcCtx, i);
  decCtx.fillStyle = '#000'; decCtx.fillRect(0, 0, W, H);
  if (player) {
    const cur = player.render(t, decCtx);
    if (!cur) {
      decCtx.fillStyle = '#8b98a5'; decCtx.font = '15px sans-serif';
      decCtx.fillText('（尚无可呈现帧）', 12, 24);
    } else if (t - cur.displayT > 1.5 / FPS) {
      decCtx.fillStyle = 'rgba(240,82,74,0.92)';
      decCtx.fillRect(0, 0, W, 30);
      decCtx.fillStyle = '#fff'; decCtx.font = '14px sans-serif';
      decCtx.fillText(`卡顿 ${(t - cur.displayT).toFixed(2)}s —— 画面冻结于帧 #${session.frames.find(f => Math.round(f.i * 1e6 / FPS) === cur.ts)?.i ?? '?'}`, 8, 20);
    }
  }
  $('clock').textContent = `${t.toFixed(3)} / ${session ? session.Tend.toFixed(3) : '0.000'} s`;
  $('seekBar').value = t;
}

function tick(ts) {
  if (!playing) return;
  const dt = lastRaf ? (ts - lastRaf) / 1000 : 0;
  lastRaf = ts;
  playhead += dt * +$('speedSel').value;
  if (playhead >= session.Tend) { playhead = session.Tend; playing = false; $('playBtn').textContent = '▶ 播放'; }
  renderFrame(playhead);
  drawChart();
  if (playing) requestAnimationFrame(tick);
}

async function seekTo(t) {
  playhead = clamp(t, 0, session ? session.Tend : DUR);
  if (player) {
    await player.reset();
    player.feedTo(playhead);
    try { await player.dec.flush(); } catch (e) {}   // 等解码输出落地再渲染
  }
  renderFrame(playhead);
  drawChart();
}

/* ================= 事件绑定 ================= */
function bindUI() {
  $('avgKbps').oninput = () => { $('avgLabel').textContent = $('avgKbps').value; drawProfileEditor(); };
  $('budgetMs').oninput = () => $('budgetLabel').textContent = $('budgetMs').value;
  $('capKb').oninput = () => $('capLabel').textContent = $('capKb').value;
  $('qpFixed').oninput = () => $('qpLabel').textContent = $('qpFixed').value + '%';
  $('presetA').onclick = () => { presetA(+$('avgKbps').value); drawProfileEditor(); };
  $('presetB').onclick = () => { presetB(+$('avgKbps').value); drawProfileEditor(); };
  $('normalize').onclick = () => { normalizeTo(+$('avgKbps').value); drawProfileEditor(); };

  let editing = false;
  profCanvas.addEventListener('pointerdown', (e) => { editing = true; profileEdit(e); });
  window.addEventListener('pointermove', (e) => editing && profileEdit(e));
  window.addEventListener('pointerup', () => (editing = false));

  chart.addEventListener('pointerdown', (e) => {
    if (!session) return;
    const r = chart.getBoundingClientRect();
    seekTo((e.clientX - r.left) / r.width * session.Tend);
  });
  $('seekBar').oninput = () => { if (session) { playing = false; $('playBtn').textContent = '▶ 播放'; seekTo(+$('seekBar').value); } };
  $('playBtn').onclick = () => {
    if (!session) return;
    playing = !playing;
    $('playBtn').textContent = playing ? '⏸ 暂停' : '▶ 播放';
    if (playing) {
      if (playhead >= session.Tend - 1e-3) seekTo(0).then(() => { lastRaf = 0; requestAnimationFrame(tick); });
      else { lastRaf = 0; requestAnimationFrame(tick); }
    }
  };

  $('runBtn').onclick = async () => {
    $('runBtn').disabled = true;
    playing = false;
    const params = {
      strategy: document.querySelector('input[name=strat]:checked').value,
      budget: +$('budgetMs').value / 1000,
      capBytes: capBytesVal(),
      qpFixedPct: +$('qpFixed').value / 100,
      avgKbps: +$('avgKbps').value,
    };
    try {
      session = await runSession(params, (i) => ($('runStatus').textContent = `编码中… 帧 ${i}/${N}`));
    } catch (e) {
      $('runStatus').textContent = '运行失败：' + e.message;
      $('runBtn').disabled = false;
      return;
    }
    if (player) { try { player.dec.close(); } catch (e) {} player.clearDecoded(); }
    player = new Player(session);
    await player.init();
    playhead = 0;
    $('seekBar').max = session.Tend;
    $('seekBar').disabled = false;
    $('playBtn').disabled = false;
    renderStats();
    renderFrame(0);
    drawChart();
    $('runStatus').textContent = `完成：${session.Tend.toFixed(2)}s 会话，点击时间轴或播放查看`;
    $('runBtn').disabled = false;
  };
}

/* ================= 启动 ================= */
(async function boot() {
  if (!('VideoEncoder' in window)) {
    $('codecBadge').textContent = '✗ 当前浏览器不支持 WebCodecs';
    return;
  }
  codecSel = await pickCodec();
  if (!codecSel) {
    $('codecBadge').textContent = '✗ 无可用硬件/软件编码器';
    return;
  }
  $('codecBadge').textContent =
    `编码器：${codecSel.codec}（${codecSel.quant ? 'QP 直控' : '动态码率回退'}）· ${W}×${H}@${FPS} · 片长 ${DUR}s · 切镜@${CUT_T}s`;
  presetA(+$('avgKbps').value);
  bindUI();
  drawProfileEditor();
  srcGen(srcCtx, 0);
  decCtx.fillStyle = '#000'; decCtx.fillRect(0, 0, W, H);
  decCtx.fillStyle = '#8b98a5'; decCtx.font = '15px sans-serif';
  decCtx.fillText('运行仿真后此处显示解码端真实可呈现画面', 12, 24);
  $('runBtn').disabled = false;
  $('runStatus').textContent = '就绪';
  window.seekToDebug = seekTo;   // 供自动化测试定位
})();
