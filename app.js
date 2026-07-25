const LABELS = ['A','B','C','D','E'];

// ウィジェット（Claudeアーティファクト）内かどうかを判定。
// アーティファクト内では window.claude.complete（テキストのみ）を使い、
// 単体HTMLとして開いた場合は Anthropic API を直接呼び出す。
const IS_WIDGET = typeof window !== 'undefined' && window.claude && typeof window.claude.complete === 'function';

let uploadedFiles = [];
let questions = [];
let currentQ = 0;
let correctCount = 0;
let wrongCount = 0;
let currentDifficulty = 'medium';
let history = [];
let answered = false;
let storedSettings = {};

// ─── コスト/安全管理 ────────────────────────────────────────────
let isGenerating = false;   // AI生成中フラグ（二重リクエスト＝二重課金の防止）
let genCount = 0;           // このセッションでの生成回数（コスト把握用）
let quizKind = 'normal';    // 今のクイズの種別（normal / retake / similar）履歴記録用
const MAX_UPLOAD_MB = 28;   // 1リクエストの合計アップロード上限の目安（APIは約32MB）

// クイズ1回分の実行状態を初期化する。全エントリ（startQuiz/startExam/startQuizFromQuestions/
// redoSameQuiz/retakeQuiz/startSimilarQuiz）から共通で呼ぶことで、グローバルの初期化漏れ
// （＝機能の継ぎ目で起きやすい結合バグ）を防ぐ。currentDifficulty は各所で個別に設定する。
function resetRunState() {
  currentQ = 0; correctCount = 0; wrongCount = 0; history = [];
  answered = false; activeMathInput = null;
  resetGradeCost(); // 採点コストの累計を新しいクイズ/試験ぶんに戻す
}

// ─── 共通ダイアログ（ネイティブ alert/confirm をアプリのUIに統一） ──────────
// Promise ベース：uiAlert(...) は閉じたら resolve、uiConfirm(...) は true/false を resolve。
// 見た目は既存の .modal-overlay / .modal-box / .notice-foot を流用。呼び出し側は
//   await uiConfirm('…', { okText:'実行', cancelText:'やめる' })
// のように使う（alert は await 不要。ただしリロード/遷移の直前だけ await する）。
let _dlgResolve = null;
function _ensureDialogEl() {
  let ov = document.getElementById('app-dialog');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'app-dialog';
  ov.innerHTML =
    '<div class="modal-box" style="width:min(440px,100%);">' +
      '<div class="modal-head"><div><div class="modal-title" id="app-dialog-title"></div></div></div>' +
      '<div class="notice-body" style="padding:18px 22px;"><p id="app-dialog-msg" style="margin:0; white-space:pre-wrap; line-height:1.7;"></p></div>' +
      '<div class="notice-foot" id="app-dialog-foot" style="justify-content:flex-end;"></div>' +
    '</div>';
  document.body.appendChild(ov);
  return ov;
}
function _closeDialog(result) {
  const ov = document.getElementById('app-dialog');
  if (ov) ov.classList.remove('show');
  try { syncBodyScrollLock(); } catch (e) {}
  const r = _dlgResolve; _dlgResolve = null;
  if (r) r(result);
}
function _openDialog(opts) {
  return new Promise(resolve => {
    // 直前のダイアログが残っていたら、その約束を（安全側で）解決してから開く（多重表示防止）
    if (_dlgResolve) { const prev = _dlgResolve; _dlgResolve = null; try { prev(opts.type === 'confirm' ? false : undefined); } catch (e) {} }
    const ov = _ensureDialogEl();
    ov.querySelector('#app-dialog-title').textContent = opts.title || (opts.type === 'confirm' ? '確認' : 'お知らせ');
    ov.querySelector('#app-dialog-msg').textContent = opts.message || '';
    const foot = ov.querySelector('#app-dialog-foot');
    foot.innerHTML = '';
    _dlgResolve = resolve;
    if (opts.type === 'confirm') {
      const cancel = document.createElement('button');
      cancel.className = 'btn-secondary'; cancel.style.cssText = 'padding:8px 16px;';
      cancel.textContent = opts.cancelText || 'キャンセル';
      cancel.onclick = () => _closeDialog(false);
      foot.appendChild(cancel);
    }
    const ok = document.createElement('button');
    ok.className = 'btn-primary'; ok.style.cssText = 'padding:8px 16px;';
    ok.textContent = opts.okText || 'OK';
    ok.onclick = () => _closeDialog(opts.type === 'confirm' ? true : undefined);
    foot.appendChild(ok);
    // オーバーレイ外クリック：alert は閉じる／confirm は誤操作防止で閉じない
    ov.onclick = ev => { if (ev.target === ov && opts.type !== 'confirm') _closeDialog(undefined); };
    requestAnimationFrame(() => {
      ov.classList.add('show');
      try { syncBodyScrollLock(); } catch (e) {}
      try { ok.focus(); } catch (e) {}
    });
  });
}
// Esc / Enter のキー操作（Esc=confirmはキャンセル・alertは閉じる／Enter=OK）
document.addEventListener('keydown', e => {
  if (!_dlgResolve) return;
  const ov = document.getElementById('app-dialog');
  if (!ov || !ov.classList.contains('show')) return;
  if (e.key === 'Escape') {
    const isConfirm = !!ov.querySelector('#app-dialog-foot .btn-secondary');
    _closeDialog(isConfirm ? false : undefined);
  } else if (e.key === 'Enter') {
    const isConfirm = !!ov.querySelector('#app-dialog-foot .btn-secondary');
    _closeDialog(isConfirm ? true : undefined);
  }
});
function uiAlert(message, opts) { return _openDialog(Object.assign({ type: 'alert', message: message }, opts || {})); }
function uiConfirm(message, opts) { return _openDialog(Object.assign({ type: 'confirm', message: message }, opts || {})); }

// ネイティブ alert をアプリ内モーダルへ置き換える（既存の多数の alert(...) 呼び出しをそのまま活かす）。
// 非ブロッキングなので「表示後すぐ return」する用途はそのままで安全。ページ再読み込み等の直前だけ
// 例外的に await uiAlert(...) を使う。confirm は同期APIのため置換できず、呼び出し側を await uiConfirm(...) に変更している。
try { window.alert = function (m) { return uiAlert(m); }; } catch (e) {}

// ─── FILE UPLOAD ───────────────────────────────────────────────
const fileInput = document.getElementById('file-input');
const uploadZone = document.getElementById('upload-zone');
const fileList = document.getElementById('file-list');

fileInput.addEventListener('change', e => handleFiles(Array.from(e.target.files)));

uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  handleFiles(Array.from(e.dataTransfer.files));
});

// AIに送れるファイル形式（Anthropic APIが受け付けるもの）。HEIC等は非対応。
const SUPPORTED_UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
// 一度にストックできる元ファイル数の上限（再開時の復元用にこの数だけ保持できる）
const MAX_FILES = 3;

function handleFiles(files) {
  let rejected = [], dup = [], overLimit = false;
  files.forEach(file => {
    if (uploadedFiles.find(f => f.name === file.name)) { dup.push(file.name); return; }
    // ウィジェットモードでは出典表示用なので形式は問わない。直接API送信時のみ形式を確認する。
    if (!IS_WIDGET && !SUPPORTED_UPLOAD_TYPES.includes(file.type)) { rejected.push(file.name); return; }
    if (uploadedFiles.length >= MAX_FILES) { overLimit = true; return; }
    uploadedFiles.push(file);
  });
  let msg = '';
  if (rejected.length) {
    msg += '次のファイルはAIに送れない形式のため除外しました：\n' + rejected.join('\n') +
      '\n\n対応形式は PDF・JPEG・PNG・GIF・WebP です。\niPhoneの写真（HEIC形式）は、JPEGで保存し直すか、スクリーンショットを撮ってからアップロードしてください。';
  }
  if (dup.length) {
    msg += (msg ? '\n\n' : '') + '同じ名前のファイルが追加済みのため除外しました：\n' + dup.join('\n');
  }
  if (overLimit) {
    msg += (msg ? '\n\n' : '') + 'ファイルは最大' + MAX_FILES + 'つまでです。超過分は追加されませんでした。';
  }
  if (msg) alert(msg);
  clearFigureCaches();
  renderFileList();
  refreshPoolUI(); // このファイルの無料プールがあればバナー表示（大きめPDFの再学習用）
}

function renderFileList() {
  fileList.innerHTML = '';
  uploadedFiles.forEach((file, i) => {
    const isPDF = file.type === 'application/pdf';
    const icon = isPDF ? '📄' : '';
    const iconClass = isPDF ? 'pdf' : 'img';
    const size = file.size < 1024*1024 ? Math.round(file.size/1024)+'KB' : (file.size/(1024*1024)).toFixed(1)+'MB';
    const div = document.createElement('div');
    div.className = 'uploaded-file';
    div.innerHTML = `
      <div class="file-icon ${iconClass}">${icon}</div>
      <div class="file-name">${escapeHtml(file.name)}</div>
      <div class="file-size">${size}</div>
      <button class="remove-file" onclick="removeFile(${i})">✕</button>
    `;
    fileList.appendChild(div);
  });
}

function removeFile(i) {
  uploadedFiles.splice(i, 1);
  clearFigureCaches();
  renderFileList();
  refreshPoolUI();
}

// ─── SCREEN CONTROL ────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  // 統計バーはクイズ中のみ／数式キーボードはクイズ・試験中のみ表示
  if (id !== 'screen-quiz') {
    document.getElementById('global-stats-bar').classList.remove('visible');
  }
  if (id !== 'screen-quiz' && id !== 'screen-exam') {
    setMathToolsVisible(false);
  }
  // 試験画面から離れたらタイマーを止める（別画面で自動採点が走らないように）
  if (id !== 'screen-exam') { try { clearInterval(examTimer); } catch (e) {} }
  // アップロード画面に戻ったら、再開バナー・苦手復習バナーを更新
  if (id === 'screen-upload') { checkResume(); checkSRS(); refreshPoolUI(); }
}

// ─── START QUIZ ────────────────────────────────────────────────
async function startQuiz() {
  const materialText = document.getElementById('material-text').value.trim();
  if (IS_WIDGET) {
    if (!materialText) {
      alert('教材テキストを貼り付けてください。（ウィジェット内ではAIに画像・PDFを渡せないため、本文のコピペが必要です）');
      return;
    }
  } else if (uploadedFiles.length === 0 && !materialText) {
    alert('教材ファイルをアップロードするか、教材テキストを貼り付けてください。');
    return;
  }

  storedSettings = {
    qCount: Math.min(20, Math.max(1, parseInt(document.getElementById('q-count').value) || 5)),
    difficulty: document.getElementById('difficulty').value,
    choiceCount: parseInt(document.getElementById('choice-count').value),
    focus: document.getElementById('focus').value,
    orderMode: document.getElementById('order-mode').value,
    answerFormat: document.getElementById('answer-format').value,
    materialText: materialText,
    apiKey: document.getElementById('api-key').value.trim(),
    extra: document.getElementById('extra-prompt').value.trim(),
    mode: (document.getElementById('quiz-mode') || {}).value || 'normal',
    examMinutes: parseInt((document.getElementById('exam-minutes') || {}).value) || 30
  };
  try { if (storedSettings.apiKey) localStorage.setItem('aiquiz_api_key', storedSettings.apiKey); } catch {}

  // 既存プールがある／大きめPDF → プール方式（無料出題 or バックグラウンド作成）で処理し、通常生成を抜ける
  if (!IS_WIDGET) {
    try { if (await maybeHandlePoolFlow(storedSettings)) return; }
    catch (e) { console.error(e); }
  }

  if (!(await preGenerateGuard(storedSettings, { confirmCost: true }))) return;

  currentDifficulty = storedSettings.difficulty;
  resetRunState();

  quizKind = 'normal';
  isGenerating = true;
  setStartBtnBusy(true);
  showScreen('screen-loading');
  setLoadingMsg('AIが教材を解析中', '内容を読み取っています');

  try {
    setLoadingMsg('問題を生成中', '最適な問題を作成しています');
    questions = await generateQuestions(storedSettings);
    genCount++;
    if (storedSettings.orderMode === 'ascending') {
      const diffOrder = { easy: 0, medium: 1, hard: 2 };
      questions.sort((a, b) => (diffOrder[a.difficulty] ?? 1) - (diffOrder[b.difficulty] ?? 1));
    }
    await persistResumeFiles(); // 再開時に図・出典を復元できるよう、元ファイルを一時保存
    enterQuiz(); // モード（通常/試験）に応じて出題を開始
  } catch(e) {
    console.error(e);
    alert('エラーが発生しました: ' + e.message);
    showScreen('screen-upload');
  } finally {
    isGenerating = false;
    setStartBtnBusy(false);
  }
}

function setLoadingMsg(title, sub) {
  document.getElementById('loading-title').textContent = title;
  document.getElementById('loading-sub').textContent = sub;
}

// ─── COST / SAFETY GUARD ───────────────────────────────────────
// 概算コストのざっくりレンジ（教材MBと出題数から）
function estimateCostLabel(mb, qn) {
  if (mb >= 8 || qn >= 15) return 'およそ十数円〜数十円';
  if (mb >= 3 || qn >= 8)  return 'およそ数円〜十数円';
  return 'およそ数円程度';
}

// 生成前の安全チェック：二重実行防止・サイズ上限・コスト確認。実行してよければ true。
// コスト確認ダイアログが非同期（uiConfirm）になったため async。呼び出し側は await すること。
async function preGenerateGuard(settings, opts) {
  opts = opts || {};
  if (isGenerating) return false; // 既に生成中なら無視（二重課金防止）
  // 問題プールをバックグラウンド作成中は、別の有料生成を走らせない（同時課金・処理交錯の防止）。
  // ※ プール作成自体の初回バッチは poolBuildActive を立てる前に本ガードを通るのでブロックされない。
  if (poolBuildActive) {
    alert('問題プールをバックグラウンドで作成中です。完成までお待ちください（進捗は画面上部に表示されます）。\n作成中のプールからは「無料で出題」も選べます。');
    return false;
  }

  if (!IS_WIDGET) {
    const totalBytes = uploadedFiles.reduce((s, f) => s + f.size, 0);
    const mb = totalBytes / (1024 * 1024);
    if (mb > MAX_UPLOAD_MB) {
      alert(`アップロードの合計が ${mb.toFixed(1)}MB で、1回の上限（約${MAX_UPLOAD_MB}MB）を超えています。\nファイルを減らすか、ページを分割してください。`);
      return false;
    }
    // コスト確認：初回、または大きめの教材/多めの出題のときに確認
    // Gemini（無料枠）キー時は「Anthropicに課金」の確認は出さない（誤案内になるため）
    const qn = settings.qCount;
    const big = mb >= 5 || qn >= 12;
    if (opts.confirmCost && !isGeminiKey(settings.apiKey) && (genCount === 0 || big)) {
      const est = estimateCostLabel(mb, qn);
      const ok = await uiConfirm(
        'AIに問題生成をリクエストします（有料）。\n\n' +
        '・教材：' + (mb > 0 ? mb.toFixed(1) + 'MB のファイル' : 'テキストのみ') + '\n' +
        '・出題数：' + qn + '問\n' +
        '・概算コスト：' + est + '\n\n' +
        'あなたのAnthropicアカウントに課金されます。実行しますか？',
        { okText: '生成する', cancelText: 'やめる' }
      );
      if (!ok) return false;
    }
  }
  return true;
}

function setStartBtnBusy(busy) {
  const b = document.getElementById('start-btn');
  if (!b) return;
  b.disabled = busy;
  b.innerHTML = busy ? '<span></span> 生成中…' : '<span></span> AIで問題を生成する';
}

// ─── MODEL RESOLUTION (廃止モデルの自動追従) ────────────────────
const PREFERRED_MODEL = 'claude-sonnet-5'; // 既定モデル。新モデルに乗り換えるときはここを変更
let activeModel = PREFERRED_MODEL;           // 実際に使うモデル（廃止時は自動で切り替わる）
let modelChecked = false;                    // このセッションで確認済みか

// ─── プロバイダ判定（最小プロトタイプ：キーの接頭辞で自動振り分け） ──────────────
// Anthropic のキーは "sk-ant-…"（sk- で始まる）で安定している。一方 Google(Gemini) のキーは
// "AIza…" や "AQ.…" など形式が複数あり得るため、接頭辞の列挙では取りこぼす。
// そこで「sk- で始まらない非空のキー＝Gemini」とみなす（この2プロバイダ構成での堅牢な判定）。
// 正式なプロバイダ選択UIは、品質確認後（設計B）で導入する予定。
const GEMINI_MODEL = 'gemini-flash-latest'; // 既定（ローリング別名）。実行時に利用可能モデルへ自動追従
let geminiModel = GEMINI_MODEL;             // 実際に使う Gemini モデル（resolveGeminiModel で解決）
let geminiModelChecked = false;             // このセッションで確認済みか
function isGeminiKey(k) { k = (k || '').trim(); return !!k && !/^sk-/i.test(k); }

// Gemini の利用可能モデルを問い合わせ、generateContent 対応の Flash 系を自動選択する。
// モデル名は時々廃止される（例：gemini-2.5-flash が新規ユーザー不可に）ため、名前を決め打ちせず
// ListModels から実在するものを選ぶ（Anthropic の resolveActiveModel と同じ方針）。セッション中1回。
async function resolveGeminiModel(apiKey, force) {
  if (geminiModelChecked && !force) return geminiModel;
  try {
    const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(apiKey));
    if (resp.ok) {
      const data = await resp.json();
      const names = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => (m.name || '').replace(/^models\//, ''));
      const pick =
        names.find(n => /flash/i.test(n) && /latest/i.test(n)) ||                       // ローリング別名の flash
        names.find(n => /flash/i.test(n) && !/lite|preview|exp|thinking/i.test(n)) ||   // 安定版 flash
        names.find(n => /flash/i.test(n)) ||                                            // 何かしらの flash
        names.find(n => /gemini/i.test(n)) ||                                           // gemini 系
        names[0];
      if (pick) { geminiModel = pick; geminiModelChecked = true; console.log('[AIQuiz] Geminiモデル自動選択:', geminiModel); }
    }
  } catch (e) { /* 取得できなくても既定(geminiModel)で続行 */ }
  return geminiModel;
}

// Models APIで利用可能モデルを確認し、既定が廃止されていれば自動で現行モデルに切り替える
async function resolveActiveModel(apiKey, force) {
  if (IS_WIDGET || !apiKey) return activeModel;       // ウィジェットはブリッジ任せ
  if (modelChecked && !force) return activeModel;     // セッション中は1回だけ確認
  try {
    const resp = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      }
    });
    if (resp.ok) {
      const data = await resp.json();
      const ids = (data.data || []).map(m => m.id).filter(Boolean);
      if (ids.length) {
        if (ids.includes(PREFERRED_MODEL)) {
          activeModel = PREFERRED_MODEL;
        } else {
          // 既定が廃止 → sonnet系の最新、無ければ一覧の先頭を採用
          activeModel = ids.find(id => /sonnet/i.test(id)) || ids[0];
          console.warn('[AIQuiz] 既定モデル', PREFERRED_MODEL, 'は利用不可。', activeModel, 'に自動切替しました。');
        }
        modelChecked = true;
        setModelStatus();
      }
    }
  } catch (e) {
    // 確認できなくても既定モデルで続行（通信制限など）
  }
  return activeModel;
}

function setModelStatus() {
  const el = document.getElementById('model-status');
  if (!el) return;
  if (!modelChecked) { el.textContent = ''; return; }
  if (activeModel === PREFERRED_MODEL) {
    el.style.color = 'var(--text3)';
    el.textContent = '使用モデル：' + activeModel + '（現行・利用可）';
  } else {
    el.style.color = 'var(--amber)';
    el.textContent = '既定モデルが利用できないため ' + activeModel + ' に自動切替しました。';
  }
}

// ─── CONNECTION TEST (file:// 等での接続/キー確認) ──────────────
function setConnStatus(msg, kind) {
  const el = document.getElementById('conn-status');
  if (!el) return;
  const colors = { ok: 'var(--green)', err: 'var(--red)', warn: 'var(--amber)', info: 'var(--text2)' };
  el.style.color = colors[kind] || 'var(--text2)';
  el.textContent = msg;
}

