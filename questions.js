// AIクイズ 問題の正規化・決定論チェック（純粋関数中心・DOM非依存）。
// AIが返した問題JSONの構造補正・破綻/ネタバレ除外・出典照合。ブラウザとNodeの二重公開。
// 元は ai_quiz_app_v5.html / js/app.js 内に定義。テスト対象として切り出し（test/questions.test.js）。

const QUESTION_TYPES = ['choice', 'sort', 'order', 'fill', 'table', 'text', 'draw', 'graph'];

function normalizeQuestions(qs) {
  const valid = (qs || []).filter(q => q && q.question).map(q => {
    if (!QUESTION_TYPES.includes(q.type)) q.type = 'choice';
    q.strict = (q.strict === true); // 厳密採点フラグ（語学のスペル・大小文字等）を真偽値に正規化

    if (q.type === 'choice') {
      if (!Number.isInteger(q.correct)) q.correct = parseInt(q.correct) || 0;
      // 正解インデックスが選択肢の範囲外だと「正解が選べない」問題になるため補正
      if (Array.isArray(q.choices) && (q.correct < 0 || q.correct >= q.choices.length)) q.correct = 0;
    } else if (q.type === 'sort') {
      q.items = Array.isArray(q.items) ? q.items : [];
      q.categories = Array.isArray(q.categories) ? q.categories : [];
      q.answer = Array.isArray(q.answer) ? q.answer : [];
    } else if (q.type === 'order') {
      q.items = Array.isArray(q.items) ? q.items : [];
    } else if (q.type === 'fill') {
      q.blanks = Array.isArray(q.blanks) ? q.blanks : [];
      q.accept = Array.isArray(q.accept) ? q.accept : [];
    } else if (q.type === 'table') {
      q.rows = Array.isArray(q.rows) ? q.rows.map(row => Array.isArray(row) ? row.map(c => c == null ? '' : String(c)) : []) : [];
      q.headers = Array.isArray(q.headers) ? q.headers.map(c => c == null ? '' : String(c)) : [];
      q.blanks = Array.isArray(q.blanks)
        ? q.blanks.filter(b => b && Number.isInteger(b.r) && Number.isInteger(b.c) && q.rows[b.r] && typeof q.rows[b.r][b.c] !== 'undefined')
        : [];
    } else if (q.type === 'text') {
      q.keywords = Array.isArray(q.keywords) ? q.keywords : [];
      q.model_answer = typeof q.model_answer === 'string' ? q.model_answer : '';
    } else if (q.type === 'draw') { // β：自由描画＋AI採点
      q.keywords = Array.isArray(q.keywords) ? q.keywords : [];
      q.model_answer = typeof q.model_answer === 'string' ? q.model_answer : '';
    } else if (q.type === 'graph') { // β：格子点プロット（決定論判定）
      const gg = (q.grid && typeof q.grid === 'object') ? q.grid : {};
      q.points = Array.isArray(q.points)
        ? q.points.map(p => Array.isArray(p) ? [Math.round(Number(p[0])), Math.round(Number(p[1]))] : null)
                  .filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        : [];
      q.mode = (q.mode === 'polyline') ? 'polyline' : 'points';
      // グリッドを整数・正順に整え、全正解点が必ず範囲内（クリック可能）に入るよう拡張する
      let xmin = Number.isFinite(gg.xmin) ? Math.round(gg.xmin) : -5;
      let xmax = Number.isFinite(gg.xmax) ? Math.round(gg.xmax) : 5;
      let ymin = Number.isFinite(gg.ymin) ? Math.round(gg.ymin) : -5;
      let ymax = Number.isFinite(gg.ymax) ? Math.round(gg.ymax) : 5;
      if (xmin > xmax) { const t = xmin; xmin = xmax; xmax = t; }
      if (ymin > ymax) { const t = ymin; ymin = ymax; ymax = t; }
      q.points.forEach(p => { xmin = Math.min(xmin, p[0]); xmax = Math.max(xmax, p[0]); ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); });
      q.grid = { xmin, xmax, ymin, ymax };
    }
    return q;
  }).filter(q => {
    switch (q.type) {
      case 'choice': return Array.isArray(q.choices) && q.choices.length > 0;
      case 'sort':   return q.items.length > 0 && q.categories.length > 0 && q.answer.length === q.items.length;
      case 'order':  return q.items.length >= 2;
      case 'fill': {
        const blanksInText = (q.question.match(/[_＿]{3,}/g) || []).length;
        return q.blanks.length > 0 && blanksInText === q.blanks.length;
      }
      case 'table':  return q.rows.length > 0 && q.blanks.length > 0;
      case 'text':   return q.question.length > 0;
      case 'draw':   return q.question.length > 0;
      case 'graph':  return Array.isArray(q.points) && q.points.length > 0;
      default:       return false;
    }
  });
  if (valid.length === 0) throw new Error('AIの返答が解析できませんでした。再度お試しください。');
  return valid;
}

