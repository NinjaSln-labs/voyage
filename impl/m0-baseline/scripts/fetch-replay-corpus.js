// 离线回放语料抓取：公开、免授权、许可清晰的多语言真实问题集
// 用法：NODE_USE_ENV_PROXY=1 node fetch-replay-corpus.js [--out DIR] [--per-tag N] [--cmrc N] [--massive N] [--dolly N] [--drcd N] [--glaive N] [--oasst N] [--skip-oasst]
//       （需要代理的机器须带 NODE_USE_ENV_PROXY=1；OASST1/MASSIVE/Dolly 大文件走系统 curl 下载并缓存）
// 许可：SE/CMRC=CC BY-SA 4.0；MASSIVE=CC BY 4.0；Dolly=CC BY-SA 3.0；DRCD=CC BY 3.0；Glaive/OASST=Apache-2.0
// 数据只落本地（默认 ~/.voyage-eval/offline-replay），不入仓库、不上传。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileP = promisify(execFile);

const LANGS = ['zh', 'en', 'es', 'pt', 'ru', 'ja', 'de', 'fr', 'ko'];
const SE_SITES = [
  { site: 'stackoverflow', lang: 'en' },
  { site: 'serverfault', lang: 'en' },
  { site: 'unix', lang: 'en' },
  { site: 'askubuntu', lang: 'en' },
  { site: 'superuser', lang: 'en' },
  { site: 'es.stackoverflow', lang: 'es' },
  { site: 'pt.stackoverflow', lang: 'pt' },
  { site: 'ru.stackoverflow', lang: 'ru' },
  { site: 'ja.stackoverflow', lang: 'ja' },
];
const SE_TAGS = ['linux', 'nginx', 'ssh', 'systemd'];
const CMRC_URLS = [
  'https://cdn.jsdelivr.net/gh/ymcui/cmrc2018@master/squad-style-data/cmrc2018_dev.json',
  'https://raw.githubusercontent.com/ymcui/cmrc2018/master/squad-style-data/cmrc2018_dev.json',
];
const OASST_URL = 'https://huggingface.co/datasets/OpenAssistant/oasst1/resolve/main/2023-04-12_oasst_all.messages.jsonl.gz';
const MASSIVE_URL = 'https://amazon-massive-nlu-dataset.s3.amazonaws.com/amazon-massive-dataset-1.1.tar.gz';
const MASSIVE_LOCALES = {
  'en-US': 'en', 'zh-CN': 'zh', 'de-DE': 'de', 'fr-FR': 'fr', 'ko-KR': 'ko',
  'es-ES': 'es', 'pt-PT': 'pt', 'ru-RU': 'ru', 'ja-JP': 'ja',
};
const DOLLY_URL = 'https://huggingface.co/datasets/databricks/databricks-dolly-15k/resolve/main/databricks-dolly-15k.jsonl';
const CC_BY_SA = 'https://creativecommons.org/licenses/by-sa/4.0/';
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
const CC_BY_SA_3 = 'https://creativecommons.org/licenses/by-sa/3.0/';
const CC_BY_3 = 'https://creativecommons.org/licenses/by/3.0/';
const APACHE = 'https://www.apache.org/licenses/LICENSE-2.0';

/** GET（fetch，跟随重定向）；用于 JSON/小文件 */
async function httpGet(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'voyage-offline-replay/1.0', 'accept-encoding': 'identity' },
    redirect: 'follow',
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

/** 大文件下载并缓存（curl 走系统代理；失败重试） */
async function downloadCached(url, dest, log) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const tmp = `${dest}.part`;
  try {
    await execFileP('curl', ['-sS', '--fail', '--location', '--http1.1', '--retry', '5', '--retry-delay', '2', '--retry-all-errors', '--max-time', '900', '-o', tmp, url]);
    fs.renameSync(tmp, dest);
    log(`已下载：${path.basename(dest)}（${(fs.statSync(dest).size / 1e6).toFixed(1)}MB）`);
    return dest;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* 忽略 */ }
    throw new Error(`下载失败：${(e.stderr || e.message || '').toString().trim().slice(0, 200)}`);
  }
}

