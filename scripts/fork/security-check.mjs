#!/usr/bin/env node
/**
 * Fork tooling: 同步上游之前的「安全檢查」。
 *
 * 比較兩個 git revision（base = 你目前已合併的上游版本，head = 剛抓下來的上游），
 * 只看「這次上游帶進來了什麼」，並把結果整理成 Markdown 報告。
 *
 * 設計原則：
 *   - 上游的內容一律當作「資料」，用 `git show` / `git diff` 讀取，
 *     絕不 checkout 後執行、也不 npm install（所以不會觸發任何安裝腳本）。
 *   - 只用 Node 內建模組；呼叫 git / npm 時使用參數陣列，不經過 shell。
 *   - 這是「降低風險的輔助工具」，不是保證。最後仍請人工看過報告中標示的項目。
 *
 * 用法：
 *   node scripts/fork/security-check.mjs --base <rev> --head <rev> [--out report.md] [--skip-audit]
 *
 * 輸出（若有 GITHUB_OUTPUT）：risk=HIGH|MEDIUM|LOW、workflow_changed=true|false、changed_files=<n>
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const base = opt('base');
const head = opt('head');
const outFile = opt('out');
const skipAudit = args.includes('--skip-audit');

if (!base || !head) {
  console.error('用法：security-check.mjs --base <rev> --head <rev> [--out file] [--skip-audit]');
  process.exit(2);
}

const git = (...a) =>
  execFileSync('git', a, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const gitOrNull = (...a) => {
  try {
    return git(...a);
  } catch {
    return null;
  }
};
const showAt = (rev, file) => gitOrNull('show', `${rev}:${file}`);
const jsonAt = (rev, file) => {
  const text = showAt(rev, file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // 存在但無法解析
  }
};
const short = (rev) => git('rev-parse', '--short=9', rev).trim();

// ---------------------------------------------------------------------------
// 收集結果
// ---------------------------------------------------------------------------
/** @type {{level:'high'|'medium', title:string, lines:string[], diff?:string}[]} */
const findings = [];
const add = (level, title, lines = [], diff) =>
  findings.push({ level, title, lines, diff });

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

// ---------------------------------------------------------------------------
// 1. 變動檔案
// ---------------------------------------------------------------------------
function parseNameStatus() {
  const raw = git('diff', '--name-status', '-z', '--no-renames', base, head);
  const tok = raw.split('\0').filter((t) => t !== '');
  const files = [];
  for (let i = 0; i + 1 < tok.length; i += 2) {
    files.push({ status: tok[i][0], path: tok[i + 1] });
  }
  return files;
}

const files = parseNameStatus();
const byPath = new Map(files.map((f) => [f.path, f.status]));
const numstat = git('diff', '--numstat', '--no-renames', base, head)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [a, d, ...p] = l.split('\t');
    return { add: a === '-' ? null : +a, del: d === '-' ? null : +d, path: p.join('\t') };
  });
const totalAdd = numstat.reduce((s, n) => s + (n.add ?? 0), 0);
const totalDel = numstat.reduce((s, n) => s + (n.del ?? 0), 0);