// ── A-1: 決定論の後段チェック（無料・追加API呼び出しなし）───────────────
// プロンプト任せの歯止め（ヒント漏れ防止・自己点検）に、機械的な「確定的な網」を足す。
// 高確度で「答えの露出」「選択肢の破綻」だけを検出し、該当問だけ除外する（再生成はしない）。
// 誤検出で良問を落としすぎないよう、しきい値は保守的に設定している。
function normLeak(s) {
  // 照合用に正規化：小文字化＋空白・区切り記号を除去（英字の大小や記号ゆれを無視）
  return String(s == null ? '' : s).toLowerCase().replace(/[\s，、。．・,.　]/g, '');
}
// 問題文から「空欄記号」と「数式($...$)」を除いた地の文（ネタバレ照合の対象）
function questionPlainText(q) {
  return normLeak(String(q.question || '').replace(/[_＿]{3,}/g, ' ').replace(/\$[^$]*\$/g, ' '));
}
// 高確度のネタバレ・破綻のみ、理由文字列で返す（問題なければ null）
function leakReason(q) {
  try {
    if (q.type === 'fill') {
      const stem = questionPlainText(q);
      for (const b of (q.blanks || [])) {
        const ans = normLeak(b);
        if (ans.length >= 2 && stem.includes(ans)) return `fill:答え「${b}」が問題文に露出`;
      }
    } else if (q.type === 'choice' && Array.isArray(q.choices)) {
      const norm = q.choices.map(normLeak);
      const ci = Number.isInteger(q.correct) ? q.correct : 0;
      const correct = norm[ci];
      // 選択肢の重複＝正解が一意に定まらない破綻
      if (correct && norm.filter(c => c && c === correct).length > 1) return 'choice:選択肢が重複';
      // 正解だけが問題文の地の文に出ていて、誤答は出ていない＝ネタバレ（誤検出を避けるため3字以上に限る）
      if (correct && correct.length >= 3) {
        const stem = questionPlainText(q);
        const inStem = norm.map(c => c.length >= 3 && stem.includes(c));
        if (inStem[ci] && inStem.filter(Boolean).length === 1) return `choice:正解「${q.choices[ci]}」が問題文に露出`;
      }
    } else if (q.type === 'sort' && Array.isArray(q.items)) {
      // 各項目に、自分の正解カテゴリ名（2字以上）がそのまま入っている＝分類がバレる
      for (let i = 0; i < q.items.length; i++) {
        const cat = q.categories[q.answer[i]];
        if (!cat) continue;
        const c = normLeak(cat);
        if (c.length >= 2 && normLeak(q.items[i]).includes(c)) return `sort:項目「${q.items[i]}」に正解カテゴリ「${cat}」が露出`;
      }
    }
  } catch {}
  return null;
}
// 構造整合の後段チェック（normalizeQuestions で担保しきれない破綻を拾う）。
// choice の correct 範囲／fill の空欄数一致／sort の answer 長／table の blank 範囲は
// normalizeQuestions が既に補正・除外済み。ここでは残る隙間だけを見る。
function integrityReason(q) {
  try {
    if (q.type === 'sort') {
      // answer の各値が実在カテゴリを指しているか（長さ一致は normalize 済み、範囲は未検証）
      const nc = (q.categories || []).length;
      for (const a of (q.answer || [])) {
        if (!Number.isInteger(a) || a < 0 || a >= nc) return 'sort:正解カテゴリのインデックスが範囲外';
      }
    }
  } catch {}
  return null;
}
// 照合用に引用/教材を強く正規化（NFKC＋小文字＋空白・約物を除去）
function normQuote(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase()
    .replace(/\s+/g, '').replace(/[、。，．・,.\-—–―\/｜|「」『』（）()\[\]"'…:：;；!！?？]/g, '');
}
// テキスト教材がある場合のみ、source.quote が実際に教材内に存在するか照合する（無料・追加API無し）。
// 一致しない引用は捏造の疑いだが、言い換え・数式・書式差での誤検出もあるため【除外せず】
// q.quoteVerified に true/false/null を記録し、警告＋出典UI表示に使う（PDF/画像教材は materialText 空 → null）。
function quoteAudit(qs) {
  try {
    const mat = (typeof storedSettings === 'object' && storedSettings && storedSettings.materialText) || '';
    if (!String(mat).trim()) return; // テキスト教材なし＝照合不可（PDF/画像）
    const normMat = normQuote(mat);
    let unverified = 0;
    for (const q of qs) {
      const quote = q && q.source && q.source.quote;
      if (typeof quote !== 'string') { if (q) q.quoteVerified = null; continue; }
      const nq = normQuote(quote);
      if (nq.length < 4) { q.quoteVerified = null; continue; } // 短すぎる引用は誤判定するので判定しない
      const ok = normMat.includes(nq);
      q.quoteVerified = ok;
      if (!ok) unverified++;
    }
    if (unverified) console.warn(`[AIQuiz] 出典照合：${unverified}問の引用(source.quote)が教材テキスト内に見つかりません（捏造/言い換えの可能性・除外はしていません）。`);
  } catch {}
}
// 破綻・ネタバレ問題を除外する。全問落ちる場合は「無いより有る」を優先し元の集合を返す（誤検出保険）。
function auditQuestions(qs) {
  const kept = [], dropped = [];
  for (const q of qs) {
    const reason = leakReason(q) || integrityReason(q);
    if (reason) dropped.push(reason); else kept.push(q);
  }
  if (dropped.length) console.warn(`[AIQuiz] 決定論チェックで${dropped.length}問を除外:`, dropped);
  quoteAudit(kept); // テキスト教材との出典照合（除外はせず q.quoteVerified に記録＋警告）
  return kept.length ? kept : qs;
}

// ── モジュール公開 ──────────────────────────────────────────────
// ブラウザ: 素の <script> 読み込みで各 function/const がグローバルになる（app.js から利用）。
//           読込順は grading.js → questions.js → app.js。
// Node   : require('./questions.js') で下記を受け取り test/ から単体テストする。
//          quoteAudit は実行時グローバル storedSettings を参照（未定義なら早期 return）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QUESTION_TYPES, normalizeQuestions, normLeak, questionPlainText, leakReason, integrityReason, normQuote, quoteAudit, auditQuestions };
}