function htmlUnescape(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function seRecord(item, lang, site) {
  return {
    id: `se-${site}-${item.question_id}`,
    lang,
    domain: 'ops',
    source: `stackexchange:${site}`,
    license: 'CC-BY-SA-4.0',
    licenseUrl: CC_BY_SA,
    sourceUrl: item.link,
    tags: item.tags,
    input: htmlUnescape(item.title || '').trim(),
  };
}

function cmrcRecords(json, limit) {
  const arr = Array.isArray(json && json.data) ? json.data : [];
  const qas = [];
  for (const d of arr) {
    if (Array.isArray(d.qas)) qas.push(...d.qas); // 扁平问答形态
    else if (Array.isArray(d.paragraphs)) {       // squad-style：data[].paragraphs[].qas[]
      for (const p of d.paragraphs) if (Array.isArray(p.qas)) qas.push(...p.qas);
    } else if (d.question) qas.push(d);           // 兼容 data[].question
  }
  return qas
    .map((x, i) => ({
      id: `cmrc-${x.id || i}`,
      lang: 'zh',
      domain: 'general',
      source: 'cmrc2018',
      license: 'CC-BY-SA-4.0',
      licenseUrl: CC_BY_SA,
      sourceUrl: 'https://github.com/ymcui/cmrc2018',
      input: String(x.question || '').trim(),
    }))
    .filter((r) => r.input)
    .slice(0, limit);
}

function oasstRecord(msg) {
  return {
    id: `oasst-${msg.message_id}`,
    lang: msg.lang,
    domain: 'general',
    source: 'oasst1',
    license: 'Apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    sourceUrl: 'https://huggingface.co/datasets/OpenAssistant/oasst1',
    input: String(msg.text || '').trim(),
  };
}

function massiveRecord(msg, lang) {
  return {
    id: `massive-${msg.locale}-${msg.id}`,
    lang,
    domain: 'general',
    source: 'massive',
    license: 'CC-BY-4.0',
    licenseUrl: CC_BY,
    sourceUrl: 'https://github.com/alexa/massive',
    tags: [msg.scenario, msg.intent].filter(Boolean),
    input: String(msg.utt || '').trim(),
  };
}

function dollyRecord(row, idx) {
  return {
    id: `dolly-${idx}`,
    lang: 'en',
    domain: 'general',
    source: 'dolly',
    license: 'CC-BY-SA-3.0',
    licenseUrl: CC_BY_SA_3,
    sourceUrl: 'https://huggingface.co/datasets/databricks/databricks-dolly-15k',
    tags: row.category ? [row.category] : undefined,
    input: String(row.instruction || '').trim(),
  };
}

function drcdRecords(row) {
  const out = [];
  for (const p of row.paragraphs || []) {
    for (const q of p.qas || []) {
      const input = String(q.question || '').trim();
      if (input) {
        out.push({
          id: `drcd-${q.id || q.question_id || out.length}`,
          lang: 'zh',
          domain: 'general',
          source: 'drcd',
          license: 'CC-BY-3.0',
          licenseUrl: CC_BY_3,
          sourceUrl: 'https://github.com/DRCKnowledgeTeam/DRCD',
          input,
        });
      }
    }
  }
  return out;
}

function glaiveRecord(row, idx) {
  const chat = String(row.chat || '');
  const m = /USER:\s*([\s\S]*?)(?:\n\nASSISTANT:|<\|endoftext\|>)/.exec(chat);
  const input = (m ? m[1] : '').trim();
  if (!input) return null;
  return {
    id: `glaive-${idx}`,
    lang: 'en',
    domain: 'tools',
    source: 'glaive',
    license: 'Apache-2.0',
    licenseUrl: APACHE,
    sourceUrl: 'https://huggingface.co/datasets/glaiveai/glaive-function-calling-v2',
    input,
  };
}

/** 按 lang+正文去重；保留首次出现 */
function dedupe(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const k = `${r.lang}|${r.input}`;
    if (!r.input || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

async function fetchStackExchange(perTag, log) {
  const out = [];
  for (const { site, lang } of SE_SITES) {
    for (const tag of SE_TAGS) {
      const url = `https://api.stackexchange.com/2.3/questions?site=${site}&tagged=${tag}` +
        `&pagesize=${perTag}&sort=votes&order=desc&filter=default`;
      try {
        const body = JSON.parse(await httpGet(url));
        for (const item of body.items || []) out.push(seRecord(item, lang, site));
        log(`SE ${site}/${tag}: ${(body.items || []).length}（quota=${body.quota_remaining}）`);
        if (body.backoff) await new Promise((r) => setTimeout(r, body.backoff * 1000));
        else await new Promise((r) => setTimeout(r, 200));
      } catch (e) {
        log(`SE ${site}/${tag} 失败：${e.message}（跳过）`);
      }
    }
  }
  return out;
}

async function fetchCmrc(limit, log) {
  let lastErr;
  for (const url of CMRC_URLS) {
    try {
      const data = JSON.parse(await httpGet(url));
      const recs = cmrcRecords(data, limit);
      log(`CMRC2018 dev: ${recs.length}（${new URL(url).host}）`);
      return recs;
    } catch (e) {
      lastErr = e;
      log(`CMRC ${new URL(url).host} 失败：${e.message}（换镜像）`);
    }
  }
  throw lastErr;
}

async function fetchOasst(perLang, outDir, log) {
  const counts = new Map(LANGS.map((l) => [l, 0]));
  const out = [];
  const gz = await downloadCached(OASST_URL, path.join(outDir, 'oasst_all.messages.jsonl.gz'), log);
  const rl = readline.createInterface({ input: fs.createReadStream(gz).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.role !== 'prompter' || !LANGS.includes(msg.lang)) continue;
    if (counts.get(msg.lang) >= perLang) continue;
    if (!msg.text || msg.text.length < 10 || msg.text.length > 500) continue;
    counts.set(msg.lang, counts.get(msg.lang) + 1);
    out.push(oasstRecord(msg));
    if ([...counts.values()].every((n) => n >= perLang)) break;
  }
  log(`OASST1: ${out.length}（${[...counts.entries()].map(([l, n]) => `${l}=${n}`).join(' ')}）`);
  return out;
}

async function fetchMassive(perLang, outDir, log) {
  const tar = await downloadCached(MASSIVE_URL, path.join(outDir, 'amazon-massive-1.1.tar.gz'), log);
  const dir = path.join(outDir, 'massive');
  fs.mkdirSync(dir, { recursive: true });
  const paths = Object.keys(MASSIVE_LOCALES).map((l) => `1.1/data/${l}.jsonl`);
  const missing = paths.filter((p) => !fs.existsSync(path.join(dir, path.basename(p))));
  if (missing.length) await execFileP('tar', ['-xzf', tar, '-C', dir, '--strip-components=2', ...missing]);
  const out = [];
  for (const [locale, lang] of Object.entries(MASSIVE_LOCALES)) {
    let n = 0;
    for (const line of fs.readFileSync(path.join(dir, `${locale}.jsonl`), 'utf8').split('\n')) {
      if (n >= perLang) break;
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.partition !== 'train') continue;
      const rec = massiveRecord(m, lang);
      if (rec.input) { out.push(rec); n += 1; }
    }
    log(`MASSIVE ${locale}: ${n}`);
  }
  return out;
}

async function fetchDolly(limit, outDir, log) {
  const file = await downloadCached(DOLLY_URL, path.join(outDir, 'dolly-15k.jsonl'), log);
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (out.length >= limit) break;
    if (!line.trim()) continue;
    const rec = dollyRecord(JSON.parse(line), out.length);
    if (rec.input.length >= 5 && rec.input.length <= 500) out.push(rec);
  }
  log(`Dolly: ${out.length}`);
  return out;
}

/** datasets-server 分页采样（无需授权）；mapRows(row) 返回记录数组 */
async function fetchDatasetsServer(dataset, split, limit, mapRows, log) {
  const out = [];
  const page = 100;
  for (let offset = 0; out.length < limit; offset += page) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}` +
      `&config=default&split=${split}&offset=${offset}&length=${page}`;
    const body = JSON.parse(await httpGet(url));
    const rows = body.rows || [];
    if (!rows.length) break;
    for (const { row } of rows) {
      for (const r of mapRows(row, out.length)) {
        if (r && r.input) out.push(r);
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    if (rows.length < page) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return out;
}

async function fetchDrcd(limit, log) {
  const out = await fetchDatasetsServer('voidful/DRCD', 'train', limit, (row) => drcdRecords(row), log);
  log(`DRCD: ${out.length}`);
  return out;
}

async function fetchGlaive(limit, log) {
  const out = await fetchDatasetsServer('glaiveai/glaive-function-calling-v2', 'train', limit,
    (row, idx) => [glaiveRecord(row, idx)], log);
  log(`Glaive: ${out.length}`);
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
  };
  const outDir = (() => {
    const i = argv.indexOf('--out');
    return i >= 0 && argv[i + 1] ? argv[i + 1] : path.join(os.homedir(), '.voyage-eval', 'offline-replay');
  })();
  const perTag = arg('--per-tag', 50);
  const cmrcN = arg('--cmrc', 500);
  const massiveN = arg('--massive', 100);
  const dollyN = arg('--dolly', 200);
  const drcdN = arg('--drcd', 300);
  const glaiveN = arg('--glaive', 200);
  const oasstN = arg('--oasst', 100);
  const skipOasst = argv.includes('--skip-oasst');
  const log = (s) => console.error(`[replay] ${s}`);
  const safe = async (name, fn) => {
    try { return await fn(); } catch (e) { log(`${name} 失败：${e.message}（跳过）`); return []; }
  };

  fs.mkdirSync(outDir, { recursive: true });
  let records = [];
  records = records.concat(await safe('Stack Exchange', () => fetchStackExchange(perTag, log)));
  records = records.concat(await safe('CMRC2018', () => fetchCmrc(cmrcN, log)));
  if (massiveN > 0) records = records.concat(await safe('MASSIVE', () => fetchMassive(massiveN, outDir, log)));
  if (dollyN > 0) records = records.concat(await safe('Dolly', () => fetchDolly(dollyN, outDir, log)));
  if (drcdN > 0) records = records.concat(await safe('DRCD', () => fetchDrcd(drcdN, log)));
  if (glaiveN > 0) records = records.concat(await safe('Glaive', () => fetchGlaive(glaiveN, log)));
  if (!skipOasst) records = records.concat(await safe('OASST1', () => fetchOasst(oasstN, outDir, log)));
  records = dedupe(records);
  if (!records.length) throw new Error('无任何来源成功，未写入语料');

  const byLang = {};
  const bySource = {};
  const byDomain = {};
  for (const r of records) {
    byLang[r.lang] = (byLang[r.lang] || 0) + 1;
    bySource[r.source] = (bySource[r.source] || 0) + 1;
    byDomain[r.domain] = (byDomain[r.domain] || 0) + 1;
  }
  const manifest = {
    fetchedAt: new Date().toISOString(),
    total: records.length,
    byLang,
    byDomain,
    bySource,
    sources: [
      { name: 'stackexchange', license: 'CC-BY-SA-4.0', licenseUrl: CC_BY_SA, note: '问题标题＋来源链接；署名见 sourceUrl' },
      { name: 'cmrc2018', license: 'CC-BY-SA-4.0', licenseUrl: CC_BY_SA, sourceUrl: 'https://github.com/ymcui/cmrc2018' },
      { name: 'massive', license: 'CC-BY-4.0', licenseUrl: CC_BY, sourceUrl: 'https://github.com/alexa/massive' },
      { name: 'dolly', license: 'CC-BY-SA-3.0', licenseUrl: CC_BY_SA_3, sourceUrl: 'https://huggingface.co/datasets/databricks/databricks-dolly-15k' },
      { name: 'drcd', license: 'CC-BY-3.0', licenseUrl: CC_BY_3, sourceUrl: 'https://github.com/DRCKnowledgeTeam/DRCD' },
      { name: 'glaive', license: 'Apache-2.0', licenseUrl: APACHE, sourceUrl: 'https://huggingface.co/datasets/glaiveai/glaive-function-calling-v2' },
      { name: 'oasst1', license: 'Apache-2.0', licenseUrl: APACHE, sourceUrl: 'https://huggingface.co/datasets/OpenAssistant/oasst1' },
    ],
  };
  fs.writeFileSync(path.join(outDir, 'corpus.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  log(`完成：${records.length} 条 → ${outDir}`);
  log(`语言分布：${JSON.stringify(byLang)}`);
  log(`领域分布：${JSON.stringify(byDomain)}`);
}

module.exports = { seRecord, cmrcRecords, oasstRecord, massiveRecord, dollyRecord, drcdRecords, glaiveRecord, dedupe, htmlUnescape, LANGS };

if (require.main === module) {
  main().catch((e) => { console.error(`[replay] 失败：${e.message}`); process.exit(1); });
}