// ---------------------------------------------------------------------------
// 2. GitHub Actions / 專案設定檔
// ---------------------------------------------------------------------------
const workflowFiles = files.filter((f) => /^\.github\/(workflows|actions)\//.test(f.path));
const workflowChanged = workflowFiles.length > 0;
if (workflowChanged) {
  const diff = git('diff', '--no-color', '--no-renames', base, head, '--', '.github/workflows', '.github/actions');
  add(
    'high',
    'GitHub Actions 設定被修改（.github/workflows、.github/actions）',
    [
      ...workflowFiles.map((f) => `- ${statusLabel(f.status)} ${code(f.path)}`),
      '',
      'Workflow 可以在你的倉庫裡執行任意指令，並讀取你設定的 secrets。**請務必看過下面的 diff 再合併。**'
    ],
    diff
  );
}

function statusLabel(s) {
  return { A: '新增', M: '修改', D: '刪除', T: '類型變更' }[s] ?? s;
}

// 在 workflow 新增的行中，找出「第三方 Action 沒有固定到 commit SHA」的用法。
// 標籤（例如 @v4）可以被作者事後改指到別的程式碼，曾發生過實際的供應鏈攻擊。
if (workflowChanged) {
  const wfDiff = git('diff', '--no-color', '--no-renames', '-U0', base, head, '--', '.github/workflows', '.github/actions');
  const unpinned = new Set();
  for (const line of wfDiff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const m = /uses:\s*['"]?([\w.-]+\/[\w./-]+)@([^\s'"#]+)/.exec(line);
    if (!m) continue;
    const [, action, ref] = m;
    if (/^[0-9a-f]{40}$/i.test(ref)) continue; // 已固定到 SHA
    if (/^(actions|github)\//.test(action)) continue; // GitHub 官方 Action 風險較低
    unpinned.add(`${action}@${ref}`);
  }
  if (unpinned.size) {
    add('medium', 'Workflow 新增了未固定到 commit SHA 的第三方 Action', [
      ...[...unpinned].slice(0, 20).map((u) => `- ${code(u)}`),
      '',
      '建議改成固定 commit SHA（例如 `owner/repo@<40 位 SHA>`），避免作者事後替換標籤內容。'
    ]);
  }
}

const SENSITIVE = [
  [/^Dockerfile/, 'Docker 建置'],
  [/^\.dockerignore$/, 'Docker 建置'],
  [/^vite\.config\./, 'Vite 建置設定'],
  [/^index\.html$/, '入口頁面（可能載入外部腳本）'],
  [/^\.husky\//, 'Git hooks'],
  [/^\.npmrc$/, 'npm 設定'],
  [/^\.env/, '環境變數'],
  [/^netlify\.toml$/, 'Netlify 部署'],
  [/^CODEOWNERS$/, '程式碼擁有者'],
  [/^\.github\/(dependabot|CODEOWNERS)/, 'GitHub 設定'],
  [/^scripts\//, '專案腳本（可能在你本機或 CI 執行）']
];
const sensitiveHits = files
  .filter((f) => !workflowFiles.includes(f))
  .map((f) => {
    const hit = SENSITIVE.find(([re]) => re.test(f.path));
    return hit ? `- ${statusLabel(f.status)} ${code(f.path)}：${hit[1]}` : null;
  })
  .filter(Boolean);
if (sensitiveHits.length) {
  add('medium', '敏感的設定／建置檔案有變動', sensitiveHits);
}

// ---------------------------------------------------------------------------
// 3. package.json：依賴與腳本
// ---------------------------------------------------------------------------
const NON_REGISTRY_SPEC = /^(git\+|git:|github:|gitlab:|bitbucket:|https?:|file:|link:|ssh:|npm:|[\w.-]+\/[\w.-]+(#.*)?$)/;
const LIFECYCLE = new Set([
  'preinstall', 'install', 'postinstall', 'prepublish', 'prepublishOnly',
  'prepare', 'preprepare', 'postprepare', 'prepack', 'postpack', 'dependencies'
]);
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions'];

function comparePackageJson() {
  const a = jsonAt(base, 'package.json');
  const b = jsonAt(head, 'package.json');
  if (b === undefined) {
    add('medium', 'package.json 在上游無法解析為 JSON', []);
    return;
  }
  if (!b || !a) return;

  const depLines = [];
  const badSpecs = [];
  for (const section of DEP_SECTIONS) {
    const oa = a[section] ?? {};
    const ob = b[section] ?? {};
    for (const name of new Set([...Object.keys(oa), ...Object.keys(ob)])) {
      const va = oa[name] === undefined ? undefined : JSON.stringify(oa[name]);
      const vb = ob[name] === undefined ? undefined : JSON.stringify(ob[name]);
      if (va === vb) continue;
      const label = `${code(name)}（${section}）`;
      if (va === undefined) depLines.push(`- ➕ 新增 ${label} ${code(vb)}`);
      else if (vb === undefined) depLines.push(`- ➖ 移除 ${label}`);
      else depLines.push(`- 🔄 ${label} ${code(va)} → ${code(vb)}`);
      if (typeof ob[name] === 'string' && NON_REGISTRY_SPEC.test(ob[name])) {
        badSpecs.push(`- ${label} 指向非 npm registry 來源：${code(ob[name])}`);
      }
    }
  }
  if (badSpecs.length) {
    add('high', '依賴指向 git／網址／本機路徑（不是 npm registry 的正式版本）', [
      ...badSpecs,
      '',
      '這類依賴不受 registry 的版本與完整性機制保護，是常見的供應鏈攻擊手法。'
    ]);
  }
  if (depLines.length) {
    add('medium', `package.json 依賴有變動（${depLines.length} 項）`, depLines.slice(0, 80));
  }

  // 腳本
  const sa = a.scripts ?? {};
  const sb = b.scripts ?? {};
  const lifecycle = [];
  const otherScripts = [];
  for (const name of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    if (sa[name] === sb[name]) continue;
    const line = `- ${code(name)}：${sa[name] === undefined ? '（無）' : code(clip(sa[name]))} → ${sb[name] === undefined ? '（移除）' : code(clip(sb[name]))}`;
    (LIFECYCLE.has(name) ? lifecycle : otherScripts).push(line);
  }
  if (lifecycle.length) {
    add('high', '安裝／生命週期腳本被改動（npm install 時會自動執行）', lifecycle);
  }
  if (otherScripts.length) {
    add('medium', 'package.json 的 scripts 有變動', otherScripts);
  }
  for (const k of ['bin', 'main', 'type', 'engines', 'packageManager', 'husky', 'lint-staged']) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      add('medium', `package.json 的 ${code(k)} 欄位有變動`, [
        `- ${code(clip(JSON.stringify(a[k]) ?? '（無）'))} → ${code(clip(JSON.stringify(b[k]) ?? '（無）'))}`
      ]);
    }
  }
}
comparePackageJson();

// ---------------------------------------------------------------------------
// 4. package-lock.json：實際會裝進來的套件
// ---------------------------------------------------------------------------
let lockChanged = false;
function compareLock() {
  const a = jsonAt(base, 'package-lock.json');
  const b = jsonAt(head, 'package-lock.json');
  if (!b || !a) return;
  lockChanged = JSON.stringify(a) !== JSON.stringify(b);
  if (!lockChanged) return;
  if (!a.packages || !b.packages) {
    add('medium', 'package-lock.json 版本過舊（lockfileVersion 1），無法逐項分析', []);
    return;
  }
  const nameOf = (k) => k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const added = [];
  const changed = [];
  const nonRegistry = [];
  const newInstallScripts = [];
  const noIntegrity = [];
  for (const [k, v] of Object.entries(b.packages)) {
    if (!k) continue; // 根專案
    const old = a.packages[k];
    if (old && old.version === v.version && old.resolved === v.resolved) continue;
    (old ? changed : added).push(`${nameOf(k)}@${v.version}`);
    if (v.link) continue;
    if (v.resolved && !v.resolved.startsWith('https://registry.npmjs.org/')) {
      nonRegistry.push(`- ${code(`${nameOf(k)}@${v.version}`)} ← ${code(clip(v.resolved))}`);
    }
    if (v.resolved && !v.integrity) {
      noIntegrity.push(`- ${code(`${nameOf(k)}@${v.version}`)}`);
    }
    if (v.hasInstallScript && !(old && old.hasInstallScript)) {
      newInstallScripts.push(`- ${code(`${nameOf(k)}@${v.version}`)}${old ? '（升級後才出現安裝腳本）' : '（新套件）'}`);
    }
  }
  const removed = Object.keys(a.packages).filter((k) => k && !b.packages[k]).length;

  const summary = [
    `- 新增 ${added.length} 個、版本變動 ${changed.length} 個、移除 ${removed} 個套件`,
    ...added.slice(0, 25).map((s) => `  - ➕ ${code(s)}`),
    ...(added.length > 25 ? [`  - …另有 ${added.length - 25} 個新增套件`] : [])
  ];
  add('medium', 'package-lock.json 有變動（實際安裝內容）', summary);
  if (nonRegistry.length) {
    add('high', '鎖定檔中有套件不是從 npm registry 下載', nonRegistry.slice(0, 40));
  }
  if (newInstallScripts.length) {
    add('medium', '有套件帶有安裝腳本（npm install 時會執行）', [
      ...newInstallScripts.slice(0, 40),
      '',
      '部分正常套件（例如 esbuild）也有安裝腳本；請確認套件名稱你認得，沒有拼字相近的可疑名稱。'
    ]);
  }
  if (noIntegrity.length) {
    add('medium', '鎖定檔中有套件缺少完整性雜湊（integrity）', noIntegrity.slice(0, 40));
  }
}
compareLock();

// ---------------------------------------------------------------------------
// 5. 逐行掃描「新增的程式碼」
// ---------------------------------------------------------------------------
const SKIP_SCAN = (p) =>
  /^public\/locales\//.test(p) || p === 'package-lock.json' || /\.(png|jpe?g|gif|ico|webp|svg|woff2?|ttf|otf|eot|mp3|mp4|wav|pdf|zip)$/i.test(p);
const IS_CODE = (p) => /\.(m?[jt]sx?|cjs|html?|sh|bash|ya?ml|toml)$|(^|\/)Dockerfile/.test(p);

const CODE_PATTERNS = [
  { level: 'high', re: /\beval\s*\(/, label: '動態執行程式碼（eval）' },
  { level: 'high', re: /new\s+Function\s*\(/, label: '動態建立函式（new Function）' },
  { level: 'high', re: /(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b/, label: '下載後直接用 shell 執行（curl | sh）' },
  { level: 'high', re: /<script[^>]+src\s*=\s*["']https?:\/\//i, label: '載入外部 <script>' },
  // (?<![.\w]) 排除 ffmpeg.exec( 、regex.exec( 這類「物件的方法」，只抓獨立呼叫與 child_process
  { level: 'medium', re: /\bchild_process\b|(?<![.\w])(exec|execSync|spawn|spawnSync|execFile)\s*\(/, label: '執行系統指令' },
  { level: 'medium', re: /navigator\.sendBeacon|new\s+WebSocket\s*\(|new\s+XMLHttpRequest|\bfetch\s*\(\s*[`'"]https?:\/\//, label: '對外部網址發出網路請求' },
  { level: 'medium', re: /dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\s*\(/, label: '直接寫入 HTML（XSS 風險）' },
  { level: 'medium', re: /[A-Za-z0-9+/]{300,}={0,2}/, label: '很長的 base64 類字串（可能是夾帶的內容）' },
  { level: 'medium', re: /(\\x[0-9a-f]{2}){20,}|(\\u[0-9a-f]{4}){20,}/i, label: '大量跳脫字元（可能是混淆過的程式碼）' }
];

const SECRET_PATTERNS = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: '私鑰' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/, label: 'GitHub Token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: 'Slack Token' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: 'Google API Key' },
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/, label: 'API Key（sk-…）' },
  { re: /(?:secret|token|passwd|password|api[_-]?key|auth)[A-Za-z_]*["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i, label: '看起來像寫死的密碼／金鑰', medium: true }
];

const ALLOWED_HOSTS = new Set([
  'github.com', 'www.github.com', 'w3.org', 'www.w3.org', 'schema.org', 'react.dev', 'reactjs.org',
  'mui.com', 'npmjs.com', 'www.npmjs.com', 'developer.mozilla.org', 'creativecommons.org',
  'wikipedia.org', 'en.wikipedia.org', 'stackoverflow.com', 'example.com', 'example.org',
  'omnitools.app', 'ko-fi.com', 'buymeacoffee.com', 'www.buymeacoffee.com', 'locize.com', 'www.locize.com'
]);
const HOST_RE = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?/gi;

function scanDiff() {
  const exclude = [':(exclude)package-lock.json', ':(exclude)public/locales'];
  const diff = git('diff', '--no-color', '--no-renames', '-U0', base, head, '--', '.', ...exclude);
  const hits = new Map(); // key -> {level,label,items[]}
  const secretHits = [];
  const hostsAdded = new Map();
  const hostsRemoved = new Set();
  let file = null;
  let newLine = 0;
  let skip = true;
  let isCode = false;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.startsWith('+++ b/') ? raw.slice(6) : null;
      skip = !file || SKIP_SCAN(file);
      isCode = !!file && IS_CODE(file);
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file')) {
      if (raw.startsWith('diff --git')) { skip = true; isCode = false; }
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (skip) continue;
    if (raw.startsWith('-')) {
      if (isCode) for (const m of raw.slice(1, 5000).matchAll(HOST_RE)) hostsRemoved.add(m[1].toLowerCase());
      continue;
    }
    if (!raw.startsWith('+')) continue;
    const line = raw.slice(1, 5000);
    const where = `${file}:${newLine}`;
    newLine += 1;

    for (const p of SECRET_PATTERNS) {
      const m = p.re.exec(line);
      if (m) secretHits.push({ where, label: p.label, medium: !!p.medium, sample: `${m[0].slice(0, 6)}…（已遮蔽）` });
    }
    if (!isCode) continue;
    for (const p of CODE_PATTERNS) {
      if (p.re.test(line)) {
        const e = hits.get(p.label) ?? { level: p.level, label: p.label, items: [] };
        e.items.push(`- ${code(where)}　${code(clip(line.trim(), 110))}`);
        hits.set(p.label, e);
      }
    }
    for (const m of line.matchAll(HOST_RE)) {
      const host = m[1].toLowerCase();
      if (!hostsAdded.has(host)) hostsAdded.set(host, where);
    }
  }

  for (const e of hits.values()) {
    add(e.level, `新增的程式碼含有：${e.label}（${e.items.length} 處）`, e.items.slice(0, 15).concat(e.items.length > 15 ? [`- …另有 ${e.items.length - 15} 處`] : []));
  }
  const highSecrets = secretHits.filter((s) => !s.medium);
  const medSecrets = secretHits.filter((s) => s.medium);
  if (highSecrets.length) {
    add('high', `疑似洩漏密鑰／金鑰（${highSecrets.length} 處）`, highSecrets.slice(0, 20).map((s) => `- ${code(s.where)}：${s.label} ${code(s.sample)}`));
  }
  if (medSecrets.length) {
    add('medium', `可能是寫死的密碼／金鑰（${medSecrets.length} 處，可能只是測試資料）`, medSecrets.slice(0, 20).map((s) => `- ${code(s.where)}：${s.label}`));
  }
  const newHosts = [...hostsAdded.entries()].filter(([h]) => !ALLOWED_HOSTS.has(h) && !hostsRemoved.has(h));
  if (newHosts.length) {
    add('medium', `新增了對外部網站的引用（${newHosts.length} 個網域）`, [
      ...newHosts.slice(0, 30).map(([h, w]) => `- ${code(h)}　首次出現在 ${code(w)}`),
      '',
      'OmniTools 的賣點是資料只在瀏覽器本機處理。請確認這些網域不會收到使用者的檔案或輸入內容。'
    ]);
  }
}
scanDiff();

// 新增的執行檔／二進位
const RISKY_EXT = /\.(exe|dll|so|dylib|bin|jar|apk|msi|bat|cmd|ps1|node|com|scr)$/i;
const binaryAdds = numstat.filter((n) => n.add === null && byPath.get(n.path) === 'A');
const riskyAdds = files.filter((f) => f.status === 'A' && (RISKY_EXT.test(f.path) || /\.(sh|bash)$/i.test(f.path)));
if (riskyAdds.length) {
  add('high', '新增了可執行檔／腳本檔', riskyAdds.slice(0, 30).map((f) => `- ${code(f.path)}`));
}
const wasmOrBinary = binaryAdds.filter((n) => !riskyAdds.some((r) => r.path === n.path) && !/\.(png|jpe?g|gif|ico|webp|svg|woff2?|ttf|otf|mp3|mp4|wav|pdf)$/i.test(n.path));
if (wasmOrBinary.length) {
  add('medium', '新增了其他二進位檔案', wasmOrBinary.slice(0, 30).map((n) => {
    const size = gitOrNull('cat-file', '-s', `${head}:${n.path}`);
    return `- ${code(n.path)}${size ? `（${Math.round(+size / 1024)} KB）` : ''}`;
  }));
}

// ---------------------------------------------------------------------------
// 6. npm audit（只讀鎖定檔，不安裝任何東西）
// ---------------------------------------------------------------------------
let auditNote = '';
function runAudit(rev) {
  const pkg = showAt(rev, 'package.json');
  const lock = showAt(rev, 'package-lock.json');
  if (!pkg || !lock) throw new Error('缺少 package.json 或 package-lock.json');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-audit-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), pkg);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), lock);
    let out;
    try {
      out = execFileSync('npm', ['audit', '--json', '--package-lock-only', '--ignore-scripts'], {
        cwd: dir, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      out = e.stdout; // npm audit 發現漏洞時會以非 0 結束，但 stdout 仍有結果
      if (!out) throw e;
    }
    const parsed = JSON.parse(out);
    // 連不上 registry 等錯誤時，npm 也會輸出 JSON（內容是 error），
    // 必須明確當成失敗，否則會被誤判成「0 個漏洞」。
    if (parsed.error || !parsed.metadata?.vulnerabilities) {
      throw new Error(parsed.error?.summary || parsed.error?.code || 'npm audit 沒有回傳有效結果');
    }
    return parsed;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const advisories = (audit) => {
  const map = new Map();
  for (const [name, v] of Object.entries(audit.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via === 'object' && via.source) {
        map.set(String(via.source), { id: via.source, pkg: via.name ?? name, severity: via.severity, title: via.title, url: via.url });
      }
    }
  }
  return map;
};

if (!skipAudit && lockChanged) {
  try {
    const before = runAudit(base);
    const after = runAudit(head);
    const prev = advisories(before);
    const fresh = [...advisories(after).values()].filter((a) => !prev.has(String(a.id)));
    const m = after.metadata?.vulnerabilities ?? {};
    auditNote = `目前上游鎖定檔的已知漏洞：嚴重 ${m.critical ?? 0}、高 ${m.high ?? 0}、中 ${m.moderate ?? 0}、低 ${m.low ?? 0}（合計 ${m.total ?? 0}）；本次更新**新增**的漏洞公告：${fresh.length} 筆。`;
    if (fresh.length) {
      const serious = fresh.some((a) => a.severity === 'high' || a.severity === 'critical');
      add(serious ? 'high' : 'medium', `npm audit：本次更新新增 ${fresh.length} 筆漏洞公告`,
        fresh.slice(0, 25).map((a) => `- **${a.severity}** ${code(a.pkg)}：${clip(a.title ?? '', 100)} ${a.url ? `（${a.url}）` : ''}`));
    }
  } catch (e) {
    auditNote = `npm audit 已略過：${clip(String(e.message).split('\n')[0], 120)}`;
  }
} else if (!skipAudit) {
  auditNote = '鎖定檔（package-lock.json）沒有變動，略過 npm audit。';
}

// ---------------------------------------------------------------------------
// 7. 組成報告
// ---------------------------------------------------------------------------
const high = findings.filter((f) => f.level === 'high');
const medium = findings.filter((f) => f.level === 'medium');
const risk = high.length ? 'HIGH' : medium.length ? 'MEDIUM' : 'LOW';
const badge = { HIGH: '🔴 高', MEDIUM: '🟡 中', LOW: '🟢 低' }[risk];

const authors = git('log', '--format=%an', `${base}..${head}`).split('\n').filter(Boolean);
const authorCount = new Map();
for (const a of authors) authorCount.set(a, (authorCount.get(a) ?? 0) + 1);
const commits = git('log', '--format=%h %an：%s', '--max-count=30', `${base}..${head}`).split('\n').filter(Boolean);

const out = [];
out.push('### 🔒 上游更新安全檢查');
out.push('');
out.push(`**風險等級：${badge}**　｜　\`${short(base)}\` → \`${short(head)}\`　｜　${authors.length} 個 commit、${files.length} 個檔案（+${totalAdd} / −${totalDel}）`);
out.push('');
if (!files.length) {
  out.push('這次沒有任何檔案變動。');
} else if (risk === 'LOW') {
  out.push('沒有發現需要特別留意的項目。仍建議快速瀏覽下方的變動概覽。');
} else {
  out.push('下列項目請人工確認後再合併。以下只是自動掃描的線索，**沒被列出不代表沒有風險**。');
}
out.push('');

const renderFinding = (f) => {
  out.push(`#### ${f.level === 'high' ? '🔴' : '🟡'} ${f.title}`);
  out.push('');
  out.push(...f.lines);
  if (f.diff) {
    out.push('');
    out.push('<details><summary>展開查看 diff</summary>');
    out.push('');
    const limited = f.diff.split('\n').slice(0, 400).join('\n');
    out.push('````diff');
    out.push(limited);
    out.push('````');
    if (f.diff.split('\n').length > 400) out.push('（diff 過長，已截斷）');
    out.push('');
    out.push('</details>');
  }
  out.push('');
};
if (high.length) {
  out.push('## 需要你親眼確認');
  out.push('');
  high.forEach(renderFinding);
}
if (medium.length) {
  out.push(`## 其他提醒${high.length ? '' : '（請快速看過）'}`);
  out.push('');
  medium.forEach(renderFinding);
}
if (auditNote) {
  out.push(`ℹ️ ${auditNote}`);
  out.push('');
}

if (authors.length) {
  out.push('<details><summary>commit 與作者概覽</summary>');
  out.push('');
  out.push(`作者：${[...authorCount.entries()].map(([n, c]) => `${code(n)}（${c}）`).join('、')}`);
  out.push('');
  out.push(...commits.map((c) => `- ${code(clip(c, 140))}`));
  if (authors.length > commits.length) out.push(`- …另有 ${authors.length - commits.length} 個 commit`);
  out.push('');
  out.push('</details>');
  out.push('');
}
if (files.length) {
  out.push('<details><summary>所有變動的檔案</summary>');
  out.push('');
  const stat = new Map(numstat.map((n) => [n.path, n]));
  for (const f of files.slice(0, 200)) {
    const n = stat.get(f.path);
    out.push(`- ${statusLabel(f.status)} ${code(f.path)}${n && n.add !== null ? `（+${n.add} −${n.del}）` : ''}`);
  }
  if (files.length > 200) out.push(`- …另有 ${files.length - 200} 個檔案`);
  out.push('');
  out.push('</details>');
}

const report = out.join('\n') + '\n';
if (outFile) fs.writeFileSync(outFile, report);
else process.stdout.write(report);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `risk=${risk}\nworkflow_changed=${workflowChanged}\nchanged_files=${files.length}\n`
  );
}
