'use strict';
// AIクイズ 問題正規化・検査の単体テスト（依存ゼロ・Node標準の node:test / node:assert）。
// 実行: npm test  （= node --test test/）
const test = require('node:test');
const assert = require('node:assert');
const q = require('./questions.js');

// ── normalizeQuestions（構造の補正・破綻の除外） ──────────────
test('normalizeQuestions: choice の正解インデックス範囲外は 0 に補正', () => {
  const r = q.normalizeQuestions([{ type: 'choice', question: 'Q', choices: ['a', 'b'], correct: 5 }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].correct, 0);
});
test('normalizeQuestions: 文字列の correct は整数化', () => {
  const r = q.normalizeQuestions([{ type: 'choice', question: 'Q', choices: ['a', 'b', 'c'], correct: '1' }]);
  assert.strictEqual(r[0].correct, 1);
});
test('normalizeQuestions: 未知の type は choice に補正', () => {
  const r = q.normalizeQuestions([{ type: 'weird', question: 'Q', choices: ['a'], correct: 0 }]);
  assert.strictEqual(r[0].type, 'choice');
});
test('normalizeQuestions: strict は真偽値に正規化', () => {
  const r = q.normalizeQuestions([
    { type: 'text', question: 'Q1', keywords: ['k'], strict: 'yes' },
    { type: 'text', question: 'Q2', keywords: ['k'], strict: true },
  ]);
  assert.strictEqual(r[0].strict, false);
  assert.strictEqual(r[1].strict, true);
});
test('normalizeQuestions: fill は 空欄記号の数 = blanks 数 でなければ除外', () => {
  assert.strictEqual(
    q.normalizeQuestions([{ type: 'fill', question: 'A ___ B ___', blanks: ['x', 'y'] }]).length, 1);
  assert.throws(() =>
    q.normalizeQuestions([{ type: 'fill', question: 'A ___ B', blanks: ['x', 'y'] }]));
});
test('normalizeQuestions: order は項目2つ未満で除外', () => {
  assert.throws(() => q.normalizeQuestions([{ type: 'order', question: 'Q', items: ['a'] }]));
  assert.strictEqual(
    q.normalizeQuestions([{ type: 'order', question: 'Q', items: ['a', 'b'] }]).length, 1);
});
test('normalizeQuestions: 有効問が0なら例外', () => {
  assert.throws(() => q.normalizeQuestions([]));
  assert.throws(() => q.normalizeQuestions([{ foo: 1 }]));
});
test('normalizeQuestions: 有効・無効混在は有効のみ残す', () => {
  const r = q.normalizeQuestions([
    { type: 'choice', question: 'ok', choices: ['a', 'b'], correct: 0 },
    { type: 'choice', question: 'ng', choices: [], correct: 0 },
  ]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].question, 'ok');
});

// ── leakReason（ネタバレ・破綻の高確度検出） ──────────────────
test('leakReason: fill の答えが問題文に露出', () => {
  assert.match(q.leakReason({ type: 'fill', question: '首都は東京', blanks: ['東京'] }) || '', /露出/);
});
test('leakReason: fill で答えが問題文に無ければ null', () => {
  assert.strictEqual(q.leakReason({ type: 'fill', question: '首都は___', blanks: ['東京'] }), null);
});
test('leakReason: choice の選択肢重複を検出', () => {
  assert.match(q.leakReason({ type: 'choice', question: 'Q', choices: ['a', 'a', 'b'], correct: 0 }) || '', /重複/);
});
test('leakReason: choice の正解だけ問題文に露出', () => {
  assert.match(q.leakReason({ type: 'choice', question: '答えは光合成です', choices: ['光合成', '呼吸', '蒸散'], correct: 0 }) || '', /露出/);
});
test('leakReason: sort の項目に正解カテゴリ名が露出', () => {
  assert.match(q.leakReason({ type: 'sort', question: 'Q', items: ['哺乳類の犬'], categories: ['哺乳類', '鳥類'], answer: [0] }) || '', /露出/);
});
test('leakReason: 健全な choice は null', () => {
  assert.strictEqual(q.leakReason({ type: 'choice', question: 'これは何色？', choices: ['赤', '青', '緑'], correct: 0 }), null);
});

// ── integrityReason（構造整合の隙間） ─────────────────────────
test('integrityReason: sort の正解カテゴリindexが範囲外', () => {
  assert.match(q.integrityReason({ type: 'sort', categories: ['A', 'B'], answer: [0, 5] }) || '', /範囲外/);
});
test('integrityReason: 正常な sort は null', () => {
  assert.strictEqual(q.integrityReason({ type: 'sort', categories: ['A', 'B'], answer: [0, 1] }), null);
});

// ── normQuote / quoteAudit（出典照合） ────────────────────────
test('normQuote: 空白・約物除去＋小文字化', () => {
  assert.strictEqual(q.normQuote('A, B. C'), 'abc');
});
test('quoteAudit: 教材に存在する引用は true / 不在は false / 無しは null', () => {
  global.storedSettings = { materialText: '光合成は二酸化炭素と水から酸素を作る反応である。' };
  try {
    const qs = [
      { source: { quote: '二酸化炭素と水' } },   // 教材にある
      { source: { quote: '核分裂の連鎖反応' } }, // 教材に無い
      { source: {} },                            // quote 無し
    ];
    q.quoteAudit(qs);
    assert.strictEqual(qs[0].quoteVerified, true);
    assert.strictEqual(qs[1].quoteVerified, false);
    assert.strictEqual(qs[2].quoteVerified, null);
  } finally {
    delete global.storedSettings;
  }
});
test('quoteAudit: テキスト教材が無ければ照合しない（例外を出さない）', () => {
  delete global.storedSettings;
  const qs = [{ source: { quote: '何か' } }];
  assert.doesNotThrow(() => q.quoteAudit(qs));
  assert.strictEqual(qs[0].quoteVerified, undefined); // 未照合＝プロパティを触らない
});

// ── auditQuestions（破綻/ネタバレ問を除外・全滅時は元集合） ───
test('auditQuestions: ネタバレ問を落として健全問を残す', () => {
  const good = { type: 'choice', question: 'これは何色？', choices: ['赤', '青', '緑'], correct: 0 };
  const leaky = { type: 'fill', question: '首都は東京', blanks: ['東京'] };
  const r = q.auditQuestions([good, leaky]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0], good);
});
test('auditQuestions: 全問が落ちる場合は「無いより有る」で元集合を返す', () => {
  const leaky = { type: 'fill', question: '首都は東京', blanks: ['東京'] };
  const r = q.auditQuestions([leaky]);
  assert.strictEqual(r.length, 1); // 除外せず元のまま
});
