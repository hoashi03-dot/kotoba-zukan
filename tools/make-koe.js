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
const VOICE = voiceArg >= 0 ? args[voiceArg + 1] : 'Grandma';
const RATE = 175; // 1分あたりの語数。小さいほどゆっくり

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

/* ── say で1語ずつ書き出す ───────────────────────────── */
function synthesize(phrases) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const voiceName = `${VOICE} (日本語（日本）)`;
  const files = {};
  let made = 0, skipped = 0;

  phrases.forEach((text, i) => {
    const name = 'w' + String(i + 1).padStart(3, '0') + '.m4a';
    files[text] = name;
    const file = path.join(OUT_DIR, name);
    if (!REBUILD_ALL && fs.existsSync(file)) { skipped++; return; }
    execFileSync('say', ['-v', voiceName, '-r', String(RATE), '--data-format=aac', '-o', file, text]);
    made++;
  });
  return { files, made, skipped };
}

const modes = loadData();
// 並び順を固定する。順番が変わると連番と中身がずれる
const phrases = collectPhrases(modes).sort();
const { files, made, skipped } = synthesize(phrases);

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
