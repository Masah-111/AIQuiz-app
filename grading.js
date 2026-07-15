// AIクイズ 採点コア（純粋関数・DOM非依存）。ブラウザとNodeの両方で使う二重公開モジュール。
// 元は ai_quiz_app_v5.html 内に定義。テスト対象として切り出し（test/grading.test.js）。

function normalizeText(s, strict) {
  const SUB_MAP = { 'ₐ':'a','ₑ':'e','ₕ':'h','ᵢ':'i','ⱼ':'j','ₖ':'k','ₗ':'l','ₘ':'m','ₙ':'n','ₒ':'o','ₚ':'p','ᵣ':'r','ₛ':'s','ₜ':'t','ᵤ':'u','ᵥ':'v','ₓ':'x','₊':'+','₋':'-','₌':'=','₍':'(','₎':')','ᵦ':'β','ᵧ':'γ','ᵨ':'ρ','ᵩ':'φ','ᵪ':'χ' };
  let t = (s || '').toString().trim()
    .replace(/[₀-₉]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x2080 + 0x30)) // 下付き数字 ₀-₉ → 0-9
    .replace(/[ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ₊₋₌₍₎ᵦᵧᵨᵩᵪ]/g, c => SUB_MAP[c]) // 下付き英字・演算子・ギリシャ → 通常文字
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); // 全角英数 → 半角（入力法の差を吸収）
  if (strict) {
    // 大文字小文字・句読点はそのまま。空白の連続のみ1つに圧縮（前後trim済み）。
    return t.replace(/[　\s]+/g, ' ');
  }
  return t.toLowerCase()
    // 上付き文字（指数）をキャレット記法に統一：x² と x^2、A⁻¹ と A^(-1) を同一視
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱˣᵀ]+/g, run => {
      const M = {'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9','⁺':'+','⁻':'-','⁼':'=','⁽':'(','⁾':')','ⁿ':'n','ⁱ':'i','ˣ':'x','ᵀ':'t'};
      const s = [...run].map(c => M[c] || '').join('');
      return s.length > 1 ? '^(' + s + ')' : '^' + s;
    })
    .replace(/[−‐-―－]/g, '-')  // 各種マイナス・ダッシュ → 半角ハイフン（※全角長音ーは対象外）
    .replace(/＋/g, '+')                        // 全角＋ → 半角+
    .replace(/[×・⋅*]/g, '')                    // 乗算記号は省略（暗黙の積として無視）
    .replace(/[\[{｛［（]/g, '(').replace(/[\]}｝］）]/g, ')') // 波括弧・角括弧・全角括弧 → 半角丸括弧に統一
    .replace(/[,，]/g, '')                           // 数値の桁区切りカンマを無視（例：10,000 = 10000）
    .replace(/[　\s]+/g, '');                        // 空白除去
}

// 数式とみなせる文字列か（ASCII英数＋演算子のみで、記号か数字を1つ以上含む）
function isMathExpr(t) {
  return !!t && /^[a-z0-9+\-*/^=().]+$/.test(t) && /[0-9+\-*/^=()]/.test(t);
}

// 数式（=を含む場合は両辺）を正規形に変換し、積の因子順・項の順序の違いを吸収する。
// 例：y1z2-z1y2 と y1z2-y2z1、a+b と b+a を同一視。
// 括弧・割り算・累乗を含む式は誤判定防止のため対象外（null を返す＝完全一致のみで判定）。
// 戻り値：「=」で分割した各辺の正規形を要素とする配列、または null。
function exprCanon(s) {
  const t = normalizeText(s);
  if (!isMathExpr(t)) return null;
  if (/[()/^]/.test(t)) return null;
  const sides = t.split('=').map(side => {
    if (side === '') return null;
    let u = (side[0] !== '+' && side[0] !== '-') ? '+' + side : side;
    const terms = [];
    const re = /([+-])([^+-]+)/g;
    let m;
    while ((m = re.exec(u)) !== null) {
      let body = m[2];
      if (/^[a-z0-9]+$/.test(body)) {
        body = (body.match(/[a-z]+[0-9]*|[0-9]+/g) || []).sort().join('*'); // 因子を並べ替え
      }
      terms.push(m[1] + body);
    }
    terms.sort();
    return terms.join('');
  });
  if (sides.some(x => x === null)) return null; // 「=0」「a=」等の不正形は対象外
  return sides;
}

// 2つの式が（順序の違いを無視して）同値か。
function mathEquiv(a, b) {
  const A = exprCanon(a), B = exprCanon(b);
  if (!A || !B) return false;
  if (A.length === 1 && B.length === 1) return A[0] === B[0];
  // 両方が方程式：A=B と B=A を同一視（両辺を並べ替えて比較）
  if (A.length === 2 && B.length === 2) {
    return A.slice().sort().join('||') === B.slice().sort().join('||');
  }
  // 片方が方程式・片方が式単体：単体が方程式の右辺と一致する場合のみ可（「p=a+td」と「a+td」を許容）
  const eq = A.length === 2 ? A : (B.length === 2 ? B : null);
  const ex = A.length === 1 ? A : (B.length === 1 ? B : null);
  if (!eq || !ex) return false;
  return ex[0] === eq[eq.length - 1];
}

// ユーザー回答が許容解リスト（生データ）のいずれかに一致するか。
// strict=true（語学向け）：大文字小文字・空白を区別する完全一致のみ（数式同値は使わない）。
// strict=false（既定）：表記揺れを吸収した一致＋数式同値で判定。
function answerMatches(userVal, acceptRawList, strict) {
  const u = normalizeText(userVal, strict);
  const list = (acceptRawList || []).filter(x => x != null).map(String);
  if (list.some(a => normalizeText(a, strict) === u)) return true;
  if (strict) return false; // 厳密モードでは表記揺れ・数式同値を許容しない
  return list.some(a => mathEquiv(userVal, a));
}

function keywordGrade(q, userAnswer) {
  const kws = (q.keywords || []).filter(Boolean);
  const u = normalizeText(userAnswer);
  if (kws.length === 0) {
    return { score: 0, verdict: 'incorrect', feedback: 'AI採点が使えないため自動採点できませんでした。模範解答と見比べて確認してください。' };
  }
  const hit = kws.filter(k => u.includes(normalizeText(k))).length;
  const score = Math.round(hit / kws.length * 100);
  const verdict = score >= 80 ? 'correct' : (score >= 50 ? 'partial' : 'incorrect');
  return { score, verdict, feedback: `要点 ${kws.length} 個中 ${hit} 個を確認しました（簡易採点）。` };
}

function normalizeTopic(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[・･,、.。\/\-‐―–—_'"「」（）()\[\]]/g, '')
    .trim();
}

// ── モジュール公開 ──────────────────────────────────────────────
// ブラウザ: 素の <script> 読み込みで各 function がグローバルになる（app.js から利用）。
// Node   : require('./grading.js') で下記を受け取り、test/ から単体テストする。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeText, isMathExpr, exprCanon, mathEquiv, answerMatches, keywordGrade, normalizeTopic };
}