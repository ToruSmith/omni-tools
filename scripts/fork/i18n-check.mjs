#!/usr/bin/env node
/**
 * Fork tooling: 檢查繁體中文 (zh-TW) 語系相對於英文 (en) 缺少哪些翻譯。
 *
 * 只使用 Node 內建模組、不執行任何來自上游的程式碼；上游內容只當作「資料」讀取。
 *
 * 用法：
 *   # 比對工作目錄中的 en 與 zh-TW（本機或 CI 皆可）
 *   node scripts/fork/i18n-check.mjs
 *
 *   # 英文來自某個 git revision（例如剛抓下來的上游），zh-TW 來自工作目錄
 *   node scripts/fork/i18n-check.mjs --ref-rev upstream/main
 *
 * 選項：
 *   --locales-dir <dir>   語系根目錄 (預設 public/locales)
 *   --ref <lang>          參考語言 (預設 en)
 *   --target <lang>       目標語言 (預設 zh-TW)
 *   --ref-rev <rev>       從 git revision 讀取參考語言，而不是工作目錄
 *   --max-rows <n>        報告中最多列出幾條缺少的字串 (預設 150)
 *   --out <file>          把 Markdown 報告寫到檔案 (預設輸出到 stdout)
 *   --fail-on-missing     有缺少的翻譯、或 {{變數}} 不一致時以非 0 結束
 *   --fail-on-invalid     只有 {{變數}} 不一致（會讓畫面出錯）時才以非 0 結束
 *
 * 規則：
 *   - 中文沒有單複數變化，因此英文的 *_one / *_zero / *_two / *_few / *_many 不要求翻譯，
 *     只要求 *_other。
 *   - 目標語言可以省略 {{plural}} 這類只為英文單複數而存在的變數。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const localesDir = opt('locales-dir', 'public/locales');
const refLang = opt('ref', 'en');
const targetLang = opt('target', 'zh-TW');
const refRev = opt('ref-rev', null);
const maxRows = Number(opt('max-rows', '150'));
const outFile = opt('out', null);

const PLURAL_SUFFIX = /_(zero|one|two|few|many)$/;
const DROPPABLE_PLACEHOLDERS = new Set(['plural']);
const PLACEHOLDER = /\{\{\s*([^}\s]+)\s*\}\}/g;

function git(...gitArgs) {
  // execFileSync + 參數陣列：不經過 shell，不會被奇怪的檔名影響
  return execFileSync('git', gitArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
}

function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, p, out);
    } else {
      out[p] = value;
    }
  }
  return out;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`無法解析 JSON：${label}（${e.message}）`);
  }
}

/** 讀取某語言的所有命名空間 -> { namespace: flatObject } */
function loadFromDisk(lang) {
  const dir = path.join(localesDir, lang);
  const result = {};
  if (!fs.existsSync(dir)) return result;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(dir, file);
    // 不跟隨符號連結，避免讀到預期之外的檔案
    if (fs.lstatSync(full).isSymbolicLink()) continue;
    result[file.slice(0, -5)] = flatten(
      parseJson(fs.readFileSync(full, 'utf8'), full)
    );
  }
  return result;
}

function loadFromRev(rev, lang) {
  const dir = `${localesDir}/${lang}`;
  const result = {};
  let listing = '';
  try {
    listing = git('ls-tree', '-r', '--name-only', rev, '--', dir);
  } catch {
    return result;
  }
  for (const file of listing.split('\n').filter(Boolean)) {
    if (!file.endsWith('.json')) continue;
    const ns = path.posix.basename(file, '.json');
    result[ns] = flatten(parseJson(git('show', `${rev}:${file}`), `${rev}:${file}`));
  }
  return result;
}

const placeholders = (value) =>
  new Set(
    [...String(value).matchAll(PLACEHOLDER)]
      .map((m) => m[1])
      .filter((p) => !DROPPABLE_PLACEHOLDERS.has(p))
  );

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

const ref = refRev ? loadFromRev(refRev, refLang) : loadFromDisk(refLang);
const target = loadFromDisk(targetLang);

if (Object.keys(ref).length === 0) {
  console.error(
    `找不到參考語言 ${refLang} 的語系檔（${refRev ? `revision ${refRev}` : localesDir}）`
  );
  process.exit(2);
}

const missing = []; // { ns, key, en }
const badPlaceholders = []; // { ns, key, en, tw }
const orphans = []; // { ns, key }
const missingFiles = []; // namespace 名稱
let refTotal = 0;

