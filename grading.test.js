'use strict';
// AIクイズ 採点コアの単体テスト（依存ゼロ・Node標準の node:test / node:assert）。
// 実行: npm test  （= node --test test/）
const test = require('node:test');
const assert = require('node:assert');
const g = require('../js/grading.js');

// ── normalizeText（表記ゆれ吸収） ──────────────────────────────
test('normalizeText: 全角英数→半角＋小文字化', () => {
  assert.strictEqual(g.normalizeText('ＡＢＣ１２３'), 'abc123');
});
test('normalizeText: 下付き数字 ₀₁₂ → 012', () => {
  assert.strictEqual(g.normalizeText('x₀₁₂'), 'x012');
});
test('normalizeText: 下付き英字 aᵢⱼ → aij', () => {
  assert.strictEqual(g.normalizeText('aᵢⱼ'), 'aij');
});
test('normalizeText: 上付き x² → x^2 ＋空白除去', () => {
  assert.strictEqual(g.normalizeText('x ²'), 'x^2');
});
test('normalizeText: 角括弧→丸括弧・桁区切りカンマ無視', () => {
  assert.strictEqual(g.normalizeText('[1,000]'), '(1000)');
});
test('normalizeText strict: 大小・語間空白を保持（連続空白のみ圧縮）', () => {
  assert.strictEqual(g.normalizeText('Hello   World', true), 'Hello World');
});

// ── answerMatches（回答一致判定） ──────────────────────────────
test('answerMatches: 単純一致', () => {
  assert.ok(g.answerMatches('70年', ['70年']));
});
test('answerMatches: accept リストのいずれかに一致', () => {
  assert.ok(g.answerMatches('死後70年', ['70年', '死後70年', '70年間']));
});
test('answerMatches: 全角・空白の表記ゆれを吸収', () => {
  assert.ok(g.answerMatches(' ７０ 年 ', ['70年']));
});
test('answerMatches: 数式同値 a+b ≡ b+a', () => {
  assert.ok(g.answerMatches('a+b', ['b+a']));
});
test('answerMatches: 不一致は false', () => {
  assert.strictEqual(g.answerMatches('80年', ['70年']), false);
});
test('answerMatches strict: 大文字小文字を区別する', () => {
  assert.strictEqual(g.answerMatches('abc', ['ABC'], true), false);
  assert.ok(g.answerMatches('ABC', ['ABC'], true));
});

// ── exprCanon / mathEquiv（数式同値） ──────────────────────────
test('mathEquiv: 積の因子順を吸収 y1z2-z1y2 ≡ y1z2-y2z1', () => {
  assert.ok(g.mathEquiv('y1z2-z1y2', 'y1z2-y2z1'));
});
test('mathEquiv: 方程式の両辺入替 x=a+b ≡ a+b=x', () => {
  assert.ok(g.mathEquiv('x=a+b', 'a+b=x'));
});
test('mathEquiv: 割り算は完全一致のみ（a/b と b/a は非同値）', () => {
  assert.strictEqual(g.mathEquiv('a/b', 'b/a'), false);
});
test('exprCanon: 括弧を含む式は誤判定防止で対象外(null)', () => {
  assert.strictEqual(g.exprCanon('(a+b)'), null);
});
test('isMathExpr: 日本語混じりは数式扱いしない', () => {
  assert.strictEqual(g.isMathExpr('価格は5'), false);
});

// ── keywordGrade（記述の簡易採点） ────────────────────────────
test('keywordGrade: 全要点ヒットで 100 / correct', () => {
  const r = g.keywordGrade({ keywords: ['光合成', '二酸化炭素'] }, '光合成では二酸化炭素を使う');
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.verdict, 'correct');
});
test('keywordGrade: 一部ヒットは partial（2/3=67）', () => {
  const r = g.keywordGrade({ keywords: ['A', 'B', 'C'] }, 'A B のみ');
  assert.strictEqual(r.score, 67);
  assert.strictEqual(r.verdict, 'partial');
});
test('keywordGrade: キーワード無しは score 0', () => {
  assert.strictEqual(g.keywordGrade({ keywords: [] }, '何か').score, 0);
});

// ── normalizeTopic（SRSトピック正規化） ───────────────────────
test('normalizeTopic: NFKC＋小文字＋約物除去', () => {
  assert.strictEqual(g.normalizeTopic('（微分・積分）'), '微分積分');
  assert.strictEqual(g.normalizeTopic('Ｄｅｒｉｖ ative'), 'derivative');
});
