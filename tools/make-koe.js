#!/usr/bin/env node
/*
  読み上げ音声を事前に作るスクリプト（macOS 専用。say コマンドを使う）

    node tools/make-koe.js            … 足りないものだけ作る
    node tools/make-koe.js --all      … 全部作り直す
    node tools/make-koe.js --voice Flo  … 声を変えて作り直す

  単語は index.html の DATA START〜DATA END から読む。語を足せば音声も増える。
  ファイル名は連番の ASCII にして、読み上げ文字列との対応は koe/index.json に持つ。
  日本語のファイル名は、URLのデコードや Unicode 正規化（NFC/NFD）で
  取り違えが起きるため使わない。
*/

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'koe');
const MANIFEST = path.join(OUT_DIR, 'index.json');

const args = process.argv.slice(2);
const REBUILD_ALL = args.includes('--all');
const voiceArg = args.indexOf('--voice');
// 既定は Kyoko（9声を聞き比べて選んだ声）。変えたいときだけ --voice を渡す
const VOICE = voiceArg >= 0 ? args[voiceArg + 1] : 'Kyoko';
const RATE = 175; // 1分あたりの語数。小さいほどゆっくり

/* say は知らない声名を渡してもエラーを返さず、既定の声で作ってしまう。
   つまり --voice のtypoは「104件を別の声で作り直して成功と表示」になる。
   最後の引数に --voice を置いて値が無い場合も同じ。ここで止める。 */
function checkVoice() {
  if (!VOICE) {
    console.error('--voice の後に声の名前がありません');
    process.exit(1);
  }
  const list = execFileSync('say', ['-v', '?'], { encoding: 'utf8' });
  const names = list.split('\n').map(line => line.trim().split(/\s{2,}|\s+#/)[0]);
  if (!names.some(n => n === VOICE || n.startsWith(VOICE + ' '))) {
    console.error(`「${VOICE}」という声はこの Mac にありません。`);
    console.error('say -v "?" で一覧を確認してください。');
    process.exit(1);
  }
}

/* ── index.html から単語データを取り出す ────────────────── */
function loadData() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // 区切りコメントの終わり（*/）までを読み飛ばしてから中身を取る
  const m = html.match(/\/\* === DATA START ===[\s\S]*?\*\/\s*([\s\S]*?)\/\* === DATA END === \*\//);
  if (!m) throw new Error('index.html に DATA START/END の区切りが見つかりません');
  // 評価するのは同じリポジトリの自分のデータ定義だけ。ビルド時にしか動かさない。
  // 外部から受け取った文字列をここに渡さないこと。
  return new Function(m[1] + '\nreturn { MODES };')().MODES;
}

/* ── 読み上げる文字列を全部集める ──────────────────────── */
function collectPhrases(modes) {
  const set = new Set();
  for (const mode of modes) {
    if (mode.name) set.add(mode.name);
    for (const group of mode.groups) {
      const tab = group.tabSpeech || group.tabName;
      if (tab) set.add(tab);
      for (const item of group.items) {
        const text = item.s || item.n;
        if (text) set.add(text);
      }
    }
  }
  return [...set];
}

/* ── 前回の対応表を読む（無ければ空）────────────────── */
function loadPrevious() {
  try {
    const prev = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const byName = {}; // ファイル名 → 前回そこに入れた読み上げ文字列
    for (const [text, name] of Object.entries(prev.files || {})) byName[name] = text;
    return { voice: prev.voice, rate: prev.rate, byName };
  } catch {
    return { voice: null, rate: null, byName: {} };
  }
}

/* ── say で1語ずつ書き出す ───────────────────────────── */
function synthesize(phrases, prev) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const voiceName = `${VOICE} (日本語（日本）)`;
  const files = {};
  let made = 0, skipped = 0;

  // 声や速さを変えたら全部作り直す（一部だけ違う状態は耳で気づきにくい）
  const forceAll = REBUILD_ALL || prev.voice !== VOICE || prev.rate !== RATE;

  phrases.forEach((text, i) => {
    const name = 'w' + String(i + 1).padStart(3, '0') + '.m4a';
    files[text] = name;
    const file = path.join(OUT_DIR, name);
    // 名前は並び順で決まるので、語を足すと番号が1つずつずれる。
    // 前回その名前に入れた文字列と違うなら、中身が食い違うので作り直す。
    // これを見落とすと、絵と音が入れ替わったまま誰も気づけない。
    const sameAsBefore = prev.byName[name] === text;
    // 空や途中で切れたファイルは、あるだけでは信用しない。
    // existsSync だけで見ると、壊れたまま永久にスキップされ続ける
    const usable = fs.existsSync(file) && fs.statSync(file).size > 1000;
    if (!forceAll && sameAsBefore && usable) { skipped++; return; }
    execFileSync('say', ['-v', voiceName, '-r', String(RATE), '--data-format=aac', '-o', file, text]);
    made++;
  });
  return { files, made, skipped };
}

checkVoice();

const modes = loadData();
// 並び順を固定する。順番が変わると連番と中身がずれる
const phrases = collectPhrases(modes).sort();
const prev = loadPrevious();

/* 対応表を先に消しておく。say が途中で失敗すると例外で即死し、
   末尾の書き出しに到達しない。そのとき対応表を残したままだと、
   「ディスクは新しい割り当て・対応表は古い割り当て」で食い違い、
   絵と音が入れ替わる。しかも git の差分には m4a しか出ないので気づけない。
   消しておけば、失敗時はアプリが全語を合成音声に落とすだけで済み（無音にはならない）、
   次に実行すれば prev が空になるので全件作り直して直る。 */
try { fs.rmSync(MANIFEST); } catch { /* 無ければよい */ }

const { files, made, skipped } = synthesize(phrases, prev);

// 前回の生成物のうち、今回使われないものを消す（語を減らしたとき用）
const keep = new Set(Object.values(files));
for (const f of fs.readdirSync(OUT_DIR)) {
  if (/^w\d+\.m4a$/.test(f) && !keep.has(f)) fs.unlinkSync(path.join(OUT_DIR, f));
}

fs.writeFileSync(MANIFEST, JSON.stringify({
  voice: VOICE,
  rate: RATE,
  updated: new Date().toISOString().slice(0, 10),
  files,
}, null, 1));

console.log(`声: ${VOICE}（速さ ${RATE}）`);
console.log(`読み上げ文字列: ${phrases.length}件（新規 ${made} / 既存 ${skipped}）`);
console.log(`出力: ${path.relative(ROOT, OUT_DIR)}/`);