async function testConnection() {
  const key = document.getElementById('api-key').value.trim();
  if (!key) { setConnStatus('APIキーを入力してからテストしてください。', 'warn'); return; }
  const btn = document.getElementById('test-conn-btn');
  if (btn) btn.disabled = true;
  setConnStatus('接続テスト中…', 'info');
  // Gemini キー（sk- 以外）なら Gemini の疎通確認（最小プロトタイプ）
  if (isGeminiKey(key)) {
    try {
      await resolveGeminiModel(key, true); // 利用可能モデルへ自動追従（廃止モデル回避）
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${encodeURIComponent(key)}`;
      const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 8 } }) });
      if (resp.ok) {
        setConnStatus('✓ 接続OK（Gemini：' + geminiModel + '）。このキーで問題を生成できます。', 'ok');
        setTimeout(collapseApiKey, 1200);
      } else {
        const err = await resp.json().catch(() => ({}));
        const m = (err.error && err.error.message) || ('HTTP ' + resp.status);
        setConnStatus('✗ Geminiエラー：' + m, 'err');
      }
    } catch (e) {
      setConnStatus('✗ 接続できませんでした（' + (e.message || e) + '）。file:// やキーのリファラ制限が原因のことがあります。', 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
    return;
  }
  try {
    await resolveActiveModel(key, true); // 既定モデルの生存確認＋必要なら自動切替
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: activeModel,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }]
      })
    });
    if (resp.ok) {
      setConnStatus('✓ 接続OK。このブラウザから問題を生成できます。', 'ok');
      setTimeout(collapseApiKey, 1200); // 成功メッセージを少し見せてから入力欄を畳む
    } else {
      const err = await resp.json().catch(() => ({}));
      const m = (err.error && err.error.message) || ('HTTP ' + resp.status);
      if (resp.status === 401) {
        setConnStatus('✗ APIキーが無効です（401）。キーを確認してください。', 'err');
      } else if (/credit|balance|billing/i.test(m)) {
        setConnStatus('✗ クレジット残高が不足しています。Billingでチャージしてください。', 'err');
      } else {
        setConnStatus('✗ エラー：' + m, 'err');
      }
    }
  } catch (e) {
    setConnStatus('✗ 接続できませんでした（' + (e.message || e) + '）。ファイルを直接(file://)開いた場合、ブラウザの制限で通信が遮断されることがあります。簡易ローカルサーバー経由で開くと解決します。', 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─── FILE READING ──────────────────────────────────────────────
async function readFiles(files) {
  const results = [];
  for (const file of files) {
    const isPDF = file.type === 'application/pdf';
    const data = await fileToBase64(file);
    results.push({
      type: isPDF ? 'document' : 'image',
      mediaType: file.type,
      data,
      name: file.name
    });
  }
  return results;
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = () => rej(new Error('ファイルの読み込みに失敗しました'));
    r.readAsDataURL(file);
  });
}

// ─── AI QUESTION GENERATION ────────────────────────────────────
// 出題生成の入口：実行環境に応じてウィジェット用／API用に振り分ける
async function generateQuestions(settings, similarTo, filesArg, opts) {
  if (IS_WIDGET) return generateQuestionsWidget(settings, similarTo);
  if (isGeminiKey(settings.apiKey)) return generateQuestionsGemini(settings, similarTo, filesArg, opts); // 最小プロトタイプ
  return generateQuestionsAPI(settings, similarTo, filesArg, opts);
}

// システムプロンプト（両モード共通）
function buildSystemPrompt() {
  let sp = `あなたは優秀な教育AIです。アップロードされた教材（教科書・参考書・過去問の画像・PDF・テキスト）を読み取り、指定された条件に従って学習問題を生成してください。

必ず以下のJSON形式のみで返答してください（他のテキストは一切含めないこと）：
{
  "questions": [
    {
      "type": "choice",
      "question": "問題文（具体的かつ明確に）",
      "choices": ["選択肢A", "選択肢B", "選択肢C", "選択肢D"],
      "correct": 0,
      "explanation": "正解の解説（なぜその答えが正しいか、他の選択肢が違う理由も含めて2〜4文で）",
      "difficulty": "easy|medium|hard",
      "topic": "この問題のトピック名",
      "figure_svg": "（任意）問題の理解に図が役立つ場合のみ、SVG文字列",
      "figure_ref": { "file": 0, "page": 1, "bbox": [0.1, 0.2, 0.6, 0.5] },
      "source": { "file": 0, "page": 1, "section": "参照箇所（章・節・見出し・問題番号など）", "quote": "教材からの短い引用（30字以内）" }
    },
    {
      "type": "sort",
      "question": "仕分け問題の指示文（例：次の項目を正しい分類に仕分けてください）",
      "items": ["仕分ける項目1", "項目2", "項目3"],
      "categories": ["分類A", "分類B"],
      "answer": [0, 1, 0],
      "explanation": "解説",
      "difficulty": "easy|medium|hard",
      "topic": "トピック名",
      "figure_svg": "（任意）",
      "source": { "file": 0, "page": 1, "section": "参照箇所", "quote": "短い引用" }
    },
    {
      "type": "order",
      "question": "次の項目を正しい順序（時系列・手順など）に並べ替えてください",
      "items": ["最初の項目", "2番目", "3番目", "最後の項目"],
      "explanation": "解説",
      "difficulty": "easy|medium|hard",
      "topic": "トピック名",
      "source": { "file": 0, "page": 1, "section": "参照箇所", "quote": "短い引用" }
    },
    {
      "type": "fill",
      "question": "光合成は ___ と水を材料に、光のエネルギーで ___ を作る反応である。",
      "blanks": ["二酸化炭素", "酸素"],
      "accept": [["CO2"], ["O2"]],
      "explanation": "解説",
      "difficulty": "easy|medium|hard",
      "topic": "トピック名",
      "source": { "file": 0, "page": 1, "section": "参照箇所", "quote": "短い引用" }
    },
    {
      "type": "text",
      "question": "○○について、その仕組みを80字程度で説明しなさい。",
      "model_answer": "模範解答（要点を押さえた説明文）",
      "keywords": ["押さえるべき要点1", "要点2", "要点3"],
      "explanation": "補足解説",
      "difficulty": "easy|medium|hard",
      "topic": "トピック名",
      "source": { "file": 0, "page": 1, "section": "参照箇所", "quote": "短い引用" }
    },
    {
      "type": "table",
      "question": "次の表の空欄を埋めてください。",
      "headers": ["勘定科目", "借方", "貸方"],
      "rows": [
        ["現金", "10000", "0"],
        ["売上", "0", "10000"]
      ],
      "blanks": [ { "r": 0, "c": 2 }, { "r": 1, "c": 1, "accept": ["0円", "—"] } ],
      "explanation": "解説",
      "difficulty": "easy|medium|hard",
      "topic": "トピック名",
      "source": { "file": 0, "page": 1, "section": "参照箇所", "quote": "短い引用" }
    }
  ]
}

ルール：
- 【出題の質・ヒント漏れ防止】正解が、問題文・選択肢・項目の【表面的な言い回し】から推測できないようにすること。具体的には、(1) カテゴリ名・正解ラベルと同じ語（やそれと一対一に対応する語）を、その項目・選択肢の文面にそのまま書かない。(2) 正しい選択肢だけが極端に長い／詳しい、定型句・括弧書きの注釈（「（原則）」「（例外）」等）が入る、等の形式的な手掛かりを作らない。全選択肢を同じ粒度・長さ・書式にそろえる（正解だけに補足や限定句を付けない）。(3) 学習者が内容を理解して初めて解けるよう、性質は式や中立的な表現で示す。例：カテゴリが「複素数の積／商」のとき、項目に『積になる』『商になる』と書くのは不可。『$|z_1 z_2| = |z_1||z_2|$』『偏角どうしを引いたものになる』のように、式や操作で示して『積/商』の語は避ける。(4) 【図にも答えを写さない】問題に添付する図（figure_svg／figure_ref）に、正解そのもの（答えとなる式・値・選択肢の内容や、それが書かれた表・公式・解答欄）を含めないこと。図は前提・状況の理解を助けるものに限る。問う対象の式・値が教材のその箇所に書かれている【想起・暗記系の問題】では、その箇所を切り出すと答えを見せてしまうため、図を付けない（または答えを含まない範囲だけを切り出す）こと。
- "source"は全問必須。各問題が教材のどのファイル・ページ・章/節/問題番号を根拠にしているかを正確に示すこと。"file"はユーザーが提示するファイル番号（0始まり）、"page"はPDFのページ番号（画像の場合は1）。
- "figure_svg"は図・グラフ・表・模式図が問題の理解に役立つ場合のみ含める（不要なら省略）。viewBox属性付きのSVGとすること。表示は【白い背景】なので、線・文字は濃い色（基本は #1f2937。強調・正解の補助線・重要点はアクセント色 #22c56b、補助的な要素は #4aa8ff）にし、塗りは白または淡い半透明色（例 rgba(34,197,107,0.1)）にすること。【薄いグレーや白に近い色は背景に溶けて見えないため使わない】。背景色は指定しない（透明のまま）。scriptや外部画像参照は禁止。特に幾何・図形問題（三角形・円・角度・座標平面・ベクトル・関数のグラフなど）では、理解を助けるため figure_svg を積極的に使うこと（教材に実物の図がある場合は後述の figure_ref を優先）。
- "figure_ref"（任意・推奨）：問題が教材内に【実際に存在する図・表・グラフ・写真・地図など】に関するものなら、その領域を切り出して原本画像を表示できるよう付けること。形式は {"file":ファイル番号(0始まり),"page":ページ番号(画像は1),"bbox":[x0,y0,x1,y1]}。bboxはそのページの左上を原点とし、x0,y0=領域の左上角、x1,y1=右下角を、ページ幅・高さに対する0.0〜1.0の割合で示す（例 [0.1,0.2,0.6,0.5]）。図のキャプションや見出しも少し含むように、やや広めに囲うこと。教材に実物がある図表は、描き起こしの"figure_svg"よりも"figure_ref"を優先する。実物が無い概念図のみ"figure_svg"を使う。【ただし上記「ヒント漏れ防止(4)」を厳守】：問う対象の式・値・答えがその領域に書かれている場合は、答えを見せてしまうので figure_ref を付けない（公式表や解答欄を切り出さない）。
- "sort"タイプは項目を2〜4個のカテゴリに仕分ける形式。itemsは3〜6個。"answer"は各itemの正解カテゴリのインデックス（0始まり）の配列で、itemsと同じ長さにすること。【重要】各itemには、カテゴリ名そのもの（およびそれと一対一に対応する語）を含めず、式・具体例・操作の説明など、理解しないと分類できない表現にすること（上記「出題の質」を厳守）。
- "order"タイプは項目を正しい順序に並べ替える形式。"items"は【正しい順序のまま】3〜6個並べること（アプリ側が表示時に自動でシャッフルする）。choices/categories/answerは不要。
- "fill"タイプは穴埋め。"question"内の空欄は半角アンダースコア3つ「___」で表すこと。"blanks"は空欄の正解を出現順に並べた配列で、文中の「___」の数と必ず同じ長さにすること。空欄「___」は、原則 数式「$...$」の【外】に置く。ただし空欄が【数式の構造の一部】（分数の分子・分母、下付き/上付きの添字、行列の要素など）のときは、式全体を LaTeX のまま、その位置に「___」を書いてよい（アプリが空欄を箱で描画し、入力欄を式の下にまとめて出す）。その場合、式をプレーン文字に崩さず必ず分数・添字で正しく組むこと。例：性能比は『性能X/性能Y＝実行時間 ___ /実行時間 ___ ＝n』のような素の文字列にせず、必ず『$\\frac{性能_X}{性能_Y}=\\frac{実行時間_{___}}{実行時間_{___}}=n$』と組む。構造に無関係な空欄（文中の語の穴埋め等）は従来どおり $...$ の外に置き、数式の外に空欄を作りたいときは空欄の前で数式を一度閉じて後で開き直す（例：正「$\\cos($ ___ $+ \\theta)$」）。また「$...$」には数式だけを入れ、日本語の文（「となり」「である」等）を混ぜないこと。"accept"（任意だが強く推奨）は各空欄の別解を入れた配列の配列。正解と同じ意味になる言い換え・同義語・別表記（例：「スカラー」⇔「スカラー値」、「二酸化炭素」⇔「CO2」、英語表記、送り仮名違い）を列挙すること。ただし【各空欄につき最大5個まで】とし、簡潔な語句に限ること。数式については、空白・記号の種類・積や和の順序の違いは採点側が自動で吸収するため不要だが、同じ量を別の標準的な書き方でも表せる場合（例：ノルム「‖a‖」と「√(x₁²+y₁²)」、内積「a・b」と「x₁x₂+y₁y₂」、「a・b=0」と「x₁x₂+y₁y₂=0」など）は、それらの別形も accept に含めること。
- "strict"（任意・真偽値）：fill／table で、回答の【大文字小文字・綴り・語間スペース】を厳密に区別して採点すべき問題には "strict": true を付けること。主に語学（英単語・英文の綴り、ドイツ語など名詞の大文字、固有名詞の正確な綴り）が対象。数学・理科・一般用語など、表記の揺れを許容したい問題には付けない（既定は通常採点）。strict を true にした問題では、accept にも正しい大文字小文字・綴りの別解のみを入れること。
- "text"タイプは記述式（AIが採点する）。"model_answer"に模範解答、"keywords"に採点で押さえるべき要点を入れること。choices/items/answerは不要。
- "table"タイプは表（簿記の精算表・試算表、集計表、対応表など）の穴埋め。教材内に表がある場合に特に有効。"rows"には【すべてのセルを正しく埋めた状態】の表データを2次元配列で入れること（各行は同じ列数）。"headers"（任意）は列見出しの配列。"blanks"は空欄にするセルの位置 {"r":行番号,"c":列番号}（いずれも0始まり）の配列で、1個以上。各blankに"accept"（別解の配列）を付けることを強く推奨し、正解と同じ意味になる言い換え・同義語・別表記を【各空欄につき最大5個まで】列挙すること。空欄の正解は"rows"の該当セルの値が使われる。数値は文字列で入れること。
- 数式・記号の表示：問題文("question")・選択肢("choices")・解説("explanation")・模範解答("model_answer")・表の見出し("headers")・表の【空欄でない】セルなど、表示用テキストでは、行列・分数・根号・総和・上下付き文字などの数式は LaTeX で書き、前後を「$」で囲むこと（インラインは $...$、独立行は $$...$$）。例：「積は $c_{ij}=\\sum_{k=1}^{m} a_{ik}b_{kj}$ で表される」「$\\sqrt{x_1^2+y_1^2}$」「ノルム $\\|a\\|$」「行列 $\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}$」。バックスラッシュはJSON内で必ず \\\\ とエスケープすること。
- ただし【利用者が入力して採点される値】＝fillの"blanks"と"accept"、tableで空欄にするセル（"blanks"が指す"rows"上の値）は、$ で囲まず、キーボードで打てる素のテキストで書くこと（例：x₁、x₁x₂+y₁y₂、√(x₁²+y₁²)、‖a‖、a・b=0）。これらにLaTeXコマンドや「$」を使ってはならない。
- 【回答値は「核心の答え」だけにする＝注釈を付けない（最重要）】採点対象になる値——choiceの各選択肢の文言、fillの"blanks"／"accept"、tableで空欄にするセルの正解値——には、「（原則）」「（例外）」「（一身専属権）」のような注釈・限定句・根拠・補足を、括弧書き等で付けないこと。値は簡潔な核心の答えのみとする（例：誤「著作者の死後70年（原則）」→正「著作者の死後70年」／誤「不可（一身専属権）」→正「不可」）。原則・例外・根拠・条件などの補足は必ず"explanation"に書く。理由：(a) 選択肢では正解だけに注釈が付くと正解が透ける、(b) 穴埋め・表では学習者が素直に書いた答えが注釈の有無で不正解になる。
- 【accept を厚くする】fill／tableの"accept"には、語尾・助詞・送り仮名・言い回しの違い（例：「70年」「死後70年」「70年間」、「〜まで」「〜間」の有無、「不可」「できない」）や、数値だけ・単位付きなど、同義になり得る素直な別表記を可能な範囲で列挙すること（各空欄・各セル最大5個・簡潔な語句）。学習者が核心を正しく書けていれば、末尾表現の違いで不正解にしない方針。
- 各タイプの必須フィールドを守ること。figure_svgはtext以外で任意。`;

  // β機能：有効なときだけ、対応タイプの仕様をプロンプトに追加する
  if (betaDraw) {
    sp += `
- 【β】"draw"タイプ（自由描画＋AI採点）：学習者が手描きで図・グラフ・模式図を描いて答える問題。"question"に「何を描くか」を明確に書く。"model_answer"に【描かれるべき図の説明＝採点基準】を文章で書く（例：原点を頂点とし上に開く放物線、など）。"keywords"に採点で見るべき要素（頂点・対称性・通る点など）を配列で入れる。choices/items等は不要。厳密な座標一致が必要な問題には使わず、概形・模式図・自由体図など【定性的に評価できるもの】に限ること。`;
  }
  if (betaGraph) {
    sp += `
- 【β】"graph"タイプ（格子点プロット・自動採点）：学習者が座標グリッド上の【整数の格子点】をクリックして打点し、点の集合で答える問題。"grid"に表示範囲 {"xmin":-5,"xmax":5,"ymin":-5,"ymax":5}（すべて整数）を指定。"points"に【正解となる整数座標の配列】 [[x,y],...] を入れる（1個以上）。"mode"は順序を問わない場合"points"、折れ線/多角形として順序も見る場合"polyline"。採点は座標の完全一致で自動的に行うため、答えは必ず格子点（整数座標）で表せる問題にすること（例：指定3点を打つ、y=2x-1上の格子点を3つ打つ、(1,1)(3,1)(2,3)を結ぶ三角形を作る）。曲線そのものを描かせる問題には使わない。`;
  }

  // A-2: 出力前の自己点検ステップ（ほぼ無料）。既存の歯止めを「出す直前に各問を必ず点検する」手順に落とし込む。
  sp += `

- 【出力前の自己点検（必須）】JSONを出力する【前】に、各問題について次を一問ずつ点検し、違反があれば必ず修正または作り直してから出力すること（点検の過程・思考は出力に含めない。最終的なJSONのみを返す）：
  (1) 答えの露出（ネタバレ）：正解——fillの"blanks"/"accept"、choiceの正解選択肢、sortの正解カテゴリ、orderの正しい並び、tableの空欄セルの値、textの"keywords"/"model_answer"の要点——が、その問題の【問題文・選択肢・項目・添付する図(figure_svg/figure_ref)】に、語句としても式としてもそのまま出ていないか。出ていたら表現を変える／図を外す／その問題を作り直す。
  (2) sort：各"items"に、自分の正解カテゴリ名（およびそれと一対一に対応する語）が混ざっていないか。混ざっていたら式・具体例・操作の説明に置き換える。
  (3) choice：選択肢どうしが実質同一・重複していないか。正解だけが不自然に長い・詳しい／定型句・括弧書きの注釈（「（原則）」等）が入る等の形式的な手掛かりが無いか。全選択肢が同程度の粒度・長さ・書式か。
  (3b) 回答値のクリーンさ：choiceの選択肢・fillの"blanks"/"accept"・tableの空欄セルの正解値に、「（原則）」「（例外）」「（一身専属権）」等の注釈・限定句・根拠が括弧書き等で付いていないか。付いていたら核心の答えだけに直し、補足は"explanation"へ移す。あわせて、素直な別表記（語尾・助詞・単位の違い等）を"accept"に補えているか確認する。
  (4) 教材忠実性：各問題の"source"（file/page/section/quote）が教材に【実在する記述】を指し、"quote"がその箇所と一致し、問題・正解がその根拠と矛盾しないか。教材外の推測で作らず、教材で確認できる内容だけを問う。
  (5) 一意に解けるか：提示した情報だけで（答えを見ずに）論理的に【ただ一つの正解】へ到達できるか。到達できない・答えが割れる問題は作り直す。`;

  return sp;
}

// 出題条件の指示文を組み立てる（両モード共通）。sourceDescは教材の渡し方の説明。
function buildInstruction(settings, similarTo, sourceDesc) {
  const diffMap = { easy: 'やさしい（基本・暗記）', medium: '普通（理解・説明）', hard: '難しい（応用・考察）' };
  const focusMap = {
    balanced: 'バランス良く',
    definitions: '用語・定義・キーワード中心',
    concepts: '概念の理解・説明中心',
    application: '応用・計算・問題解決中心'
  };
  const formatMap = {
    mixed: '選択式("choice")・仕分け表("sort")・並べ替え("order")・穴埋め("fill")・表穴埋め("table")・記述("text")を、教材に合うものをバランス良く混ぜる（教材に表が含まれる場合は"table"も積極的に使う）',
    choice: 'すべて選択式("choice")にする',
    sort: 'すべて仕分け表("sort")にする',
    order: 'すべて並べ替え("order")にする',
    fill: 'すべて穴埋め("fill")にする',
    table: 'すべて表穴埋め("table")にする',
    text: 'すべて記述式("text")にする',
    draw: 'すべて自由描画＋AI採点("draw")にする（描いて答える定性的な問題）',
    graph: 'すべてグラフ作成("graph")にする（座標グリッドに格子点を打つ問題）'
  };

  let instruction = `${sourceDesc}

以下の条件で問題を生成してください：
- 出題数：${settings.qCount}問
- 難易度：${diffMap[settings.difficulty]}
- 選択肢の数：choice問題は各問${settings.choiceCount}択
- 出題の重点：${focusMap[settings.focus]}
- 回答形式：${formatMap[settings.answerFormat] || formatMap.mixed}
${settings.extra ? '- 追加指示：' + settings.extra : ''}

"correct"フィールドは正解の選択肢インデックス（0始まり）を整数で返してください。
各問題には必ず"source"（教材内の参照箇所）を付けてください。
重要な箇所を正確に読み取り、教育的価値の高い問題を作成してください。`;

  if (similarTo && similarTo.length) {
    instruction += `

【重要】以下は学習者が間違えた問題です。これらと同じトピック・同じ論点を、表現や角度を変えて問う「類似問題」を生成してください：
${similarTo.map((q, i) => `${i + 1}. [${q.topic || 'その他'}] ${q.question}`).join('\n')}`;
  }
  return instruction;
}

// AIの返答テキストからJSONを取り出して正規化する（両モード共通）
function parseQuestionJSON(text) {
  const clean = (text || '').replace(/```json|```/g, '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(clean);
  } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!parsed) throw new Error('AIの返答が解析できませんでした。再度お試しください。');
  return auditQuestions(normalizeQuestions(parsed.questions));
}

// ── ウィジェット（アーティファクト）モード：window.claude.complete を使用（テキストのみ）
async function generateQuestionsWidget(settings, similarTo) {
  const fileNote = uploadedFiles.length
    ? `\n（出典表示用に次のファイルが添付されています。"source"の"file"にはこの番号を使ってよい：${uploadedFiles.map((f, i) => i + ':' + f.name).join(' / ')}）`
    : '';
  const sourceDesc = `以下の教材テキストから問題を生成してください。${fileNote}

=== 教材テキスト ===
${settings.materialText || ''}
=== ここまで ===`;

  const prompt = buildSystemPrompt() + '\n\n' + buildInstruction(settings, similarTo, sourceDesc);

  let text;
  try {
    text = await window.claude.complete(prompt);
  } catch (e) {
    throw new Error('AIの呼び出しに失敗しました: ' + (e && e.message ? e.message : e));
  }
  return parseQuestionJSON(text);
}

// ── 単体HTML（standalone）モード：Anthropic API を直接呼び出し（画像・PDF対応）
async function generateQuestionsAPI(settings, similarTo, filesArg, opts) {
  opts = opts || {};
  const fileContents = await readFiles(filesArg || uploadedFiles);
  const userContent = [];

  for (const f of fileContents) {
    if (f.type === 'document') {
      userContent.push({ type: 'document', source: { type: 'base64', media_type: f.mediaType, data: f.data } });
    } else {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.data } });
    }
  }

  const fileListText = fileContents.map((f, i) => `${i}: ${f.name}`).join('\n');
  const sourceDesc =
    (fileContents.length
      ? `アップロードした教材ファイル一覧（"source"の"file"にはこの番号を使うこと）：\n${fileListText}\n`
      : '') +
    (settings.materialText ? `\n教材テキスト：\n${settings.materialText}\n` : '') +
    '\n上記の教材から問題を生成してください。';

  userContent.push({ type: 'text', text: buildInstruction(settings, similarTo, sourceDesc) });

  // プール作成など連続生成時は、教材（system＋PDF/画像）をプロンプトキャッシュして
  // 2回目以降の入力課金を約1/10に抑える。可変の指示テキストの前（＝最後のファイルブロック）に
  // キャッシュ境界を置く。単発生成では付けない（1回だけだとキャッシュ書込分だけ割高になるため）。
  if (opts.cachePdf && fileContents.length) {
    userContent[fileContents.length - 1].cache_control = { type: 'ephemeral' };
  }

  if (!settings.apiKey) {
    throw new Error('AIを呼び出すには、APIキーが必要です。アップロード画面の「APIキー」欄に、Claude（sk-ant-… で始まるキー）または Google Gemini（無料枠あり）のキーを入力してください。キー欄に貼ると自動で判別されます。');
  }

  await resolveActiveModel(settings.apiKey); // 廃止モデルなら自動で現行へ追従
  // 出力上限：JSON本体（1500 + 問数×700）に加え、B の思考トークン用に余白（+8000）を確保する。
  // 思考トークンは max_tokens を食うので、不足するとJSONが途中で切れて解析に失敗する。上限は24000。
  const maxTokens = Math.min(24000, 1500 + (settings.qCount || 5) * 700 + 8000);

  const reqInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: activeModel,
      max_tokens: maxTokens,
      // B: adaptive thinking を有効化。教材を読む→出題範囲を計画→漏れ・ネタバレ・矛盾を
      // 自己チェックしてからJSONを吐く。effort:"low" で思考トークン（＝出力課金）を抑える。
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      // 思考＋生成で応答が長くなるため、非ストリーミングだと接続がタイムアウトしうる。SSEで受け取る。
      stream: true,
      // 大きなsystemプロンプトをキャッシュ（再生成・類似問題・プール作成でsystem部が9割引に）。
      system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }]
    })
  };

  // 429（レート制限）・5xx（過負荷・一時エラー）は指数バックオフで数回リトライする。
  // 4xx（キー不正など）は即エラー。リトライはストリーム開始前の応答にのみ適用（本文途中の切断は対象外）。
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const MAX_RETRY = 3;
  let resp;
  for (let attempt = 0; ; attempt++) {
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', reqInit);
    } catch (e) {
      throw new Error('APIに接続できませんでした（' + (e && e.message ? e.message : e) + '）。\n・claude.aiのアーティファクト枠内では外部通信が遮断されます。\n・ファイルを直接(file://)開いた場合も、ブラウザによっては遮断されます。\nアップロード画面の「接続テスト」で確認するか、簡易ローカルサーバー経由で開いてください。');
    }
    if (resp.ok) break;
    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRY) {
      const ra = parseFloat(resp.headers.get('retry-after'));
      const backoff = Math.min(30000, 1000 * Math.pow(2, attempt + 1)); // 2s,4s,8s（上限30s）
      const waitMs = (ra > 0 ? ra * 1000 : backoff) + Math.floor(Math.random() * 500);
      setLoadingMsg('混雑のため待機中', `${attempt + 1}回目の再試行まで約${Math.round(waitMs / 1000)}秒…`);
      try { if (resp.body && resp.body.cancel) await resp.body.cancel(); } catch (e) {}
      await sleep(waitMs);
      continue;
    }
    // エラー時はSSEではなくJSONのエラーボディが返る
    const err = await resp.json().catch(() => ({}));
    throw new Error((err.error && err.error.message) || `APIエラー (${resp.status})`);
  }

  // SSEストリームから本文テキスト(text_delta)だけを結合する。思考ブロックは本文に含めない。
  const text = await readAnthropicStream(resp);
  return parseQuestionJSON(text);
}

// ── Gemini（Google Generative Language API）モード：最小プロトタイプ ──────────────
// 目的は「PDF/画像→問題JSON」が Gemini でも通るか＋生成品質の確認。system/指示/JSON整形は
// Claude 経路と全く同じもの（buildSystemPrompt / buildInstruction / parseQuestionJSON）を再利用する。
// 非ストリーミング（プロンプトは有限で応答も短め）。採点系（記述/同値/描画）はまだ Claude 前提のため、
// Gemini キー時は resp.ok=false でキーワード採点にフォールバックする（プロトタイプの割り切り）。
async function generateQuestionsGemini(settings, similarTo, filesArg, opts) {
  opts = opts || {};
  const fileContents = await readFiles(filesArg || uploadedFiles);
  // 教材（PDF/画像）は inlineData（base64）で渡す。Claude の document/image と同じ base64 をそのまま使う。
  const parts = fileContents.map(f => ({ inlineData: { mimeType: f.mediaType, data: f.data } }));

  const fileListText = fileContents.map((f, i) => `${i}: ${f.name}`).join('\n');
  const sourceDesc =
    (fileContents.length
      ? `アップロードした教材ファイル一覧（"source"の"file"にはこの番号を使うこと）：\n${fileListText}\n`
      : '') +
    (settings.materialText ? `\n教材テキスト：\n${settings.materialText}\n` : '') +
    '\n上記の教材から問題を生成してください。';
  parts.push({ text: buildInstruction(settings, similarTo, sourceDesc) });

  // responseMimeType:'application/json' で「JSONだけ」を強制（Claudeよりも素直にJSONが返る）。
  // 2.5系は思考トークンを大量に使うため、出力上限は「思考＋JSON」が両方収まるよう大きめに取る
  // （thinkingConfig は一部モデルが400を返すので触らない）。
  const maxOutputTokens = Math.min(65536, 8000 + (settings.qCount || 5) * 1500);
  const body = {
    systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens }
  };

  await resolveGeminiModel(settings.apiKey); // 廃止モデル回避：利用可能モデルへ自動追従
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error('Gemini APIに接続できませんでした（' + (e && e.message ? e.message : e) + '）。file:// で開いた場合やキー制限（HTTPリファラ）が原因のことがあります。ローカルサーバー経由で開くか、キー制限を確認してください。');
  }
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const m = (err.error && err.error.message) || ('HTTP ' + resp.status);
    throw new Error('Geminiエラー：' + m);
  }
  const data = await resp.json();

  // 安全フィルタ等でブロックされた場合の分かりやすいエラー
  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    const br = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error(br ? ('Geminiが応答をブロックしました（' + br + '）。教材内容を見直してください。') : 'Geminiの応答が空でした。もう一度お試しください。');
  }
  const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
  if (!text.trim()) {
    const fr = cand.finishReason || '不明';
    throw new Error('Geminiが空の応答を返しました（finishReason: ' + fr + '）。出力が上限で途切れた可能性があります。問題数を減らすか、再度お試しください。');
  }
  // 実測トークン（無料枠のため金額は出さず、目安として件数のみコンソールに出す）
  const u = data.usageMetadata || {};
  console.log(`[AIQuiz] Gemini生成 (${geminiModel})  入力 ${u.promptTokenCount || 0} / 出力 ${u.candidatesTokenCount || 0} / 合計 ${u.totalTokenCount || 0} tok`);
  return parseQuestionJSON(text);
}

// ── 採点系の単発補完（プロバイダ共通）────────────────────────────────
// 記述採点・AI同値判定・描画採点で使う。key で Claude(sk-ant-)／Gemini(AIza) を自動振り分け。
// 非ストリーミングで応答テキストを返す。opts.imageB64 があれば画像も添付（描画採点）。
// opts.jsonOut=true で Gemini は JSON 強制。失敗時は throw（呼び出し側がフォールバックを判断）。
// コストは Anthropic のみ実額計上（logGradingCost）、Gemini は無料枠のため件数のみコンソールに出す。
async function aiGradeComplete(opts) {
  const apiKey = opts.apiKey, maxTokens = opts.maxTokens || 400;
  if (isGeminiKey(apiKey)) {
    const parts = [];
    if (opts.imageB64) parts.push({ inlineData: { mimeType: 'image/png', data: opts.imageB64 } });
    parts.push({ text: opts.userText });
    // 2.5系は思考が出力枠を食うため、小さな採点JSONでも余裕を持たせる（最低2048）。thinkingConfigは触らない（400回避）。
    const gen = { maxOutputTokens: Math.max(2048, maxTokens) };
    if (opts.jsonOut) gen.responseMimeType = 'application/json';
    const body = { systemInstruction: { parts: [{ text: opts.system }] }, contents: [{ role: 'user', parts }], generationConfig: gen };
    await resolveGeminiModel(apiKey); // 廃止モデル回避：利用可能モデルへ自動追従（セッション中1回）
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error('Gemini採点エラー (' + resp.status + ')');
    const data = await resp.json();
    const u = data.usageMetadata || {};
    console.log(`[AIQuiz] Gemini採点 (${geminiModel}) 入力 ${u.promptTokenCount || 0} / 出力 ${u.candidatesTokenCount || 0} tok`);
    const cand = data.candidates && data.candidates[0];
    return ((cand && cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
  }
  // Anthropic
  await resolveActiveModel(apiKey);
  const content = opts.imageB64
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: opts.imageB64 } }, { type: 'text', text: opts.userText }]
    : opts.userText;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: activeModel, max_tokens: maxTokens, system: opts.system, messages: [{ role: 'user', content }] })
  });
  if (!resp.ok) throw new Error('AI request failed (' + resp.status + ')');
  const data = await resp.json();
  try { logGradingCost(data.usage); } catch (e) {}
  return data.content.map(b => b.text || '').join('');
}

// Anthropic Messages API のSSEストリームを読み取り、本文テキスト(text_delta)を結合して返す。
// 思考ブロック(thinking_delta / signature_delta)は本文に含めず、進捗表示にだけ使う。
async function readAnthropicStream(resp) {
  if (!resp.body || !resp.body.getReader) {
    // 稀にストリームが使えない環境の保険：一括JSONとして読む
    const data = await resp.json();
    return (data.content || []).map(b => b.text || '').join('');
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '', apiError = null, sawText = false;
  // 実測トークン数（コスト把握用）。input_tokens は「非キャッシュの入力」のみ。
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  const handle = payload => {
    let ev;
    try { ev = JSON.parse(payload); } catch { return; }
    if (ev.type === 'message_start' && ev.message && ev.message.usage) {
      const u = ev.message.usage;
      usage.input_tokens = u.input_tokens || 0;
      usage.cache_creation_input_tokens = u.cache_creation_input_tokens || 0;
      usage.cache_read_input_tokens = u.cache_read_input_tokens || 0;
      usage.output_tokens = u.output_tokens || 0;
    } else if (ev.type === 'content_block_start') {
      if (ev.content_block && ev.content_block.type === 'thinking') {
        setLoadingMsg('問題を生成中', 'AIが出題内容を吟味しています…');
      }
    } else if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta') {
        if (!sawText) { sawText = true; setLoadingMsg('問題を生成中', '問題を書き出しています…'); }
        text += ev.delta.text || '';
      }
      // thinking_delta / signature_delta は本文に含めない
    } else if (ev.type === 'message_delta' && ev.usage) {
      // 最終的な出力トークン数（思考＋本文の合計）はここに入る
      if (typeof ev.usage.output_tokens === 'number') usage.output_tokens = ev.usage.output_tokens;
    } else if (ev.type === 'error') {
      apiError = (ev.error && ev.error.message) || 'ストリーム中にエラーが発生しました';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // \r を除去して \n\n 区切りに正規化（サーバ差異の保険）
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const evChunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of evChunk.split('\n')) {
        if (line.startsWith('data:')) handle(line.slice(5).trim());
      }
    }
  }
  if (apiError) throw new Error(apiError);
  logGenerationCost(usage);
  return text;
}

// 実測トークンから概算コスト（USD/JPY）を計算し、共通の形に整える。生成・採点の両方で使う。
// 戻り値：{ model, usage:{input_tokens,cache_creation_input_tokens,cache_read_input_tokens,output_tokens}, usd, jpy }
function computeUsageCost(usage) {
  // per 1M tokens（USD）：in=入力, out=出力, cw=キャッシュ書込, cr=キャッシュ読込
  const PRICES = {
    'claude-sonnet-4-6': { in: 3, out: 15, cw: 3.75, cr: 0.30 },
    'claude-sonnet-5':   { in: 3, out: 15, cw: 3.75, cr: 0.30 },
    'claude-opus-4-8':   { in: 5, out: 25, cw: 6.25, cr: 0.50 },
    'claude-opus-4-7':   { in: 5, out: 25, cw: 6.25, cr: 0.50 },
    'claude-haiku-4-5':  { in: 1, out: 5,  cw: 1.25, cr: 0.10 }
  };
  const model = (typeof activeModel !== 'undefined' && activeModel) || 'claude-sonnet-4-6';
  let p = PRICES[model] || PRICES['claude-sonnet-4-6'];
  // Sonnet 5 は 2026-08-31 まで導入価格（入力$2 / 出力$10）。以降は通常価格（$3/$15）に戻る。
  if (model === 'claude-sonnet-5' && Date.now() < Date.parse('2026-09-01T00:00:00Z')) {
    p = { in: 2, out: 10, cw: 2.5, cr: 0.20 };
  }
  const inTok = (usage && usage.input_tokens) || 0;
  const cwTok = (usage && usage.cache_creation_input_tokens) || 0;
  const crTok = (usage && usage.cache_read_input_tokens) || 0;
  const outTok = (usage && usage.output_tokens) || 0;
  const usd = (inTok * p.in + cwTok * p.cw + crTok * p.cr + outTok * p.out) / 1e6;
  return {
    model,
    usage: { input_tokens: inTok, cache_creation_input_tokens: cwTok, cache_read_input_tokens: crTok, output_tokens: outTok },
    usd, jpy: usd * 155 // 円換算は概算レート
  };
}

// 生成1回の実測トークンから概算コストを算出し、コンソール＋トーストに出す（推定でなく実額を把握するため）。
// 直近の値は window.__lastUsage にも保存する。
function logGenerationCost(usage) {
  const c = computeUsageCost(usage);
  const t = c.usage;
  window.__lastUsage = c;
  console.log(
    `[AIQuiz] 生成コスト実測 (${c.model})\n` +
    `  入力(非キャッシュ): ${t.input_tokens} tok\n` +
    `  キャッシュ 書込:${t.cache_creation_input_tokens} / 読込:${t.cache_read_input_tokens} tok\n` +
    `  出力(思考+JSON): ${t.output_tokens} tok\n` +
    `  概算コスト: $${c.usd.toFixed(4)}  (≈¥${c.jpy.toFixed(1)})`
  );
  // アプリ内トーストにも表示（PC/スマホでコンソールを見なくても分かるように）。実データのみ。
  if ((t.input_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens + t.output_tokens) > 0) {
    sessionCost.genUsd += c.usd; sessionCost.genJpy += c.jpy; sessionCost.genCalls++;
    try { showCostToast(c); } catch (e) {}
  }
}

// このセッション（ページ読み込み〜）の生成＋採点コストの累計。データ管理ハブで一覧表示する。
// リロードでリセット（＝Anthropicの請求総額ではなく「この画面を開いてからの目安」）。
let sessionCost = { genUsd: 0, genJpy: 0, genCalls: 0, gradeUsd: 0, gradeJpy: 0, gradeCalls: 0 };

// ── 採点系API（記述採点・AI同値判定・描画採点）の実測コスト ──
// 生成とは別枠で累計し、コンソール＋トーストに出す。1回のクイズ／試験ぶんを resetRunState でリセットする。
// ウィジェット（window.claude.complete）は usage を返さないので加算されない（トークン0で早期return）。
let gradeCost = { usd: 0, jpy: 0, calls: 0, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, model: '' };
function resetGradeCost() {
  gradeCost = { usd: 0, jpy: 0, calls: 0, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, model: '' };
}
function logGradingCost(usage) {
  const c = computeUsageCost(usage);
  const t = c.usage;
  const tokens = t.input_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens + t.output_tokens;
  if (tokens <= 0) return; // usage が取れない環境では累計しない
  gradeCost.calls++;
  gradeCost.usd += c.usd; gradeCost.jpy += c.jpy; gradeCost.model = c.model;
  for (const k in gradeCost.usage) gradeCost.usage[k] += t[k] || 0;
  sessionCost.gradeUsd += c.usd; sessionCost.gradeJpy += c.jpy; sessionCost.gradeCalls++;
  window.__lastGradeCost = { call: c, totalUsd: gradeCost.usd, totalJpy: gradeCost.jpy, calls: gradeCost.calls };
  console.log(`[AIQuiz] 採点コスト実測 (${c.model}) 今回 $${c.usd.toFixed(4)}（≈¥${c.jpy.toFixed(1)}） ／ 累計 ${gradeCost.calls}回 $${gradeCost.usd.toFixed(4)}（≈¥${gradeCost.jpy.toFixed(1)}）`);
  try {
    showCostToast({ model: gradeCost.model, usage: gradeCost.usage, usd: gradeCost.usd, jpy: gradeCost.jpy }, { label: '🧮 採点コスト', calls: gradeCost.calls });
  } catch (e) {}
}

// ── 生成コストのアプリ内トースト（standalone/APIモードのみ。logGenerationCost から呼ぶ）──
let costToastTimer = null;
function showCostToast(u, opts) {
  if (!u) return;
  opts = opts || {};
  const el = document.getElementById('cost-toast');
  if (!el) return;
  const main = document.getElementById('cost-toast-main');
  const detail = document.getElementById('cost-toast-detail');
  const t = u.usage || {};
  const label = opts.label || '💴 生成コスト';
  const callsNote = opts.calls ? `（${opts.calls}回）` : '';
  if (main) main.textContent = `${label}${callsNote} ¥${u.jpy.toFixed(1)}（$${u.usd.toFixed(4)}・実測）　▸明細`;
  if (detail) {
    detail.textContent = `入力(非キャッシュ) ${t.input_tokens || 0} ／ キャッシュ 書込 ${t.cache_creation_input_tokens || 0}・読込 ${t.cache_read_input_tokens || 0} ／ 出力(思考+JSON) ${t.output_tokens || 0} tok　(${u.model})`;
    detail.style.display = 'none';
  }
  el.style.opacity = '1';
  el.style.transform = 'translateX(-50%) translateY(0)';
  el.style.pointerEvents = 'auto';
  clearTimeout(costToastTimer);
  costToastTimer = setTimeout(hideCostToast, 12000); // 12秒で自動的に消す
}
function toggleCostToastDetail() {
  const d = document.getElementById('cost-toast-detail');
  if (d) d.style.display = (d.style.display === 'none') ? 'block' : 'none';
  clearTimeout(costToastTimer); // 明細を開いたら自動消去を止める（じっくり読めるように）
}
function hideCostToast(ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  const el = document.getElementById('cost-toast');
  if (!el) return;
  el.style.opacity = '0';
  el.style.transform = 'translateX(-50%) translateY(20px)';
  el.style.pointerEvents = 'none';
  clearTimeout(costToastTimer);
}

// [js/questions.js に移動] QUESTION_TYPES / normalizeQuestions / leakReason / integrityReason / quoteAudit / auditQuestions ほか（問題の正規化・検査・テスト対象）

// SVGから危険な要素・属性を除去してから表示する
// 色の明度（0〜1）。判定できない色（gradientのurl等）は null
function colorLuminance(c) {
  if (!c) return null;
  c = c.trim().toLowerCase();
  const named = { white: '#ffffff', whitesmoke: '#f5f5f5', gainsboro: '#dcdcdc', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', silver: '#c0c0c0', ivory: '#fffff0', snow: '#fffafa' };
  if (named[c]) c = named[c];
  let m = c.match(/^#([0-9a-f]{3})$/);
  if (m) { const h = m[1]; c = '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
  m = c.match(/^#([0-9a-f]{6})$/);
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function sanitizeSVG(svgStr) {
  try {
    const doc = new DOMParser().parseFromString(svgStr, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg || doc.querySelector('parsererror')) return null;
    doc.querySelectorAll('script, foreignObject').forEach(el => el.remove());
    const DARK = '#1f2937'; // 白背景でも見えるよう、薄すぎる線・文字色を置き換える濃色
    doc.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(a => {
        if (/^on/i.test(a.name) || /javascript:/i.test(a.value)) el.removeAttribute(a.name);
        // 外部URLへの参照（<image href>・<a href>等）は読み込ませない。#内部参照とdata:は許可
        else if (/^(href|xlink:href)$/i.test(a.name) && !/^\s*(#|data:)/i.test(a.value)) el.removeAttribute(a.name);
      });
      // 【安全網】白背景で見えない薄色（明度が高い stroke/fill）を濃色へ補正
      ['stroke', 'fill'].forEach(prop => {
        const v = el.getAttribute(prop);
        if (v && v.toLowerCase() !== 'none') {
          const lum = colorLuminance(v);
          if (lum !== null && lum > 0.82) el.setAttribute(prop, DARK);
        }
        const sv = el.style && el.style[prop];
        if (sv && sv.toLowerCase() !== 'none') {
          const lum = colorLuminance(sv);
          if (lum !== null && lum > 0.82) el.style[prop] = DARK;
        }
      });
    });
    // 描画要素が無い空SVGはボックス・キャプションごと出さない
    if (!svg.children.length) return null;
    // width/height 属性が無く viewBox だけのSVGは、このレイアウトで 0×0 に潰れて見えなくなる。
    // viewBox から寸法を補う（CSSの max-width:100% / height:auto で縮小・アスペクト比維持は効く）。
    const vb = svg.getAttribute('viewBox');
    const hasW = svg.hasAttribute('width'), hasH = svg.hasAttribute('height');
    if (vb && (!hasW || !hasH)) {
      const p = vb.split(/[\s,]+/).map(Number);
      if (p.length === 4 && p[2] > 0 && p[3] > 0) {
        if (!hasW) svg.setAttribute('width', p[2]);
        if (!hasH) svg.setAttribute('height', p[3]);
      }
    } else if (!vb && (!hasW || !hasH)) {
      // viewBox も寸法も無い場合の保険（潰れ防止）
      if (!hasW) svg.setAttribute('width', '400');
      if (!hasH) svg.setAttribute('height', '300');
    }
    return svg.outerHTML;
  } catch { return null; }
}

// ─── FIGURE EXTRACTION (教材から図・表を切り出して表示) ─────────
const pageCanvasCache = new Map(); // 'img:idx' / 'pdf:idx:page' -> canvas
const pdfDocCache = new Map();     // fileIdx -> Promise<pdf document>
let pdfjsLoading = null;
let figureToken = 0;               // 問題を切り替えたら古い非同期描画を破棄

function clearFigureCaches() {
  pageCanvasCache.clear();
  pdfDocCache.clear();
  revokeFileUrls(); // 不要になったオブジェクトURLを解放（メモリリーク防止）
  fpMemo = { key: '', ids: null }; // ファイル構成が変わったのでプール判定キーのメモも破棄
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// pdf.js を必要時にローカル同梱ファイル（同じ階層）から遅延読み込み（オフライン・CDN非依存）。
// 単一HTML完結は廃止し、pdf.js は同じ階層の実ファイルとして同梱する（HTMLの肥大化を避ける）。
function ensurePdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfjsLoading) return pdfjsLoading;
  pdfjsLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'pdf.min.js';
    s.onload = () => {
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
      } catch {}
      resolve(window.pdfjsLib);
    };
    s.onerror = () => { pdfjsLoading = null; reject(new Error('pdf.jsの読み込みに失敗')); };
    document.head.appendChild(s);
  });
  return pdfjsLoading;
}

function getPdfDoc(fileIdx) {
  if (pdfDocCache.has(fileIdx)) return pdfDocCache.get(fileIdx);
  const p = (async () => {
    const pdfjsLib = await ensurePdfJs();
    const buf = await uploadedFiles[fileIdx].arrayBuffer();
    return pdfjsLib.getDocument({ data: buf }).promise;
  })();
  pdfDocCache.set(fileIdx, p);
  return p;
}

async function renderPdfPage(fileIdx, pageNum) {
  const key = 'pdf:' + fileIdx + ':' + pageNum;
  if (pageCanvasCache.has(key)) return pageCanvasCache.get(key);
  const pdf = await getPdfDoc(fileIdx);
  const pn = Math.min(Math.max(1, pageNum || 1), pdf.numPages);
  const page = await pdf.getPage(pn);
  const viewport = page.getViewport({ scale: 2 }); // 切り出し解像度確保のため2倍
  const cv = document.createElement('canvas');
  cv.width = viewport.width; cv.height = viewport.height;
  await page.render({ canvasContext: cv.getContext('2d'), viewport }).promise;
  pageCanvasCache.set(key, cv);
  return cv;
}

function renderImageFile(fileIdx) {
  const key = 'img:' + fileIdx;
  if (pageCanvasCache.has(key)) return Promise.resolve(pageCanvasCache.get(key));
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      cv.getContext('2d').drawImage(im, 0, 0);
      pageCanvasCache.set(key, cv);
      resolve(cv);
    };
    im.onerror = () => reject(new Error('画像の読み込みに失敗'));
    im.src = getFileUrl(uploadedFiles[fileIdx]);
  });
}

// figure_ref から実画像を切り出して <img> を返す（失敗時は null）
async function renderFigureCrop(ref) {
  if (!ref || !Array.isArray(ref.bbox) || ref.bbox.length < 4) return null;
  const file = uploadedFiles[ref.file];
  if (!file) return null;

  let bbox = ref.bbox.map(Number);
  if (bbox.some(v => isNaN(v))) return null;
  const maxv = Math.max(...bbox);
  if (maxv > 1) { const d = maxv > 100 ? 1000 : 100; bbox = bbox.map(v => v / d); } // 0-1000/0-100表記を0-1へ
  let [x0, y0, x1, y1] = bbox;
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (x1 - x0 < 0.03 || y1 - y0 < 0.03) return null; // 元の領域が小さすぎ＝信頼できないので切り出さない
  const pad = 0.01; // 図のキャプション等が切れないよう少し広げる
  x0 = clamp01(x0 - pad); y0 = clamp01(y0 - pad); x1 = clamp01(x1 + pad); y1 = clamp01(y1 + pad);

  let src;
  if (file.type === 'application/pdf') {
    src = await renderPdfPage(ref.file, ref.page || 1);
  } else {
    src = await renderImageFile(ref.file);
  }
  if (!src) return null;

  const cx = Math.round(x0 * src.width), cy = Math.round(y0 * src.height);
  const cw = Math.round((x1 - x0) * src.width), ch = Math.round((y1 - y0) * src.height);
  if (cw < 4 || ch < 4) return null;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(src, cx, cy, cw, ch, 0, 0, cw, ch);
  const img = document.createElement('img');
  img.src = out.toDataURL('image/png');
  img.alt = '教材からの図・表';
  return img;
}

// 問題の図を表示：切り出し画像→AI生成SVG→非表示 の順でフォールバック
async function renderQuestionFigure(q) {
  const token = ++figureToken;
  const figDiv = document.getElementById('q-figure');
  figDiv.innerHTML = '';
  figDiv.style.display = 'none';

  // 1) 教材からの実画像切り出しを優先
  if (q.figure_ref && uploadedFiles[q.figure_ref.file]) {
    figDiv.innerHTML = '<div class="figure-loading">教材から図を読み込み中…</div>';
    figDiv.style.display = 'flex';
    let img = null;
    try { img = await renderFigureCrop(q.figure_ref); } catch {}
    if (token !== figureToken) return; // 別の問題に進んだら破棄
    if (img) {
      const box = document.createElement('div');
      box.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:6px;';
      box.appendChild(img);
      const cap = document.createElement('div');
      cap.className = 'figure-caption';
      cap.textContent = '教材から抜粋';
      if (q.source) {
        const link = document.createElement('button');
        link.className = 'figure-link';
        link.textContent = '全体を見る';
        link.onclick = () => openSourceModal(currentQ);
        cap.append(' ・ ', link);
      }
      box.appendChild(cap);
      figDiv.innerHTML = '';
      figDiv.appendChild(box);
      figDiv.style.display = 'flex';
      return;
    }
    // 切り出し失敗 → SVGフォールバックへ
  }

  // 2) フォールバック：AI生成SVG
  const safeSvg = q.figure_svg ? sanitizeSVG(q.figure_svg) : null;
  if (token !== figureToken) return;
  if (safeSvg) {
    // AI作図は内容の正しさを保証できないため、参考である旨を明示する
    const box = document.createElement('div');
    box.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:6px;';
    const svgWrap = document.createElement('div');
    svgWrap.innerHTML = safeSvg;
    box.appendChild(svgWrap);
    const cap = document.createElement('div');
    cap.className = 'figure-caption';
    cap.textContent = 'AIが作成した図（参考・誤りがあり得ます）';
    box.appendChild(cap);
    figDiv.innerHTML = '';
    figDiv.appendChild(box);
    figDiv.style.display = 'flex';
  } else {
    figDiv.innerHTML = '';
    figDiv.style.display = 'none';
  }
}

// ─── ADAPTIVE DIFFICULTY ───────────────────────────────────────
function getAdaptiveDifficulty() {
  const recent = history.slice(-4);
  if (recent.length < 2) return currentDifficulty;
  const rate = recent.filter(r => r).length / recent.length;

  if (rate >= 0.75 && currentDifficulty === 'easy') return 'medium';
  if (rate >= 0.75 && currentDifficulty === 'medium') return 'hard';
  if (rate <= 0.25 && currentDifficulty === 'hard') return 'medium';
  if (rate <= 0.25 && currentDifficulty === 'medium') return 'easy';
  return currentDifficulty;
}

// ─── MATH RENDERING (KaTeX) ────────────────────────────────────
// テキスト中の $...$（インライン）／$$...$$（ディスプレイ）を KaTeX で描画する。
// KaTeX が読み込めていない、または数式が無い場合は、エスケープした生テキストを返す。
function mathToHtml(text) {
  const s = (text == null) ? '' : String(text);
  if (typeof katex === 'undefined' || s.indexOf('$') === -1) return escapeHtml(s);
  let out = '', last = 0, m;
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  while ((m = re.exec(s)) !== null) {
    out += escapeHtml(s.slice(last, m.index));
    const display = m[1] !== undefined;
    const tex = display ? m[1] : m[2];
    // 通貨等（例：「価格は$5と$10」）を数式描画してしまうのを防ぐ。ただし日本語の有無だけで
    // 弾くと \frac{性能_X}{性能_Y} のような正当な式まで生表示になるため、LaTeX構造
    // （\コマンド・波括弧・上下付き）を含まない日本語のみ通貨等とみなして生表示する。
    const looksMath = /[\\{}]/.test(tex) || /[_^]\S/.test(tex);
    if (/[぀-ヿ一-鿿]/.test(tex) && !looksMath) {
      out += escapeHtml(m[0]);
    } else {
      try { out += katex.renderToString(tex, { throwOnError: false, displayMode: display }); }
      catch (e) { out += escapeHtml(m[0]); }
    }
    last = re.lastIndex;
  }
  out += escapeHtml(s.slice(last));
  return out;
}

// 要素に「数式入りテキスト」を安全に設定する（textContent の代わり。HTMLはエスケープ）
function setMath(el, text) {
  if (el) el.innerHTML = mathToHtml(text);
}

// ─── 答えの値（正解・選択肢など）を「表示だけ」数式として整形する ───────────
// 採点は素テキストのまま（answerMatches は不変）。ここは表示専用で、値を触らない。
// AIが tan^{-1}(b/a) や x^2, sqrt(2), π/3 のようなキャレット/スラッシュ記法を
// 値として返したとき、生テキストのまま出ると読みにくいので KaTeX で整形する。
// 「いかにも式」のときだけ整形し、70年 / 9/11 のような非数式・日付は素のまま出す（誤検出回避）。
// 変換・描画に失敗したら必ず生テキストにフォールバックする。
function plainToLatex(s) {
  let t = String(s);
  t = t.replace(/\bsqrt\s*\(([^()]*)\)/g, '\\sqrt{$1}');                 // sqrt(x) → \sqrt{x}
  // 関数名を \付きに（すでに \ が付いている・語の一部は除外）
  t = t.replace(/(^|[^\\A-Za-z])(sin|cos|tan|sec|csc|cot|log|ln|exp|lim|arg|det|max|min)(?![A-Za-z])/g, '$1\\$2');
  const GREEK = { 'α':'\\alpha','β':'\\beta','γ':'\\gamma','δ':'\\delta','ε':'\\epsilon','ζ':'\\zeta','η':'\\eta','θ':'\\theta','ι':'\\iota','κ':'\\kappa','λ':'\\lambda','μ':'\\mu','ν':'\\nu','ξ':'\\xi','π':'\\pi','ρ':'\\rho','σ':'\\sigma','τ':'\\tau','υ':'\\upsilon','φ':'\\phi','χ':'\\chi','ψ':'\\psi','ω':'\\omega','Δ':'\\Delta','Σ':'\\Sigma','Ω':'\\Omega','Φ':'\\Phi','Θ':'\\Theta','Π':'\\Pi','Γ':'\\Gamma','Λ':'\\Lambda' };
  t = t.replace(/[αβγδεζηθικλμνξπρστυφχψωΔΣΩΦΘΠΓΛ]/g, c => GREEK[c] || c);
  t = t.replace(/×/g, '\\times ').replace(/÷/g, '\\div ').replace(/·/g, '\\cdot ')
       .replace(/≤/g, '\\le ').replace(/≥/g, '\\ge ').replace(/≠/g, '\\ne ')
       .replace(/±/g, '\\pm ').replace(/→/g, '\\to ').replace(/∞/g, '\\infty ').replace(/√/g, '\\sqrt ');
  // 分数 A/B → \frac{A}{B}（1レベルのみ：英数・\コマンド・( ) グループを A,B とみなす）
  const frac = /(\\?[A-Za-z0-9{}]+|\([^()]*\))\s*\/\s*(\\?[A-Za-z0-9{}]+|\([^()]*\))/g;
  t = t.replace(frac, (m, a, b) => {
    const strip = x => x.replace(/^\((.*)\)$/, '$1');
    return '\\frac{' + strip(a) + '}{' + strip(b) + '}';
  });
  return t;
}
function mathifyValue(v) {
  const s = (v == null) ? '' : String(v);
  if (!s) return '';
  if (s.indexOf('$') !== -1) return mathToHtml(s);        // 明示的な $...$ は既存処理に任せる
  if (typeof katex === 'undefined') return escapeHtml(s);
  // 数式の合図（指数・添字・\・関数名・ギリシャ・記号）が無ければ素テキスト＝日付や「70年」を壊さない
  const mathish = /[\^_\\]|\b(sqrt|sin|cos|tan|sec|csc|cot|log|ln|exp|lim|arg|det)\b|[αβγδεζηθικλμνξπρστυφχψωΔΣΩΦΘΠΓΛ√∞∑∫±≤≥≠→×÷·]/.test(s);
  if (!mathish) return escapeHtml(s);
  try { return katex.renderToString(plainToLatex(s), { throwOnError: true, displayMode: false }); }
  catch (e) { return escapeHtml(s); }                     // 変換/描画に失敗したら生テキスト
}
// レビュー画面などの「正解」表示用：値ごとに mathifyValue で整形し、区切りは素の文字で連結する
// （区切りを含めて数式化すると a/b の / が分数化されて壊れるため、必ず値単位で整形する）。
function formatAnswerHtml(q) {
  switch (q.type) {
    case 'sort':  return (q.items || []).map((it, j) => mathifyValue(it) + '→' + mathifyValue(q.categories[q.answer[j]] ?? '?')).join('、');
    case 'order': return (q.items || []).map(mathifyValue).join(' → ');
    case 'fill':  return (q.blanks || []).map(mathifyValue).join(' / ');
    case 'table': return (q.blanks || []).map(b => (q.rows[b.r] && q.rows[b.r][b.c]) ?? '').filter(v => v !== '').map(mathifyValue).join(' / ');
    case 'text':  return mathifyValue(q.model_answer || '（記述）');
    case 'draw':  return mathifyValue(q.model_answer || '（描画）');
    case 'graph': return escapeHtml((q.points || []).map(p => `(${p[0]}, ${p[1]})`).join(q.mode === 'polyline' ? ' → ' : '、'));
    default:      return mathifyValue(q.choices[q.correct]);
  }
}

// 穴埋め用：問題文を「数式($...$)／非数式」に分解しながら、空欄(___)を置換する（表示テキスト用）。
// fill(blankIndex, inMath) が各空欄の置換文字列を返す。数式の中（特に行列など \begin{} の環境）でも
// 数式を壊さず、空欄をその場で置換するので、行列内の空欄でも崩れない。
// 数式内/外の判定（inMath）を渡すので、振り返り表示や印刷で表記を出し分けられる。
function fillQuestionTextWith(q, fill) {
  const src = (q && q.question != null) ? String(q.question) : '';
  let n = 0, out = '', last = 0, m;
  const reMath = /\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g;
  const plain = txt => txt.replace(/[_＿]{3,}/g, () => fill(n++, false));
  while ((m = reMath.exec(src)) !== null) {
    out += plain(src.slice(last, m.index));
    const tok = m[0];
    if (/[_＿]{3,}/.test(tok)) {
      const disp = tok.startsWith('$$');
      const d = disp ? '$$' : '$';
      const inner = (disp ? tok.slice(2, -2) : tok.slice(1, -1)).replace(/[_＿]{3,}/g, () => fill(n++, true));
      out += d + inner + d;
    } else {
      out += tok;
    }
    last = reMath.lastIndex;
  }
  out += plain(src.slice(last));
  return out;
}

// ─── MATH KEYBOARD (回答用 数式キーボード) ─────────────────────
let activeMathInput = null;

// キー定義：l=表示ラベル, ins=挿入文字列, caret=挿入後にカーソルを ins 内の何文字目へ置くか（任意。□スロット）,
//           act='back'=1文字削除, wide=横2マス
// タブ（カテゴリ）切り替え式。□ は挿入後にカーソルが入る空きスロットを表す。
const MATH_TABS = {
  // 構造（√・累乗・分数・括弧・絶対値…）→ 演算子 → 定数・記号 の順に整列。数字は常時表示の数字行、下付きは「下付き」タブへ。
  '基本': [
    { l: '√☐', ins: '√()', caret: 2 }, { l: '☐²', ins: '²' }, { l: '☐³', ins: '³' }, { l: '☐ⁿ', ins: 'ⁿ' }, { l: '☐/☐', ins: '()/()', caret: 1 }, { l: '( )', ins: '()', caret: 1 },
    { l: '|☐|', ins: '||', caret: 1 }, { l: '‖☐‖', ins: '‖‖', caret: 1 }, { l: '[☐]', ins: '[]', caret: 1 }, { l: 'xᵀ', ins: 'ᵀ' },
    { l: '+', ins: '+' }, { l: '−', ins: '−' }, { l: '×', ins: '×' }, { l: '÷', ins: '÷' }, { l: '=', ins: '=' }, { l: '±', ins: '±' }, { l: '・', ins: '・' }, { l: ',', ins: ', ' },
    { l: 'π', ins: 'π' }, { l: 'e', ins: 'e' }, { l: 'θ', ins: 'θ' }, { l: '∞', ins: '∞' }, { l: '°', ins: '°' }, { l: '√', ins: '√' }, { l: 'i', ins: 'i' }
  ],
  '関係・演算': [
    { l: '=', ins: '=' }, { l: '≠', ins: '≠' }, { l: '<', ins: '<' }, { l: '>', ins: '>' }, { l: '≤', ins: '≤' },
    { l: '≥', ins: '≥' }, { l: '≈', ins: '≈' }, { l: '≡', ins: '≡' }, { l: '±', ins: '±' }, { l: '∓', ins: '∓' },
    { l: '+', ins: '+' }, { l: '−', ins: '−' }, { l: '×', ins: '×' }, { l: '÷', ins: '÷' }, { l: '・', ins: '・' },
    { l: '∝', ins: '∝' }, { l: '∴', ins: '∴' }, { l: '∵', ins: '∵' }, { l: '→', ins: '→' }, { l: '↔', ins: '↔' },
    { l: '∈', ins: '∈' }, { l: '∉', ins: '∉' }, { l: '⊂', ins: '⊂' }, { l: '⊆', ins: '⊆' }, { l: '∪', ins: '∪' },
    { l: '∩', ins: '∩' }, { l: '∅', ins: '∅' }, { l: '∀', ins: '∀' }, { l: '∃', ins: '∃' }, { l: '¬', ins: '¬' }
  ],
  'ギリシャ': [
    { l: 'α', ins: 'α' }, { l: 'β', ins: 'β' }, { l: 'γ', ins: 'γ' }, { l: 'δ', ins: 'δ' }, { l: 'ε', ins: 'ε' },
    { l: 'ζ', ins: 'ζ' }, { l: 'η', ins: 'η' }, { l: 'θ', ins: 'θ' }, { l: 'κ', ins: 'κ' }, { l: 'λ', ins: 'λ' },
    { l: 'μ', ins: 'μ' }, { l: 'ν', ins: 'ν' }, { l: 'ξ', ins: 'ξ' }, { l: 'π', ins: 'π' }, { l: 'ρ', ins: 'ρ' },
    { l: 'σ', ins: 'σ' }, { l: 'τ', ins: 'τ' }, { l: 'φ', ins: 'φ' }, { l: 'χ', ins: 'χ' }, { l: 'ψ', ins: 'ψ' },
    { l: 'ω', ins: 'ω' }, { l: 'Γ', ins: 'Γ' }, { l: 'Δ', ins: 'Δ' }, { l: 'Θ', ins: 'Θ' }, { l: 'Λ', ins: 'Λ' },
    { l: 'Σ', ins: 'Σ' }, { l: 'Φ', ins: 'Φ' }, { l: 'Ψ', ins: 'Ψ' }, { l: 'Ω', ins: 'Ω' }, { l: 'Π', ins: 'Π' }
  ],
  '三角・関数': [
    { l: 'sin', ins: 'sin()', caret: 4 }, { l: 'cos', ins: 'cos()', caret: 4 }, { l: 'tan', ins: 'tan()', caret: 4 },
    { l: 'cot', ins: 'cot()', caret: 4 }, { l: 'sec', ins: 'sec()', caret: 4 }, { l: 'csc', ins: 'csc()', caret: 4 },
    { l: 'sinh', ins: 'sinh()', caret: 5 }, { l: 'cosh', ins: 'cosh()', caret: 5 }, { l: 'tanh', ins: 'tanh()', caret: 5 },
    { l: 'sin⁻¹', ins: 'arcsin()', caret: 7 }, { l: 'cos⁻¹', ins: 'arccos()', caret: 7 }, { l: 'tan⁻¹', ins: 'arctan()', caret: 7 },
    { l: 'log', ins: 'log()', caret: 4 }, { l: 'logₐ', ins: 'log_()', caret: 4 }, { l: 'ln', ins: 'ln()', caret: 3 },
    { l: 'eˣ', ins: 'e^()', caret: 3 }, { l: '|☐|', ins: '||', caret: 1 }, { l: '⌊☐⌋', ins: '⌊⌋', caret: 1 },
    { l: '⌈☐⌉', ins: '⌈⌉', caret: 1 }, { l: '☐!', ins: '!' }, { l: 'f(x)', ins: 'f()', caret: 2 }
  ],
  '微積・解析': [
    { l: '∫', ins: '∫' }, { l: '∬', ins: '∬' }, { l: '∮', ins: '∮' }, { l: 'Σ', ins: 'Σ' }, { l: 'Π', ins: 'Π' },
    { l: 'lim', ins: 'lim' }, { l: 'd/dx', ins: 'd/dx' }, { l: '∂/∂x', ins: '∂/∂x' }, { l: '∂', ins: '∂' }, { l: '∇', ins: '∇' },
    { l: "☐′", ins: '′' }, { l: "☐″", ins: '″' }, { l: 'Δ', ins: 'Δ' }, { l: '→', ins: '→' }, { l: '∞', ins: '∞' },
    { l: '∈', ins: '∈' }, { l: 'ℝ', ins: 'ℝ' }, { l: 'ℕ', ins: 'ℕ' }, { l: 'ℤ', ins: 'ℤ' }, { l: 'ℚ', ins: 'ℚ' },
    { l: '√☐', ins: '√()', caret: 2 }, { l: '☐/☐', ins: '()/()', caret: 1 }, { l: '( )', ins: '()', caret: 1 }
  ],
  '指数': [
    { l: 'x^(☐)', ins: '^()', caret: 2 }, { l: 'e^(☐)', ins: 'e^()', caret: 3 }, { l: '10^(☐)', ins: '10^()', caret: 4 }, { l: '☐⁻¹', ins: '⁻¹' },
    { l: 'x⁰', ins: '⁰' }, { l: 'x¹', ins: '¹' }, { l: 'x²', ins: '²' }, { l: 'x³', ins: '³' }, { l: 'x⁴', ins: '⁴' },
    { l: 'x⁵', ins: '⁵' }, { l: 'x⁶', ins: '⁶' }, { l: 'x⁷', ins: '⁷' }, { l: 'x⁸', ins: '⁸' }, { l: 'x⁹', ins: '⁹' },
    { l: 'ˣ⁺', ins: '⁺' }, { l: 'ˣ⁻', ins: '⁻' }, { l: 'ˣ⁽', ins: '⁽' }, { l: 'ˣ⁾', ins: '⁾' },
    { l: 'xⁿ', ins: 'ⁿ' }, { l: 'xⁱ', ins: 'ⁱ' }, { l: 'xˣ', ins: 'ˣ' }, { l: 'xᵀ', ins: 'ᵀ' }
  ],
  // 下付き専用（指数タブの対）。数字 → 演算子 → 英字 → よく使うギリシャ の順。
  // ※Unicodeに下付き字形が無い文字（b・c・d・f・g・q・w・y・z 等）は出せない。採点は normalizeText で下付き→通常に畳む。
  '下付き': [
    { l: '₀', ins: '₀' }, { l: '₁', ins: '₁' }, { l: '₂', ins: '₂' }, { l: '₃', ins: '₃' }, { l: '₄', ins: '₄' }, { l: '₅', ins: '₅' }, { l: '₆', ins: '₆' }, { l: '₇', ins: '₇' }, { l: '₈', ins: '₈' }, { l: '₉', ins: '₉' },
    { l: '₊', ins: '₊' }, { l: '₋', ins: '₋' }, { l: '₌', ins: '₌' }, { l: '₍', ins: '₍' }, { l: '₎', ins: '₎' },
    { l: 'ₐ', ins: 'ₐ' }, { l: 'ₑ', ins: 'ₑ' }, { l: 'ₕ', ins: 'ₕ' }, { l: 'ᵢ', ins: 'ᵢ' }, { l: 'ⱼ', ins: 'ⱼ' }, { l: 'ₖ', ins: 'ₖ' }, { l: 'ₗ', ins: 'ₗ' }, { l: 'ₘ', ins: 'ₘ' }, { l: 'ₙ', ins: 'ₙ' }, { l: 'ₒ', ins: 'ₒ' }, { l: 'ₚ', ins: 'ₚ' }, { l: 'ᵣ', ins: 'ᵣ' }, { l: 'ₛ', ins: 'ₛ' }, { l: 'ₜ', ins: 'ₜ' }, { l: 'ᵤ', ins: 'ᵤ' }, { l: 'ᵥ', ins: 'ᵥ' }, { l: 'ₓ', ins: 'ₓ' },
    { l: 'ᵦ', ins: 'ᵦ' }, { l: 'ᵧ', ins: 'ᵧ' }, { l: 'ᵨ', ins: 'ᵨ' }, { l: 'ᵩ', ins: 'ᵩ' }, { l: 'ᵪ', ins: 'ᵪ' }
  ]
};
let currentMathTab = '基本';

function buildMathKeyboard() {
  const tabs = document.getElementById('mk-tabs');
  if (tabs) {
    tabs.innerHTML = '';
    Object.keys(MATH_TABS).forEach(name => {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'mk-tab' + (name === currentMathTab ? ' active' : '');
      t.textContent = name;
      t.dataset.tab = name;
      t.addEventListener('mousedown', e => e.preventDefault());
      t.onclick = () => switchMathTab(name);
      tabs.appendChild(t);
    });
  }
  renderNumRow();
  renderMathGrid();
}

function switchMathTab(name) {
  currentMathTab = name;
  document.querySelectorAll('#mk-tabs .mk-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  renderMathGrid();
  updateKbPadding(); // タブで段数（高さ）が変わるので余白を更新
}

// キー定義からボタンDOMを生成（グリッド・数字行で共用）
function createMathKey(k) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mk-key' + (k.wide ? ' wide' : '') + (k.act ? ' act' : '');
  b.textContent = k.l;
  // フォーカスを回答欄に保つため、ボタンへのフォーカス移動を抑止
  b.addEventListener('mousedown', e => e.preventDefault());
  b.onclick = () => { if (k.act === 'back') mathBackspace(); else insertMathToken(k.ins, k.caret); };
  return b;
}

// 数字行（常時表示）。タブに依存しないので buildMathKeyboard で一度だけ描画する。
const MATH_NUM_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '.'].map(d => ({ l: d, ins: d }));
function renderNumRow() {
  const row = document.getElementById('mk-numrow');
  if (!row) return;
  row.innerHTML = '';
  MATH_NUM_KEYS.forEach(k => row.appendChild(createMathKey(k)));
}

function renderMathGrid() {
  const grid = document.getElementById('mk-grid');
  if (!grid) return;
  grid.innerHTML = '';
  // 各タブのキー＋共通の操作キー（空白・削除）
  const keys = (MATH_TABS[currentMathTab] || []).concat([
    { l: '空白', ins: ' ', wide: true }, { l: '⌫ 削除', act: 'back', wide: true }
  ]);
  keys.forEach(k => grid.appendChild(createMathKey(k)));
}

function registerMathInput(input) {
  if (!input) return;
  input.dataset.mathmanaged = '1'; // 数式キーボードの対象＝OSキーボード抑制の対象
  input.addEventListener('focus', () => {
    activeMathInput = input;
    // キーボードが開いているなら、隠れないよう入力欄を見える位置へ＋OSキーボードを抑制
    const kb = document.getElementById('math-keyboard');
    if (kb && kb.classList.contains('show')) {
      input.setAttribute('inputmode', 'none'); // 開いている間に別の空欄へ移ってもOSキーボードを出さない
      scrollActiveInputIntoView();
    }
  });
  if (!activeMathInput) activeMathInput = input; // 最初の入力欄を既定の対象に
}

function insertMathToken(ins, caret) {
  const el = activeMathInput;
  if (!el || el.disabled) return;
  const start = (el.selectionStart != null) ? el.selectionStart : el.value.length;
  const end = (el.selectionEnd != null) ? el.selectionEnd : el.value.length;
  const selected = el.value.slice(start, end);
  let insertText, pos;
  if (selected && typeof caret === 'number') {
    // 選択範囲をスロット（☐の位置）に包む。例：√() で "x+1" 選択 → "√(x+1)"
    insertText = ins.slice(0, caret) + selected + ins.slice(caret);
    pos = start + insertText.length; // 包んだ末尾へ
  } else {
    insertText = ins;
    pos = start + (typeof caret === 'number' ? caret : ins.length);
  }
  el.value = el.value.slice(0, start) + insertText + el.value.slice(end);
  el.focus();
  try { el.setSelectionRange(pos, pos); } catch (e) {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function mathBackspace() {
  const el = activeMathInput;
  if (!el || el.disabled) return;
  let s = el.selectionStart, e = el.selectionEnd;
  if (s == null) { s = e = el.value.length; }
  if (s === e && s > 0) { el.value = el.value.slice(0, s - 1) + el.value.slice(e); s = s - 1; }
  else if (s !== e) { el.value = el.value.slice(0, s) + el.value.slice(e); }
  el.focus();
  try { el.setSelectionRange(s, s); } catch (err) {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// 数式キーボードを開いている間は、画面下でOSのソフトキーボードと二重に出ないよう
// 回答欄の inputmode を 'none' にしてOSキーボードを抑制する。
// 閉じれば属性を外して通常入力（数字・英字・日本語IME）に戻る。
function setOSKeyboardSuppressed(suppress) {
  document.querySelectorAll('[data-mathmanaged]').forEach(el => {
    if (suppress) el.setAttribute('inputmode', 'none');
    else el.removeAttribute('inputmode');
  });
}

function toggleMathKeyboard(force) {
  const kb = document.getElementById('math-keyboard');
  if (!kb) return;
  const show = (typeof force === 'boolean') ? force : !kb.classList.contains('show');
  kb.classList.toggle('show', show);
  const isTouch = (navigator.maxTouchPoints > 0) || ('ontouchstart' in window);
  if (show) {
    setOSKeyboardSuppressed(true);                 // OSキーボードを抑制（数式キーボードのみ表示）
    if (isTouch && activeMathInput) activeMathInput.blur(); // 既に出ているOSキーボードを閉じる（タッチ端末のみ。PCはフォーカス＝カーソル位置を維持）
    updateKbPadding();            // キーボードの高さ分だけ下部に余白を確保（内容が隠れないように）
    scrollActiveInputIntoView();  // 回答欄を見える位置へ
  } else {
    setOSKeyboardSuppressed(false); // OSキーボードを再び使えるように戻す
    document.body.style.paddingBottom = '';
  }
}

// 開いているキーボードの高さ分だけ body 下部に余白を入れる（タブ切替で高さが変わっても追従）
function updateKbPadding() {
  const kb = document.getElementById('math-keyboard');
  if (kb && kb.classList.contains('show')) {
    document.body.style.paddingBottom = (kb.offsetHeight + 12) + 'px';
  }
}

// 現在の入力欄を、キーボードに隠れない位置へスクロール
function scrollActiveInputIntoView() {
  const el = activeMathInput;
  if (el && typeof el.scrollIntoView === 'function') {
    setTimeout(() => { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {} }, 60);
  }
}

// 回答入力がある問題でのみ、トグルボタンを表示する
function setMathToolsVisible(visible) {
  const t = document.getElementById('math-kb-toggle');
  if (t) t.style.display = visible ? 'inline-flex' : 'none';
  if (!visible) { toggleMathKeyboard(false); closeMatrixBuilder(); }
}

// ─── MATH TEMPLATE BUILDER (数式テンプレートをスロットで作って回答欄に挿入) ───
// 行列／積分／総和／総積／極限／分数／場合分け を1つのモーダルで選んで組み立てる。
// 採点は素のテキスト一致＋AI同値（このビルダーは入力補助のみ。計算はしない）。
let tbTarget = null, tbAutoShowedKb = false, tbCurrent = 'matrix';
let tbRows = 2, tbCols = 2, tbCaseRows = 2;
const TB_MAX = 6;
const TB_LIST = [['matrix','行列'],['integral','積分'],['sum','総和'],['prod','総積'],['limit','極限'],['frac','分数'],['cases','場合分け']];
// fields型テンプレートの定義：[key, ラベル, プレースホルダ, 既定値]
const TB_FIELDS = {
  integral: [['lo','下端','例 0',''],['up','上端','例 1',''],['f','被積分関数','例 x^2',''],['dx','変数','x','x']],
  sum:      [['v','変数','i','i'],['from','開始','例 1',''],['to','終了','例 n',''],['body','式','例 i^2','']],
  prod:     [['v','変数','i','i'],['from','開始','例 1',''],['to','終了','例 n',''],['body','式','例 i','']],
  limit:    [['v','変数','x','x'],['to','近づく先','例 0, ∞',''],['body','式','例 (sin x)/x','']],
  frac:     [['num','分子','例 a',''],['den','分母','例 b','']]
};

function openTemplateBuilder(initial) {
  // 直前に編集していた回答欄を「挿入先」として保持（無ければ最初の回答欄）
  tbTarget = activeMathInput ||
    document.querySelector('#screen-quiz .fill-input, #screen-quiz .table-input, #screen-quiz .text-answer');
  if (initial && (initial === 'matrix' || initial === 'cases' || TB_FIELDS[initial])) tbCurrent = initial;
  tbRows = 2; tbCols = 2; tbCaseRows = 2;
  renderTemplateTabs();
  renderTemplate();
  const modal = document.getElementById('template-modal');
  if (modal) modal.classList.add('show');
  // 数式キーボードをモーダル前面に出し、必要なら開く（スロットに θ や ^ を入力できるように）
  const kb = document.getElementById('math-keyboard');
  if (kb) { tbAutoShowedKb = !kb.classList.contains('show'); if (tbAutoShowedKb) toggleMathKeyboard(true); kb.classList.add('above-modal'); }
  const box = modal ? modal.querySelector('.modal-box') : null;
  const kbH = (kb && kb.classList.contains('show')) ? kb.offsetHeight : 0;
  if (box) box.style.maxHeight = Math.max(240, window.innerHeight - kbH - 32) + 'px';
  const first = document.querySelector('#tb-slots .mb-cell'); if (first) first.focus();
}
function closeTemplateBuilder() {
  const modal = document.getElementById('template-modal');
  if (modal) { modal.classList.remove('show'); const box = modal.querySelector('.modal-box'); if (box) box.style.maxHeight = ''; }
  const kb = document.getElementById('math-keyboard');
  if (kb) { kb.classList.remove('above-modal'); if (tbAutoShowedKb) { toggleMathKeyboard(false); tbAutoShowedKb = false; } }
  if (tbTarget) activeMathInput = tbTarget; // キーボードの入力先を元の回答欄へ戻す
}
// 旧名の後方互換（数式キーボードや記述ヒントの既存呼び出し用）
function openMatrixBuilder() { openTemplateBuilder('matrix'); }
function closeMatrixBuilder() { closeTemplateBuilder(); }

function renderTemplateTabs() {
  const tabs = document.getElementById('tb-tabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  TB_LIST.forEach(([key, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mk-tab' + (key === tbCurrent ? ' active' : '');
    b.textContent = label;
    b.addEventListener('mousedown', e => e.preventDefault());
    b.onclick = () => selectTemplate(key);
    tabs.appendChild(b);
  });
}
function selectTemplate(key) { tbCurrent = key; renderTemplateTabs(); renderTemplate(); }

// スロット入力欄を1つ作る（フォーカスで数式キーボードの入力先になる）
function tbMakeCell(attrs) {
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'mb-cell'; inp.autocomplete = 'off';
  inp.style.cssText = 'flex:1; min-width:60px; box-sizing:border-box; text-align:center; background:var(--surface2); border:1px solid var(--border2); border-radius:6px; color:var(--text); padding:8px 6px; font-size:14px; font-family:inherit; outline:none;';
  for (const k in attrs) inp.setAttribute(k, attrs[k]);
  inp.addEventListener('input', tbUpdatePreview);
  inp.addEventListener('focus', () => { activeMathInput = inp; });
  return inp;
}
// 行/列などの増減コントロール
function tbSizeControls(label, onMinus, onPlus, val) {
  const wrap = document.createElement('span');
  wrap.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:13px; color:var(--text2);';
  wrap.appendChild(document.createTextNode(label));
  const mk = (txt, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'mb-step'; b.textContent = txt; b.onclick = fn; return b; };
  const v = document.createElement('b'); v.textContent = String(val); v.style.cssText = 'min-width:18px; text-align:center; color:var(--text);';
  wrap.appendChild(mk('−', onMinus)); wrap.appendChild(v); wrap.appendChild(mk('＋', onPlus));
  return wrap;
}

function renderTemplate() {
  const controls = document.getElementById('tb-controls');
  const slots = document.getElementById('tb-slots');
  if (!controls || !slots) return;
  controls.innerHTML = ''; slots.innerHTML = '';

  if (tbCurrent === 'matrix') {
    controls.appendChild(tbSizeControls('行', () => tbMatrixSize(-1, 0), () => tbMatrixSize(1, 0), tbRows));
    controls.appendChild(tbSizeControls('列', () => tbMatrixSize(0, -1), () => tbMatrixSize(0, 1), tbCols));
    slots.style.cssText = 'display:grid; gap:6px; margin:12px 0 14px; grid-template-columns:repeat(' + tbCols + ', 1fr);';
    for (let r = 0; r < tbRows; r++) for (let c = 0; c < tbCols; c++) slots.appendChild(tbMakeCell({ 'data-r': r, 'data-c': c }));
  } else if (tbCurrent === 'cases') {
    controls.appendChild(tbSizeControls('行', () => tbCasesSize(-1), () => tbCasesSize(1), tbCaseRows));
    slots.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin:12px 0 14px;';
    for (let r = 0; r < tbCaseRows; r++) {
      const row = document.createElement('div'); row.style.cssText = 'display:flex; gap:8px; align-items:center;';
      const v = tbMakeCell({ 'data-row': r, 'data-col': 0, placeholder: '値 例 x' }); v.style.textAlign = 'left';
      const sep = document.createElement('span'); sep.textContent = 'のとき'; sep.style.cssText = 'font-size:12px; color:var(--text2); white-space:nowrap;';
      const c = tbMakeCell({ 'data-row': r, 'data-col': 1, placeholder: '条件 例 x>0' }); c.style.textAlign = 'left';
      row.appendChild(v); row.appendChild(sep); row.appendChild(c); slots.appendChild(row);
    }
  } else {
    const defs = TB_FIELDS[tbCurrent] || [];
    slots.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin:12px 0 14px;';
    defs.forEach(([k, label, ph, def]) => {
      const row = document.createElement('div'); row.style.cssText = 'display:flex; gap:10px; align-items:center;';
      const lab = document.createElement('span'); lab.textContent = label; lab.style.cssText = 'font-size:13px; color:var(--text2); min-width:88px;';
      const inp = tbMakeCell({ 'data-k': k, placeholder: ph || '' }); inp.style.textAlign = 'left';
      if (def) inp.value = def;
      row.appendChild(lab); row.appendChild(inp); slots.appendChild(row);
    });
  }
  tbUpdatePreview();
}
function tbMatrixSize(dr, dc) {
  const prev = tbReadMatrix();
  tbRows = Math.max(1, Math.min(TB_MAX, tbRows + dr));
  tbCols = Math.max(1, Math.min(TB_MAX, tbCols + dc));
  renderTemplate();
  document.querySelectorAll('#tb-slots .mb-cell').forEach(inp => { const r = +inp.dataset.r, c = +inp.dataset.c; if (prev[r] && prev[r][c] != null) inp.value = prev[r][c]; });
  tbUpdatePreview();
}
function tbCasesSize(d) {
  const prev = tbReadCases();
  tbCaseRows = Math.max(1, Math.min(TB_MAX, tbCaseRows + d));
  renderTemplate();
  document.querySelectorAll('#tb-slots .mb-cell').forEach(inp => { const r = +inp.dataset.row, c = +inp.dataset.col; if (prev[r] && prev[r][c] != null) inp.value = prev[r][c]; });
  tbUpdatePreview();
}
function tbReadFields() { const o = {}; document.querySelectorAll('#tb-slots .mb-cell[data-k]').forEach(i => o[i.dataset.k] = i.value.trim()); return o; }
function tbReadMatrix() { const m = []; document.querySelectorAll('#tb-slots .mb-cell[data-r]').forEach(i => { const r = +i.dataset.r, c = +i.dataset.c; (m[r] = m[r] || [])[c] = i.value; }); return m; }
function tbReadCases() { const rows = []; document.querySelectorAll('#tb-slots .mb-cell[data-row]').forEach(i => { const r = +i.dataset.row, c = +i.dataset.col; (rows[r] = rows[r] || ['', ''])[c] = i.value.trim(); }); return rows; }

// 素のテキスト表記を作る（回答欄に挿入される文字列）
function buildTemplateNotation() {
  if (tbCurrent === 'matrix') return '[' + tbReadMatrix().map(row => row.map(c => (c || '').trim()).join(' ')).join('; ') + ']';
  if (tbCurrent === 'cases') return '{ ' + tbReadCases().filter(r => r[0] || r[1]).map(r => r[0] + (r[1] ? (' (' + r[1] + 'のとき)') : '')).join('; ') + ' }';
  const f = tbReadFields();
  switch (tbCurrent) {
    case 'integral': { const b = (f.lo !== '' && f.up !== '') ? ('[' + f.lo + ',' + f.up + ']') : ''; return '∫' + b + ' ' + (f.f || '') + ' d' + (f.dx || 'x'); }
    case 'sum':  return 'Σ[' + (f.v || 'i') + '=' + (f.from || '') + ',' + (f.to || '') + '] ' + (f.body || '');
    case 'prod': return 'Π[' + (f.v || 'i') + '=' + (f.from || '') + ',' + (f.to || '') + '] ' + (f.body || '');
    case 'limit': return 'lim(' + (f.v || 'x') + '→' + (f.to || '') + ') ' + (f.body || '');
    case 'frac': return '(' + (f.num || '') + ')/(' + (f.den || '') + ')';
  }
  return '';
}
// プレビュー用 LaTeX（空欄は □ で表示）
function buildTemplatePreviewTex() {
  const o = s => (s === undefined || s === '') ? '\\square' : s;
  if (tbCurrent === 'matrix') return '\\begin{bmatrix}' + tbReadMatrix().map(row => row.map(c => ((c || '').trim() || '\\square')).join(' & ')).join(' \\\\ ') + '\\end{bmatrix}';
  if (tbCurrent === 'cases') { const rows = tbReadCases().filter(r => r[0] || r[1]); if (!rows.length) return '\\begin{cases}\\square & \\square\\end{cases}'; return '\\begin{cases}' + rows.map(r => ((r[0] || '\\square') + ' & ' + (r[1] || ''))).join(' \\\\ ') + '\\end{cases}'; }
  const f = tbReadFields();
  switch (tbCurrent) {
    case 'integral': { const hb = (f.lo !== '' && f.up !== ''); return '\\int' + (hb ? ('_{' + f.lo + '}^{' + f.up + '}') : '') + ' ' + o(f.f) + ' \\, d' + (f.dx || 'x'); }
    case 'sum':  return '\\sum_{' + (f.v || 'i') + '=' + o(f.from) + '}^{' + o(f.to) + '} ' + o(f.body);
    case 'prod': return '\\prod_{' + (f.v || 'i') + '=' + o(f.from) + '}^{' + o(f.to) + '} ' + o(f.body);
    case 'limit': return '\\lim_{' + (f.v || 'x') + ' \\to ' + o(f.to) + '} ' + o(f.body);
    case 'frac': return '\\frac{' + o(f.num) + '}{' + o(f.den) + '}';
  }
  return '';
}
function tbUpdatePreview() {
  const el = document.getElementById('tb-preview'); if (!el) return;
  if (typeof katex !== 'undefined') {
    try { el.innerHTML = katex.renderToString(buildTemplatePreviewTex(), { throwOnError: false, displayMode: true }); return; } catch (e) {}
  }
  el.textContent = buildTemplateNotation();
}
function insertTemplate() {
  const notation = buildTemplateNotation();
  const target = tbTarget;
  if (target && !target.disabled) { activeMathInput = target; insertMathToken(notation); }
  else { alert('挿入先の回答欄が見つかりません。回答欄をタップしてからもう一度お試しください。'); return; }
  closeTemplateBuilder();
}

// ─── BETA FEATURES (実験的機能：自由描画＋Vision採点／格子点グラフ) ───
let betaDraw = false, betaGraph = false;

function loadBetaSettings() {
  try { betaDraw = localStorage.getItem('aiquiz_beta_draw') === '1'; } catch (e) {}
  try { betaGraph = localStorage.getItem('aiquiz_beta_graph') === '1'; } catch (e) {}
  reflectBetaUI();
  applyBetaToFormatOptions();
}
function reflectBetaUI() {
  const dt = document.getElementById('beta-draw-toggle'); if (dt) dt.checked = betaDraw;
  const gt = document.getElementById('beta-graph-toggle'); if (gt) gt.checked = betaGraph;
  const ds = document.getElementById('beta-draw-state'); if (ds) { ds.textContent = betaDraw ? 'ON' : 'OFF'; ds.className = 'sr-state ' + (betaDraw ? 'on' : 'off'); }
  const gs = document.getElementById('beta-graph-state'); if (gs) { gs.textContent = betaGraph ? 'ON' : 'OFF'; gs.className = 'sr-state ' + (betaGraph ? 'on' : 'off'); }
  const btn = document.getElementById('beta-btn'); if (btn) btn.textContent = (betaDraw || betaGraph) ? 'β機能 ●' : 'β機能';
}
// β形式の回答形式オプションの表示/非表示を切り替え（OFFのものを選択中なら mixed に戻す）
function applyBetaToFormatOptions() {
  const od = document.getElementById('fmt-opt-draw'); if (od) od.hidden = !betaDraw;
  const og = document.getElementById('fmt-opt-graph'); if (og) og.hidden = !betaGraph;
  const sel = document.getElementById('answer-format');
  if (sel) { const cur = sel.options[sel.selectedIndex]; if (cur && cur.hidden) { sel.value = 'mixed'; sel.dispatchEvent(new Event('change', { bubbles: true })); } }
}
function onBetaToggle(name, on) {
  if (name === 'draw') { betaDraw = !!on; try { localStorage.setItem('aiquiz_beta_draw', betaDraw ? '1' : '0'); } catch (e) {} }
  else if (name === 'graph') { betaGraph = !!on; try { localStorage.setItem('aiquiz_beta_graph', betaGraph ? '1' : '0'); } catch (e) {} }
  reflectBetaUI();
  applyBetaToFormatOptions();
}
function openBetaModal() { reflectBetaUI(); const m = document.getElementById('beta-modal'); if (m) m.classList.add('show'); }
function closeBetaModal() { const m = document.getElementById('beta-modal'); if (m) m.classList.remove('show'); }

// ── β：自由描画＋AI採点 ──
let drawCanvas = null, drawCtx = null, drawUndo = [];
function drawGradeAvailable() { return !IS_WIDGET && !!(storedSettings && storedSettings.apiKey); }
function pushDrawUndo() {
  if (!drawCtx) return;
  try { drawUndo.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height)); if (drawUndo.length > 15) drawUndo.shift(); } catch (e) {}
}
function renderDrawQuestion(q, container) {
  const note = document.createElement('div');
  note.style.cssText = 'font-size:12px;color:var(--text2);background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:8px 10px;margin-bottom:8px;line-height:1.6;';
  note.innerHTML = '✏️ <b>β機能</b>：マウス・指・ペンで描いてください。' + (drawGradeAvailable()
    ? '描いた画像をAI（Vision）が読み取って採点します。<span class="imp">手描きの精密な判定は苦手なので、結果は目安です。</span>'
    : '<span class="imp">この環境ではAI採点が使えません（APIキー直結モードが必要）。</span>描いた後は模範解答と見比べて、自分で正誤を選んでください。');
  container.appendChild(note);

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;';
  const colors = ['#1f2937', '#e0245e', '#1d9bf0', '#22c56b'];
  let penColor = colors[0], eraser = false;
  const swatches = [];
  const refreshSwatches = () => swatches.forEach((s, i) => s.style.borderColor = (colors[i] === penColor && !eraser) ? 'var(--text)' : 'transparent');
  colors.forEach(c => {
    const b = document.createElement('button'); b.type = 'button';
    b.style.cssText = 'width:26px;height:26px;border-radius:50%;border:2px solid transparent;background:' + c + ';cursor:pointer;';
    b.onclick = () => { penColor = c; eraser = false; eraserBtn.style.background = ''; refreshSwatches(); };
    swatches.push(b); bar.appendChild(b);
  });
  const mkTool = (label) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn-secondary'; b.textContent = label; b.style.cssText = 'padding:5px 10px;font-size:12px;'; return b; };
  const eraserBtn = mkTool('消しゴム');
  eraserBtn.onclick = () => { eraser = !eraser; eraserBtn.style.background = eraser ? '#ececec' : ''; refreshSwatches(); };
  const undoBtn = mkTool('取り消し');
  undoBtn.onclick = () => { if (drawUndo.length && drawCtx) drawCtx.putImageData(drawUndo.pop(), 0, 0); };
  const clearBtn = mkTool('全消去');
  clearBtn.onclick = () => { if (!drawCtx) return; pushDrawUndo(); drawCtx.fillStyle = '#fff'; drawCtx.fillRect(0, 0, drawCanvas.width, drawCanvas.height); };
  bar.appendChild(eraserBtn); bar.appendChild(undoBtn); bar.appendChild(clearBtn);
  container.appendChild(bar);
  refreshSwatches();

  const canvas = document.createElement('canvas');
  canvas.width = 720; canvas.height = 380;
  canvas.style.cssText = 'width:100%;height:auto;border:1px solid var(--border2);border-radius:8px;background:#fff;touch-action:none;display:block;cursor:crosshair;';
  container.appendChild(canvas);
  drawCanvas = canvas; drawCtx = canvas.getContext('2d'); drawUndo = [];
  drawCtx.fillStyle = '#fff'; drawCtx.fillRect(0, 0, canvas.width, canvas.height);
  drawCtx.lineCap = 'round'; drawCtx.lineJoin = 'round';

  let drawing = false, last = null;
  const pos = e => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) }; };
  canvas.addEventListener('pointerdown', e => { if (answered) return; drawing = true; pushDrawUndo(); last = pos(e); try { canvas.setPointerCapture(e.pointerId); } catch (err) {} });
  canvas.addEventListener('pointermove', e => { if (!drawing) return; const p = pos(e); drawCtx.strokeStyle = eraser ? '#fff' : penColor; drawCtx.lineWidth = eraser ? 18 : 2.5; drawCtx.beginPath(); drawCtx.moveTo(last.x, last.y); drawCtx.lineTo(p.x, p.y); drawCtx.stroke(); last = p; });
  const endStroke = () => { drawing = false; last = null; };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', endStroke);

  const submit = document.createElement('button');
  submit.className = 'btn-primary quiz-submit-btn'; submit.id = 'draw-submit';
  submit.textContent = drawGradeAvailable() ? 'AIに採点してもらう' : '描けたら採点へ';
  submit.onclick = submitDrawAnswer;
  container.appendChild(submit);
}
async function submitDrawAnswer() {
  if (answered) return;
  const q = questions[currentQ];
  const submit = document.getElementById('draw-submit');
  if (drawGradeAvailable()) {
    answered = true;
    if (submit) { submit.disabled = true; submit.textContent = '採点中…'; }
    let grade;
    try { grade = await gradeDrawAnswer(q, drawCanvas.toDataURL('image/png')); }
    catch (e) { grade = { score: 0, verdict: 'incorrect', feedback: '採点に失敗しました（' + (e.message || e) + '）。模範解答と見比べて自己採点してください。' }; }
    if (submit) submit.style.display = 'none';
    showDrawResult(q, grade);
    finishAnswer(grade.score >= 60);
  } else {
    answered = true;
    if (submit) submit.style.display = 'none';
    showDrawSelfGrade(q);
  }
}
function showDrawResult(q, grade) {
  const vClass = grade.verdict === 'correct' ? 'correct' : (grade.verdict === 'partial' ? 'partial' : 'incorrect');
  const vLabel = grade.verdict === 'correct' ? '正解' : (grade.verdict === 'partial' ? '部分点' : '不正解');
  const panel = document.createElement('div'); panel.className = 'text-result';
  panel.innerHTML = `<div class="text-score-row"><span class="text-score">${grade.score}<span style="font-size:14px;color:var(--text2)">点</span></span><span class="text-verdict ${vClass}">${vLabel}</span></div><div class="text-feedback">${escapeHtml(grade.feedback || '')}</div>${q.model_answer ? `<div class="text-model"><strong>模範解答：</strong>${mathToHtml(q.model_answer)}</div>` : ''}`;
  document.getElementById('choices').appendChild(panel);
}
function showDrawSelfGrade(q) {
  const panel = document.createElement('div'); panel.className = 'text-result';
  panel.innerHTML = `<div class="text-feedback">自分の描画を模範解答と見比べて、正誤を選んでください。</div>${q.model_answer ? `<div class="text-model"><strong>模範解答：</strong>${mathToHtml(q.model_answer)}</div>` : ''}`;
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
  const ok = document.createElement('button'); ok.className = 'btn-primary'; ok.textContent = 'できていた（正解）'; ok.style.flex = '1';
  const ng = document.createElement('button'); ng.className = 'btn-secondary'; ng.textContent = 'できなかった（不正解）'; ng.style.flex = '1';
  ok.onclick = () => { ok.disabled = true; ng.disabled = true; finishAnswer(true); };
  ng.onclick = () => { ok.disabled = true; ng.disabled = true; finishAnswer(false); };
  row.appendChild(ok); row.appendChild(ng); panel.appendChild(row);
  document.getElementById('choices').appendChild(panel);
}
async function gradeDrawAnswer(q, dataUrl) {
  const b64 = (dataUrl || '').split(',')[1] || '';
  const sys = `あなたは公正な採点者です。学習者が手描きした画像を見て、問題の要求と模範解答（採点基準）に照らして採点してください。手描きのブレは大目に見て、要点（形状・特徴・通る点・ラベルなど）が押さえられているかを重視します。必ず次のJSONのみで返答（他の文章は不要）：{"score":0から100の整数,"verdict":"correct"または"partial"または"incorrect","feedback":"短い講評(1〜2文,日本語)"}`;
  const userText = `【問題】${q.question}\n【模範解答(描くべき図の説明)】${q.model_answer || '（なし）'}\n【押さえるべき要素】${(q.keywords && q.keywords.length) ? q.keywords.join(' / ') : '（指定なし）'}\n\n添付の手描き画像を採点してください。`;
  const text = await aiGradeComplete({ apiKey: storedSettings.apiKey, system: sys, userText: userText, imageB64: b64, maxTokens: 400, jsonOut: true });
  const clean = (text || '').replace(/```json|```/g, '').trim();
  let g = null;
  try { g = JSON.parse(clean); } catch { const mm = clean.match(/\{[\s\S]*\}/); if (mm) { try { g = JSON.parse(mm[0]); } catch (e) {} } }
  if (!g || typeof g.score === 'undefined') return { score: 0, verdict: 'incorrect', feedback: 'AIの採点結果を解析できませんでした。模範解答と見比べて確認してください。' };
  g.score = Math.max(0, Math.min(100, parseInt(g.score) || 0));
  if (!['correct', 'partial', 'incorrect'].includes(g.verdict)) g.verdict = g.score >= 80 ? 'correct' : (g.score >= 50 ? 'partial' : 'incorrect');
  if (typeof g.feedback !== 'string') g.feedback = '';
  return g;
}

// ── β：格子点グラフ（座標グリッドに打点・決定論採点） ──
let graphCfg = null, graphPlaced = [], graphLocked = false;
function renderGraphQuestion(q, container) {
  const note = document.createElement('div');
  note.style.cssText = 'font-size:12px;color:var(--text2);background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:8px 10px;margin-bottom:8px;line-height:1.6;';
  note.innerHTML = '📈 <b>β機能</b>：格子点（交点）をクリックして打点します。もう一度クリックで取り消し。' + (q.mode === 'polyline' ? '<b>クリックした順に線で結ばれます。</b>' : '');
  container.appendChild(note);

  const g = q.grid || {};
  const xmin = Number.isFinite(g.xmin) ? Math.round(g.xmin) : -5;
  const xmax = Number.isFinite(g.xmax) ? Math.round(g.xmax) : 5;
  const ymin = Number.isFinite(g.ymin) ? Math.round(g.ymin) : -5;
  const ymax = Number.isFinite(g.ymax) ? Math.round(g.ymax) : 5;
  const W = Math.max(1, xmax - xmin), H = Math.max(1, ymax - ymin);
  const cell = Math.max(18, Math.min(42, Math.floor(460 / Math.max(W, H))));
  const pad = 26;
  graphCfg = { xmin, xmax, ymin, ymax, cell, pad, svgW: W * cell + pad * 2, svgH: H * cell + pad * 2 };
  graphPlaced = []; graphLocked = false;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'graph-svg';
  svg.setAttribute('viewBox', `0 0 ${graphCfg.svgW} ${graphCfg.svgH}`);
  svg.style.cssText = 'width:100%;max-width:' + graphCfg.svgW + 'px;height:auto;border:1px solid var(--border2);border-radius:8px;background:#fff;touch-action:manipulation;display:block;cursor:crosshair;';
  svg.addEventListener('click', e => {
    if (graphLocked) return;
    const pt = svgClientToLattice(svg, e);
    if (!pt) return;
    const i = graphPlaced.findIndex(p => p[0] === pt[0] && p[1] === pt[1]);
    if (i >= 0) graphPlaced.splice(i, 1); else graphPlaced.push(pt);
    drawGraph(false);
    const sb = document.getElementById('graph-submit'); if (sb) sb.disabled = graphPlaced.length === 0;
  });
  container.appendChild(svg);

  const submit = document.createElement('button');
  submit.className = 'btn-primary quiz-submit-btn'; submit.id = 'graph-submit';
  submit.textContent = '回答する'; submit.disabled = true;
  submit.onclick = submitGraphAnswer;
  container.appendChild(submit);

  drawGraph(false);
}
function svgClientToLattice(svg, e) {
  const r = svg.getBoundingClientRect();
  const { xmin, ymax, cell, pad, svgW } = graphCfg;
  const scale = svgW / r.width;
  const mx = (e.clientX - r.left) * scale, my = (e.clientY - r.top) * scale;
  const x = Math.round((mx - pad) / cell) + xmin;
  const y = ymax - Math.round((my - pad) / cell);
  if (x < graphCfg.xmin || x > graphCfg.xmax || y < graphCfg.ymin || y > graphCfg.ymax) return null;
  return [x, y];
}
function drawGraph(showExpected) {
  const svg = document.getElementById('graph-svg'); if (!svg || !graphCfg) return;
  const { xmin, xmax, ymin, ymax, cell, pad } = graphCfg;
  const q = questions[currentQ];
  const NS = 'http://www.w3.org/2000/svg';
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const mk = (t, a) => { const el = document.createElementNS(NS, t); for (const k in a) el.setAttribute(k, a[k]); return el; };
  const toX = x => pad + (x - xmin) * cell, toY = y => pad + (ymax - y) * cell;
  for (let x = xmin; x <= xmax; x++) svg.appendChild(mk('line', { x1: toX(x), y1: toY(ymax), x2: toX(x), y2: toY(ymin), stroke: x === 0 ? '#9aa3af' : '#e5e7eb', 'stroke-width': x === 0 ? 1.5 : 1 }));
  for (let y = ymin; y <= ymax; y++) svg.appendChild(mk('line', { x1: toX(xmin), y1: toY(y), x2: toX(xmax), y2: toY(y), stroke: y === 0 ? '#9aa3af' : '#e5e7eb', 'stroke-width': y === 0 ? 1.5 : 1 }));
  // 軸の数値（端のみ・原点）
  const lab = (s, x, y) => { const t = mk('text', { x: x, y: y, 'font-size': 10, fill: '#6b7280' }); t.textContent = s; svg.appendChild(t); };
  lab(String(xmax), toX(xmax) - 4, toY(0) + 13); lab(String(xmin), toX(xmin) - 2, toY(0) + 13);
  lab(String(ymax), toX(0) + 4, toY(ymax) + 10); lab(String(ymin), toX(0) + 4, toY(ymin) - 2);
  if (showExpected) {
    const exp = q.points || [];
    if (q.mode === 'polyline' && exp.length > 1) svg.appendChild(mk('path', { d: exp.map((p, i) => (i ? 'L' : 'M') + toX(p[0]) + ' ' + toY(p[1])).join(' '), fill: 'none', stroke: '#22c56b', 'stroke-width': 2, 'stroke-dasharray': '4 3' }));
    exp.forEach(p => svg.appendChild(mk('circle', { cx: toX(p[0]), cy: toY(p[1]), r: 6, fill: 'none', stroke: '#22c56b', 'stroke-width': 2 })));
  }
  if (q.mode === 'polyline' && graphPlaced.length > 1) svg.appendChild(mk('path', { d: graphPlaced.map((p, i) => (i ? 'L' : 'M') + toX(p[0]) + ' ' + toY(p[1])).join(' '), fill: 'none', stroke: '#1d9bf0', 'stroke-width': 2 }));
  graphPlaced.forEach((p, i) => {
    svg.appendChild(mk('circle', { cx: toX(p[0]), cy: toY(p[1]), r: 5, fill: '#1d9bf0' }));
    if (q.mode === 'polyline') { const t = mk('text', { x: toX(p[0]) + 7, y: toY(p[1]) - 7, 'font-size': 11, fill: '#1d9bf0' }); t.textContent = String(i + 1); svg.appendChild(t); }
  });
}
// 置いた点が正解と一致するか（points=順不同、polyline=順序ありで逆順も許容）
function graphCorrect(q, placed) {
  const exp = q.points || [];
  if (placed.length !== exp.length) return false;
  if (q.mode === 'polyline') {
    const same = arr => arr.every((p, i) => p[0] === placed[i][0] && p[1] === placed[i][1]);
    return same(exp) || same(exp.slice().reverse());
  }
  const key = a => a.map(p => p[0] + ',' + p[1]).sort().join(';');
  return key(placed) === key(exp);
}
function submitGraphAnswer() {
  if (answered) return;
  answered = true; graphLocked = true;
  const q = questions[currentQ];
  const ok = graphCorrect(q, graphPlaced);
  drawGraph(!ok); // 不正解なら正解の点を緑で重ねて表示
  const sb = document.getElementById('graph-submit'); if (sb) sb.style.display = 'none';
  if (!ok) {
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:8px;font-size:13px;color:var(--red);';
    note.textContent = '正解：' + formatAnswerText(q);
    document.getElementById('choices').appendChild(note);
  }
  finishAnswer(ok);
}

// ─── SHOW QUESTION ─────────────────────────────────────────────
function showQuizQuestion() {
  const q = questions[currentQ];
  answered = false;
  activeMathInput = null;

  document.getElementById('q-num').textContent = currentQ + 1;
  document.getElementById('q-total').textContent = questions.length;
  document.getElementById('q-label').textContent = `Q${currentQ + 1}`;
  setMath(document.getElementById('q-text'), (q.type === 'fill') ? '次の空欄を埋めてください。' : q.question);
  document.getElementById('stat-q').textContent = currentQ + 1;
  document.getElementById('stat-correct').textContent = correctCount;
  document.getElementById('stat-wrong').textContent = wrongCount;
  const rate = (currentQ > 0) ? Math.round(correctCount / currentQ * 100) + '%' : '–';
  document.getElementById('stat-rate').textContent = rate;
  document.getElementById('next-btn').disabled = true;
  const quitBtn = document.getElementById('quit-btn');
  if (quitBtn) quitBtn.style.display = ''; // クイズ中は常に「中断」を表示
  document.getElementById('explanation-box').classList.remove('show');
  document.getElementById('adaptive-hint').textContent = '';

  const prog = (currentQ / questions.length) * 100;
  document.getElementById('progress-bar').style.width = prog + '%';

  // 難易度順モードは適応難易度がOFFで currentDifficulty が動かないため、各問の実難易度を表示する
  const shownDiff = (storedSettings.orderMode === 'ascending' && q.difficulty) ? q.difficulty : currentDifficulty;
  const diffLevel = { easy: 1, medium: 2, hard: 3 }[shownDiff] || 2;
  for (let i = 1; i <= 3; i++) {
    document.getElementById('d'+i).classList.toggle('on', i <= diffLevel);
  }

  // 図の表示（教材からの切り出し画像を優先、無ければAI生成SVG）
  renderQuestionFigure(q);

  document.getElementById('source-row').style.display = 'none';

  const choicesDiv = document.getElementById('choices');
  choicesDiv.innerHTML = '';
  switch (q.type) {
    case 'sort':  renderSortQuestion(q, choicesDiv); break;
    case 'order': renderOrderQuestion(q, choicesDiv); break;
    case 'fill':  renderFillQuestion(q, choicesDiv); break;
    case 'table': renderTableQuestion(q, choicesDiv); break;
    case 'text':  renderTextQuestion(q, choicesDiv); break;
    case 'draw':  renderDrawQuestion(q, choicesDiv); break;
    case 'graph': renderGraphQuestion(q, choicesDiv); break;
    default:
      q.choices.forEach((c, i) => {
        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.innerHTML = `<span class="choice-label">${LABELS[i]}</span><span>${mathifyValue(c)}</span>`;
        btn.onclick = () => selectAnswer(i, btn);
        choicesDiv.appendChild(btn);
      });
  }

  // 回答入力がある問題形式のときだけ数式キーボードのトグルを表示
  setMathToolsVisible(['fill', 'table', 'text'].includes(q.type));

  saveQuizState(); // 中断・再開用に進行状況を保存
}

function selectAnswer(chosen, clickedBtn) {
  if (answered) return;
  answered = true;

  const q = questions[currentQ];
  const isCorrect = chosen === q.correct;

  const btns = document.querySelectorAll('.choice-btn');
  btns.forEach((b, i) => {
    b.disabled = true;
    if (i === q.correct && !isCorrect) b.classList.add('reveal-correct');
  });
  if (isCorrect) clickedBtn.classList.add('correct');
  else clickedBtn.classList.add('wrong');

  finishAnswer(isCorrect);
}

// ─── SORT (仕分け表) QUESTION ──────────────────────────────────
let sortSelections = [];

function renderSortQuestion(q, container) {
  sortSelections = new Array(q.items.length).fill(-1);
  const table = document.createElement('div');
  table.className = 'sort-table';
  q.items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'sort-row';
    row.dataset.idx = idx;
    const label = document.createElement('div');
    label.className = 'sort-item-label';
    setMath(label, item);
    const btns = document.createElement('div');
    btns.className = 'sort-cat-btns';
    q.categories.forEach((cat, ci) => {
      const b = document.createElement('button');
      b.className = 'sort-cat-btn';
      setMath(b, cat);
      b.onclick = () => selectSortCategory(idx, ci, row);
      btns.appendChild(b);
    });
    row.appendChild(label);
    row.appendChild(btns);
    table.appendChild(row);
  });
  container.appendChild(table);

  const submit = document.createElement('button');
  submit.className = 'btn-primary sort-submit-btn';
  submit.id = 'sort-submit';
  submit.textContent = '回答する';
  submit.disabled = true;
  submit.onclick = submitSortAnswer;
  container.appendChild(submit);
}

function selectSortCategory(itemIdx, catIdx, row) {
  if (answered) return;
  sortSelections[itemIdx] = catIdx;
  row.querySelectorAll('.sort-cat-btn').forEach((b, i) => b.classList.toggle('selected', i === catIdx));
  document.getElementById('sort-submit').disabled = sortSelections.some(s => s < 0);
}

function submitSortAnswer() {
  if (answered) return;
  answered = true;

  const q = questions[currentQ];
  let allCorrect = true;
  document.querySelectorAll('.sort-row').forEach(row => {
    const idx = parseInt(row.dataset.idx);
    const ok = sortSelections[idx] === q.answer[idx];
    if (!ok) allCorrect = false;
    row.classList.add(ok ? 'correct' : 'wrong');
    if (!ok) {
      const note = document.createElement('div');
      note.className = 'sort-answer-note';
      setMath(note, '正解：' + (q.categories[q.answer[idx]] ?? '不明'));
      row.appendChild(note);
    }
    row.querySelectorAll('.sort-cat-btn').forEach(b => b.disabled = true);
  });
  document.getElementById('sort-submit').style.display = 'none';

  finishAnswer(allCorrect);
}

// ─── ORDER (並べ替え) QUESTION ─────────────────────────────────
let orderState = []; // 表示順：各要素は q.items 内の正解インデックス

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderOrderQuestion(q, container) {
  // 正解は q.items の並び順。表示用にシャッフルする。
  let idxs = shuffleArray(q.items.map((_, i) => i));
  // 偶然、初期表示が正解の並びになってしまうのを回避（重複項目があり得るので値で比較）
  if (q.items.length > 1 && idxs.every((v, i) => q.items[v] === q.items[i])) idxs.push(idxs.shift());
  orderState = idxs;

  const list = document.createElement('div');
  list.className = 'order-list';
  list.id = 'order-list';
  container.appendChild(list);
  renderOrderRows(q, list);

  const submit = document.createElement('button');
  submit.className = 'btn-primary quiz-submit-btn';
  submit.id = 'order-submit';
  submit.textContent = '回答する';
  submit.onclick = submitOrderAnswer;
  container.appendChild(submit);
}

function renderOrderRows(q, list) {
  list.innerHTML = '';
  orderState.forEach((itemIdx, pos) => {
    const row = document.createElement('div');
    row.className = 'order-row' + (answered ? '' : ' draggable');
    row.title = answered ? '' : 'ドラッグして並べ替え';
    const handle = document.createElement('div');
    handle.className = 'order-drag';
    handle.textContent = '↕';
    if (answered) handle.style.opacity = '0.3';
    const num = document.createElement('div');
    num.className = 'order-pos';
    num.textContent = (pos + 1) + '.';
    const text = document.createElement('div');
    text.className = 'order-text';
    setMath(text, q.items[itemIdx]);
    const moves = document.createElement('div');
    moves.className = 'order-moves';
    const up = document.createElement('button');
    up.className = 'order-move-btn'; up.textContent = '▲'; up.disabled = pos === 0;
    up.onclick = () => moveOrderItem(pos, -1);
    const down = document.createElement('button');
    down.className = 'order-move-btn'; down.textContent = '▼'; down.disabled = pos === orderState.length - 1;
    down.onclick = () => moveOrderItem(pos, 1);
    moves.appendChild(up); moves.appendChild(down);
    // ブロック全体を掴んでドラッグ（▲▼ボタン上では発火しない）
    if (!answered) row.addEventListener('pointerdown', e => startBlockDrag(e, {
      pos,
      getRows: () => document.getElementById('order-list').querySelectorAll('.order-row'),
      getOrder: () => orderState,
      rerender: () => renderOrderRows(questions[currentQ], document.getElementById('order-list')),
      isLocked: () => answered
    }));
    row.appendChild(handle); row.appendChild(num); row.appendChild(text); row.appendChild(moves);
    list.appendChild(row);
  });
}

function moveOrderItem(pos, dir) {
  if (answered) return;
  const np = pos + dir;
  if (np < 0 || np >= orderState.length) return;
  [orderState[pos], orderState[np]] = [orderState[np], orderState[pos]];
  renderOrderRows(questions[currentQ], document.getElementById('order-list'));
}

// 並べ替えのドラッグ（行ブロック全体を掴む）。隣接する行の中点を越えたら1つ入れ替える方式
// （短いリスト向けで確実・ズレない）。pointermove/up は document に張るので、入れ替えのたびの
// 再描画を跨いでも追従する。通常モード（orderState）と試験モード（examOrderState[i]）で共用。
// opts: pos=掴んだ表示位置 / getRows()=行NodeList / getOrder()=生の並び配列(in-placeで入替) /
//       rerender()=行を描き直す / isLocked()=回答・提出済みでドラッグ不可なら true
function startBlockDrag(e, opts) {
  if (opts.isLocked()) return;
  if (e.button != null && e.button !== 0) return; // 右クリック等は無視
  if (e.target.closest('button')) return;         // ▲▼ボタン上ではドラッグを開始しない（クリックさせる）
  e.preventDefault();
  let cur = opts.pos;
  const mark = () => { const rows = opts.getRows(); if (rows[cur]) rows[cur].classList.add('dragging'); };
  mark();
  const swap = (a, b) => {
    const order = opts.getOrder();
    [order[a], order[b]] = [order[b], order[a]];
    cur = b;
    opts.rerender();
    mark();
  };
  const onMove = ev => {
    if (opts.isLocked()) { onUp(); return; }
    const rows = opts.getRows();
    const y = ev.clientY;
    if (cur > 0) {
      const prev = rows[cur - 1].getBoundingClientRect();
      if (y < prev.top + prev.height / 2) { swap(cur, cur - 1); return; }
    }
    if (cur < rows.length - 1) {
      const next = rows[cur + 1].getBoundingClientRect();
      if (y > next.top + next.height / 2) { swap(cur, cur + 1); return; }
    }
  };
  const onUp = () => {
    const rows = opts.getRows();
    if (rows[cur]) rows[cur].classList.remove('dragging');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

function submitOrderAnswer() {
  if (answered) return;
  answered = true;
  const q = questions[currentQ];
  // 重複する文言の項目があり得るため、インデックスではなく値（テキスト）で正誤判定する
  const allCorrect = orderState.every((v, i) => q.items[v] === q.items[i]);

  document.querySelectorAll('#order-list .order-row').forEach((row, pos) => {
    row.classList.remove('draggable'); // ドラッグ無効化（cursor/touch-actionも戻る）
    row.classList.add(q.items[orderState[pos]] === q.items[pos] ? 'correct' : 'wrong');
    row.querySelectorAll('.order-move-btn').forEach(b => b.disabled = true);
    row.querySelectorAll('.order-drag').forEach(h => { h.style.opacity = '0.3'; });
  });
  if (!allCorrect) {
    const note = document.createElement('div');
    note.className = 'order-answer-note';
    setMath(note, '正しい順序：' + q.items.join(' → '));
    document.getElementById('order-list').appendChild(note);
  }
  document.getElementById('order-submit').style.display = 'none';
  finishAnswer(allCorrect);
}

// ─── FILL (穴埋め) QUESTION ────────────────────────────────────
// 全角→半角・空白除去・小文字化して比較しやすくする
// strict=true（語学向け厳密採点）：大文字小文字・語間スペース・記号を区別する。
// strict=false（既定・通常）：表記の揺れ（大小文字・空白・記号・順序）を吸収する。
// [js/grading.js に移動] normalizeText / isMathExpr / exprCanon / mathEquiv / answerMatches（純粋採点コア・テスト対象）

// 「回答する」ボタンの有効/無効を全空欄の入力状況から更新
function updateFillSubmitState() {
  const btn = document.getElementById('fill-submit');
  if (!btn) return;
  const inputs = [...document.querySelectorAll('.fill-input')];
  btn.disabled = inputs.some(inp => inp.value.trim() === '');
}

// 空欄の入力欄を1つ作る（idx は q.blanks に対応する0始まりの空欄番号）
function makeFillInput(idx) {
  const input = document.createElement('input');
  input.className = 'fill-input';
  input.type = 'text';
  input.dataset.idx = idx;
  input.autocomplete = 'off';
  input.addEventListener('input', updateFillSubmitState);
  registerMathInput(input);
  return input;
}

function renderFillQuestion(q, container) {
  const sentence = document.createElement('div');
  sentence.className = 'fill-sentence';
  const below = document.createElement('div'); // 行列など、数式の中の空欄は下にまとめて入力させる
  below.style.cssText = 'margin-top:12px; display:flex; flex-direction:column; gap:8px;';

  let blankNo = 0;              // 0始まりの空欄番号（q.blanks と対応）
  const deferred = [];         // 数式環境内の空欄番号（下にまとめる）

  const appendMath = txt => { const span = document.createElement('span'); span.innerHTML = mathToHtml(txt); sentence.appendChild(span); };
  // 非数式テキスト：___ で割って、間にインライン入力欄を挟む
  const appendPlain = txt => {
    const segs = txt.split(/[_＿]{3,}/);
    segs.forEach((seg, i) => {
      appendMath(seg);
      if (i < segs.length - 1) sentence.appendChild(makeFillInput(blankNo++));
    });
  };

  const reMath = /\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g;
  let last = 0, m;
  while ((m = reMath.exec(q.question)) !== null) {
    appendPlain(q.question.slice(last, m.index));
    const tok = m[0];
    const disp = tok.startsWith('$$');
    const d = disp ? '$$' : '$';
    const inner = disp ? tok.slice(2, -2) : tok.slice(1, -1);
    if (/[_＿]{3,}/.test(inner)) {
      // 数式の中の空欄は、分割すると行列・\frac・\sqrt などが壊れるため、空欄を箱に置き換えて
      // 数式全体を描画し、入力欄は番号付きで下にまとめて出す（LaTeXを崩さない）。
      const rep = inner.replace(/[_＿]{3,}/g, () => { const no = blankNo++; deferred.push(no); return '\\boxed{(' + (no + 1) + ')}'; });
      appendMath(d + rep + d);
    } else {
      appendMath(tok);
    }
    last = reMath.lastIndex;
  }
  appendPlain(q.question.slice(last));
  container.appendChild(sentence);

  // 数式環境内の空欄は、番号付きで下にまとめて入力欄を出す
  if (deferred.length) {
    deferred.forEach(no => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap;';
      const lab = document.createElement('span');
      lab.style.cssText = 'color:var(--text2); font-size:13px;';
      lab.textContent = '空欄(' + (no + 1) + ')';
      row.appendChild(lab);
      row.appendChild(makeFillInput(no));
      below.appendChild(row);
    });
    container.appendChild(below);
  }

  const submit = document.createElement('button');
  submit.className = 'btn-primary quiz-submit-btn';
  submit.id = 'fill-submit';
  submit.textContent = '回答する';
  submit.disabled = true;
  submit.onclick = submitFillAnswer;
  container.appendChild(submit);
}

// AI同値判定が使えるか（キーがある／アーティファクト内）
function aiEquivAvailable() {
  return aiEquivEnabled && (IS_WIDGET || !!(storedSettings && storedSettings.apiKey));
}

// ─── AI同値判定のON/OFF設定 ────────────────────────────────────
let aiEquivEnabled = true; // 既定はON（従来挙動）。localStorageに永続化。

function loadAiEqSetting() {
  try { const v = localStorage.getItem('aiquiz_aieq'); if (v !== null) aiEquivEnabled = (v === '1'); } catch {}
  reflectAiEqUI();
}
function reflectAiEqUI() {
  const cb = document.getElementById('aieq-toggle');
  if (cb) cb.checked = aiEquivEnabled;
  const st = document.getElementById('aieq-state');
  if (st) { st.textContent = aiEquivEnabled ? 'ON' : 'OFF'; st.className = 'sr-state ' + (aiEquivEnabled ? 'on' : 'off'); }
}
function onAiEqToggle(checked) {
  aiEquivEnabled = !!checked;
  try { localStorage.setItem('aiquiz_aieq', aiEquivEnabled ? '1' : '0'); } catch {}
  reflectAiEqUI();
  showAiEqInfo(); // 切り替え時に特徴を説明するポップアップ
}
function showAiEqInfo() {
  const m = document.getElementById('aieq-modal');
  if (m) m.classList.add('show');
}
function closeAiEqInfo() {
  const m = document.getElementById('aieq-modal');
  if (m) m.classList.remove('show');
}

// ─── 採点の厳密さ（語学向け） ──────────────────────────────────
// 'auto'：問題ごとの q.strict に従う ／ 'strict'：常に厳密 ／ 'lenient'：常に通常
let gradeStrictMode = 'auto';
function loadStrictSetting() {
  try { const v = localStorage.getItem('aiquiz_strict'); if (v) gradeStrictMode = v; } catch {}
  const sel = document.getElementById('grade-strict');
  if (sel) sel.value = gradeStrictMode;
}
function onStrictModeChange(v) {
  gradeStrictMode = (['auto', 'strict', 'lenient'].includes(v)) ? v : 'auto';
  try { localStorage.setItem('aiquiz_strict', gradeStrictMode); } catch {}
}
// この問題を厳密採点するか（設定＋問題のstrictフラグから決定）
function isStrictQuestion(q) {
  if (gradeStrictMode === 'strict') return true;
  if (gradeStrictMode === 'lenient') return false;
  return !!(q && q.strict); // auto
}

// 文字列照合で外れたセルについて、AIに「数学的・意味的に同値か」をまとめて1回で判定させる。
// 戻り値：pairs と同じ長さの真偽値配列。
async function aiCheckEquivalence(q, pairs) {
  const sys = `あなたは厳格かつ公正な採点者です。各項目について、受験者の解答が正解と「数学的・意味的に同値（同じ内容を別の正しい書き方で表したもの）」であるか否かを判定してください。例：ノルム「‖a‖」と「√(x₁²+y₁²)」、内積「a・b」と「x₁x₂+y₁y₂」は同値。単なる書き間違い・別概念・値が異なるものは同値ではありません。確信が持てない場合は false としてください。必ず長さ${pairs.length}の真偽値のみのJSON配列で返答してください（例：[true,false]）。`;
  const body = pairs.map((p, i) => `${i + 1}. 正解「${p.correct}」／受験者「${p.user}」`).join('\n');
  const user = `【問題】${q.question}\n\n次の各組について、同値かどうかを順に判定してください：\n${body}`;

  let text;
  if (IS_WIDGET) {
    text = await window.claude.complete(sys + '\n\n' + user);
  } else {
    text = await aiGradeComplete({ apiKey: storedSettings.apiKey, system: sys, userText: user, maxTokens: 100, jsonOut: true });
  }
  const clean = (text || '').replace(/```json|```/g, '').trim();
  let arr = null;
  try { arr = JSON.parse(clean); }
  catch { const m = clean.match(/\[[\s\S]*\]/); if (m) { try { arr = JSON.parse(m[0]); } catch {} } }
  if (!Array.isArray(arr)) return pairs.map(() => false);
  return pairs.map((_, i) => arr[i] === true);
}

// 不正解セルに「正解：…」表示と手動上書きボタンを付ける
function addWrongNote(input, correctValue, type) {
  const note = document.createElement(type === 'fill' ? 'span' : 'div');
  note.className = type === 'fill' ? 'fill-correct-note' : 'table-correct';
  note.style.color = 'var(--red)';
  note.innerHTML = '正解：' + mathifyValue(correctValue ?? ''); // 値は表示のみ数式整形（採点は不変）
  input.after(note);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'override-btn';
  btn.textContent = '別解として正解にする';
  btn.title = '自分の解答が正しいと判断した場合に、正解として記録します';
  btn.onclick = () => acceptOverride(input, btn, note);
  note.after(btn);
}

// AIが同値と判定したセルに付けるノート
function addAINote(input, type) {
  const note = document.createElement(type === 'fill' ? 'span' : 'div');
  note.className = (type === 'fill' ? 'fill-correct-note' : 'table-correct') + ' ai-note';
  note.textContent = '別解として正解（AI判定）';
  input.after(note);
}

// 手動で「別解として正解にする」
function acceptOverride(input, btn, note) {
  input.classList.remove('wrong');
  input.classList.add('correct');
  if (btn) btn.remove();
  if (note) { note.textContent = '別解として正解にしました'; note.classList.add('ai-note'); note.style.color = ''; }
  recomputeQuestionScore();
}

// 上書きの結果、この問題の全セルが正解になったら、問題単位の正誤を訂正する
function recomputeQuestionScore() {
  const anyWrong = document.querySelector('#screen-quiz .fill-input.wrong, #screen-quiz .table-input.wrong');
  if (!anyWrong && history[currentQ] === false) {
    history[currentQ] = true;
    correctCount++;
    wrongCount = Math.max(0, wrongCount - 1);
    updateLiveStats();
  }
}

// セル採点の共通処理：文字列照合 → AI同値フォールバック → 描画 → 確定
async function runCellGrading(cells, submitBtn, type) {
  const strict = isStrictQuestion(questions[currentQ]);
  cells.forEach(c => { c.ok = answerMatches(c.userValue, c.accepts, strict); c.input.disabled = true; });

  const unresolved = cells.filter(c => !c.ok && c.userValue.trim() !== '');
  // 厳密モードでは表記揺れを許容しないので、AIによる同値判定は使わない
  if (unresolved.length && !strict && aiEquivAvailable()) {
    if (submitBtn) submitBtn.textContent = '別解を確認中…';
    try {
      const verdicts = await aiCheckEquivalence(questions[currentQ],
        unresolved.map(c => ({ user: c.userValue, correct: c.correctValue })));
      unresolved.forEach((c, i) => { if (verdicts[i] === true) { c.ok = true; c.byAI = true; } });
    } catch {}
  }

  cells.forEach(c => {
    c.input.classList.add(c.ok ? 'correct' : 'wrong');
    if (c.ok && c.byAI) addAINote(c.input, type);
    else if (!c.ok) addWrongNote(c.input, c.correctValue, type);
  });
  if (submitBtn) submitBtn.style.display = 'none';
  finishAnswer(cells.every(c => c.ok));
}

async function submitFillAnswer() {
  if (answered) return;
  answered = true;
  const q = questions[currentQ];
  // DOM順ではなく空欄番号(dataset.idx)で q.blanks と対応させる（行列内の空欄を下にまとめても順序がずれない）
  const cells = [...document.querySelectorAll('.fill-input')].map(inp => {
    const i = parseInt(inp.dataset.idx);
    return {
      input: inp,
      userValue: inp.value,
      accepts: [q.blanks[i], ...((q.accept && q.accept[i]) || [])],
      correctValue: q.blanks[i] ?? ''
    };
  });
  await runCellGrading(cells, document.getElementById('fill-submit'), 'fill');
}

// ─── TABLE (表穴埋め) QUESTION ─────────────────────────────────
function isBlankCell(q, r, c) {
  return (q.blanks || []).some(b => b.r === r && b.c === c);
}

function renderTableQuestion(q, container) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.className = 'quiz-table';

  // 見出し行（任意）
  if (q.headers && q.headers.length) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    q.headers.forEach(h => {
      const th = document.createElement('th');
      setMath(th, h);
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    table.appendChild(thead);
  }

  const tbody = document.createElement('tbody');
  q.rows.forEach((row, r) => {
    const tr = document.createElement('tr');
    row.forEach((cell, c) => {
      const td = document.createElement('td');
      if (isBlankCell(q, r, c)) {
        const input = document.createElement('input');
        input.className = 'table-input';
        input.type = 'text';
        input.dataset.r = r;
        input.dataset.c = c;
        input.autocomplete = 'off';
        input.addEventListener('input', () => {
          const inputs = [...document.querySelectorAll('.table-input')];
          document.getElementById('table-submit').disabled = inputs.some(inp => inp.value.trim() === '');
        });
        registerMathInput(input);
        td.appendChild(input);
      } else {
        if (c === 0) td.className = 'rowhead';
        setMath(td, cell);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  const submit = document.createElement('button');
  submit.className = 'btn-primary quiz-submit-btn';
  submit.id = 'table-submit';
  submit.textContent = '回答する';
  submit.disabled = true;
  submit.onclick = submitTableAnswer;
  container.appendChild(submit);
}

function tableBlankAccepts(q, r, c) {
  const b = (q.blanks || []).find(x => x.r === r && x.c === c);
  const list = [q.rows[r][c]];
  if (b && Array.isArray(b.accept)) list.push(...b.accept);
  return list; // 生データを返す（判定は answerMatches 側で正規化・数式同値を行う）
}

async function submitTableAnswer() {
  if (answered) return;
  answered = true;
  const q = questions[currentQ];
  const cells = [...document.querySelectorAll('.table-input')].map(inp => {
    const r = parseInt(inp.dataset.r), c = parseInt(inp.dataset.c);
    return {
      input: inp,
      userValue: inp.value,
      accepts: tableBlankAccepts(q, r, c),
      correctValue: q.rows[r][c] ?? ''
    };
  });
  await runCellGrading(cells, document.getElementById('table-submit'), 'table');
}

// ─── TEXT (記述・AI採点) QUESTION ──────────────────────────────
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// この問題が行列を扱うか（問題文・模範解答・要点に行列環境や「行列」の語が含まれるか）
function involvesMatrix(q) {
  const s = [q.question, q.model_answer, (q.keywords || []).join(' ')].join(' ');
  return /\\begin\{[a-zA-Z]*matrix\}|行列/.test(s);
}

// 問題文の字数指定を返す。「N文字以内」＝上限(hard)、「N文字程度」＝目安(soft)。無ければ null。全角数字も許容。
function parseCharLimit(q) {
  const s = String((q && q.question) || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  let m = s.match(/(\d+)\s*(?:文字|字)\s*以内/);
  if (m) return { n: parseInt(m[1], 10), hard: true };
  m = s.match(/(\d+)\s*(?:文字|字)\s*程度/);
  if (m) return { n: parseInt(m[1], 10), hard: false };
  return null;
}

// 記述の回答欄に文字数カウンタを付ける。
//  ・「N文字以内」：現在/上限字 を表示し、超過で赤（.over）。
//  ・「N文字程度」：現在/目安字（目安）を表示（“程度”なので超過赤は付けない）。
//  ・指定なし：現在字 のみ。
// カウントはコードポイント単位（[...str].length）＝サロゲートペアも1文字として数える。
// 数式キーボードでの挿入も input イベントを発火するので、その入力も自動で反映される。
function attachCharCounter(textarea, q, container) {
  const lim = parseCharLimit(q);
  const counter = document.createElement('div');
  counter.className = 'char-counter';
  const update = () => {
    const n = [...textarea.value].length;
    if (lim) {
      counter.textContent = n + ' / ' + lim.n + '字' + (lim.hard ? '' : '（目安）');
      counter.classList.toggle('over', lim.hard && n > lim.n);
    } else {
      counter.textContent = n + '字';
    }
  };
  textarea.addEventListener('input', update);
  update();
  container.appendChild(counter);
  return counter;
}

function renderTextQuestion(q, container) {
  // 行列が絡む記述では、初心者向けに入力の書き方を案内する（[1 2; 3 4] が自明でないため）
  if (involvesMatrix(q)) {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px; color:var(--text2); background:var(--surface2); border:1px solid var(--border2); border-radius:8px; padding:8px 10px; margin-bottom:8px; line-height:1.7;';
    hint.innerHTML = '💡 行列は <span style="font-family:monospace; background:var(--surface); padding:1px 5px; border-radius:4px;">[1 2; 3 4]</span> のように書けます（同じ行の数字は<b>半角スペース</b>区切り、行が変わるところは<b>半角の ;</b>）。√・分数・添字などの記号は、右下の「∑ 数式キーボード」からも入力できます。' +
      '<div style="margin-top:8px;"><button type="button" onmousedown="event.preventDefault()" onclick="openTemplateBuilder(\'matrix\')" style="font-size:12px; padding:6px 12px; border-radius:7px; border:1px solid var(--accent); background:var(--accent-glow); color:var(--accent); cursor:pointer;">⊞ 数式テンプレート（行列・分数など）</button></div>';
    container.appendChild(hint);
  }

  const ta = document.createElement('textarea');
  ta.className = 'text-answer';
  ta.id = 'text-answer';
  ta.placeholder = 'ここに自分の言葉で解答を入力してください。';
  // 入力量に応じて高さを自動で伸ばす（長い計算過程でも内部スクロールにせず全体を見せる）。
  // 上限は画面の7割までとし、それを超えたらスクロールに切り替える。
  ta.style.overflowY = 'hidden';
  const autoGrow = () => {
    ta.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.7);
    const h = Math.min(ta.scrollHeight, max);
    ta.style.height = h + 'px';
    ta.style.overflowY = (ta.scrollHeight > max) ? 'auto' : 'hidden';
  };
  ta.addEventListener('input', () => {
    document.getElementById('text-submit').disabled = ta.value.trim() === '';
    autoGrow();
  });
  registerMathInput(ta);
  container.appendChild(ta);
  attachCharCounter(ta, q, container); // 文字数カウンタ（「N文字以内」指定があれば上限も表示）
  requestAnimationFrame(autoGrow); // 初期表示・再開時の復元内容に合わせて高さを整える

  const submit = document.createElement('button');
  submit.className = 'btn-primary quiz-submit-btn';
  submit.id = 'text-submit';
  submit.textContent = 'AIに採点してもらう';
  submit.disabled = true;
  submit.onclick = submitTextAnswer;
  container.appendChild(submit);
}

async function submitTextAnswer() {
  if (answered) return;
  const q = questions[currentQ];
  const ta = document.getElementById('text-answer');
  const userAnswer = ta.value.trim();
  if (!userAnswer) return;
  answered = true;
  ta.disabled = true;
  const submit = document.getElementById('text-submit');
  submit.disabled = true;
  submit.textContent = '採点中…';

  let grade;
  try {
    grade = await gradeTextAnswer(q, userAnswer);
  } catch (e) {
    grade = { score: 0, verdict: 'incorrect', feedback: '採点に失敗しました（' + (e.message || e) + '）。模範解答と見比べて自己採点してください。' };
  }
  submit.style.display = 'none';

  const isCorrect = grade.score >= 60;
  const vClass = grade.verdict === 'correct' ? 'correct' : (grade.verdict === 'partial' ? 'partial' : 'incorrect');
  const vLabel = grade.verdict === 'correct' ? '正解' : (grade.verdict === 'partial' ? '部分点' : '不正解');

  const panel = document.createElement('div');
  panel.className = 'text-result';
  panel.innerHTML = `
    <div class="text-score-row">
      <span class="text-score">${grade.score}<span style="font-size:14px;color:var(--text2)">点</span></span>
      <span class="text-verdict ${vClass}">${vLabel}</span>
    </div>
    <div class="text-feedback">${escapeHtml(grade.feedback || '')}</div>
    ${q.model_answer ? `<div class="text-model"><strong>模範解答：</strong>${mathToHtml(q.model_answer)}</div>` : ''}
  `;
  document.getElementById('choices').appendChild(panel);

  finishAnswer(isCorrect);
}

// AIで記述回答を採点。{score, verdict, feedback} を返す
async function gradeTextAnswer(q, userAnswer) {
  const sys = `あなたは公正な採点者です。受験者の記述回答を、問題文・模範解答・採点の要点に照らして採点してください。表現の言い回しの違いは許容し、内容（要点を押さえているか）を重視します。必ず次のJSONのみで返答してください（他の文章は不要）：
{"score": 0から100の整数, "verdict": "correct" または "partial" または "incorrect", "feedback": "短い講評（1〜2文、日本語）"}`;
  const user = `【問題】${q.question}
【模範解答】${q.model_answer || '（なし）'}
【押さえるべき要点】${(q.keywords && q.keywords.length) ? q.keywords.join(' / ') : '（指定なし）'}
【受験者の回答】${userAnswer}

採点してください。`;

  let text;
  if (IS_WIDGET) {
    text = await window.claude.complete(sys + '\n\n' + user);
  } else {
    if (!storedSettings.apiKey) return keywordGrade(q, userAnswer);
    try {
      text = await aiGradeComplete({ apiKey: storedSettings.apiKey, system: sys, userText: user, maxTokens: 400, jsonOut: true });
    } catch (e) {
      return keywordGrade(q, userAnswer); // AI採点に失敗したらキーワード採点にフォールバック（無料で続行）
    }
  }

  const clean = (text || '').replace(/```json|```/g, '').trim();
  let g = null;
  try { g = JSON.parse(clean); }
  catch { const m = clean.match(/\{[\s\S]*\}/); if (m) { try { g = JSON.parse(m[0]); } catch {} } }
  if (!g || typeof g.score === 'undefined') return keywordGrade(q, userAnswer);
  g.score = Math.max(0, Math.min(100, parseInt(g.score) || 0));
  if (!['correct', 'partial', 'incorrect'].includes(g.verdict)) {
    g.verdict = g.score >= 80 ? 'correct' : (g.score >= 50 ? 'partial' : 'incorrect');
  }
  if (typeof g.feedback !== 'string') g.feedback = '';
  return g;
}

// AIが使えない時のフォールバック：キーワード一致率で採点
// [js/grading.js に移動] keywordGrade

// 回答確定後の共通処理（解説・出典・難易度調整・統計）
function finishAnswer(isCorrect) {
  if (isCorrect) correctCount++;
  else wrongCount++;

  history.push(isCorrect);

  const q = questions[currentQ];
  setMath(document.getElementById('explanation-text'), q.explanation || '');
  const srcRow = document.getElementById('source-row');
  if (q.source) {
    let srcTxt = formatSource(q.source);
    if (q.quoteVerified === false) srcTxt += '　⚠ 引用未確認（教材本文で確認できず）';
    document.getElementById('source-text').textContent = srcTxt;
    srcRow.style.display = 'flex';
  } else {
    srcRow.style.display = 'none';
  }
  document.getElementById('explanation-box').classList.add('show');
  document.getElementById('next-btn').disabled = false;
  setMathToolsVisible(false); // 回答確定後は入力欄が無効になるので数式キーボードを閉じる

  const newDiff = getAdaptiveDifficulty();
  if (storedSettings.orderMode !== 'ascending' && newDiff !== currentDifficulty) {
    const msgs = {
      easy: '難易度を下げました',
      medium: isCorrect ? '難易度を上げました' : '難易度を調整しました',
      hard: '難易度を上げました'
    };
    document.getElementById('adaptive-hint').textContent = msgs[newDiff] || '';
    currentDifficulty = newDiff;
  }

  updateLiveStats();
}

// クイズ中の正解・不正解・正答率の表示を更新（採点確定時・手動上書き時に共通利用）
function updateLiveStats() {
  document.getElementById('stat-correct').textContent = correctCount;
  document.getElementById('stat-wrong').textContent = wrongCount;
  const rate = Math.round(correctCount / (currentQ + 1) * 100);
  document.getElementById('stat-rate').textContent = rate + '%';
}

// ─── SOURCE REFERENCE (出典) ───────────────────────────────────
const fileUrlMap = new Map();

function getFileUrl(file) {
  if (!fileUrlMap.has(file)) fileUrlMap.set(file, URL.createObjectURL(file));
  return fileUrlMap.get(file);
}

// 生成済みのオブジェクトURLをすべて解放してマップを空にする（ファイル変更・再開復元時に呼ぶ）
function revokeFileUrls() {
  try { fileUrlMap.forEach(url => URL.revokeObjectURL(url)); } catch (e) {}
  fileUrlMap.clear();
}

function formatSource(s) {
  const f = uploadedFiles[s.file];
  const parts = ['出典：' + (f ? f.name : 'ファイル' + ((s.file ?? 0) + 1))];
  if (s.page) parts.push('p.' + s.page);
  if (s.section) parts.push(s.section);
  return parts.join('　');
}

function openSourceModal(qIndex) {
  const q = questions[qIndex];
  const s = q && q.source;
  if (!s) return;
  const file = uploadedFiles[s.file] || uploadedFiles[0];
  if (!file) {
    alert('元の教材ファイルが見つかりません（削除された可能性があります）。');
    return;
  }
  const body = document.getElementById('modal-body');
  body.innerHTML = '';
  const url = getFileUrl(file);
  if (file.type === 'application/pdf') {
    // モバイルのブラウザは <iframe> 内でPDFをインライン表示できないため、
    // pdf.js で該当ページを画像化して表示する（失敗時は外部で開くリンクにフォールバック）。
    const fileIdx = uploadedFiles[s.file] ? s.file : 0;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:14px; padding:16px; width:100%;';
    wrap.innerHTML = '<div class="figure-loading">出典ページを読み込み中…</div>';
    body.appendChild(wrap);
    renderPdfPage(fileIdx, s.page || 1).then(cv => {
      wrap.innerHTML = '';
      const img = document.createElement('img');
      img.src = cv.toDataURL('image/png');
      img.alt = '出典ページ';
      img.style.cssText = 'max-width:100%; height:auto; border-radius:6px;';
      wrap.appendChild(img);
      wrap.appendChild(makeSourceOpenLink(url, file.name));
    }).catch(() => {
      wrap.innerHTML = '<div class="figure-loading" style="line-height:1.7;">この環境ではPDFをページ内に表示できませんでした。下のボタンから開いてください。</div>';
      wrap.appendChild(makeSourceOpenLink(url, file.name));
    });
  } else {
    const img = document.createElement('img');
    img.src = url;
    body.appendChild(img);
  }
  document.getElementById('modal-title').textContent = '出典：' + file.name;
  const subParts = [];
  if (s.page) subParts.push('ページ：p.' + s.page);
  if (s.section) subParts.push('参照箇所：' + s.section);
  if (s.quote) subParts.push('「' + s.quote + '」');
  document.getElementById('modal-sub').textContent = subParts.join('　');
  document.getElementById('source-modal').classList.add('show');
}

function closeSourceModal() {
  document.getElementById('source-modal').classList.remove('show');
  document.getElementById('modal-body').innerHTML = '';
}

// 出典PDFを外部（別画面）で開くリンク。pdf.js での画像表示に加えて、全体を見たい人向けの逃げ道。
function makeSourceOpenLink(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.className = 'btn-secondary';
  a.style.cssText = 'text-decoration:none; display:inline-flex; align-items:center;';
  a.textContent = '📄 PDF全体を別画面で開く';
  return a;
}

// ─── NEXT QUESTION ─────────────────────────────────────────────
function nextQuestion() {
  currentQ++;
  if (currentQ >= questions.length) {
    showResults();
  } else {
    showQuizQuestion();
  }
}

// ─── EXAM MODE (試験モード：全問一括表示＋制限時間＋一括採点) ─────
// 単一問題レンダラー（固定ID・グローバル依存）は流用できないため、試験専用の軽量レンダラーと
// 一括採点を持つ。採点結果は history に詰め（true/false、draw/graphβは採点対象外＝null）、
// 既存の showResults() をそのまま利用する。図（renderExamFigure）・数式キーボード
//（registerMathInput）・穴埋め/表のAI同値判定（gradeCellsExam）に対応済み。記述は簡易キーワード採点。
let examTimer = null;      // カウントダウンの interval
let examEndTime = 0;       // 終了時刻(ms)
let examSubmitted = false; // 提出済みか（二重採点防止）
let examActive = false;    // 試験の実施中か（画面遷移で試験が消滅・復帰不能になるのを防ぐガード）
let examOrderState = {};   // 並べ替え問題の現在の並び（問題index→項目indexの配列）

// モード切替（開始時に読むので基本は何もしない。将来のUI調整用フック）
function onModeChange(v) { /* mode は startQuiz/startQuizFromQuestions で読む */ }

// クイズ開始の共通入口：モードに応じて通常クイズ or 試験モードへ振り分ける
function enterQuiz() {
  const bar = document.getElementById('global-stats-bar');
  if (storedSettings.mode === 'exam') {
    if (bar) bar.classList.remove('visible');
    startExam();
  } else {
    if (bar) bar.classList.add('visible');
    showQuizQuestion();
    showScreen('screen-quiz');
  }
}

function startExam() {
  // SRS復習（quizKind='srs'）はそのまま維持する。'exam' で上書きすると recordSRSFromResult が
  // 通常クイズ扱いになり、正解してもboxが昇格・卒業しない（＝復習が壊れる）ため。
  if (quizKind !== 'srs') quizKind = 'exam';
  resetRunState();
  currentDifficulty = storedSettings.difficulty || 'medium';
  examOrderState = {};
  examSubmitted = false;
  examActive = true;
  // タブを閉じても問題セット（有料生成分）を失わないよう保存する。再開バナーから
  // 試験をやり直すか「破棄」でき、破棄・完了時に教材ファイル(IndexedDB)も削除される。
  saveQuizState();
  renderExamSheet();
  showScreen('screen-exam');
  // 数式キーボードは入力欄のある形式（穴埋め・表・記述）が含まれる時だけ表示（通常モードと同じ基準）
  setMathToolsVisible(questions.some(q => ['fill', 'table', 'text'].includes(q.type)));
  window.scrollTo(0, 0);
  startExamTimer(storedSettings.examMinutes || 30);
}

// 穴埋め問題文：空欄を (1)(2)… の番号プレースホルダにして表示（数式は壊さない）
function examFillText(q) {
  return fillQuestionTextWith(q, (n, inMath) => inMath ? '\\boxed{(' + (n + 1) + ')}' : '（' + (n + 1) + '）');
}

function renderExamSheet() {
  const list = document.getElementById('exam-list');
  list.innerHTML = '';
  const totalEl = document.getElementById('exam-total');
  if (totalEl) totalEl.textContent = questions.length;
  questions.forEach((q, i) => {
    const card = document.createElement('div');
    card.id = 'exq-' + i;
    card.style.cssText = 'border:1px solid var(--border2); border-radius:12px; padding:16px; margin:14px 0; background:var(--surface);';
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:600; margin-bottom:10px; line-height:1.7;';
    const qText = (q.type === 'fill') ? examFillText(q) : q.question;
    head.innerHTML = 'Q' + (i + 1) + '. ' + mathToHtml(qText) +
      ' <span style="font-size:11px; color:var(--text3); font-weight:400;">[' + typeLabel(q) + ']</span>';
    card.appendChild(head);
    renderExamFigure(q, i, card); // 図（実図切り出し→AI生成SVG）を非同期で挿入
    const body = document.createElement('div');
    renderExamInput(q, i, body);
    card.appendChild(body);
    list.appendChild(card);
  });
}

function renderExamInput(q, i, body) {
  const inputStyle = 'flex:1; min-width:140px; background:var(--surface2); border:1px solid var(--border2); border-radius:8px; color:var(--text); padding:8px 10px; font-size:16px; font-family:inherit;';
  if (q.type === 'choice') {
    (q.choices || []).forEach((ch, j) => {
      const lab = document.createElement('label');
      lab.style.cssText = 'display:flex; align-items:flex-start; gap:8px; padding:6px 4px; cursor:pointer; line-height:1.6;';
      const r = document.createElement('input'); r.type = 'radio'; r.name = 'exq-' + i; r.value = j; r.style.marginTop = '3px';
      const span = document.createElement('span'); span.innerHTML = mathifyValue(ch);
      lab.appendChild(r); lab.appendChild(span); body.appendChild(lab);
    });
  } else if (q.type === 'fill') {
    const n = (q.blanks || []).length;
    for (let bi = 0; bi < n; bi++) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; margin:6px 0; flex-wrap:wrap;';
      const lab = document.createElement('span'); lab.style.cssText = 'font-size:13px; color:var(--text2);'; lab.textContent = '空欄(' + (bi + 1) + ')';
      const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'exam-fill'; inp.dataset.bi = bi; inp.autocomplete = 'off'; inp.style.cssText = inputStyle;
      registerMathInput(inp);
      row.appendChild(lab); row.appendChild(inp); body.appendChild(row);
    }
  } else if (q.type === 'table') {
    const wrap = document.createElement('div'); wrap.style.overflowX = 'auto';
    const table = document.createElement('table'); table.className = 'quiz-table';
    if (q.headers && q.headers.length) {
      const thead = document.createElement('thead'); const tr = document.createElement('tr');
      q.headers.forEach(h => { const th = document.createElement('th'); setMath(th, h); tr.appendChild(th); });
      thead.appendChild(tr); table.appendChild(thead);
    }
    const tbody = document.createElement('tbody');
    (q.rows || []).forEach((row, r) => {
      const tr = document.createElement('tr');
      row.forEach((cell, c) => {
        const td = document.createElement('td');
        if (isBlankCell(q, r, c)) {
          const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'exam-tcell'; inp.dataset.r = r; inp.dataset.c = c; inp.autocomplete = 'off';
          inp.style.cssText = 'width:100%; min-width:80px; background:var(--surface2); border:1px solid var(--border2); border-radius:6px; color:var(--text); padding:6px 8px; font-size:16px; font-family:inherit;';
          registerMathInput(inp);
          td.appendChild(inp);
        } else { if (c === 0) td.className = 'rowhead'; setMath(td, cell); }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); wrap.appendChild(table); body.appendChild(wrap);
  } else if (q.type === 'text') {
    const ta = document.createElement('textarea'); ta.className = 'exam-text'; ta.rows = 3;
    ta.style.cssText = 'width:100%; background:var(--surface2); border:1px solid var(--border2); border-radius:8px; color:var(--text); padding:8px 10px; font-size:16px; font-family:inherit; resize:vertical;';
    registerMathInput(ta);
    body.appendChild(ta);
    attachCharCounter(ta, q, body); // 文字数カウンタ（「N文字以内」指定があれば上限も表示）
  } else if (q.type === 'sort') {
    (q.items || []).forEach((item, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:10px; margin:6px 0; flex-wrap:wrap;';
      const lab = document.createElement('div'); lab.style.cssText = 'flex:1; min-width:120px;'; setMath(lab, item);
      const sel = document.createElement('select'); sel.className = 'exam-sort'; sel.dataset.item = idx;
      sel.style.cssText = 'background:var(--surface2); border:1px solid var(--border2); border-radius:8px; color:var(--text); padding:6px 10px; font-size:16px; font-family:inherit;';
      const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '（分類を選択）'; sel.appendChild(o0);
      (q.categories || []).forEach((cat, ci) => { const o = document.createElement('option'); o.value = ci; o.textContent = cat; sel.appendChild(o); });
      row.appendChild(lab); row.appendChild(sel); body.appendChild(row);
    });
  } else if (q.type === 'order') {
    let idxs = shuffleArray((q.items || []).map((_, k) => k));
    if ((q.items || []).length > 1 && idxs.every((v, k) => q.items[v] === q.items[k])) idxs.push(idxs.shift());
    examOrderState[i] = idxs;
    const listEl = document.createElement('div'); listEl.id = 'exq-' + i + '-order';
    body.appendChild(listEl);
    renderExamOrderRows(q, i, listEl);
  } else {
    const note = document.createElement('div');
    note.style.cssText = 'font-size:13px; color:var(--amber);';
    note.textContent = 'この形式（' + typeLabel(q) + '）は試験モードでは採点対象外です（正答率などの成績には含まれません）。';
    body.appendChild(note);
  }
}

// 試験用の図表示（実図切り出し→AI生成SVG の順。カード直下に非同期で挿入）。出典は openSourceModal(i)。
async function renderExamFigure(q, i, host) {
  const figDiv = document.createElement('div');
  figDiv.style.cssText = 'margin:8px 0; display:none; flex-direction:column; align-items:center; gap:6px;';
  host.appendChild(figDiv);

  // 1) 教材からの実画像切り出しを優先
  if (q.figure_ref && uploadedFiles[q.figure_ref.file]) {
    let img = null;
    try { img = await renderFigureCrop(q.figure_ref); } catch (e) {}
    if (img) {
      img.style.maxWidth = '100%'; img.style.height = 'auto';
      figDiv.appendChild(img);
      const cap = document.createElement('div'); cap.className = 'figure-caption'; cap.textContent = '教材から抜粋';
      if (q.source) {
        const link = document.createElement('button'); link.className = 'figure-link'; link.textContent = '全体を見る';
        link.onclick = () => openSourceModal(i);
        cap.append(' ・ ', link);
      }
      figDiv.appendChild(cap);
      figDiv.style.display = 'flex';
      return;
    }
  }
  // 2) フォールバック：AI生成SVG
  const safe = q.figure_svg ? sanitizeSVG(q.figure_svg) : null;
  if (safe) {
    const w = document.createElement('div'); w.innerHTML = safe; figDiv.appendChild(w);
    const cap = document.createElement('div'); cap.className = 'figure-caption'; cap.textContent = 'AIが作成した図（参考・誤りがあり得ます）';
    figDiv.appendChild(cap);
    figDiv.style.display = 'flex';
  }
}

function renderExamOrderRows(q, i, listEl) {
  listEl.innerHTML = '';
  examOrderState[i].forEach((itemIdx, pos) => {
    const row = document.createElement('div');
    row.className = 'exam-order-row' + (examSubmitted ? '' : ' draggable');
    row.style.cssText = 'display:flex; align-items:center; gap:8px; margin:4px 0;';
    if (!examSubmitted) row.title = 'ドラッグして並べ替え';
    const handle = document.createElement('div'); handle.className = 'order-drag'; handle.textContent = '↕';
    const num = document.createElement('div'); num.style.cssText = 'width:26px; color:var(--text3);'; num.textContent = (pos + 1) + '.';
    const text = document.createElement('div'); text.style.flex = '1'; setMath(text, q.items[itemIdx]);
    const up = document.createElement('button'); up.className = 'btn-secondary'; up.style.cssText = 'padding:2px 10px;'; up.textContent = '▲'; up.disabled = pos === 0; up.onclick = () => examMoveOrder(i, pos, -1);
    const down = document.createElement('button'); down.className = 'btn-secondary'; down.style.cssText = 'padding:2px 10px;'; down.textContent = '▼'; down.disabled = pos === examOrderState[i].length - 1; down.onclick = () => examMoveOrder(i, pos, 1);
    // ブロック全体を掴んでドラッグ（▲▼ボタン上では発火しない）
    if (!examSubmitted) row.addEventListener('pointerdown', e => startBlockDrag(e, {
      pos,
      getRows: () => document.getElementById('exq-' + i + '-order').querySelectorAll('.exam-order-row'),
      getOrder: () => examOrderState[i],
      rerender: () => renderExamOrderRows(questions[i], i, document.getElementById('exq-' + i + '-order')),
      isLocked: () => examSubmitted
    }));
    row.appendChild(handle); row.appendChild(num); row.appendChild(text); row.appendChild(up); row.appendChild(down);
    listEl.appendChild(row);
  });
}
function examMoveOrder(i, pos, dir) {
  if (examSubmitted) return;
  const st = examOrderState[i]; const np = pos + dir;
  if (np < 0 || np >= st.length) return;
  [st[pos], st[np]] = [st[np], st[pos]];
  renderExamOrderRows(questions[i], i, document.getElementById('exq-' + i + '-order'));
}

// タイマー
function startExamTimer(minutes) {
  const total = Math.max(1, minutes | 0) * 60;
  examEndTime = Date.now() + total * 1000;
  updateExamTimer();
  clearInterval(examTimer);
  examTimer = setInterval(updateExamTimer, 1000);
}
function updateExamTimer() {
  const remain = Math.max(0, Math.round((examEndTime - Date.now()) / 1000));
  const el = document.getElementById('exam-timer');
  if (el) {
    const mm = String(Math.floor(remain / 60)).padStart(2, '0');
    const ss = String(remain % 60).padStart(2, '0');
    el.textContent = mm + ':' + ss;
    el.style.color = remain <= 60 ? 'var(--red)' : '';
  }
  if (remain <= 0) { clearInterval(examTimer); submitExam(true); }
}

// 採点中のUI（提出ボタンを無効化・「採点中…」表示。AI同値判定・記述採点に時間がかかるため）
function setExamGrading(on) {
  const t = document.getElementById('exam-timer');
  if (t && on) t.textContent = '採点中… 0/' + questions.length;
  document.querySelectorAll('#screen-exam .btn-primary').forEach(b => {
    b.disabled = on; b.textContent = on ? '採点中…' : '採点する（提出）';
  });
}
// 一括採点の進捗（何問中何問まで採点したか）をタイマー枠に表示する。逐次採点で待つ間の無反応を防ぐ。
function updateExamGradeProgress(done) {
  const t = document.getElementById('exam-timer');
  if (t) t.textContent = '採点中… ' + done + '/' + questions.length;
}

// 提出（auto=時間切れ）。全問を一括採点し、既存の結果画面へ。AI同値判定はONかつキー有り時のみ。
async function submitExam(auto) {
  if (examSubmitted) return;
  if (!auto && !(await uiConfirm('採点して結果を表示します。よろしいですか？\n（未回答は不正解になります。提出後は戻れません）', { okText: '採点する', cancelText: 'まだ' }))) return;
  examSubmitted = true;
  clearInterval(examTimer);
  setExamGrading(true);
  correctCount = 0; wrongCount = 0; history = [];
  try {
    for (let i = 0; i < questions.length; i++) {
      const t = questions[i].type;
      if (t === 'draw' || t === 'graph') { history.push(null); updateExamGradeProgress(i + 1); continue; } // 採点対象外＝成績に含めない（不正解扱いにしない）
      const ok = await gradeExamQuestion(questions[i], i);
      history.push(ok);
      if (ok) correctCount++; else wrongCount++;
      updateExamGradeProgress(i + 1); // 逐次採点の進捗を更新（記述・同値判定で待つ間の目安）
    }
  } catch (e) {
    // 想定外のエラーで「採点中…」のまま固まらないよう、提出前の状態に戻して再提出できるようにする
    console.error(e);
    examSubmitted = false;
    setExamGrading(false);
    alert('採点中にエラーが発生しました: ' + (e && e.message ? e.message : e) + '\nもう一度「採点する（提出）」を押してください。');
    return;
  }
  examActive = false;
  setExamGrading(false);
  showResults();
}

// 穴埋め・表のセル群を採点：まず文字列一致、外れた非空セルは（非厳密かつAI可なら）AI同値判定でまとめて拾う
async function gradeCellsExam(q, cells, strict) {
  cells.forEach(c => c.ok = answerMatches(c.userValue, c.accepts, strict));
  const unresolved = cells.filter(c => !c.ok && c.userValue.trim() !== '');
  if (unresolved.length && !strict && aiEquivAvailable()) {
    try {
      const verdicts = await aiCheckEquivalence(q, unresolved.map(c => ({ user: c.userValue, correct: c.correctValue })));
      unresolved.forEach((c, i) => { if (verdicts[i] === true) c.ok = true; });
    } catch (e) {}
  }
  return cells.every(c => c.ok);
}

// 1問分の採点（DOMから回答を読む）。真偽を返す。fill/table は AI同値判定を使うため async。
async function gradeExamQuestion(q, i) {
  const card = document.getElementById('exq-' + i);
  if (!card) return false;
  const strict = isStrictQuestion(q);
  switch (q.type) {
    case 'choice': {
      const sel = card.querySelector('input[type=radio]:checked');
      return sel ? (parseInt(sel.value) === q.correct) : false;
    }
    case 'fill': {
      const inputs = [...card.querySelectorAll('.exam-fill')];
      if (!inputs.length) return false;
      const cells = inputs.map(inp => {
        const bi = parseInt(inp.dataset.bi);
        return { userValue: inp.value, accepts: [q.blanks[bi], ...((q.accept && q.accept[bi]) || [])], correctValue: q.blanks[bi] ?? '' };
      });
      return await gradeCellsExam(q, cells, strict);
    }
    case 'table': {
      const inputs = [...card.querySelectorAll('.exam-tcell')];
      if (!inputs.length) return false;
      const cells = inputs.map(inp => {
        const r = parseInt(inp.dataset.r), c = parseInt(inp.dataset.c);
        return { userValue: inp.value, accepts: tableBlankAccepts(q, r, c), correctValue: q.rows[r][c] ?? '' };
      });
      return await gradeCellsExam(q, cells, strict);
    }
    case 'text': {
      const ta = card.querySelector('.exam-text');
      const val = ta ? ta.value.trim() : '';
      if (!val) return false;
      // 通常モードと同じAI採点（gradeTextAnswer）で合否判定する。キーが無い/失敗時は
      // gradeTextAnswer 内部で keywordGrade に自動フォールバックする。合格基準も通常モードと同じ score>=60。
      const g = await gradeTextAnswer(q, val);
      return g.score >= 60;
    }
    case 'sort': {
      const sels = [...card.querySelectorAll('.exam-sort')];
      if (sels.length !== (q.items || []).length) return false;
      return sels.every(s => s.value !== '' && parseInt(s.value) === q.answer[parseInt(s.dataset.item)]);
    }
    case 'order': {
      const st = examOrderState[i];
      if (!st) return false;
      return st.every((v, idx) => q.items[v] === q.items[idx]);
    }
    default: return false; // draw/graph(β)は自動採点対象外＝不正解扱い
  }
}

async function quitExam() {
  const isDemo = !!storedSettings.isDemo;
  const msg = isDemo
    ? 'お試しの試験を終了して最初の画面に戻ります。よろしいですか？（採点されません）'
    : '試験を中断して最初の画面に戻ります。（採点されません）\n\n回答内容は保存されませんが、「続きから再開」で同じ問題セットの試験をやり直せます。よろしいですか？';
  if (!(await uiConfirm(msg, { okText: '中断する', cancelText: '続ける' }))) return;
  clearInterval(examTimer);
  examSubmitted = true;
  examActive = false;
  if (isDemo) clearQuizState(); // デモは再開対象にしない（教材・状態を残さない）
  showScreen('screen-upload'); // 通常は保存済みの状態を残す＝再開バナーから「やり直し」or「破棄（教材も削除）」できる
}

// ─── RESULTS ───────────────────────────────────────────────────
function showResults() {
  clearQuizState(); // 完了したら中断データを消す（再開バナーを出さない）
  const total = questions.length;
  // 採点対象外（試験モードのdraw/graphβ＝history[i]がnull）は正答率の母数に含めない
  const gradedTotal = history.filter(v => typeof v === 'boolean').length;
  const pct = Math.round(correctCount / (gradedTotal || total) * 100);

  document.getElementById('final-pct').textContent = pct + '%';
  document.getElementById('r-total').textContent = total;
  document.getElementById('r-correct').textContent = correctCount;
  document.getElementById('r-wrong').textContent = wrongCount;
  document.getElementById('r-diff').textContent = { easy: 'やさしい', medium: '普通', hard: '難しい' }[currentDifficulty];

  const titles = [
    [0,  39, '復習が必要です', 'もう少し基礎を固めてから再挑戦しましょう。'],
    [40, 59, 'もう少し！', '基本は押さえています。苦手な箇所を重点的に復習しましょう。'],
    [60, 79, '良い調子です！', '標準的な理解度です。間違えた問題をしっかり確認しましょう。'],
    [80, 89, 'とても良いです！', '高い理解度です。さらに難しい問題にも挑戦してみましょう。'],
    [90, 100, '素晴らしい！', '非常に高い理解度です。完璧な仕上がりです！']
  ];
  const [,, title, msg] = titles.find(([lo, hi]) => pct >= lo && pct <= hi);
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-msg').textContent = msg;

  const offset = 314 * (1 - pct / 100);
  document.getElementById('score-circle').style.strokeDashoffset = offset;

  const reviewList = document.getElementById('review-list');
  reviewList.innerHTML = '';
  questions.forEach((q, i) => {
    const correct = history[i];
    const graded = typeof correct === 'boolean'; // null＝採点対象外（試験モードのdraw/graphβ）
    const resultTag = graded
      ? `<span class="tag ${correct ? 'correct' : 'wrong'}">${correct ? '✓ 正解' : '✗ 不正解'}</span>`
      : '<span class="tag info">－ 採点対象外</span>';
    const qText = (q.type === 'fill') ? formatFillQuestionText(q) : q.question;
    const div = document.createElement('div');
    div.className = 'review-item';
    div.innerHTML = `
      <div class="q-text">Q${i+1}. ${mathToHtml(qText)}</div>
      <div class="answer-row">
        ${resultTag}
        <span class="tag info">${typeLabel(q)}</span>
        <span class="tag info">正解：${formatAnswerHtml(q)}</span>
        ${q.topic ? `<span style="font-size:12px; color:var(--text3);">${escapeHtml(q.topic)}</span>` : ''}
        ${q.source ? `<button class="source-btn" onclick="openSourceModal(${i})">出典を見る</button>` : ''}
      </div>
    `;
    reviewList.appendChild(div);
  });

  const saved = !!storedSettings.fromSaved;
  document.getElementById('similar-btn').style.display = (wrongCount > 0 && !saved) ? 'flex' : 'none';
  const regenBtn = document.getElementById('regen-btn');
  if (regenBtn) regenBtn.style.display = saved ? 'none' : '';

  saveQuizToHistory(pct);
  recordSRSFromResult(); // 苦手問題の復習ボックスを更新（通常＝不正解を登録／復習＝box更新）

  showScreen('screen-results');
}

// 出題形式のラベル
function typeLabel(q) {
  return ({ choice: '選択', sort: '仕分け', order: '並べ替え', fill: '穴埋め', table: '表穴埋め', text: '記述', draw: '描画(β)', graph: 'グラフ(β)' })[q.type] || '選択';
}

// 振り返り用の「正解」テキスト
function formatAnswerText(q) {
  switch (q.type) {
    case 'sort':  return q.items.map((it, j) => `${it}→${q.categories[q.answer[j]] ?? '?'}`).join('、');
    case 'order': return q.items.join(' → ');
    case 'fill':  return (q.blanks || []).join(' / ');
    case 'table': return (q.blanks || []).map(b => (q.rows[b.r] && q.rows[b.r][b.c]) ?? '').filter(v => v !== '').join(' / ');
    case 'text':  return q.model_answer || '（記述）';
    case 'draw':  return q.model_answer || '（描画）';
    case 'graph': return (q.points || []).map(p => `(${p[0]}, ${p[1]})`).join(q.mode === 'polyline' ? ' → ' : '、');
    default:      return q.choices[q.correct];
  }
}

// 穴埋めの問題文を、空欄を正解で埋めた形にして振り返り表示する。
// 数式の外は【正解】で強調、数式の中（行列など）は数式を壊さないよう正解値をそのまま埋める。
function formatFillQuestionText(q) {
  return fillQuestionTextWith(q, (i, inMath) => {
    const v = (q.blanks && q.blanks[i]) ?? '__';
    return inMath ? v : '【' + v + '】';
  });
}

// 今回の成績を学習履歴に保存（トピック別の正誤も記録）
function saveQuizToHistory(pct) {
  const topics = {};
  questions.forEach((q, i) => {
    if (typeof history[i] !== 'boolean') return; // 採点対象外（null）はトピック集計に含めない
    const t = q.topic || 'その他';
    if (!topics[t]) topics[t] = { correct: 0, total: 0 };
    topics[t].total++;
    if (history[i]) topics[t].correct++;
  });
  saveHistoryRecord({
    id: Date.now(),
    date: new Date().toISOString(),
    total: questions.length,
    correct: correctCount,
    wrong: wrongCount,
    pct: pct,
    difficulty: currentDifficulty,
    format: storedSettings.answerFormat || 'mixed',
    kind: quizKind,
    topics: topics
  });
}

// ─── 簡易SRS（苦手問題のセッション横断復習） ───────────────────
// 間違えた問題を localStorage に貯め、Leitner式（box1〜5＋日数間隔）で後日また出題する。
const SRS_KEY = 'aiquiz_srs';
const SRS_INTERVALS = { 2: 1, 3: 3, 4: 7, 5: 16 }; // 正解で box が上がった時、次回までの日数
const SRS_MAX = 200;

function loadSRS() {
  try { const a = JSON.parse(localStorage.getItem(SRS_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveSRS(arr) {
  try { localStorage.setItem(SRS_KEY, JSON.stringify(arr)); }
  catch (e) {
    // 従来は黙って握りつぶしていたため、容量到達時に苦手リストが静かに保存されなくなっていた
    console.warn('[AIQuiz] 苦手リストを保存できませんでした', e);
    try { notifyStorageFull(e); } catch (e2) {}
  }
}
function srsKey(q) { return normalizeText((q && q.question) || '') + '|' + ((q && q.type) || ''); }
function srsDaysFromNow(d) { return Date.now() + d * 86400000; }

// ── トピック正規化 ──────────────────────────────────────────────
// 類似問題を再生成すると問題文が変わり srsKey が別物になる（＝同じ論点が別トラックに分裂）。
// primaryキー(srsKey)は問題単位の同一性のため変えず、トピック単位の副インデックスを別に持つ。
// 書式ゆれ（全角/半角・大小文字・空白・区切り記号）は吸収するが、同義語（微分法/導関数）は畳まない。
// [js/grading.js に移動] normalizeTopic

// ── 試験（科目名・試験日）ストア：カレンダー機能の土台。試験日クリップに使う ──
// 設定UIはカレンダー機能側で用意する。ここではデータ層と、SRS側のクリップ配線のみ。
const EXAMS_KEY = 'aiquiz_exams';
function loadExams() {
  try { const a = JSON.parse(localStorage.getItem(EXAMS_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveExams(arr) { try { localStorage.setItem(EXAMS_KEY, JSON.stringify(arr)); } catch {} }
// 試験を1件追加（name:科目/試験名, date:'YYYY-MM-DD'）
function addExam(name, date) {
  const arr = loadExams();
  const e = { id: 'ex_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(name || ''), date: String(date || '') };
  arr.push(e); saveExams(arr); return e;
}
// 未来で最も近い試験日の ms（その日の終わりまで有効）。試験が無ければ null。
function nextExamMs() {
  const now = Date.now();
  let soonest = null;
  for (const e of loadExams()) {
    const t = Date.parse((e && e.date || '') + 'T23:59:59');
    if (!isNaN(t) && t >= now && (soonest == null || t < soonest)) soonest = t;
  }
  return soonest;
}
// 次回復習日を「直近の試験日を超えない」ようにクリップ（試験5日前なのに16日後配置、を防ぐ）
function clipDueToExam(due) {
  const ex = nextExamMs();
  return (ex != null && due > ex) ? ex : due;
}

// ── SRSをトピック単位で集約（カレンダーの「今日やるべきトピック」表示用）──
function srsItemNT(it) { return (it && it.nt) || normalizeTopic(it && it.q && it.q.topic); }
function srsByTopic() {
  const now = Date.now();
  const groups = {};
  for (const it of loadSRS()) {
    const nt = srsItemNT(it) || '(未分類)';
    if (!groups[nt]) groups[nt] = { normTopic: nt, topic: (it.q && it.q.topic) || '(未分類)', items: [], due: Infinity, dueCount: 0, minBox: 99 };
    const g = groups[nt];
    g.items.push(it);
    const d = it.due || 0;
    if (d < g.due) g.due = d;
    if (d <= now) g.dueCount++;
    if ((it.box || 1) < g.minBox) g.minBox = it.box || 1;
  }
  return Object.values(groups).sort((a, b) => a.due - b.due);
}

// 不正解の問題を復習ボックスへ（既出なら box1 に戻す）
function addWrongToSRS(q) {
  if (!q || !q.question) return;
  const arr = loadSRS();
  const key = srsKey(q);
  const topic = (q.topic || '').toString();
  const nt = normalizeTopic(topic);
  // 保存用に複製（ライブの問題オブジェクトは変更しない）。極端に大きいAI作図SVGだけ外し、
  // localStorage枯渇でSRS全体が保存できなくなるのを防ぐ（通常サイズの図は復習時もそのまま出る）。
  const qc = JSON.parse(JSON.stringify(q));
  if (typeof qc.figure_svg === 'string' && qc.figure_svg.length > 50000) delete qc.figure_svg;
  const ex = arr.find(it => it.key === key);
  if (ex) { ex.box = 1; ex.due = Date.now(); ex.wrongCount = (ex.wrongCount || 0) + 1; ex.q = qc; ex.topic = topic; ex.nt = nt; }
  else {
    arr.push({ key, q: qc, box: 1, due: Date.now(), wrongCount: 1, addedAt: Date.now(), topic, nt });
    while (arr.length > SRS_MAX) arr.shift();
  }
  saveSRS(arr);
}

// 復習結果で box を更新（正解→昇格・卒業、不正解→box1へ）
function updateSRSAfterReview(qs, hist) {
  const arr = loadSRS();
  qs.forEach((q, i) => {
    const idx = arr.findIndex(it => it.key === srsKey(q));
    if (idx < 0) return;
    if (hist[i] === true) {
      const nb = arr[idx].box + 1;
      if (nb > 5) { arr.splice(idx, 1); return; } // 5回連続で正解＝卒業（ボックスから除外）
      arr[idx].box = nb; arr[idx].due = clipDueToExam(srsDaysFromNow(SRS_INTERVALS[nb] || 1));
    } else if (hist[i] === false) { // null（採点対象外）はboxを動かさない
      arr[idx].box = 1; arr[idx].due = Date.now(); arr[idx].wrongCount = (arr[idx].wrongCount || 0) + 1;
    }
  });
  saveSRS(arr);
}

function srsDueItems() { const now = Date.now(); return loadSRS().filter(it => (it.due || 0) <= now); }

// 今回のクイズ結果を SRS に反映（復習クイズなら box 更新、通常クイズなら不正解を登録）
function recordSRSFromResult() {
  if (storedSettings.isDemo) return;
  if (quizKind === 'srs') updateSRSAfterReview(questions, history);
  // history[i]===null（採点対象外）は「間違えた」わけではないのでSRSに登録しない
  else questions.forEach((q, i) => { if (history[i] === false) addWrongToSRS(q); });
}

function checkSRS() {
  const banner = document.getElementById('srs-banner');
  if (!banner) return;
  const due = srsDueItems().length;
  const total = loadSRS().length;
  const reviewBtn = document.getElementById('srs-review-btn');
  const pdfBtn = document.getElementById('srs-pdf-btn');
  // 苦手が1問でも登録されていればバナーを表示する（期限が来ていなくても「苦手をPDF化」は使える）。
  if (total > 0) {
    document.getElementById('srs-text').textContent = due > 0
      ? `復習できる苦手問題が ${due} 問あります（登録 ${total} 問）。間違えた問題を後日また解いて定着させましょう。`
      : `苦手問題を ${total} 問登録中（今日の復習期限はありません）。「苦手をPDF化」で見直せます。`;
    if (reviewBtn) reviewBtn.style.display = due > 0 ? '' : 'none'; // 期限0なら復習ボタンは無反応なので隠す
    if (pdfBtn) pdfBtn.style.display = '';
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

function startSRSReview() {
  const items = srsDueItems().slice(0, 15);
  if (!items.length) { checkSRS(); return; }
  const qs = JSON.parse(JSON.stringify(items.map(it => it.q)));
  startQuizFromQuestions(qs, { answerFormat: 'mixed', difficulty: 'medium', srs: true }, 'srs');
}

async function clearSRS() {
  if (!(await uiConfirm('苦手問題の復習リストをすべて削除しますか？（元に戻せません）', { okText: '削除する', cancelText: 'やめる' }))) return;
  saveSRS([]);
  checkSRS();
}

// ─── SIMILAR QUESTIONS (類似問題) ──────────────────────────────
async function startSimilarQuiz() {
  const wrongQs = questions.filter((q, i) => !history[i]);
  if (wrongQs.length === 0) return;

  const settings = { ...storedSettings, qCount: Math.min(Math.max(wrongQs.length, 3), 10) };
  if (!(await preGenerateGuard(settings, { confirmCost: true }))) return;

  quizKind = 'similar';
  isGenerating = true;
  showScreen('screen-loading');
  setLoadingMsg('類似問題を生成中', '間違えた問題を分析しています');

  try {
    const newQs = await generateQuestions(settings, wrongQs);
    genCount++;
    if (settings.orderMode === 'ascending') {
      const diffOrder = { easy: 0, medium: 1, hard: 2 };
      newQs.sort((a, b) => (diffOrder[a.difficulty] ?? 1) - (diffOrder[b.difficulty] ?? 1));
    }
    questions = newQs;
    resetRunState();
    currentDifficulty = storedSettings.difficulty;
    await persistResumeFiles(); // 再開時に図・出典を復元できるよう、元ファイルを一時保存
    document.getElementById('global-stats-bar').classList.add('visible');
    showQuizQuestion();
    showScreen('screen-quiz');
  } catch(e) {
    alert('エラー: ' + e.message);
    showScreen('screen-results');
  } finally {
    isGenerating = false;
  }
}

// ─── RETAKE ────────────────────────────────────────────────────
async function retakeQuiz() {
  if (!(await preGenerateGuard(storedSettings, { confirmCost: true }))) return;

  resetRunState();
  currentDifficulty = storedSettings.difficulty;

  quizKind = 'retake';
  isGenerating = true;
  showScreen('screen-loading');
  setLoadingMsg('問題を再生成中', '新しい問題セットを準備しています');

  try {
    questions = await generateQuestions(storedSettings);
    genCount++;
    if (storedSettings.orderMode === 'ascending') {
      const diffOrder = { easy: 0, medium: 1, hard: 2 };
      questions.sort((a, b) => (diffOrder[a.difficulty] ?? 1) - (diffOrder[b.difficulty] ?? 1));
    }
    await persistResumeFiles(); // 再開時に図・出典を復元できるよう、元ファイルを一時保存
    document.getElementById('global-stats-bar').classList.add('visible');
    showQuizQuestion();
    showScreen('screen-quiz');
  } catch(e) {
    alert('エラー: ' + e.message);
    showScreen('screen-upload');
  } finally {
    isGenerating = false;
  }
}

// ─── SAVE / LOAD / DEMO (問題セットの保存・共有・お試し) ────────
// キー不要で体験できるサンプル問題（各形式を網羅）
const DEMO_QUESTIONS = [
  { type:'choice', question:'地球から見て、昼に空を明るく照らす最も近い恒星はどれ？', choices:['月','太陽','火星','シリウス'], correct:1,
    explanation:'太陽は地球に最も近い恒星。月は衛星、火星は惑星、シリウスははるか遠くの恒星です。', difficulty:'easy', topic:'天文' },
  { type:'fill', question:'日本の四季は、春・夏・___・冬の ___ つである。', blanks:['秋','4'], accept:[[],['四','４']],
    explanation:'四季は春・夏・秋・冬の4つです。', difficulty:'easy', topic:'一般常識' },
  { type:'sort', question:'次の生き物を「ほ乳類」と「鳥類」に仕分けてください。', items:['イヌ','ハト','クジラ','ペンギン'], categories:['ほ乳類','鳥類'], answer:[0,1,0,1],
    explanation:'クジラは水中にすみますがほ乳類、ペンギンは飛べませんが鳥類です。', difficulty:'medium', topic:'生物' },
  { type:'order', question:'次の数を小さい順に並べ替えてください。', items:['1','5','12','30'],
    explanation:'昇順では 1 → 5 → 12 → 30 となります。', difficulty:'easy', topic:'算数' },
  { type:'table', question:'次の九九の表の空欄を埋めてください。', headers:['×','2','3'],
    rows:[['2','4','6'],['3','6','9']], blanks:[{r:0,c:2},{r:1,c:1}],
    explanation:'2×3=6、3×2=6 です。', difficulty:'easy', topic:'算数' },
  { type:'fill', question:'平面ベクトル $a=[x_1,\\;y_1]^{T}$ のノルムは $\\|a\\|=$ ___ である（下の「∑ 数式キーボード」で √ や ₁ を入力できます）。',
    blanks:['√(x₁²+y₁²)'], accept:[['√(x1²+y1²)','(x₁²+y₁²)^(1/2)']],
    explanation:'ノルムは三平方の定理より $\\|a\\|=\\sqrt{x_1^2+y_1^2}$ です。', difficulty:'medium', topic:'ベクトル' },
  { type:'text', question:'「リサイクル」とは何か、ひとことで説明してください。', model_answer:'使い終わった物を資源として再び利用すること。', keywords:['再','利用','資源'],
    explanation:'廃棄物を資源として再利用する取り組みのことです。', difficulty:'medium', topic:'環境' }
];

// 生成を介さず、与えられた問題配列でクイズを開始（保存セット・デモ共通）
async function startQuizFromQuestions(qs, settings, kind) {
  questions = qs;
  storedSettings = Object.assign({
    qCount: qs.length, difficulty: 'medium', choiceCount: 4, focus: 'balanced',
    orderMode: 'random', answerFormat: 'mixed', materialText: '',
    apiKey: (document.getElementById('api-key') ? document.getElementById('api-key').value.trim() : ''),
    extra: '', fromSaved: true
  }, settings || {});
  storedSettings.fromSaved = true; // 保存/デモ由来は生成系（再生成・類似）を出さない
  // アップロード画面のモード選択を尊重（保存セット・プール出題も試験モードで開始できる）。
  // ただし「AIで問題を生成する」ボタン以外の入口（プールバナー・保存セット読込・デモ・苦手復習）では、
  // 以前の生成で選んだ試験モードが残っていて不意打ちで試験が始まらないよう、開始前に確認する。
  // 生成ボタン経由のプール出題（maybeHandlePoolFlow/startPoolBuildAndQuiz）は modeConfirmed:true で確認を飛ばす。
  let mode = (document.getElementById('quiz-mode') || {}).value || 'normal';
  if (mode === 'exam' && !storedSettings.modeConfirmed) {
    if (!(await uiConfirm('モードが「試験モード」になっています。\n試験モード（制限時間つき・全問一括の採点）で始めますか？\n\n「通常モード」を選ぶと1問ずつ回答する形式で始めます。', { okText: '試験モードで開始', cancelText: '通常モードで開始' }))) mode = 'normal';
  }
  storedSettings.mode = mode;
  storedSettings.examMinutes = parseInt((document.getElementById('exam-minutes') || {}).value) || 30;
  resetRunState();
  currentDifficulty = storedSettings.difficulty;
  quizKind = kind || 'normal';
  // 中断→再開で図・出典を復元できるよう、現在の元ファイルを一時保存する。
  // プール出題は直前の restorePoolFiles で uploadedFiles が復元済み＝それを保存する。
  // 保存セット・デモなど元ファイルが無い場合は persistResumeFiles 側が保存キーを消す（＝出典なしとして正しい挙動）。
  await persistResumeFiles();
  enterQuiz(); // モード（通常/試験）に応じて出題を開始
}

function startDemo() {
  // サンプルは元データを壊さないよう複製して渡す
  const qs = JSON.parse(JSON.stringify(DEMO_QUESTIONS));
  startQuizFromQuestions(qs, { difficulty: 'easy', answerFormat: 'mixed', isDemo: true }, 'normal');
}

// クイズを中断してアップロード画面に戻る（途中経過は保存しない）
async function quitQuiz() {
  const isDemo = !!storedSettings.isDemo;
  const msg = isDemo
    ? 'お試しモードを終了して最初の画面に戻ります。よろしいですか？'
    : 'クイズを中断して最初の画面に戻ります。\n\n進行状況は保存され、後で「続きから再開」できます。よろしいですか？';
  if (!(await uiConfirm(msg, { okText: '中断する', cancelText: '続ける' }))) return;
  // デモは再開対象にしないので破棄。通常クイズは自動保存済みの状態を残して再開可能にする。
  if (isDemo) clearQuizState();
  document.getElementById('global-stats-bar').classList.remove('visible');
  showScreen('screen-upload'); // showScreen 内で checkResume / checkSRS を更新（再開バナーが出る）
}

// 同じ問題をもう一度（再生成なし＝無料）
function redoSameQuiz() {
  if (!questions || !questions.length) return;
  resetRunState();
  currentDifficulty = storedSettings.difficulty;
  enterQuiz(); // 通常/試験モードに応じてやり直す
}

// 現在の問題セットをJSONファイルに保存（再生成不要・他者へ配布可）
function exportQuestions() {
  if (!questions || !questions.length) { alert('保存できる問題がありません。'); return; }
  const payload = {
    app: 'AIQuiz', version: 'v5', exportedAt: new Date().toISOString(),
    title: (questions[0].topic ? questions[0].topic + ' ほか' : '問題セット') + '（' + questions.length + '問）',
    settings: {
      difficulty: storedSettings.difficulty, answerFormat: storedSettings.answerFormat,
      choiceCount: storedSettings.choiceCount, orderMode: storedSettings.orderMode, focus: storedSettings.focus
    },
    questions: questions
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  a.href = url;
  a.download = `aiquiz_問題セット_${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 保存した問題セット(JSON)を読み込んで開始（APIキー不要）
// 「保存した問題を読み込む」：ファイル種別を自動判別して振り分ける。
//  ・type:'pool'    → プールとして一覧に復元（＋今すぐ出題を確認）
//  ・type:'backup'  → 全体復元（従来のバックアップ復元）
//  ・それ以外       → 問題セットとしてクイズ開始（従来）
async function importQuestionsFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { alert('ファイルを読み込めませんでした（JSON形式ではありません）。'); return; }

  if (data && data.type === 'pool' && data.pool) { await importPoolFile(data.pool); return; }
  if (data && data.type === 'backup') { await restoreBackupData(data); return; }

  let qs;
  try { qs = normalizeQuestions(data && data.questions); }
  catch { alert('この問題セットには有効な問題が含まれていません。'); return; }
  startQuizFromQuestions(qs, data.settings || {}, 'normal');
}

// プール単体ファイル（type:'pool'）を IndexedDB に復元し、一覧を更新。復元後に出題するか確認する。
async function importPoolFile(poolExport) {
  try {
    const rec = poolRecordFromExport(poolExport);
    if (!rec.id) rec.id = 'pool_' + poolHashStr(JSON.stringify(rec.fileMeta || rec.name || Date.now()));
    if (rec.status === 'building') rec.status = 'ready'; // 作成中のまま書き出された保険
    await poolSaveGuarded(rec);
    refreshPoolUI();
    const n = (rec.questions && rec.questions.length) || 0;
    if (await uiConfirm(`問題プール「${rec.name}」（${n}問）を復元しました。\n\n今すぐこのプールから出題しますか？`, { okText: '出題する', cancelText: '一覧に戻る' })) {
      await serveFromPool(rec);
    }
  } catch (e) {
    alert('プールの復元に失敗しました: ' + (e && e.message ? e.message : e));
  }
}

// ─── AUTOSAVE / RESUME (中断・再開) ────────────────────────────
const RESUME_KEY = 'aiquiz_resume';

// ── 再開用に、アップロードした元ファイルをIndexedDBへ一時保存する ──
// localStorageは容量が小さくPDFを保持できないため、Blobを扱えるIndexedDBを使う。
// 再開時に読み戻して図の切り出し・出典表示を復元し、終了・破棄時に削除する（教材をブラウザに残さない）。
const IDB_NAME = 'aiquiz';
const IDB_STORE = 'resume_files';
const POOL_STORE = 'pools';       // 問題プール（大量生成した問題の保存フォルダ）
const IDB_FILES_KEY = 'current';

function idbOpen() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(IDB_NAME, 2); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) { try { db.createObjectStore(IDB_STORE); } catch (e) {} }
      if (!db.objectStoreNames.contains(POOL_STORE)) { try { db.createObjectStore(POOL_STORE); } catch (e) {} }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// objectStore に対する1操作を行い、結果を返す（成功時はトランザクション完了を待つ）
// storeName 省略時は再開ファイル用ストア。問題プールは POOL_STORE を渡す。
function idbRun(mode, fn, storeName) {
  const store = storeName || IDB_STORE;
  return idbOpen().then(db => new Promise((resolve, reject) => {
    let r;
    const tx = db.transaction(store, mode);
    r = fn(tx.objectStore(store));
    tx.oncomplete = () => { resolve(r ? r.result : undefined); db.close(); };
    tx.onerror = () => { reject(tx.error); db.close(); };
    tx.onabort = () => { reject(tx.error); db.close(); };
  }));
}

// 現在のアップロードファイルを再開用に保存（最大MAX_FILES件）。ファイルが無ければ削除。
async function persistResumeFiles() {
  try {
    if (typeof indexedDB === 'undefined') return;
    if (!uploadedFiles.length) { await idbRun('readwrite', os => os.delete(IDB_FILES_KEY)); return; }
    const recs = uploadedFiles.slice(0, MAX_FILES).map(f => ({ name: f.name, type: f.type, blob: f }));
    await idbRun('readwrite', os => os.put(recs, IDB_FILES_KEY));
  } catch (e) { /* 保存できなくても致命ではない（再開時に図・出典が出ないだけ） */ }
}

// 再開用に保存したファイルを読み戻して uploadedFiles を復元する
async function restoreResumeFiles() {
  try {
    if (typeof indexedDB === 'undefined') return;
    const recs = await idbRun('readonly', os => os.get(IDB_FILES_KEY));
    if (Array.isArray(recs) && recs.length) {
      uploadedFiles = recs.map(r => new File([r.blob], r.name, { type: r.type }));
      clearFigureCaches();
    }
  } catch (e) {}
}

// 保存した再開用ファイルを削除（終了・破棄時に呼ぶ）
function clearResumeFiles() {
  try { if (typeof indexedDB !== 'undefined') idbRun('readwrite', os => os.delete(IDB_FILES_KEY)); } catch (e) {}
}

// 進行中のクイズ状態をlocalStorageに保存（出題のたびに呼ぶ）
function saveQuizState() {
  try {
    const s = Object.assign({}, storedSettings);
    delete s.apiKey; // 鍵は別領域にあるので複製しない
    localStorage.setItem(RESUME_KEY, JSON.stringify({
      savedAt: Date.now(), questions, currentQ, correctCount, wrongCount,
      history, currentDifficulty, quizKind, settings: s
    }));
  } catch (e) {}
}
function clearQuizState() { try { localStorage.removeItem(RESUME_KEY); } catch (e) {} clearResumeFiles(); }
function loadQuizState() { try { return JSON.parse(localStorage.getItem(RESUME_KEY) || 'null'); } catch (e) { return null; } }

// 起動時に中断中のクイズがあれば再開バナーを表示
function checkResume() {
  const snap = loadQuizState();
  const banner = document.getElementById('resume-banner');
  if (!banner) return;
  if (snap && Array.isArray(snap.questions) && snap.questions.length && snap.currentQ < snap.questions.length) {
    const d = new Date(snap.savedAt); const p = n => String(n).padStart(2, '0');
    document.getElementById('resume-text').textContent =
      `中断した問題があります（全${snap.questions.length}問中 ${snap.currentQ + 1}問目／保存：${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}）`;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}
async function resumeQuiz() {
  const snap = loadQuizState();
  if (!snap) return;
  await restoreResumeFiles(); // 中断前にアップロードしていた元ファイルを読み戻す（図・出典の復元）
  questions = snap.questions;
  currentQ = snap.currentQ; correctCount = snap.correctCount; wrongCount = snap.wrongCount;
  history = snap.history || []; currentDifficulty = snap.currentDifficulty || 'medium';
  quizKind = snap.quizKind || 'normal';
  storedSettings = Object.assign(
    { qCount: questions.length, choiceCount: 4, focus: 'balanced', orderMode: 'random', answerFormat: 'mixed', materialText: '', extra: '', difficulty: currentDifficulty },
    snap.settings || {}
  );
  storedSettings.apiKey = document.getElementById('api-key') ? document.getElementById('api-key').value.trim() : '';
  storedSettings.fromSaved = true; // 再開は元ファイルが無いので生成系は出さない
  // モードに応じて再開する（通常＝続きの問題から／試験＝回答はDOMにしか無いため最初から・時間もリセット）
  enterQuiz();
}
function discardResume() {
  clearQuizState();
  const b = document.getElementById('resume-banner');
  if (b) b.style.display = 'none';
}

// ─── QUESTION POOL (大きめPDF → 大量の問題プールを作り、以降は無料で出題) ──
// 方針：所定のページ数を超えるPDFは、初回だけAIで大量に問題を作って IndexedDB に保存する。
//   2回目以降は同じファイルを判別し、API を呼ばずプールから（毎回ちがう問題を）出題する＝無料。
//   作成はバックグラウンドで進み、最初のまとまりができ次第クイズを開始できる。
// 保存構造：IndexedDB の POOL_STORE に、ファイル判別キーをIDとした「保存フォルダ」1件ずつ。
//   各プールは name（判別しやすい名前・変更可）／元ファイル（図・出典復元用）／設定／questions を持つ。
const POOL_PAGE_THRESHOLD = 5;  // このページ数を超えるPDFでプール方式を提案（用途に合わせて変更可）
const POOL_TARGET = 60;         // 作成する問題プールの目標問数（例：50〜100）
const POOL_BATCH = 15;          // 1回のAI生成で作る問数（複数回に分けて目標へ到達）
const POOL_MAX_BATCHES = 12;    // 暴走・課金しすぎ防止：最大バッチ数
let poolBuildActive = false;    // プール作成が進行中か（二重起動防止）
let geminiPoolNoticeShown = false; // Gemini時にプール非提案の案内を出したか（セッション中1回だけ）
let poolToastTimer = null;

// ── IndexedDB（POOL_STORE）への読み書き ──
function poolPut(pool)   { return idbRun('readwrite', os => os.put(pool, pool.id), POOL_STORE); }
function poolGet(id)     { return idbRun('readonly',  os => os.get(id), POOL_STORE); }
function poolDelete(id)  { return idbRun('readwrite', os => os.delete(id), POOL_STORE); }
function poolList()      { return idbRun('readonly',  os => os.getAll(), POOL_STORE).then(a => Array.isArray(a) ? a : []); }

// ── 保存容量オーバー（QuotaExceeded）の検知・通知（#5） ──
// 従来は保存失敗を .catch(()=>{}) で握りつぶしていたため、容量オーバーで「保存できたつもりが空」に
// なり得た。容量エラーだけは検知してユーザーに知らせる（それ以外の一時エラーは従来どおり黙って続行）。
let storageFull = false;   // このセッションで容量オーバーを検知したか（ハブの容量表示を赤にする）
let storageWarned = false; // 大きな警告アラートはセッション中1回だけ
function isQuotaError(e) {
  return !!e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014 || /quota/i.test(e.message || ''));
}
function notifyStorageFull(e) {
  if (!isQuotaError(e)) return; // 容量以外のエラーは無視（保存の一時失敗は致命でない）
  storageFull = true;
  try { refreshDataModal(); } catch (err) {} // ハブが開いていれば容量表示を即赤に
  if (storageWarned) return;
  storageWarned = true;
  alert('このブラウザの保存容量がいっぱいで、問題プール等を保存できませんでした。\n\n' +
        'ヘッダーの「データ管理」から不要な問題プールを削除するか、バックアップに書き出してから削除すると空きが増えます。');
}
// プールデータの保存（容量オーバーだけ通知し、それ以外は従来どおり静かに続行）。呼び出し側は await のみでよい。
function poolSaveGuarded(pool) {
  return poolPut(pool).catch(e => { notifyStorageFull(e); });
}

// 作成中の保存：この間に serve/rename が cursor・order・name を更新しているかもしれないので、
// 最新レコードのそれらを尊重しつつ（questions は増えた自分を採用）保存し、lost-update を減らす。
async function poolSaveMerge(pool) {
  try {
    const latest = await poolGet(pool.id);
    if (latest) {
      if (typeof latest.cursor === 'number') pool.cursor = latest.cursor;
      if (Array.isArray(latest.order)) pool.order = latest.order;
      if (latest.name) pool.name = latest.name;
    }
  } catch (e) {}
  return poolSaveGuarded(pool);
}

// 起動時：作成が中断されて 'building' のまま残ったプールを 'ready' に正常化する
// （リロード時点でバックグラウンド作成は動いていないため、作成中表示が固定化するのを防ぐ）。
async function reconcileStalePools() {
  try {
    const pools = await poolList();
    for (const p of pools) {
      if (!p.questions || !p.questions.length) { await poolDelete(p.id).catch(() => {}); continue; } // 空の幽霊プールは掃除
      if (p.status === 'building') { p.status = 'ready'; await poolPut(p).catch(() => {}); }
    }
  } catch (e) {}
}

// ── 小さなユーティリティ ──
function poolNormQ(s) { return (s || '').replace(/\s+/g, ' ').trim().toLowerCase(); } // 重複判定用の正規化
function poolHashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; } return (h >>> 0).toString(36); }
function poolShuffledIndices(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// アップロード中PDFの総ページ数（pdf.jsで数える。読めなければ0）
async function countUploadedPdfPages() {
  let total = 0;
  for (let i = 0; i < uploadedFiles.length; i++) {
    if (uploadedFiles[i].type !== 'application/pdf') continue;
    try { const pdf = await getPdfDoc(i); total += pdf.numPages || 0; } catch (e) {}
  }
  return total;
}
// ── 同一ファイル判定キー。PDFが無ければ null。──
// 旧IDは「名前+サイズ+総ページ数」のみで理論上の衝突があったため、現行IDは各ファイル
// 先頭8KBの内容ハッシュも含める。旧ID（legacyId）のプールは poolGetForCurrentFiles() が
// 参照時に新IDへ自動移行する（既存ユーザーのプールを壊さない後方互換）。
// 計算はファイル構成ごとにメモ化し、アップロード画面を開くたびのPDF再解析を避ける
//（メモは clearFigureCaches ＝ ファイル変更時に破棄される）。
let fpMemo = { key: '', ids: null };
async function fileSampleHash(f) {
  try {
    const buf = new Uint8Array(await f.slice(0, 8192).arrayBuffer());
    let h = 5381;
    for (let i = 0; i < buf.length; i++) h = ((h << 5) + h + buf[i]) | 0;
    return (h >>> 0).toString(36);
  } catch (e) { return '0'; }
}
async function currentFilesFingerprintIds() {
  if (!uploadedFiles.some(f => f.type === 'application/pdf')) return null;
  const memoKey = uploadedFiles.map(f => f.name + ':' + f.size).join('|');
  if (fpMemo.ids && fpMemo.key === memoKey) return fpMemo.ids;
  const pages = await countUploadedPdfPages();
  const legacyKey = memoKey + '#' + pages;
  const samples = [];
  for (const f of uploadedFiles) samples.push(await fileSampleHash(f));
  const ids = {
    id: 'pool_' + poolHashStr(legacyKey + '~' + samples.join('.')),
    legacyId: 'pool_' + poolHashStr(legacyKey)
  };
  fpMemo = { key: memoKey, ids };
  return ids;
}
async function currentFilesFingerprint() {
  const ids = await currentFilesFingerprintIds();
  return ids ? ids.id : null;
}
// 現在のファイル構成に対応するプールを取得する（旧ID形式で保存されたプールは新IDへ移行）
async function poolGetForCurrentFiles() {
  const ids = await currentFilesFingerprintIds();
  if (!ids) return null;
  const pool = await poolGet(ids.id).catch(() => null);
  if (pool) return pool;
  const legacy = await poolGet(ids.legacyId).catch(() => null);
  if (legacy) {
    const oldId = legacy.id;
    legacy.id = ids.id;
    try { await poolPut(legacy); try { await poolDelete(oldId); } catch (e2) {} }
    catch (e) { legacy.id = oldId; } // 移行に失敗しても旧IDのまま使えれば良い（次回また試す）
    return legacy;
  }
  return null;
}
// 判別しやすい既定名（ファイル名＋作成日）
function defaultPoolName(files) {
  const pdf = files.find(f => f.type === 'application/pdf') || files[0];
  let base = pdf ? pdf.name.replace(/\.[^.]+$/, '') : '教材';
  if (files.length > 1) base += ' ほか';
  const d = new Date();
  return base + '（' + (d.getMonth() + 1) + '/' + d.getDate() + ' 作成）';
}
// 出題に使う現在の設定（プール出題は q-count 等の入力欄を尊重）
function poolServeSettings() {
  const g = id => document.getElementById(id);
  return {
    qCount: Math.min(20, Math.max(1, parseInt(g('q-count') && g('q-count').value) || 5)),
    difficulty: (g('difficulty') && g('difficulty').value) || 'medium',
    answerFormat: (g('answer-format') && g('answer-format').value) || 'mixed',
    choiceCount: parseInt(g('choice-count') && g('choice-count').value) || 4,
    orderMode: (g('order-mode') && g('order-mode').value) || 'random',
    focus: (g('focus') && g('focus').value) || 'balanced'
  };
}

// ── プールから出題分を取り出す（ローテーションで毎回ちがう問題を出す） ──
// wantFormat（任意）：'mixed' 以外が指定され、プール内に該当形式があれば、その形式だけから
// シャッフルして出題する（形式指定時はローテーションではなく毎回ランダム抽出）。
function poolTakeSubset(pool, n, wantFormat) {
  const total = pool.questions.length;
  n = Math.min(n, total);
  if (wantFormat && wantFormat !== 'mixed') {
    const idxs = [];
    pool.questions.forEach((q, i) => { if (q.type === wantFormat) idxs.push(i); });
    if (idxs.length) {
      const sh = poolShuffledIndices(idxs.length);
      const picked = [];
      for (let k = 0; k < Math.min(n, idxs.length); k++) picked.push(pool.questions[idxs[sh[k]]]);
      return JSON.parse(JSON.stringify(picked));
    }
    // 該当形式が1問も無ければ従来どおり全体ローテーションへフォールバック（呼び出し側で通知）
  }
  if (!Array.isArray(pool.order) || pool.order.length !== total) { pool.order = poolShuffledIndices(total); pool.cursor = 0; }
  if (typeof pool.cursor !== 'number' || pool.cursor < 0) pool.cursor = 0;
  const picked = [];
  for (let k = 0; k < n; k++) {
    if (pool.cursor >= total) { pool.order = poolShuffledIndices(total); pool.cursor = 0; } // 一巡したら混ぜ直す
    picked.push(pool.questions[pool.order[pool.cursor]]);
    pool.cursor++;
  }
  return JSON.parse(JSON.stringify(picked)); // 元データを壊さないよう複製して渡す
}

// プールの元ファイルを uploadedFiles に復元（図の切り出し・出典表示のため）
async function restorePoolFiles(pool) {
  try {
    if (Array.isArray(pool.files) && pool.files.length) {
      uploadedFiles = pool.files.map(r => new File([r.blob], r.name, { type: r.type }));
      clearFigureCaches();
      renderFileList();
    }
  } catch (e) {}
}

// プールから（API不要・無料で）出題を開始する
async function serveFromPool(pool, settings) {
  if (!pool.questions || !pool.questions.length) { alert('この問題プールは空です。'); return; }
  closeDataModal(); // データ管理ハブから出題した場合はハブを閉じる（クイズ画面をふさがない）
  const s = settings || poolServeSettings();
  await restorePoolFiles(pool);
  // 画面で選んだ「回答形式」を尊重する（プールに該当形式が無いときだけミックスへフォールバック＋通知）
  let wantFormat = s.answerFormat || 'mixed';
  if (wantFormat !== 'mixed' && !pool.questions.some(q => q.type === wantFormat)) {
    alert('このプールには「' + (FORMAT_LABEL[wantFormat] || wantFormat) + '」形式の問題が無いため、ミックスで出題します。');
    wantFormat = 'mixed';
  }
  const subset = poolTakeSubset(pool, s.qCount || 5, wantFormat);
  await poolSaveGuarded(pool); // cursor を保存（次回はちがう問題から）
  startQuizFromQuestions(subset, {
    difficulty: s.difficulty || (pool.settings && pool.settings.difficulty) || 'medium',
    answerFormat: wantFormat,
    choiceCount: (pool.settings && pool.settings.choiceCount) || s.choiceCount,
    orderMode: s.orderMode, focus: s.focus, fromSaved: true, poolId: pool.id,
    modeConfirmed: !!s.modeConfirmed // 生成ボタン経由（maybeHandlePoolFlow）だけ試験モード確認を飛ばす
  }, 'normal');
}

// startQuiz から呼ばれる分岐。プール方式で処理したら true（＝通常生成を行わない）
async function maybeHandlePoolFlow(settings) {
  if (IS_WIDGET) return false;
  if (!uploadedFiles.some(f => f.type === 'application/pdf')) return false;

  const existing = await poolGetForCurrentFiles().catch(() => null); // 旧IDのプールも自動移行して拾う

  // 2回目以降：このファイルの無料プールがある → プールから出題を提案
  if (existing && existing.questions && existing.questions.length) {
    const ok = await uiConfirm(
      `このファイルの問題プール「${existing.name}」があります（全${existing.questions.length}問${existing.status === 'building' ? '・作成中' : ''}）。\n\n` +
      'APIを使わず、このプールから無料で出題できます。',
      { okText: '無料で出題', cancelText: 'AIで新しく生成（有料）' }
    );
    // 生成ボタンから来た＝モード選択は画面で確認済みなので、試験モードの再確認は不要
    if (ok) { await serveFromPool(existing, Object.assign({}, settings, { modeConfirmed: true })); return true; }
    return false; // 新規生成を選択 → 通常フローへ
  }

  // 新規：ページ数がしきい値超なら大量プールをまとめて作る
  const pages = await countUploadedPdfPages();
  if (pages > POOL_PAGE_THRESHOLD) {
    if (!settings.apiKey) return false; // キーが無ければ通常フロー側のエラー表示に任せる
    // Gemini（無料枠）はプール作成＝短時間に多数のAI呼び出しで、レート上限（例：20回/分）に即当たる。
    // よってプール作成は提案せず、通常生成（単発）で進める。案内はセッション中1回だけ出す。
    if (isGeminiKey(settings.apiKey)) {
      if (!geminiPoolNoticeShown) {
        geminiPoolNoticeShown = true;
        await uiAlert(`大きめのPDF（${pages}ページ）ですが、Gemini（無料枠）では「問題プール」（連続生成）は回数上限に当たるため作成しません。\n\n今回は通常生成（${settings.qCount}問）で進めます。\n同じ教材で何度も無料出題したい場合は、Claude（sk-ant-…）のキーをお使いください。`);
      }
      return false; // 通常生成へ
    }
    const ok = await uiConfirm(
      `このPDFは${pages}ページと大きめです。\n\n` +
      `初回だけAIで「問題プール（目標 約${POOL_TARGET}問）」をまとめて作成し、以降はAPIを使わず無料でくり返し出題できるようにしますか？\n\n` +
      '・作成はバックグラウンドで進みます（最初のまとまりができ次第クイズを開始）。\n' +
      '・複数回のAI生成を行うため、単発生成より費用がかかります。',
      { okText: 'プールを作成', cancelText: `今回だけ生成（${settings.qCount}問）` }
    );
    if (ok) { await startPoolBuildAndQuiz(settings); return true; }
  }
  return false;
}

// AI生成1バッチ分をプールに追加（既出と重複しないよう重点を変えつつ重複除去）
async function poolGenerateOneBatch(pool, settings, files, batchIndex) {
  const focusRotation = ['balanced', 'definitions', 'concepts', 'application'];
  const batchSize = Math.min(POOL_BATCH, POOL_TARGET - pool.questions.length);
  if (batchSize <= 0) return;
  const s = Object.assign({}, settings, {
    qCount: Math.max(1, batchSize),
    focus: focusRotation[batchIndex % focusRotation.length],
    extra: (settings.extra ? settings.extra + '\n' : '') +
      '既に作成済みの問題と内容が重複しない、新規の問題のみを作成してください。教材全体からまんべんなく出題してください。'
  });
  const qs = await generateQuestions(s, null, files, { cachePdf: true });
  const seen = new Set(pool.questions.map(q => poolNormQ(q.question)));
  for (const q of qs) {
    const k = poolNormQ(q.question);
    if (k && !seen.has(k)) { seen.add(k); pool.questions.push(q); }
  }
  pool.updatedAt = Date.now();
}

// 初回：最初のバッチを作ってすぐ出題を開始し、残りはバックグラウンドで作り続ける
async function startPoolBuildAndQuiz(settings) {
  if (poolBuildActive) { alert('問題プールを作成中です。完了までお待ちください。'); return; }
  // 防御：Gemini（無料枠）はプール作成（連続生成）で即レート上限に当たるため、ここでは作らない。
  // 通常は maybeHandlePoolFlow 側で提案しないので到達しないが、別経路からの誤呼び出しに備える。
  if (isGeminiKey(settings.apiKey)) { await uiAlert('Gemini（無料枠）では、問題プールの作成（連続生成）は回数上限に当たるため行えません。通常の生成をご利用ください。'); return; }
  if (!(await preGenerateGuard(settings, { confirmCost: false }))) return; // サイズ・二重実行チェック

  const fp = await currentFilesFingerprint();
  const filesSnapshot = uploadedFiles.slice(); // 作成中にファイルが変わっても固定
  const pool = {
    id: fp, name: defaultPoolName(filesSnapshot),
    createdAt: Date.now(), updatedAt: Date.now(),
    fileMeta: filesSnapshot.map(f => ({ name: f.name, type: f.type, size: f.size })),
    files: filesSnapshot.map(f => ({ name: f.name, type: f.type, blob: f })), // 図・出典復元用
    settings: { difficulty: settings.difficulty, answerFormat: settings.answerFormat, choiceCount: settings.choiceCount, focus: settings.focus },
    questions: [], order: [], cursor: 0, target: POOL_TARGET, status: 'building'
  };
  // 空のプールをここで先に保存すると、初回バッチ失敗やタブ閉じで「0問」の幽霊プールが残る。
  // 保存は最初のバッチで問題ができてから（下）行う。

  poolBuildActive = true;
  isGenerating = true; setStartBtnBusy(true);
  showScreen('screen-loading');
  setLoadingMsg('問題プールを作成中', '最初のまとまりを生成しています…（初回のみ）');

  // 1) 最初のバッチを生成 → できたらすぐ出題
  try {
    await poolGenerateOneBatch(pool, settings, filesSnapshot, 0);
    await poolSaveGuarded(pool);
  } catch (e) {
    poolBuildActive = false; isGenerating = false; setStartBtnBusy(false);
    console.error(e);
    alert('問題プールの作成に失敗しました: ' + (e && e.message ? e.message : e));
    showScreen('screen-upload');
    return;
  }
  isGenerating = false; setStartBtnBusy(false);

  if (pool.questions.length > 0) {
    const subset = poolTakeSubset(pool, settings.qCount);
    await poolSaveGuarded(pool);
    startQuizFromQuestions(subset, {
      difficulty: settings.difficulty, answerFormat: settings.answerFormat,
      choiceCount: settings.choiceCount, orderMode: settings.orderMode, focus: settings.focus,
      fromSaved: true, poolId: pool.id,
      modeConfirmed: true // 生成ボタン経由＝モード選択は画面で確認済み。試験モードの再確認は不要
    }, 'normal');
  } else {
    showScreen('screen-upload');
  }

  // 2) 残りをバックグラウンドで作り続ける（await しない＝学習を妨げない）
  continuePoolBuild(pool, settings, filesSnapshot);
}

// 目標問数に達するまでバッチ生成を繰り返す（進捗を上部に表示）
async function continuePoolBuild(pool, settings, files) {
  let batchIndex = 1; // 0 は最初に実行済み
  try {
    while (pool.questions.length < pool.target && batchIndex < POOL_MAX_BATCHES) {
      showPoolProgress(pool);
      const before = pool.questions.length;
      try { await poolGenerateOneBatch(pool, settings, files, batchIndex); }
      catch (e) { console.warn('[AIQuiz] プールのバッチ生成に失敗', e); break; }
      await poolSaveMerge(pool).catch(() => {});
      refreshPoolUI();
      batchIndex++;
      if (pool.questions.length <= before) break; // 重複ばかりで増えない → 打ち切り
    }
  } finally {
    poolBuildActive = false;
    if (!pool.questions.length) {
      // 1問も作れなかった（全バッチ失敗など）→ 「0問」の幽霊プールを残さず削除
      await poolDelete(pool.id).catch(() => {});
      hidePoolProgress();
    } else {
      pool.status = 'ready'; pool.updatedAt = Date.now();
      await poolSaveMerge(pool).catch(() => {});
      poolDoneToast(pool);
    }
    refreshPoolUI();
  }
}

// ── 進捗トースト（上部・非ブロッキング） ──
function showPoolProgress(pool) {
  const el = document.getElementById('pool-progress');
  if (!el) return;
  const n = pool.questions ? pool.questions.length : 0;
  const t = el.querySelector('#pool-progress-text');
  if (t) t.textContent = `問題プール作成中… ${n}/${pool.target}問（このまま学習を続けられます）`;
  clearTimeout(poolToastTimer);
  el.style.opacity = '1'; el.style.pointerEvents = 'auto';
}
function hidePoolProgress() {
  const el = document.getElementById('pool-progress');
  if (!el) return;
  el.style.opacity = '0'; el.style.pointerEvents = 'none';
}
function poolDoneToast(pool) {
  const el = document.getElementById('pool-progress');
  if (!el) return;
  const n = pool.questions ? pool.questions.length : 0;
  const t = el.querySelector('#pool-progress-text');
  if (t) t.textContent = `✅ 問題プール「${pool.name}」完成：${n}問。次回から無料で出題できます。`;
  el.style.opacity = '1'; el.style.pointerEvents = 'auto';
  clearTimeout(poolToastTimer);
  poolToastTimer = setTimeout(hidePoolProgress, 8000);
}

// ── アップロード画面のプールUI（バナー＋一覧）を最新化 ──
async function refreshPoolUI() {
  try { await refreshPoolBanner(); } catch (e) {}
  try { await refreshPoolLibrary(); } catch (e) {}
}
// 今アップロード中のファイルに一致する無料プールがあればバナー表示
async function refreshPoolBanner() {
  const banner = document.getElementById('pool-banner');
  if (!banner) return;
  const pool = await poolGetForCurrentFiles().catch(() => null); // 旧IDのプールも自動移行して拾う
  if (pool && pool.questions && pool.questions.length) {
    document.getElementById('pool-banner-text').textContent =
      `このファイルの無料プール「${pool.name}」があります（全${pool.questions.length}問${pool.status === 'building' ? '・作成中' : ''}）。APIを使わず出題できます。`;
    banner.dataset.poolId = pool.id;
    banner.style.display = 'flex';
  } else {
    banner.removeAttribute('data-pool-id');
    banner.style.display = 'none';
  }
}
// プール1件の表示HTML（アップロード画面の一覧とデータ管理ハブで共用）
function poolItemHtml(p) {
  const files = escapeHtml((p.fileMeta || []).map(f => f.name).join('、'));
  return `<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; background:var(--surface2); border:1px solid var(--border2); border-radius:10px; padding:10px 12px;">
    <div style="flex:1; min-width:160px;">
      <div style="font-weight:600;">${escapeHtml(p.name)}</div>
      <div style="font-size:11px; color:var(--text3); margin-top:2px;">${p.questions ? p.questions.length : 0}問 ／ ${files}${p.status === 'building' ? ' ・作成中…' : ''}</div>
    </div>
    <button class="btn-primary" style="padding:6px 12px; font-size:12px;" onclick="servePool('${p.id}')">▶ 出題（無料）</button>
    <button class="btn-secondary" style="padding:6px 10px; font-size:12px;" onclick="exportPool('${p.id}')" title="このプールを1つのJSONファイルとしてダウンロードに書き出します（PDF・図・出典も同梱）。事故対策・共有・引っ越しに。">書き出し</button>
    <button class="btn-secondary" style="padding:6px 10px; font-size:12px;" onclick="renamePool('${p.id}')">名前変更</button>
    <button class="btn-secondary" style="padding:6px 10px; font-size:12px;" onclick="deletePool('${p.id}')">削除</button>
  </div>`;
}

// 保存済みプールの一覧を表示（アップロード画面の details ＋ 開いていればデータ管理ハブも同期）
async function refreshPoolLibrary() {
  const pools = (await poolList()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const wrap = document.getElementById('pool-library');
  const list = document.getElementById('pool-library-list');
  if (wrap && list) {
    if (!pools.length) { wrap.style.display = 'none'; list.innerHTML = ''; }
    else { wrap.style.display = 'block'; list.innerHTML = pools.map(poolItemHtml).join(''); }
  }
  const modal = document.getElementById('data-modal');
  const hubList = document.getElementById('data-pool-list');
  if (hubList && modal && modal.classList.contains('show')) {
    hubList.innerHTML = pools.length ? pools.map(poolItemHtml).join('') : '<div style="font-size:12px; color:var(--text3);">まだ問題プールはありません。</div>';
  }
}

// バナー／一覧から呼ばれる操作
async function servePoolFromBanner() {
  const banner = document.getElementById('pool-banner');
  const id = banner && banner.dataset.poolId;
  if (id) servePool(id);
}
// 「問題プールから読み込む」ボタン：保存済みプール一覧（#pool-library）を最新化して開き、そこへスクロール。
// プールが無ければ、作成方法を案内する。
async function openPoolLibrary() {
  try { await refreshPoolLibrary(); } catch (e) {}
  const wrap = document.getElementById('pool-library');
  const list = document.getElementById('pool-library-list');
  const hasPools = wrap && wrap.style.display !== 'none' && list && list.children.length > 0;
  if (!hasPools) {
    alert('まだ保存された問題プールがありません。\n\nページ数が多めのPDF（' + (POOL_PAGE_THRESHOLD + 1) + 'ページ以上）を読み込んで問題を生成すると「問題プール」を作成でき、以降はアップロードし直さず無料で何度でも出題できます。');
    return;
  }
  wrap.open = true; // 一覧を開く（そのまま各プールの「出題（無料）」から選べる）
  try { wrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
}
async function servePool(id) {
  const pool = await poolGet(id).catch(() => null);
  if (!pool) { alert('この問題プールが見つかりませんでした。'); return; }
  await serveFromPool(pool, poolServeSettings());
}
async function renamePool(id) {
  const pool = await poolGet(id).catch(() => null);
  if (!pool) return;
  const name = prompt('問題プールの名前を変更', pool.name);
  if (name === null) return;
  pool.name = name.trim() || pool.name;
  pool.updatedAt = Date.now();
  await poolPut(pool).catch(() => {});
  refreshPoolUI();
}
async function deletePool(id) {
  if (!(await uiConfirm('この問題プールを削除しますか？（元に戻せません）', { okText: '削除する', cancelText: 'やめる' }))) return;
  await poolDelete(id).catch(() => {});
  refreshPoolUI();
}

// ファイル名に使えない文字（\ / : * ? " < > |）を「_」に置換し、空白を整え、長すぎる名前は切る。
function sanitizeFileName(s) {
  let out = String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  return (out || '無題').slice(0, 60);
}

// プールを1個、Downloads へ JSON 書き出し（type:'pool'。PDF等は base64 同梱＝図・出典も復元可能）。
// ブラウザ内(IndexedDB)だけだとサイトデータ削除で消えるため、実ファイルにして事故対策・共有・引っ越しを可能にする。
async function exportPool(id) {
  const pool = await poolGet(id).catch(() => null);
  if (!pool) { alert('この問題プールが見つかりませんでした。'); return; }
  try {
    const rec = Object.assign({}, pool);
    const filesB64 = [];
    for (const f of (pool.files || [])) {
      try { filesB64.push({ name: f.name, type: f.type, dataB64: await blobToB64(f.blob) }); } catch (e) {}
    }
    delete rec.files;
    rec.filesB64 = filesB64;
    const payload = { app: 'AIQuiz', type: 'pool', version: 'v5', exportedAt: new Date().toISOString(), pool: rec };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date(); const p = n => String(n).padStart(2, '0');
    a.href = url;
    a.download = 'AIQuiz_プール_' + sanitizeFileName(pool.name) + '_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('プールの書き出しに失敗しました: ' + (e && e.message ? e.message : e));
  }
}

// ─── DATA MANAGEMENT HUB / BACKUP (データ管理ハブ・全体バックアップ) ──
// 方針：localStorage / IndexedDB は「ブラウザ内ストレージ」で本体フォルダには出せない。
//   そこで“総括”は (1) アプリ内の1画面（このハブ）にまとめる、(2) 全データを1ファイルに書き出す、で実現する。
//   バックアップには APIキーを含めない（漏洩防止）。図・出典の再利用のため、プール内のPDF等はbase64で同梱する。
function openDataModal() { const m = document.getElementById('data-modal'); if (m) m.classList.add('show'); refreshDataModal(); }
function closeDataModal() { const m = document.getElementById('data-modal'); if (m) m.classList.remove('show'); }

// ハブ内の状態表示を更新
async function refreshDataModal() {
  let hasKey = false; try { hasKey = !!localStorage.getItem('aiquiz_api_key'); } catch (e) {}
  const keyEl = document.getElementById('data-key-status');
  if (keyEl) keyEl.textContent = hasKey ? '✓ 設定済み（このブラウザに保存）' : '未設定';

  const expBtn = document.getElementById('data-export-set-btn');
  if (expBtn) expBtn.disabled = !(questions && questions.length);

  const cnt = k => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); if (Array.isArray(v)) return v.length; if (v && typeof v === 'object') return Object.keys(v).length; return 0; } catch (e) { return 0; } };
  const ld = document.getElementById('data-learn-status');
  if (ld) ld.textContent = `学習履歴 ${cnt('aiquiz_history')}件 ／ 苦手 ${cnt('aiquiz_srs')}件 ／ 試験 ${cnt('aiquiz_exams')}件`;

  // 今セッションのAI利用コスト（生成＋採点の実測トークンから算出した概算）
  const costEl = document.getElementById('data-cost-status');
  if (costEl) {
    const calls = sessionCost.genCalls + sessionCost.gradeCalls;
    if (calls === 0) {
      costEl.textContent = 'この画面を開いてから、AIの生成・採点は行われていません。';
    } else {
      const totJpy = sessionCost.genJpy + sessionCost.gradeJpy;
      const totUsd = sessionCost.genUsd + sessionCost.gradeUsd;
      costEl.textContent =
        `生成 ¥${sessionCost.genJpy.toFixed(1)}（${sessionCost.genCalls}回） ／ ` +
        `採点 ¥${sessionCost.gradeJpy.toFixed(1)}（${sessionCost.gradeCalls}回） ／ ` +
        `合計 概算 ¥${totJpy.toFixed(1)}（$${totUsd.toFixed(4)}）`;
    }
  }

  const pools = (await poolList().catch(() => [])).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const hubList = document.getElementById('data-pool-list');
  if (hubList) hubList.innerHTML = pools.length ? pools.map(poolItemHtml).join('') : '<div style="font-size:12px; color:var(--text3);">まだ問題プールはありません。</div>';
  const pdfCount = pools.reduce((s, p) => s + (p.fileMeta || []).filter(f => f.type === 'application/pdf').length, 0);
  const pdfEl = document.getElementById('data-pdf-status');
  if (pdfEl) pdfEl.textContent = `問題プール ${pools.length}個 の中に PDF ${pdfCount}件を保存中（再利用時の図・出典表示用）`;
  const stEl = document.getElementById('data-storage-status');
  if (stEl) {
    const est = await storageEstimate();
    const nearFull = storageFull || est.ratio >= 0.9; // 容量オーバー検知済み、または使用率9割超で警告
    stEl.textContent = est.text + (nearFull ? '　⚠ 容量が上限に近づいています。不要なプールを削除するか、バックアップ後に削除してください。' : '');
    stEl.style.color = nearFull ? 'var(--red)' : 'var(--text3)';
  }
}