for (const [ns, refFlat] of Object.entries(ref)) {
  const targetFlat = target[ns];
  if (!targetFlat) missingFiles.push(ns);
  for (const [key, enValue] of Object.entries(refFlat)) {
    const leaf = key.split('.').pop();
    if (PLURAL_SUFFIX.test(leaf)) continue;
    refTotal += 1;
    const twValue = targetFlat?.[key];
    if (twValue === undefined || String(twValue).trim() === '') {
      missing.push({ ns, key, en: String(enValue) });
      continue;
    }
    if (!sameSet(placeholders(enValue), placeholders(twValue))) {
      badPlaceholders.push({
        ns,
        key,
        en: String(enValue),
        tw: String(twValue)
      });
    }
  }
}

for (const [ns, targetFlat] of Object.entries(target)) {
  const refFlat = ref[ns];
  for (const key of Object.keys(targetFlat)) {
    const leaf = key.split('.').pop();
    if (PLURAL_SUFFIX.test(leaf)) continue;
    if (!refFlat || !(key in refFlat)) orphans.push({ ns, key });
  }
}

const translated = refTotal - missing.length;
const pct = refTotal === 0 ? 100 : Math.round((translated / refTotal) * 1000) / 10;

const cell = (s) =>
  String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 140);

const lines = [];
lines.push(`### 🈶 繁體中文（${targetLang}）翻譯檢查`);
lines.push('');
lines.push(
  `完成度：**${pct}%**（${translated} / ${refTotal} 條）` +
    (refRev ? `　｜　英文來源：\`${refRev}\`` : '')
);
lines.push('');

if (missing.length === 0 && badPlaceholders.length === 0) {
  lines.push('✅ 沒有缺少的翻譯，也沒有變數不一致的字串。');
} else {
  lines.push(
    '> 沒翻的字串不會讓網站壞掉：i18next 會自動改顯示英文。補上翻譯後畫面才會變成中文。'
  );
}

if (missingFiles.length) {
  lines.push('');
  lines.push(
    `**整個檔案尚未翻譯**：${missingFiles
      .map((n) => `\`${localesDir}/${targetLang}/${n}.json\``)
      .join('、')}`
  );
}

if (missing.length) {
  const perNs = new Map();
  for (const m of missing) perNs.set(m.ns, (perNs.get(m.ns) ?? 0) + 1);
  lines.push('');
  lines.push(`**缺少 ${missing.length} 條翻譯**`);
  lines.push('');
  lines.push(
    [...perNs.entries()].map(([ns, n]) => `\`${ns}\` ${n} 條`).join('、')
  );
  lines.push('');
  lines.push('<details><summary>展開查看（檔案 / 鍵 / 英文原文）</summary>');
  lines.push('');
  lines.push('| 檔案 | 鍵 | 英文 |');
  lines.push('|---|---|---|');
  for (const m of missing.slice(0, maxRows)) {
    lines.push(`| \`${m.ns}.json\` | \`${m.key}\` | ${cell(m.en)} |`);
  }
  if (missing.length > maxRows) {
    lines.push('');
    lines.push(
      `…另外還有 ${missing.length - maxRows} 條未列出，請在本機或網頁編輯器執行 \`node scripts/fork/i18n-check.mjs\` 查看完整清單。`
    );
  }
  lines.push('');
  lines.push('</details>');
}

if (badPlaceholders.length) {
  lines.push('');
  lines.push(
    `**⚠️ ${badPlaceholders.length} 條翻譯的 \`{{變數}}\` 與英文不一致**（可能造成畫面顯示錯誤）`
  );
  lines.push('');
  lines.push('| 檔案 | 鍵 | 英文 | 繁中 |');
  lines.push('|---|---|---|---|');
  for (const b of badPlaceholders.slice(0, 50)) {
    lines.push(
      `| \`${b.ns}.json\` | \`${b.key}\` | ${cell(b.en)} | ${cell(b.tw)} |`
    );
  }
}

if (orphans.length) {
  lines.push('');
  lines.push(
    `<details><summary>ℹ️ ${orphans.length} 條繁中翻譯在英文中已不存在（上游可能改名或移除，可自行清理）</summary>`
  );
  lines.push('');
  for (const o of orphans.slice(0, 100)) lines.push(`- \`${o.ns}.json\` → \`${o.key}\``);
  if (orphans.length > 100) lines.push(`- …另有 ${orphans.length - 100} 條`);
  lines.push('');
  lines.push('</details>');
}

const report = lines.join('\n') + '\n';
if (outFile) fs.writeFileSync(outFile, report);
else process.stdout.write(report);

// 供 workflow 讀取的摘要（GITHUB_OUTPUT）
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `i18n_missing=${missing.length}\ni18n_bad_placeholders=${badPlaceholders.length}\ni18n_percent=${pct}\n`
  );
}

if (flag('fail-on-missing') && (missing.length || badPlaceholders.length)) {
  process.exit(1);
}
if (flag('fail-on-invalid') && badPlaceholders.length) {
  process.exit(1);
}
