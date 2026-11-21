'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BudgetLedger } from '../core/ledger.js';
import { makeFrame } from '../core/model.js';

function frame(id, bytes) {
  return makeFrame({ id, bytes });
}

test('reserved 模式：提交预留，反馈按实耗做差额校正', () => {
  const l = new BudgetLedger('reserved');
  const f = frame(1, 4000);                 // 实耗 32000 bit
  l.reserve(1, 40000, 0);
  assert.equal(l.earmarkedBits(), 40000);
  assert.equal(l.grantedBits, 40000);

  l.settleFrame(f, 0.1);
  assert.equal(l.chargedBits, 32000);
  assert.equal(l.earmarkedBits(), 0);
  const d = l.frameDelta(1);
  assert.equal(d.delta, -8000);             // 实耗低于预留
  assert.equal(l.attribution.filter((a) => a.frameId === 1).length, 2);
  l.checkInvariant();
});

test('reserved 模式：超支帧产生正差额，欠账为正', () => {
  const l = new BudgetLedger('reserved');
  const f = frame(2, 6000);                 // 48000 bit 实耗
  l.reserve(2, 30000, 0);
  l.settleFrame(f, 0.1);
  const d = l.frameDelta(2);
  assert.equal(d.delta, 18000);
  assert.equal(l.debtBits(), 18000);
});

test('feedback 模式：提交不占账，反馈逐笔销账，全部反馈后欠账归零', () => {
  const l = new BudgetLedger('feedback');
  l.reserve(3, 99999, 0);
  assert.equal(l.earmarkedBits(), 0);
  assert.equal(l.grantedBits, 0);
  l.settleFrame(frame(3, 5000), 0.2);
  assert.equal(l.chargedBits, 40000);
  assert.equal(l.debtBits(), 0);             // 该帧已反馈，欠账销掉
  assert.ok(l.attribution.some((a) => a.kind === 'charge'));
});

test('feedback 模式：已发出未反馈的在途字节计入欠账', () => {
  const l = new BudgetLedger('feedback');
  // 帧 A 已反馈，帧 B 仍在途（只记账未结算）
  l.settleFrame(frame(30, 5000), 0.1);
  l.chargedBits += 3000 * 8;                 // 帧 B 的在途实耗先入实扣
  assert.equal(l.debtBits(), 3000 * 8);      // 仅未反馈部分是欠账
});

test('重复反馈幂等：同一帧只扣一次账', () => {
  for (const mode of ['reserved', 'feedback']) {
    const l = new BudgetLedger(mode);
    const f = frame(4, 2000);
    l.reserve(4, 30000, 0);
    l.settleFrame(f, 0.1);
    const chargedOnce = l.chargedBits;
    l.settleFrame(f, 0.15);
    l.settleFrame(f, 0.2);
    assert.equal(l.chargedBits, chargedOnce, `${mode} 不得二次扣账`);
    assert.equal(l.duplicateFeedback, 2, `${mode} 记录两次重复反馈`);
    assert.equal(f.settledBytes, 2000);
  }
});

test('丢弃退款：只退仍占用的预留，退完即止', () => {
  const l = new BudgetLedger('reserved');
  const refunded = l.refund(5, 0.05, 50000);
  assert.equal(refunded, 0);                // 无预留可退
  l.reserve(5, 30000, 0);
  const r = l.refund(5, 0.1, 50000);
  assert.equal(r, 30000);
  assert.equal(l.earmarkedBits(), 0);
  assert.equal(l.refundedBits, 30000);
  assert.equal(l.refund(5, 0.2, 1000), 0);
  l.checkInvariant();
});

test('快照恢复后账目一致', () => {
  const l = new BudgetLedger('reserved');
  l.reserve(6, 20000, 0);
  l.reserve(7, 15000, 0.01);
  const snap = l.snapshot();
  l.settleFrame(frame(6, 3000), 0.1);
  l.restore(snap);
  assert.equal(l.earmarkedBits(), 35000);
  assert.equal(l.chargedBits, 0);
  assert.equal(l.attribution.length, 2);
});