// 保存済みAPIキーを削除
async function deleteApiKey() {
  if (!(await uiConfirm('保存したAPIキーをこのブラウザから削除しますか？', { okText: '削除する', cancelText: 'やめる' }))) return;
  try { localStorage.removeItem('aiquiz_api_key'); } catch (e) {}
  const inp = document.getElementById('api-key'); if (inp) inp.value = '';
  try { expandApiKey(); } catch (e) {}
  refreshDataModal();
}

// おおよそのブラウザ保存容量（text＋使用率ratioを返す。ratioで表示色を出し分ける）
async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      const usage = e.usage || 0, quota = e.quota || 0;
      const mb = x => (x / 1048576).toFixed(1);
      return { text: `このアプリの推定使用容量：${mb(usage)}MB（ブラウザ上限の目安：約${mb(quota)}MB）`, ratio: quota ? usage / quota : 0 };
    }
  } catch (e) {}
  return { text: '容量情報は取得できません。', ratio: 0 };
}

// Blob ⇄ base64（JSONに図・出典用PDFを同梱するため）
function blobToB64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result.split(',')[1]) || '');
    r.onerror = () => rej(new Error('ファイルの読み込みに失敗しました'));
    r.readAsDataURL(blob);
  });
}
function b64ToBlob(b64, type) {
  const bin = atob(b64 || '');
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: type || 'application/octet-stream' });
}

// バックアップに含める localStorage キー（APIキーは意図的に除外）
const BACKUP_LOCAL_KEYS = ['aiquiz_history', 'aiquiz_srs', 'aiquiz_exams', 'aiquiz_aieq', 'aiquiz_strict', 'aiquiz_beta_draw', 'aiquiz_beta_graph', 'aiquiz_agreed'];

// 全データを1ファイルに書き出す（問題プールのPDFはbase64で同梱・キーは含めない）
async function exportBackup() {
  try {
    const pools = await poolList().catch(() => []);
    const poolsOut = [];
    for (const p of pools) {
      const rec = Object.assign({}, p);
      const filesB64 = [];
      for (const f of (p.files || [])) {
        try { filesB64.push({ name: f.name, type: f.type, dataB64: await blobToB64(f.blob) }); } catch (e) {}
      }
      delete rec.files;
      rec.filesB64 = filesB64;
      poolsOut.push(rec);
    }
    const local = {};
    BACKUP_LOCAL_KEYS.forEach(k => { try { const v = localStorage.getItem(k); if (v !== null) local[k] = v; } catch (e) {} });
    const payload = { app: 'AIQuiz', type: 'backup', version: 'v5', exportedAt: new Date().toISOString(), local, pools: poolsOut };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date(); const p = n => String(n).padStart(2, '0');
    a.href = url;
    a.download = `AIQuiz_バックアップ_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('バックアップの書き出しに失敗しました: ' + (e && e.message ? e.message : e));
  }
}

// エクスポート形式のプールレコード（filesB64 同梱）を、保存用（files=Blob付き）へ復元する。
// バックアップ復元・プール単体復元の両方で共用。
function poolRecordFromExport(p) {
  const rec = Object.assign({}, p);
  const filesB64 = rec.filesB64 || [];
  delete rec.filesB64;
  delete rec.type; // エクスポート用の目印は保存レコードに残さない
  rec.files = filesB64.map(f => ({ name: f.name, type: f.type, blob: new File([b64ToBlob(f.dataB64, f.type)], f.name, { type: f.type }) }));
  return rec;
}

// バックアップデータ（parse済み）から復元（プール追加＋学習/設定を上書き。キーは触らない）→ 再読み込みで全反映
async function restoreBackupData(data) {
  if (!data || data.type !== 'backup') {
    if (!(await uiConfirm('AIQuizのバックアップ形式として認識できませんでした。それでも復元を試みますか？', { okText: '試みる', cancelText: 'やめる' }))) return;
  }
  if (!(await uiConfirm('バックアップから復元します。\n\n・問題プールを追加します（同じIDは上書き）\n・学習履歴・苦手・試験・設定を上書きします\n・APIキーは含まれないため変更されません\n\n続けますか？', { okText: '復元する', cancelText: 'やめる' }))) return;
  let poolN = 0;
  try {
    for (const p of (data.pools || [])) {
      await poolSaveGuarded(poolRecordFromExport(p));
      poolN++;
    }
    if (data.local) {
      Object.keys(data.local).forEach(k => { if (k === 'aiquiz_api_key') return; try { localStorage.setItem(k, data.local[k]); } catch (e) {} });
    }
  } catch (e) {
    alert('復元中にエラーが発生しました: ' + (e && e.message ? e.message : e));
    return;
  }
  await uiAlert(`復元しました（問題プール ${poolN}個）。設定を反映するためページを再読み込みします。`);
  location.reload();
}

// バックアップファイルから復元（データ管理ハブの「バックアップから復元」用）
async function importBackupFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { alert('読み込めませんでした（JSON形式ではありません）。'); return; }
  await restoreBackupData(data);
}

// ─── PRINT / PDF (印刷・PDF保存) ───────────────────────────────
// 現在の問題セットを「問題（ワークシート）＋解答キー」として印刷用に整形
// includeAnswers=true で解答キーも印刷。false／未指定なら問題のみ（配布・自己テスト用）。
function printQuestions(includeAnswers, qsArg, titleArg) {
  const qs = (qsArg && qsArg.length) ? qsArg : questions; // サブセット（苦手ノート等）が渡されればそれを印刷
  if (!qs || !qs.length) { alert('印刷できる問題がありません。'); return; }
  const area = document.getElementById('print-area');
  const m = s => mathToHtml(s); // 数式（$...$）を描画。KaTeX未読込なら生テキストにフォールバック
  const LBL = ['A', 'B', 'C', 'D', 'E', 'F'];
  const blankLines = n => '<div class="pl"></div>'.repeat(n);

  let body = '';
  qs.forEach((q, i) => {
    let qhtml = '';
    if (q.type === 'choice') {
      qhtml = '<div class="pq-q">' + m(q.question) + '</div><ol class="pc">' +
        q.choices.map(c => '<li>' + m(c) + '</li>').join('') + '</ol>';
    } else if (q.type === 'sort') {
      qhtml = '<div class="pq-q">' + m(q.question) + '</div><div class="pn">分類：' + q.categories.map(m).join(' ／ ') + '</div><ul class="pi">' +
        q.items.map(it => '<li>' + m(it) + '：（　　　　　）</li>').join('') + '</ul>';
    } else if (q.type === 'order') {
      // 画面表示（renderOrderQuestion）と同じ基準：偏りのないシャッフル＋偶然正解順のまま印刷される事故を回避
      let items = shuffleArray(q.items);
      if (q.items.length > 1 && items.every((v, i) => v === q.items[i])) items.push(items.shift());
      qhtml = '<div class="pq-q">' + m(q.question) + '</div><ul class="pi">' +
        items.map(it => '<li>（　）　' + m(it) + '</li>').join('') + '</ul>';
    } else if (q.type === 'fill') {
      // 数式の外は記入欄、数式の中（行列など）は空の箱にして、数式を壊さず印刷する
      qhtml = '<div class="pq-q">' + m(fillQuestionTextWith(q, (idx, inMath) => inMath ? '\\boxed{\\phantom{00}}' : '（　　　　　）')) + '</div>';
    } else if (q.type === 'table') {
      let t = '<table class="pt">';
      if (q.headers && q.headers.length) t += '<tr>' + q.headers.map(h => '<th>' + m(h) + '</th>').join('') + '</tr>';
      q.rows.forEach((row, r) => {
        t += '<tr>' + row.map((cell, c) => {
          const blank = (q.blanks || []).some(b => b.r === r && b.c === c);
          return '<td>' + (blank ? '' : m(cell)) + '</td>';
        }).join('') + '</tr>';
      });
      t += '</table>';
      qhtml = '<div class="pq-q">' + m(q.question) + '</div>' + t;
    } else if (q.type === 'text') {
      qhtml = '<div class="pq-q">' + m(q.question) + '</div>' + blankLines(3);
    } else if (q.type === 'draw') {
      // 描画問題：解答用に空白の枠を用意する
      qhtml = '<div class="pq-q">' + m(q.question) + '</div><div style="border:1px solid #888; height:160px; border-radius:6px;"></div>';
    } else if (q.type === 'graph') {
      qhtml = '<div class="pq-q">' + m(q.question) + '</div><div class="pn">（座標グリッドに点をプロット）</div><div style="border:1px solid #888; height:200px; border-radius:6px;"></div>';
    }
    body += '<div class="pq"><div class="pq-n">問' + (i + 1) + '</div>' + qhtml + '</div>';
  });

  let key = '';
  if (includeAnswers) {
    key = '<div class="pk"><h2>解答</h2>';
    qs.forEach((q, i) => {
      key += '<div class="pk-row"><b>問' + (i + 1) + '．</b>' + m(formatAnswerText(q)) +
        (q.explanation ? '<div class="pk-e">' + m(q.explanation) + '</div>' : '') + '</div>';
    });
    key += '</div>';
  }

  const d = new Date(); const p = n => String(n).padStart(2, '0');
  area.innerHTML = '<h1>' + (titleArg || 'AIクイズ 問題') + '（全' + qs.length + '問）</h1>' +
    '<div class="pdate">作成：' + d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + '</div>' +
    body + key;
  window.print();
}

// 苦手ノート：SRSに溜まった苦手問題【全部】を、解答・解説つきでPDF化（印刷）する。
function printSRSNote() {
  const items = loadSRS();
  if (!items.length) { alert('登録された苦手問題がありません。まず問題を解いて、間違えた問題をためましょう。'); return; }
  const qs = JSON.parse(JSON.stringify(items.map(it => it.q))); // 保存データを壊さないよう複製
  printQuestions(true, qs, 'AIクイズ 苦手ノート');
}

// ─── HISTORY & DASHBOARD (成績の永続化・学習履歴) ──────────────
const HISTORY_KEY = 'aiquiz_history';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function saveHistoryRecord(rec) {
  try {
    const h = loadHistory();
    h.push(rec);
    while (h.length > 200) h.shift(); // 直近200件まで保持
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  } catch (e) { /* localStorage不可の環境では履歴を残さない */ }
}

async function clearHistory() {
  if (!(await uiConfirm('学習履歴をすべて削除します。よろしいですか？（元に戻せません）', { okText: '削除する', cancelText: 'やめる' }))) return;
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
  renderDashboard();
}

function openDashboard() {
  // 試験の実施中に画面を切り替えると showScreen がタイマーを止め、試験画面へ戻る手段も
  // 無いため（回答・問題セットが失われる）、実施中はダッシュボードを開かせない。
  if (examActive) {
    alert('試験モードの実施中は学習履歴を開けません。\n先に「採点する（提出）」または「中断」を押してください。');
    return;
  }
  renderDashboard();
  showScreen('screen-dashboard');
}

const KIND_LABEL = { normal: '通常', retake: '再挑戦', similar: '類似問題', exam: '試験', srs: '苦手復習' };
const FORMAT_LABEL = { mixed: 'ミックス', choice: '選択', sort: '仕分け', order: '並べ替え', fill: '穴埋め', table: '表穴埋め', text: '記述', draw: '描画(β)', graph: 'グラフ(β)' };

function formatDate(iso) {
  try {
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return iso || ''; }
}

function renderDashboard() {
  const h = loadHistory();
  const summary = document.getElementById('dash-summary');
  const trend = document.getElementById('dash-trend');
  const topicsEl = document.getElementById('dash-topics');
  const sessionsEl = document.getElementById('dash-sessions');

  if (h.length === 0) {
    summary.innerHTML = '';
    trend.innerHTML = '<div class="dash-empty">まだ学習履歴がありません。クイズを解くとここに記録されます。</div>';
    topicsEl.innerHTML = '';
    sessionsEl.innerHTML = '';
    return;
  }

  // サマリー
  const totalQuizzes = h.length;
  const totalQ = h.reduce((s, r) => s + (r.total || 0), 0);
  const totalCorrect = h.reduce((s, r) => s + (r.correct || 0), 0);
  const avgPct = Math.round(h.reduce((s, r) => s + (r.pct || 0), 0) / h.length);
  summary.innerHTML = `
    <div class="stat-card"><div class="stat-val">${totalQuizzes}</div><div class="stat-label">受験回数</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--amber)">${avgPct}%</div><div class="stat-label">平均正答率</div></div>
    <div class="stat-card"><div class="stat-val">${totalQ}</div><div class="stat-label">累計問題数</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--green)">${totalCorrect}</div><div class="stat-label">累計正解</div></div>
  `;

  // スコア推移（直近15件）
  const recent = h.slice(-15);
  trend.innerHTML = `<div class="dash-bars">${recent.map(r => {
    const p = r.pct || 0;
    const col = p >= 80 ? 'var(--green)' : (p >= 50 ? 'var(--amber)' : 'var(--red)');
    return `<div class="dash-bar-wrap" title="${formatDate(r.date)}　${p}%">
      <div class="dash-bar-val">${p}</div>
      <div class="dash-bar" style="height:${Math.max(2, p)}%; background:${col}"></div>
    </div>`;
  }).join('')}</div>`;

  // トピック別理解度（全履歴を集計し、苦手な順に表示）
  const topicAgg = {};
  h.forEach(r => {
    const tp = r.topics || {};
    Object.keys(tp).forEach(t => {
      if (!topicAgg[t]) topicAgg[t] = { correct: 0, total: 0 };
      topicAgg[t].correct += tp[t].correct || 0;
      topicAgg[t].total += tp[t].total || 0;
    });
  });
  const topicArr = Object.keys(topicAgg).map(t => ({
    name: t,
    correct: topicAgg[t].correct,
    total: topicAgg[t].total,
    pct: topicAgg[t].total ? Math.round(topicAgg[t].correct / topicAgg[t].total * 100) : 0
  })).sort((a, b) => a.pct - b.pct).slice(0, 12);

  topicsEl.innerHTML = topicArr.length === 0 ? '<div class="dash-empty">データなし</div>' : topicArr.map(t => {
    const col = t.pct >= 80 ? 'var(--green)' : (t.pct >= 50 ? 'var(--amber)' : 'var(--red)');
    return `<div class="topic-row">
      <span class="topic-name">${escapeHtml(t.name)}</span>
      <span class="topic-bar-track"><span class="topic-bar-fill" style="width:${t.pct}%; background:${col}"></span></span>
      <span class="topic-pct">${t.pct}%</span>
      <span style="font-size:12px;color:var(--text3);">(${t.correct}/${t.total})</span>
    </div>`;
  }).join('');

  // 受験履歴（新しい順・最大30件）
  const sessions = h.slice().reverse().slice(0, 30);
  sessionsEl.innerHTML = sessions.map(r => {
    const p = r.pct || 0;
    const col = p >= 80 ? 'var(--green)' : (p >= 50 ? 'var(--amber)' : 'var(--red)');
    return `<div class="session-row">
      <span class="session-date">${formatDate(r.date)}</span>
      <span class="tag info">${KIND_LABEL[r.kind] || r.kind || '通常'}</span>
      <span style="color:var(--text3);">${FORMAT_LABEL[r.format] || r.format || ''}</span>
      <span style="margin-left:auto; font-weight:600; color:${col};">${r.correct}/${r.total}（${p}%）</span>
    </div>`;
  }).join('');
}

// ─── MODE-SPECIFIC UI ──────────────────────────────────────────
// ウィジェット内では画像/PDFをAIに渡せないため、テキスト貼り付けを主入力にする
function applyModeUI() {
  // 保存済みAPIキーを復元し、以降は入力のたびに自動保存する
  const keyInput = document.getElementById('api-key');
  if (keyInput) {
    try { keyInput.value = localStorage.getItem('aiquiz_api_key') || ''; } catch {}
    keyInput.addEventListener('input', () => {
      try { localStorage.setItem('aiquiz_api_key', keyInput.value.trim()); } catch {}
    });
    // すでにキーが保存済みなら入力欄を畳んで「設定済み」表示にする（毎回入力させない）
    if (keyInput.value) collapseApiKey();
  }

  // 保存した問題セット(JSON)の読み込み
  const importInput = document.getElementById('import-input');
  if (importInput) {
    importInput.addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) importQuestionsFile(f);
      e.target.value = ''; // 同じファイルを再選択できるようにリセット
    });
  }

  // ファイルを直接(file://)開いている場合は、接続テストを促す注意を表示
  const protoNote = document.getElementById('file-proto-note');
  if (protoNote && location.protocol === 'file:') {
    protoNote.textContent = 'ファイルを直接開いています。一部のブラウザでは通信が遮断されることがあります。まず「接続テスト」で確認してください。';
    protoNote.style.display = 'block';
  }

  if (!IS_WIDGET) return;

  // 内蔵AIブリッジが使える環境：APIキー・キー取得ガイドは不要なので隠す
  const keyArea = document.getElementById('api-key-area');
  if (keyArea) keyArea.style.display = 'none';
  const guideBox = document.getElementById('guide-box');
  if (guideBox) guideBox.style.display = 'none';
  const divider = document.getElementById('setup-divider');
  if (divider) divider.style.display = 'none';
  const badge = document.querySelector('.status-badge');
  if (badge) badge.textContent = 'ウィジェットモード';
  const heroP = document.querySelector('.upload-hero p');
  if (heroP) heroP.innerHTML = '教材の本文をテキストで貼り付けると、AIが内容を読み取り、<br>あなたのレベルに合わせた問題を自動生成します。（出典表示用にPDF・画像を任意で添付できます）';
  const zoneH3 = document.querySelector('#upload-zone h3');
  if (zoneH3) zoneH3.textContent = '出典用ファイルを添付（任意）';
  const zoneP = document.querySelector('#upload-zone p');
  if (zoneP) zoneP.textContent = 'AIには送られません。「出典を見る」で開く用です';
  const pasteLabel = document.getElementById('paste-label');
  if (pasteLabel) pasteLabel.textContent = '教材テキスト（必須・コピペ）';
}
// APIキー入力欄を畳んで「✓設定済み」表示にする
function collapseApiKey() {
  const kh = document.getElementById('api-key-head');
  const kb = document.getElementById('api-key-body');
  if (kh && kb) { kb.style.display = 'none'; kh.style.display = 'flex'; }
}
// 「変更」クリックでAPIキー入力欄を開き直す
function expandApiKey() {
  const kh = document.getElementById('api-key-head');
  const kb = document.getElementById('api-key-body');
  if (kh && kb) { kh.style.display = 'none'; kb.style.display = ''; }
  const inp = document.getElementById('api-key');
  if (inp) inp.focus();
}
// ─── 折りたたみ項目（details）の開閉をなめらかにアニメーション ──
function setupDetailsAnimation() {
  document.querySelectorAll('details.guide-box').forEach(d => {
    const summary = d.querySelector('summary');
    const body = d.querySelector('.guide-body');
    if (!summary || !body) return;
    summary.addEventListener('click', e => {
      e.preventDefault();
      if (d.dataset.anim === '1') return;
      d.dataset.anim = '1';
      const finish = () => {
        body.style.height = ''; body.style.overflow = ''; body.style.transition = ''; body.style.opacity = '';
        d.dataset.anim = '';
      };
      if (!d.open) {
        d.open = true; // 中身を描画させてから高さを測る
        const h = body.scrollHeight;
        body.style.overflow = 'hidden'; body.style.height = '0px'; body.style.opacity = '0';
        requestAnimationFrame(() => {
          body.style.transition = 'height 0.25s ease, opacity 0.25s ease';
          body.style.height = h + 'px'; body.style.opacity = '1';
        });
        const te = ev => { if (ev.target === body && ev.propertyName === 'height') { finish(); body.removeEventListener('transitionend', te); } };
        body.addEventListener('transitionend', te);
      } else {
        const h = body.scrollHeight;
        body.style.overflow = 'hidden'; body.style.height = h + 'px'; body.style.opacity = '1';
        requestAnimationFrame(() => {
          body.style.transition = 'height 0.25s ease, opacity 0.2s ease';
          body.style.height = '0px'; body.style.opacity = '0';
        });
        const te = ev => { if (ev.target === body && ev.propertyName === 'height') { d.open = false; finish(); body.removeEventListener('transitionend', te); } };
        body.addEventListener('transitionend', te);
      }
    });
  });
}

// ─── CUSTOM DROPDOWN (ネイティブ<select>をアニメ付きの自前UIに置換) ───────────
// 本物の<select>はDOMに残して値の源泉とし（既存ロジック・採点は不変）、視覚的に隠して
// カスタムUIを重ねる。選択時に<select>へ change を発火して同期する。
function closeAllDropdowns(except) {
  document.querySelectorAll('.cdd.open').forEach(el => { if (el !== except && el._cddClose) el._cddClose(); });
}
function enhanceSelect(select) {
  if (!select || select.dataset.cddDone) return;
  select.dataset.cddDone = '1';

  const cdd = document.createElement('div');
  cdd.className = 'cdd';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'cdd-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (select.id) btn.id = select.id + '-btn';
  const valEl = document.createElement('span'); valEl.className = 'cdd-val';
  const arrow = document.createElement('span'); arrow.className = 'cdd-arrow'; arrow.textContent = '▾'; arrow.setAttribute('aria-hidden', 'true');
  btn.append(valEl, arrow);
  const list = document.createElement('ul');
  list.className = 'cdd-list'; list.setAttribute('role', 'listbox'); list.tabIndex = -1;
  cdd.append(btn, list);
  select.parentNode.insertBefore(cdd, select.nextSibling);
  select.classList.add('cdd-native');

  function syncLabel() {
    const opt = select.options[select.selectedIndex];
    valEl.textContent = opt ? opt.textContent : '';
  }
  function buildList() {
    list.innerHTML = '';
    Array.from(select.options).forEach(opt => {
      if (opt.hidden || opt.disabled) return; // βの非表示オプション等は出さない
      const li = document.createElement('li');
      li.className = 'cdd-opt' + (opt.value === select.value ? ' selected' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', opt.value === select.value ? 'true' : 'false');
      li.dataset.value = opt.value;
      li.textContent = opt.textContent;
      li.addEventListener('click', () => choose(opt.value));
      list.appendChild(li);
    });
  }
  function setActive(i) {
    const opts = Array.from(list.querySelectorAll('.cdd-opt'));
    opts.forEach(o => o.classList.remove('active'));
    if (opts[i]) { opts[i].classList.add('active'); opts[i].scrollIntoView({ block: 'nearest' }); }
  }
  // overflow:hidden な祖先（詳細設定のguide-box等）にクリップされないよう position:fixed で配置し、
  // 下に入りきらなければ上に開く
  function positionList() {
    const r = btn.getBoundingClientRect();
    list.style.position = 'fixed';
    list.style.left = r.left + 'px';
    list.style.right = 'auto';
    list.style.width = r.width + 'px';
    list.style.maxHeight = '';
    const lh = list.offsetHeight;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    if (lh <= below || below >= above) {
      list.style.top = (r.bottom + 6) + 'px';
      list.style.maxHeight = Math.max(120, below) + 'px';
      list.style.transformOrigin = 'top center';
    } else {
      const h = Math.min(lh, above);
      list.style.top = (r.top - 6 - h) + 'px';
      list.style.maxHeight = Math.max(120, above) + 'px';
      list.style.transformOrigin = 'bottom center';
    }
  }
  function open() {
    if (cdd.classList.contains('open')) return;
    closeAllDropdowns(cdd);
    buildList();
    positionList();
    cdd.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    const opts = Array.from(list.querySelectorAll('.cdd-opt'));
    const si = opts.findIndex(o => o.classList.contains('selected'));
    setActive(si >= 0 ? si : 0);
    list.focus();
  }
  function close() {
    if (!cdd.classList.contains('open')) return;
    cdd.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  cdd._cddClose = close;
  function choose(value) {
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true })); // 既存のonchange等を発火
    }
    syncLabel();
    close();
    btn.focus();
  }
  function onKey(e) {
    const opts = Array.from(list.querySelectorAll('.cdd-opt'));
    const isOpen = cdd.classList.contains('open');
    if (!isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); open(); return;
    }
    if (!isOpen) return;
    let i = opts.findIndex(o => o.classList.contains('active'));
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(opts.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(opts.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (opts[i]) choose(opts[i].dataset.value); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
  }
  btn.addEventListener('click', () => { cdd.classList.contains('open') ? close() : open(); });
  btn.addEventListener('keydown', onKey);
  list.addEventListener('keydown', onKey);
  select.addEventListener('change', syncLabel); // 値が外部から変わってもラベル追従

  syncLabel();
}
function initCustomDropdowns() {
  document.querySelectorAll('select').forEach(enhanceSelect);
}
// 外側タップで閉じる／スクロール・リサイズで閉じる（リスト内スクロールは除外）
document.addEventListener('click', e => { if (!e.target.closest('.cdd')) closeAllDropdowns(null); });
window.addEventListener('scroll', e => {
  if (e.target && e.target.closest && e.target.closest('.cdd-list')) return;
  closeAllDropdowns(null);
}, true);
window.addEventListener('resize', () => closeAllDropdowns(null));

applyModeUI();
buildMathKeyboard(); // 回答用 数式キーボードのキーを生成
setupDetailsAnimation(); // 詳細設定・使い方の開閉をなめらかに
loadAiEqSetting();   // AI同値判定のON/OFF設定を復元
loadStrictSetting(); // 採点の厳密さ設定を復元
loadBetaSettings();  // β機能（自由描画／格子点グラフ）のON/OFF設定を復元
checkResume(); // 中断中のクイズがあれば再開バナーを表示
checkSRS();    // 苦手問題の復習バナーを表示
reconcileStalePools().then(refreshPoolUI); // 中断で作成中のまま残ったプールを正常化してから一覧・バナー表示
initCustomDropdowns(); // <select>をアニメ付きカスタムドロップダウンに置換（設定復元後に実行しラベルを同期）

// ─── ホーム画面に追加（アイコン） ─────────────────────────────
// インストール可能な環境（多くはhttps/localhost＋対応ブラウザ）では beforeinstallprompt を捕捉し、
// ボタンで即追加。そうでない環境（file:// 等）では手順案内ポップアップを出す。
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt = e; });
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; });

// 既にホーム画面アプリ（standalone）として開いているか
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

// 緑「A」アイコン（headのapple-touch-icon・install-modalと同じSVG）
const APP_ICON_SVG = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI0IiBmaWxsPSIjZmZmZmZmIi8+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMiw0KSIgZmlsbD0iIzBhN2QzYSI+PHBvbHlnb24gcG9pbnRzPSI1OCwyNCA3MCwyNCA1MCwxMDQgMzAsMTA0Ii8+PHBvbHlnb24gcG9pbnRzPSI1OCwyNCA3MCwyNCA5OCwxMDQgNzgsMTA0Ii8+PHJlY3QgeD0iNDkiIHk9Ijc0IiB3aWR0aD0iMzAiIGhlaWdodD0iMTMiLz48L2c+PGcgZmlsbD0iIzIyYzU2YiI+PHBvbHlnb24gcG9pbnRzPSI1OCwyNCA3MCwyNCA1MCwxMDQgMzAsMTA0Ii8+PHBvbHlnb24gcG9pbnRzPSI1OCwyNCA3MCwyNCA5OCwxMDQgNzgsMTA0Ii8+PHJlY3QgeD0iNDkiIHk9Ijc0IiB3aWR0aD0iMzAiIGhlaWdodD0iMTMiLz48L2c+PC9zdmc+';

// SVGアイコンを指定サイズのPNG(dataURL)へラスタライズ（iOSはSVGのapple-touch-iconを無視するためPNGが要る）
function rasterizeIcon(size) {
  return new Promise(resolve => {
    const im = new Image();
    im.onload = () => {
      try {
        const cv = document.createElement('canvas'); cv.width = cv.height = size;
        cv.getContext('2d').drawImage(im, 0, 0, size, size);
        resolve(cv.toDataURL('image/png'));
      } catch (e) { resolve(null); }
    };
    im.onerror = () => resolve(null);
    im.src = APP_ICON_SVG;
  });
}

// PWA: manifest と Apple用PNGアイコンを実行時に注入（単一HTMLファイルのまま同梱）。
// ローカル(file://, content://)では自動インストールは出ないが、手動「ホーム画面に追加」で
// 正しいアイコン・名前・全画面表示になり、将来 https 配信すればインストールも有効になる。
async function setupPwa() {
  try {
    const [png180, png192, png512] = await Promise.all([rasterizeIcon(180), rasterizeIcon(192), rasterizeIcon(512)]);
    if (png180) { const al = document.getElementById('apple-touch-icon'); if (al) al.href = png180; }
    const icons = [];
    if (png192) icons.push({ src: png192, sizes: '192x192', type: 'image/png', purpose: 'any' });
    if (png512) icons.push({ src: png512, sizes: '512x512', type: 'image/png', purpose: 'any' });
    icons.push({ src: APP_ICON_SVG, sizes: 'any', type: 'image/svg+xml' });
    const manifest = {
      name: 'AIQuiz - AI問題集メーカー',
      short_name: 'AIQuiz',
      start_url: location.href.split('#')[0],
      display: 'standalone',
      background_color: '#f5f6f8',
      theme_color: '#ffffff',
      lang: 'ja',
      icons
    };
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = URL.createObjectURL(blob);
    document.head.appendChild(link);
  } catch (e) { /* 失敗してもアプリ本体には影響しない */ }
}
setupPwa();

async function addToHomeScreen() {
  if (isStandalone()) {
    alert('すでにホーム画面のアプリとして開いています。');
    return;
  }
  if (deferredInstallPrompt) {
    try {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
    } catch (e) {}
    deferredInstallPrompt = null;
    return;
  }
  showInstallHint();
  const m = document.getElementById('install-modal');
  if (m) m.classList.add('show');
}

// 端末を推定して、該当する手順を案内文の先頭に出す（手動追加の迷子防止）
function showInstallHint() {
  const el = document.getElementById('install-hint');
  if (!el) return;
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const localFile = location.protocol === 'file:' || location.protocol === 'content:';
  let msg;
  if (isIOS) msg = 'お使いの端末は <b>iPhone / iPad</b> のようです。下の【iOS】の手順をご覧ください。';
  else if (isAndroid) msg = 'お使いの端末は <b>Android</b> のようです。下の【Android】の手順をご覧ください。';
  else msg = 'お使いの端末は <b>パソコン</b> のようです。下の【PC】の手順をご覧ください。';
  if (localFile) msg += '<br><span class="imp">※ ローカルファイルとして開いているため、ワンタップのインストールは出ません。</span>上記の手動手順、または付属の「起動」サーバ経由（http://localhost…）で開くと追加しやすくなります。';
  el.innerHTML = msg;
}
function closeInstallModal() {
  const m = document.getElementById('install-modal');
  if (m) m.classList.remove('show');
}

// ─── HEADER NAV (モバイルのハンバーガーメニュー) ──────────────────
function toggleHeaderMenu() {
  const nav = document.getElementById('header-nav');
  const btn = document.getElementById('hamburger-btn');
  if (!nav) return;
  const open = nav.classList.toggle('open');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function closeHeaderMenu() {
  const nav = document.getElementById('header-nav');
  const btn = document.getElementById('hamburger-btn');
  if (nav) nav.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
// メニュー項目を選んだら閉じる／メニューの外をタップしたら閉じる
document.addEventListener('click', function (e) {
  const nav = document.getElementById('header-nav');
  if (!nav || !nav.classList.contains('open')) return;
  if (e.target.closest('#header-nav .notice-link')) { closeHeaderMenu(); return; }
  if (!e.target.closest('#header-nav') && !e.target.closest('#hamburger-btn')) closeHeaderMenu();
});

// ─── モーダル表示中は背面（body）のスクロールをロック ──────────────────
// どのモーダルも .modal-overlay に .show を付け外しするので、その class 変化を監視して
// 開いているモーダルが1つでもあれば body をロックする（スマホで背景が動く対策）。
function syncBodyScrollLock() {
  document.body.classList.toggle('modal-open', !!document.querySelector('.modal-overlay.show'));
}
(function watchModalsForScrollLock() {
  const obs = new MutationObserver(syncBodyScrollLock);
  document.querySelectorAll('.modal-overlay').forEach(ov =>
    obs.observe(ov, { attributes: true, attributeFilter: ['class'] }));
})();

// ─── NOTICE / DISCLAIMER (利用上の注意・免責) ──────────────────
// firstRun=true: 初回起動。同意必須（同意して始めるまで閉じられない）
// firstRun=false: ヘッダーからの参照。いつでも閉じられる
function openNoticeModal(firstRun) {
  const m = document.getElementById('notice-modal');
  document.getElementById('notice-agree-row').style.display = firstRun ? 'flex' : 'none';
  document.getElementById('notice-agree-btn').style.display = firstRun ? 'inline-flex' : 'none';
  document.getElementById('notice-close-btn').style.display = firstRun ? 'none' : 'inline-flex';
  document.getElementById('notice-close-x').style.display = firstRun ? 'none' : 'inline-block';
  if (firstRun) {
    const chk = document.getElementById('notice-agree-check');
    chk.checked = false;
    document.getElementById('notice-agree-btn').disabled = true;
  }
  m.classList.add('show');
}

function agreeNotice() {
  try { localStorage.setItem('aiquiz_agreed', '1'); } catch {}
  document.getElementById('notice-modal').classList.remove('show');
}

function closeNoticeModal() {
  document.getElementById('notice-modal').classList.remove('show');
}

// 使い方・機能の説明モーダル
function openHelpModal() {
  document.getElementById('help-modal').classList.add('show');
}
function closeHelpModal() {
  document.getElementById('help-modal').classList.remove('show');
}

// 初回起動チェック：未同意なら同意必須モーダルを表示
(function initFirstRun() {
  let agreed = false;
  try { agreed = localStorage.getItem('aiquiz_agreed') === '1'; } catch {}
  if (!agreed) openNoticeModal(true);
})();
