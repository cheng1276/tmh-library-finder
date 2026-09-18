/**
 * 找文獻 — 網站 ＋ AI 中繼站（Cloudflare Pages，_worker.js）
 * 台南市立醫院圖書館　v2.0（2026-09）
 *
 * 這一個檔案同時做兩件事：
 *   1. /api/ai 開頭的網址 → AI 中繼站：用 Cloudflare Workers AI（免費額度 10,000
 *      neurons／天）產生 PubMed 檢索式與重點整理。
 *   2. 其他所有網址 → 原樣送出網站本身的檔案（index.html、holdings.csv、go.html …）。
 *
 * 放法：放在 GitHub 倉庫最上層，檔名必須正好是 _worker.js，Cloudflare Pages 會自動接手。
 *
 * 重要特性
 *   ▸ 提示詞寫在這支程式裡，網頁只能送「問題」與「文獻清單」，不能自訂指令
 *     ——這樣即使網址被別人知道，也無法拿它當免費 AI 用。
 *   ▸ 預設只接受本站自己呼叫（同一個網域），不必另外設定。
 *   ▸ 額度快用完時，整理重點會先停掉（回 429 quota），把剩下的額度留給
 *     「轉檢索式」這個核心功能；網頁收到後會改顯示「交給你自己的 Claude」。
 *   ▸ 綁定 KV（選用）可記錄用量並快取結果，省額度。
 *
 * 唯一要設定的一件事（Cloudflare 主控台 → Workers & Pages → 你的 Pages 專案 → Settings）
 *   Bindings → Add → Workers AI，變數名稱填 AI，然後重新部署。
 *
 * 選用：
 *   Bindings → Add → KV namespace，變數名稱 QUOTA（用量統計與快取）
 *   Variables → ALLOWED_ORIGINS（逗號分隔；不填＝只允許本站）、ACCESS_CODE、
 *               DAILY_NEURONS（預設 9200）、MODEL_TRANSLATE、MODEL_SUMMARY
 *
 * 自我測試：用瀏覽器打開  https://你的網站/api/ai
 */
const API = '/api/ai';   // 中繼站的路徑；其餘網址一律當成網站檔案

const VERSION = '2.8 (2026-09) / Pages';
// 提示詞版本。改動任何提示詞就把它加一 —— 快取鍵含這個版本，舊的結果會自動作廢。
// （之前改了提示詞卻沒換快取鍵，同一個問題一直回舊的短檢索式，改什麼都看不出效果。）
const PROMPT_V = 'p4';

/* ---------------- 提示詞（只在這裡，網頁不能改） ---------------- */
const SYS_TRANSLATE = `你是醫院圖書館的實證醫學檢索專家。使用者會用中文或英文輸入一個臨床問題，或是一段臨床情境（病人描述、床邊遇到的狀況、開會要準備的題目）。

請「逐行」輸出下列欄位，一行一個，欄位名稱後面接冒號。不要用 JSON、不要用 markdown、不要加任何其他說明文字：

QUERY: 一條英文 PubMed 檢索式（最重要，務必放在第一行）
QUESTION: 歸納後的臨床問題（繁體中文，一句完整的話，25–60 字，要把族群、介入或暴露、結果都講出來，不要只寫幾個關鍵詞）
TYPE: therapy 或 diagnosis 或 prognosis 或 etiology 或 other
PICO: P=… | I=… | C=… | O=…（每欄用繁體中文具體描述，例如 P=65 歲以上、接受髖部骨折手術的住院病人；沒有的欄位留空）
SUGGEST: sr 或 rct 或 guideline（不確定就留空）
ALT: 標籤 | 另一條英文檢索式　（最多兩行；標籤 6 字內，例如「更廣」「更精準」）
NOTE: 兩到三句繁體中文：這是哪一類臨床問題、你把它拆成哪幾個概念、建議先看哪一類文獻，以及這樣檢索可能會漏掉什麼

QUERY 的寫法：
- 拆出 2–4 個核心概念；每個概念用 MeSH 詞（[mh]）加上 3–5 個同義自由詞（[tiab]）以 OR 併列，概念之間用 AND 連接。
- 同義詞要盡量列全：包含常見縮寫、英／美拼法、臨床上的別名與上位詞。漏了同義詞就會漏掉文獻，寧可長一點。
- 一律用英文。不要加日期、語言、humans 或文獻類型的限制（介面會另外處理）。
- 寫成一行，括號必須成對。
- 不要使用雙引號（"）。需要片語時直接寫，例如 hip fracture[tiab]、heart failure[mh]。
- 只在確定是 MeSH 主標題時才用 [mh]；不確定就用 [tiab]。

若輸入與醫學、健康或生醫研究無關，或無法用文獻資料庫回答，就只輸出一行，不要輸出 QUERY：
NOTSEARCHABLE: 一句繁體中文說明為什麼不適合用 PubMed 查

範例輸出：
QUERY: (Hip Fractures[mh] OR hip fracture[tiab] OR femoral neck fracture[tiab] OR proximal femoral fracture[tiab] OR hip surgery[tiab]) AND (Delirium[mh] OR delirium[tiab] OR acute confusion[tiab] OR postoperative confusion[tiab] OR acute confusional state[tiab]) AND (prevention[tiab] OR prophylaxis[tiab] OR preventive[tiab] OR multicomponent intervention[tiab] OR nonpharmacological[tiab])
QUESTION: 老年髖部骨折術後如何預防譫妄？
TYPE: therapy
PICO: P=65 歲以上、接受髖部骨折手術的住院病人 | I=術前或術後的預防性介入（多成分照護、藥物、麻醉方式） | C=常規照護 | O=術後譫妄的發生率與嚴重度
SUGGEST: sr
ALT: 更廣 | (hip fracture[tiab] OR femoral fracture[tiab]) AND (delirium[tiab] OR confusion[tiab])
ALT: 更精準 | (Hip Fractures[mh]) AND (Delirium[mh]) AND (multicomponent intervention[tiab] OR care bundle[tiab] OR orthogeriatric[tiab])
NOTE: 這是治療／預防型問題，拆成「髖部骨折」「譫妄」「預防性介入」三個概念。建議先看系統性回顧與統合分析，再回頭補隨機試驗。若只用 [mh] 會漏掉尚未編入 MeSH 的新文獻，所以每個概念都另外加了自由詞。`;

const SYS_SUMMARIZE = `你是實證醫學圖書館員。使用者會給你一個問題，以及一份有編號的文獻清單（含摘要）。
請只根據這些摘要，用繁體中文寫 400–500 字的重點整理（全文絕不超過 550 字，每段 120–170 字；超過會被系統截斷），分成三段，每段以下列小標開頭（小標單獨一行，後面接內容）：
共識：多數文獻一致的發現，以及它們的研究類型或證據等級（例如系統性回顧、隨機試驗、觀察性研究、病例報告）。
分歧與限制：文獻之間不一致的地方、證據較弱或樣本小的地方、與使用者情境不完全相符的地方。
對這個問題的意涵：從上述證據能推到的實務要點，並明確標出哪些是證據直接支持、哪些只是延伸；若證據不足以回答，就直說。
規則：
- 每個陳述句都必須以 [編號] 標注來源，且只能引用清單中存在的編號。
- 不得加入清單以外的資訊，不得推論摘要中沒有寫的結論。
- 直接就手上的內容寫，不要花篇幅說明「清單只有幾篇」或「摘要不完整」這類輸入本身的問題。
- 清單只有一兩篇時照樣分三段：就這幾篇講清楚它們做了什麼、限制在哪、對這個問題能說到什麼程度。
- 「證據不足以回答」是可以寫的結論，但要說清楚是因為研究設計或樣本（例如只有病例報告），而不是因為清單篇數。
- 最後另起一行寫「最相關：[編號], [編號], [編號]」（列 3–5 篇，最值得先讀的排前面）。
純文字，不用 markdown，段落之間空一行。`;

/* ---------------- 模型 ----------------
   依序嘗試；前面的開不了（模型名稱變更、暫時故障）就自動換下一個。
   neurons：每千個 token 的花費（輸入, 輸出），用來估算今日用量。
   順序＝嘗試順序。Gemma-4 放第一（實測在本帳號可用且輸出穩定）；Qwen3-30B 是 MoE、單價最低，
   留作第二順位。若第一個叫不動（模型下架、暫時故障），會自動換下一個。 */
const MODELS = [
  { id: '@cf/google/gemma-4-26b-a4b-it',         neurons: [9.091, 27.273] },
  { id: '@cf/qwen/qwen3-30b-a3b-fp8',            neurons: [4.625, 30.475] },
  { id: '@cf/openai/gpt-oss-20b',                neurons: [18.182, 27.273] },
  { id: '@cf/meta/llama-3.1-8b-instruct-fast',   neurons: [4.119, 34.868] },
  { id: '@cf/meta/llama-3.1-8b-instruct',        neurons: [25.608, 75.147] }
];
const priceOf = id => (MODELS.find(m => m.id === id) || { neurons: [20, 60] }).neurons;

/* ---------------- 小工具 ---------------- */
const json = (obj, status, headers) => new Response(JSON.stringify(obj), {
  status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers || {})
});
const fail = (type, message, status, headers) => json({ error: { type, message } }, status || 400, headers);
const today = () => new Date().toISOString().slice(0, 10);   // 額度每天 00:00 UTC（台灣早上 8 點）重置
const clip = (s, n) => String(s == null ? '' : s).replace(/[ --]/g, ' ').slice(0, n);
// 每篇摘要能帶多少字。原則：先讓每一篇都拿到完整摘要，只有在總量超過上限時才砍，
// 而且不是齊頭砍——齊頭砍會連短摘要一起砍掉、長的也還是不夠。改用水位法：
// 找一個水位，低於水位的原封不動，高於水位的砍到水位，剛好塞滿總量上限。
// 實測 10 篇一般摘要加起來約 1 萬字元，根本碰不到上限；只有 Cochrane 這種
// 一篇 6,000 字元的系統性回顧湊在一起時才會啟動。
function abstractBudget(lens, total, perMax){
  const cap = Math.max(200, perMax || 8000);
  const L = lens.map(n => Math.min(Math.max(0, n | 0), cap));
  if (L.reduce((a, b) => a + b, 0) <= total) return L;       // 塞得下就全給
  let lo = 0, hi = cap;                                       // 二分找水位：塞得下的最大整數水位
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (L.reduce((a, n) => a + Math.min(n, mid), 0) <= total) lo = mid; else hi = mid - 1;
  }
  const lvl = Math.max(400, lo);                               // 再擠也保留 400 字元，不讓任何一篇整篇消失
  return L.map(n => Math.min(n, lvl));
}
const estTokens = s => Math.ceil(String(s || '').length / 3.2);   // 中英混合的粗估

function cors(request, env, selfOrigin) {
  const origin = request.headers.get('Origin') || '';
  // 沒設定 ALLOWED_ORIGINS 時，預設只允許本站自己（同網域）；同網域的請求有時不帶 Origin，一併放行
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (!list.length && selfOrigin) list.push(String(selfOrigin).replace(/\/$/, ''));
  const ok = !list.length || !origin || list.includes(origin.replace(/\/$/, ''));
  const h = {
    'Access-Control-Allow-Origin': ok && origin ? origin : (list[0] || '*'),
    'Access-Control-Allow-Headers': 'content-type,x-access-code',
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  return { ok, origin, headers: h, restricted: !!String(env.ALLOWED_ORIGINS || '').trim() };
}

/* ---------------- 用量與快取（綁了 KV 才有；沒綁也能運作） ---------------- */
async function usedToday(env) {
  if (!env.QUOTA) return null;
  try { return +(await env.QUOTA.get('n:' + today())) || 0; } catch (e) { return null; }
}
async function addUsage(env, n) {
  if (!env.QUOTA || !n) return;
  try {
    const key = 'n:' + today();
    const cur = +(await env.QUOTA.get(key)) || 0;
    await env.QUOTA.put(key, String(Math.round(cur + n)), { expirationTtl: 3 * 86400 });
  } catch (e) {}
}
async function cacheGet(env, key) {
  if (!env.QUOTA) return null;
  try { const v = await env.QUOTA.get('c:' + key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
async function cachePut(env, key, value) {
  if (!env.QUOTA) return;
  try { await env.QUOTA.put('c:' + key, JSON.stringify(value), { expirationTtl: 86400 }); } catch (e) {}
}
async function hashKey(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- 呼叫 Workers AI ---------------- */
function textOf(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;                                  // 傳統回傳格式
  if (r.choices && r.choices[0]) {                                                        // OpenAI 相容格式
    const m = r.choices[0].message || {};
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(c => (typeof c === 'string' ? c : c.text || '')).join('');
    if (typeof r.choices[0].text === 'string') return r.choices[0].text;
  }
  if (Array.isArray(r.output)) {                                                          // gpt-oss 的 responses 格式
    return r.output.filter(o => o.type !== 'reasoning')
      .map(o => (o.content || []).map(c => c.text || '').join('')).join('');
  }
  return '';
}
function stopOf(r) {
  const f = r && (r.finish_reason || (r.choices && r.choices[0] && r.choices[0].finish_reason));
  return f === 'length' || f === 'max_tokens' ? 'max_tokens' : 'end_turn';
}
// 推理型模型（Qwen3、gpt-oss）可能會吐出思考段落，一律去掉
const stripThink = t => String(t || '')
  .replace(/<think>[\s\S]*?<\/think>/gi, '')
  .replace(/<\|channel\|>analysis[\s\S]*?<\|message\|>/gi, '')
  .replace(/^[\s\S]*?<\/think>/i, m => (/<think>/i.test(m) ? '' : m))
  .trim();

async function runModel(env, modelId, messages, maxTokens) {
  const started = Date.now();
  const r = await env.AI.run(modelId, {
    messages,
    max_tokens: maxTokens,
    temperature: 0.3,
    chat_template_kwargs: { enable_thinking: false }   // 關掉思考模式（模型不支援時會被忽略）
  });
  const text = stripThink(textOf(r));
  const u = r && r.usage || {};
  const p = priceOf(modelId);
  const inTok = u.prompt_tokens || estTokens(messages.map(m => m.content).join(' '));
  const outTok = u.completion_tokens || estTokens(text);
  return {
    text, stop: stopOf(r), model: modelId, ms: Date.now() - started,
    neurons: Math.round((inTok / 1000) * p[0] + (outTok / 1000) * p[1]),
    tokens: { in: inTok, out: outTok }
  };
}
// 依序試模型；全部失敗才丟出最後一個錯誤
async function runChain(env, preferred, messages, maxTokens) {
  const chain = [];
  if (preferred) chain.push(preferred);
  MODELS.forEach(m => { if (m.id !== preferred) chain.push(m.id); });
  let last = null;
  for (const id of chain) {
    try {
      const out = await runModel(env, id, messages, maxTokens);
      if (out.text) return out;
      last = new Error('模型沒有回傳內容：' + id);
    } catch (e) {
      last = e;
      const msg = String(e && e.message || e);
      if (/neuron|quota|limit|exceed|capacity|429/i.test(msg)) { const err = new Error(msg); err.quota = true; throw err; }
    }
  }
  throw last || new Error('沒有可用的模型');
}

/* ---------------- 檢索式把關 ----------------
   模型偶爾會回中文、回半形／全形混雜、或直接照抄提示詞裡的佔位符 "..."。
   這種字串送到 PubMed 會被它濾成空字串，然後回一句很難懂的
   "Search Backend failed ... Empty Term in the request"。所以在這裡先擋下來。 */
const CJK_RE = /[\u3000-\u303F\u3400-\u9FFF\uF900-\uFAFF]/g;
// 全形英數與標點換回半形，全形空白換成空白，再把剩下的中日韓字元拿掉
function tidyQuery(q) {
  let t = String(q || '')
    .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'")
    .replace(/\u3000/g, ' ')
    .replace(CJK_RE, ' ')
    .replace(/\)(AND|OR|NOT)\b/gi, ') $1').replace(/\b(AND|OR|NOT)\(/gi, '$1 (')   // 補回運算子前後的空白，PubMed 需要
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/\s*(AND|OR|NOT)\s*$/i, '').replace(/^\s*(AND|OR|NOT)\s+/i, '').trim();   // 去掉被截斷後留下的運算子
  const sq = (t.match(/\[/g) || []).length - (t.match(/\]/g) || []).length;                  // 欄位標籤被切斷 → 補上 ]
  if (sq > 0 && sq <= 2) t += ']'.repeat(sq);
  const open = (t.match(/\(/g) || []).length, close = (t.match(/\)/g) || []).length;         // 少幾個括號就補回來
  if (open > close && open - close <= 3) t += ')'.repeat(open - close);
  else if (close > open && close - open <= 3) t = '('.repeat(close - open) + t;
  return t;
}
function looksLikeQuery(q) {
  const t = String(q || '').trim();
  if (t.length < 5 || t.length > 3000) return false;
  if (/^[\s.,;:()[\]"'\-*]+$/.test(t)) return false;                          // 只有標點（例如照抄的 "..."）
  if (/\(\s*\)/.test(t)) return false;                                        // 出現空括號＝原本括號裡是中文，已被清掉
  const open = (t.match(/\(/g) || []).length, close = (t.match(/\)/g) || []).length;
  if (open !== close) return false;                                           // 括號沒配對＝被截斷或格式壞掉
  // 去掉欄位標籤與布林運算子之後，必須還剩下真正的英文檢索詞
  const words = (t.replace(/\[[^\]]*\]/g, ' ').match(/[A-Za-z][A-Za-z'\-]+/g) || []).filter(w => !/^(AND|OR|NOT)$/i.test(w));
  if (!words.length) return false;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (letters / t.length < 0.3) return false;                                 // 英文字母太少＝多半不是英文檢索式
  return true;
}

/* ---------------- 解析模型輸出 ----------------
   改用逐行欄位而不是 JSON：小模型常常在 JSON 字串裡忘了跳脫雙引號（檢索式裡到處都是引號），
   或是輸出被長度上限截斷而少了結尾括號，兩種情況都會讓 JSON 整段失效。逐行格式沒有這個問題：
   每一行各自獨立，就算後面被截斷，前面的 QUERY 仍然完整可用（所以要求模型把 QUERY 放第一行）。 */
function parseLines(text, truncated) {
  const out = { query: '', question: '', type: '', pico: {}, suggest: '', alternatives: [], note: '', notSearchable: '' };
  let found = false;
  const lines = String(text || '').split(/\r?\n/);
  if (truncated && lines.length > 1) lines.pop();          // 輸出被長度上限切斷：最後一行不完整，整行丟掉
  lines.forEach(line => {
    const m = line.match(/^\s*\**\s*([A-Za-z_]+)\s*[:：]\s*(.*)$/);
    if (!m) return;
    const k = m[1].toUpperCase(), v = m[2].trim().replace(/^\**|\**$/g, '').trim();
    if (!v) return;
    if (k === 'QUERY') { if (!out.query) { out.query = v; found = true; } }
    else if (k === 'QUESTION') out.question = v;
    else if (k === 'TYPE') out.type = v.toLowerCase();
    else if (k === 'SUGGEST') out.suggest = v.toLowerCase();
    else if (k === 'NOTE') out.note = v;
    else if (k === 'NOTSEARCHABLE') { out.notSearchable = v; found = true; }
    else if (k === 'PICO') v.split('|').forEach(part => {
      const mm = part.match(/^\s*([PICO])\s*[=＝]\s*(.*)$/i);
      if (mm && mm[2].trim()) out.pico[mm[1].toUpperCase()] = mm[2].trim();
    });
    else if (k === 'ALT') { const i = v.indexOf('|'); if (i > 0 && v.slice(i + 1).trim()) out.alternatives.push({ label: v.slice(0, i).trim(), query: v.slice(i + 1).trim() }); }
  });
  return found ? out : null;
}

/* ---------------- 解析 AI 回傳的 JSON（舊格式的備援） ---------------- */
function extractJSON(text) {
  let clean = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const tryParse = t => { try { return JSON.parse(t); } catch (e) { return undefined; } };
  const fix = t => t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1');
  let r = tryParse(clean); if (r !== undefined) return r;
  r = tryParse(fix(clean)); if (r !== undefined) return r;
  const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
  if (a >= 0 && b > a) { const seg = clean.slice(a, b + 1); r = tryParse(seg); if (r === undefined) r = tryParse(fix(seg)); if (r !== undefined) return r; }
  const m = clean.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) { try { return { query: JSON.parse('"' + m[1] + '"') }; } catch (e) { return { query: m[1] }; } }
  return null;
}
function normalizeTranslation(j) {
  const oneLine = q => tidyQuery(q);
  const pico = j.pico && typeof j.pico === 'object' ? j.pico : {};
  return {
    query: oneLine(j.query),
    question: String(j.question || '').slice(0, 300),
    type: ['therapy', 'diagnosis', 'prognosis', 'etiology', 'prediction', 'other'].includes(j.type) ? j.type : '',
    pico: ['P', 'I', 'C', 'O'].map(k => (pico[k] ? k + '：' + String(pico[k]).slice(0, 120) : '')).filter(Boolean),
    alternatives: (Array.isArray(j.alternatives) ? j.alternatives : []).filter(a => a && a.query).slice(0, 3)
      .map(a => ({ label: String(a.label || '替代').slice(0, 12), query: oneLine(a.query) })).filter(a => looksLikeQuery(a.query)),
    suggest: ['sr', 'rct', 'guideline'].includes(j.suggest) ? j.suggest : '',
    note: String(j.note || '').slice(0, 400)
  };
}

/* ---------------- 兩個任務 ---------------- */
async function doTranslate(env, body) {
  const question = clip(body.question, 2000).trim();
  if (!question) return fail('bad_request', '沒有收到問題', 400);
  const key = await hashKey('t|' + PROMPT_V + '|' + question);   // 提示詞一改，快取自動換新
  const hit = await cacheGet(env, key);
  if (hit && looksLikeQuery(hit.query)) return json({ ok: true, cached: true, translation: hit });   // 快取也要通過檢查才能用

  const base = [{ role: 'system', content: SYS_TRANSLATE }, { role: 'user', content: question }];
  const tried = [];                                                    // 每次嘗試的原始輸出，失敗時回傳給網頁顯示，方便找原因
  const NUDGE = '\n\n（注意：上一次回覆的 query 不能用。query 必須是「英文」的 PubMed 檢索式，'
    + '只能出現英文字、數字、括號、AND/OR、[mh]、[tiab] 這類欄位標籤；不可以有中文字，不可以照抄範例裡的 "..."，括號必須成對。）';
  let out = null, t = null, lastText = '', notSearchable = null;

  for (let i = 0; i < 3; i++) {                                        // 吐不出 JSON、或檢索式不能用，就再試一次
    // 提醒併進同一則 user 訊息：有些模型（如 Gemma）的對話樣板不接受連續兩則 user 訊息
    const messages = [base[0], { role: 'user', content: base[1].content + (i === 0 ? '' : NUDGE) }];
    out = await runChain(env, pickModel(body, env.MODEL_TRANSLATE), messages, i === 0 ? 1600 : 1800);   // 檢索式長、同義詞多，留足空間
    await addUsage(env, out.neurons);
    lastText = out.text;
    tried.push({ model: out.model, stop: out.stop, text: String(out.text || '').slice(0, 500) });
    const j = parseLines(out.text, out.stop === 'max_tokens') || extractJSON(out.text);   // 先用逐行格式，舊的 JSON 格式仍然讀得懂
    if (!j) continue;
    if (j.notSearchable) { notSearchable = String(j.notSearchable).slice(0, 400); break; }
    if (!j.query && j.note) { notSearchable = String(j.note).slice(0, 400); break; }   // AI 判斷不適合查文獻
    const cand = normalizeTranslation(j);
    if (looksLikeQuery(cand.query)) { t = cand; break; }
    const alt = (cand.alternatives || []).find(a => looksLikeQuery(a.query));          // 主檢索式壞掉但替代可用 → 直接升上來
    if (alt) { cand.query = alt.query; cand.alternatives = cand.alternatives.filter(a => a !== alt); t = cand; break; }
  }

  if (notSearchable) return json({ ok: true, notSearchable: true, note: notSearchable, model: out && out.model });
  if (!t) return json({ ok: false, error: { type: 'badquery', message: 'AI 這次沒有給出可用的英文檢索式' },
                        raw: tried.map((x, i) => '第 ' + (i + 1) + ' 次（' + x.model + (x.stop === 'max_tokens' ? '，輸出被長度上限截斷' : '') + '）：\n' + x.text).join('\n\n---\n\n'),
                        model: out && out.model }, 502);

  await cachePut(env, key, t);                                         // 只快取通過檢查的結果
  return json({ ok: true, translation: t, model: out.model, neurons: out.neurons, ms: out.ms });
}

// 網頁或診斷頁可以指定模型，但只能從上面的白名單挑（避免被拿去跑別的東西）
const pickModel = (body, fallback) => (body && body.model && MODELS.some(m => m.id === body.model)) ? body.model : fallback;

async function doSummarize(env, body) {
  const question = clip(body.question, 600).trim();
  // 單篇上限依篇數分配（長的系統性回顧摘要才不會被切一半），總量有上限。
  // 先算好每篇能分到多少，而不是先到先用 —— 否則排在後面的文獻會被整篇丟掉，編號就對不上了。
  // 網頁端已經照同樣的規則分配過，這裡只是最後一道防線。
  const raw = (Array.isArray(body.records) ? body.records : []).slice(0, 20);
  // 網頁端已經配好字數，這裡只是防線：擋住手工打造的超大請求，別讓它一次吃掉一天的額度。
  // 和網頁用同一套水位法，所以正常情況下這裡不會再砍任何一篇。
  const per = abstractBudget(raw.map(r => String(r && r.abstract || '').length), 48000, 8000);
  const recs = raw
    .map((r, i) => ({ n: Math.max(1, Math.min(999, parseInt(r.n, 10) || 0)), title: clip(r.title, 250), meta: clip(r.meta, 120), abstract: clip(r.abstract, per[i]) }))
    .filter(r => r.n && r.abstract);
  if (!recs.length) return fail('bad_request', '沒有收到可整理的文獻', 400);

  const key = await hashKey('s|' + PROMPT_V + '|' + question + '|' + recs.map(r => r.n + ':' + r.abstract.length + ':' + r.title.slice(0, 40)).join('|'));
  const hit = await cacheGet(env, key);
  if (hit) return json({ ok: true, cached: true, text: hit });

  const list = recs.map(r => '[' + r.n + '] ' + r.title + (r.meta ? '（' + r.meta + '）' : '') + '\n摘要：' + r.abstract).join('\n\n');
  const user = '問題：' + (question || '（未提供，請依文獻內容整理）') + '\n\n文獻清單：\n' + list;
  const messages = [{ role: 'system', content: SYS_SUMMARIZE }, { role: 'user', content: user }];

  let out = await runChain(env, pickModel(body, env.MODEL_SUMMARY), messages, 1800);
  await addUsage(env, out.neurons);
  let text = out.text, neurons = out.neurons;

  if (out.stop === 'max_tokens' || !/最相關/.test(text)) {            // 被輸出上限截斷：接續一次
    const tail = text.slice(-300);
    const cont = await runChain(env, out.model, messages.concat([
      { role: 'assistant', content: text },
      { role: 'user', content: '你上一次的回覆被截斷了（結尾是：…' + tail + '）。請直接從中斷處接續寫完剩下的內容，不要重複已寫過的文字、不要重寫小標，最後仍以「最相關：[編號], …」結尾。' }
    ]), 900);
    await addUsage(env, cont.neurons);
    neurons += cont.neurons;
    text = text.replace(/\s*\[?\s*$/, '') + cont.text;
    if (cont.stop === 'max_tokens') {
      const cut = Math.max(text.lastIndexOf('。'), text.lastIndexOf('\n最相關'));
      text = (cut > 0 ? text.slice(0, cut + 1) : text) + '\n（整理內容超過長度上限，已在此截斷。）';
    }
  }
  text = text.trim();
  if (!text) return fail('empty', 'AI 沒有回傳內容', 502);
  await cachePut(env, key, text);
  return json({ ok: true, text, model: out.model, neurons, ms: out.ms, n: recs.length });
}

/* ---------------- 首頁與自我測試 ---------------- */
function statusPage(env, used) {
  const budget = +env.DAILY_NEURONS || 9200;
  const rows = [
    ['版本', VERSION + '　提示詞 ' + PROMPT_V],
    ['Workers AI 綁定（AI）', env.AI ? '✅ 已綁定' : '❌ 未綁定 —— 請到 Pages 專案 Settings → Bindings → Add → Workers AI，變數名稱填 AI，再重新部署'],
    ['KV 綁定（QUOTA，選用）', env.QUOTA ? '✅ 已綁定（可統計用量、快取結果）' : '⚪ 未綁定（仍可運作，但沒有用量統計與快取）'],
    ['允許的網站', env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS) : '✅ 只允許本站自己呼叫（預設，不必設定）'],
    ['存取碼（ACCESS_CODE，選用）', env.ACCESS_CODE ? '已設定' : '未設定'],
    ['今日已用（估計）', used == null ? '未統計（未綁 KV）' : used + ' / ' + budget + ' neurons'],
    ['轉檢索式模型', env.MODEL_TRANSLATE || MODELS[0].id],
    ['重點整理模型', env.MODEL_SUMMARY || MODELS[0].id]
  ];
  return `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>找文獻 AI 中繼站</title>
<style>body{font-family:system-ui,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.7;color:#16262E}
h1{font-size:22px;margin:0 0 4px}p.sub{color:#5B6A70;margin:0 0 20px;font-size:14px}
table{border-collapse:collapse;width:100%;font-size:14px}td{border-top:1px solid #D5DFDA;padding:8px 6px;vertical-align:top}
td:first-child{color:#5B6A70;width:210px}button{font:inherit;padding:8px 16px;border:1px solid #1B6B5A;background:#1B6B5A;color:#fff;border-radius:6px;cursor:pointer;margin:16px 8px 0 0}
button.alt{background:#fff;color:#114A3E}pre{white-space:pre-wrap;word-break:break-word;background:#F5F8F6;padding:12px;border-radius:8px;font-size:12.5px;margin-top:14px}
code{background:#F5F8F6;padding:1px 5px;border-radius:4px;font-size:12.5px}</style></head><body>
<h1>找文獻 — AI 中繼站</h1><p class="sub">台南市立醫院圖書館　這是中繼站的狀態頁，給管理者看的；要查文獻請回<a href="/">首頁</a>。</p>
<table>${rows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('')}</table>
<p style="margin-top:22px"><strong>自我測試</strong>（會實際用掉一點額度）：</p>
<p><input id="qq" value="老年髖部骨折術後如何預防譫妄？" style="width:100%;font:inherit;padding:8px 10px;border:1px solid #D5DFDA;border-radius:6px;box-sizing:border-box"></p>
<p style="font-size:14px">模型：<select id="mm" style="font:inherit;padding:6px 8px;border:1px solid #D5DFDA;border-radius:6px">
<option value="">（依預設順序）</option>${MODELS.map(m => '<option value="' + m.id + '">' + m.id + '</option>').join('')}
</select>　<span style="color:#5B6A70;font-size:13px">換模型比較整理品質；選好之後可把它填進 Variables 的 MODEL_SUMMARY</span></p>
<button onclick="t('translate')">測試：轉檢索式</button><button class="alt" onclick="t('summarize')">測試：重點整理</button>
<pre id="out" hidden></pre>
<script>
async function t(task){
  const o=document.getElementById('out'); o.hidden=false; o.textContent='測試中…（第一次可能要 10–30 秒）';
  const q = (document.getElementById('qq').value || '老年髖部骨折術後如何預防譫妄？').trim();
  const mm = document.getElementById('mm').value;
  const body = task==='translate'
    ? {task:'translate', question:q, model:mm}
    : {task:'summarize', question:q, model:mm, records:[
        {n:1,title:'Multicomponent intervention to prevent delirium after hip fracture surgery',meta:'Lancet；2024；隨機對照試驗',abstract:'We randomised 480 patients aged 70 or older to a multicomponent intervention or usual care. Delirium incidence was 18% versus 31% (RR 0.58, 95% CI 0.42-0.80).'},
        {n:2,title:'Melatonin for delirium prevention in older surgical patients: a meta-analysis',meta:'Lancet Glob Health；2023；統合分析',abstract:'Pooled analysis of 12 trials (n=2340) found melatonin reduced delirium incidence (OR 0.62, 95% CI 0.45-0.86) with substantial heterogeneity (I2=68%).'}]};
  const t0=Date.now();
  try{
    const r=await fetch('/api/ai',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();
    o.textContent='HTTP '+r.status+'　耗時 '+((Date.now()-t0)/1000).toFixed(1)+' 秒\\n\\n'+JSON.stringify(j,null,2);
  }catch(e){ o.textContent='呼叫失敗：'+e.message; }
}
</script></body></html>`;
}

/* ---------------- 入口 ----------------
   /api/ai 開頭的網址交給中繼站，其餘一律交還給網站本身的檔案（env.ASSETS）。
   中繼站這一段就算出意外，也只影響 /api/ai，不會讓網站打不開。 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname === API || url.pathname.startsWith(API + '/');
    if (!isApi) {
      if (env.ASSETS && env.ASSETS.fetch) return env.ASSETS.fetch(request);
      return new Response('這個專案沒有可提供的網站檔案。', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    try { return await api(request, env, url); }
    catch (e) { return fail('server', '中繼站發生非預期錯誤：' + String(e && e.message || e).slice(0, 200), 500); }
  }
};

async function api(request, env, url) {
    const c = cors(request, env, url.origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.headers });

    if (request.method === 'GET') {
      if (url.pathname === API + '/ping') {                 // 網頁開啟時的探測：不呼叫 AI，不花額度
        const used = await usedToday(env);
        const budget = +env.DAILY_NEURONS || 9200;
        return json({ ok: true, version: VERSION, ai: !!env.AI, kv: !!env.QUOTA, used, budget,
                      summaryOff: used != null && used >= budget * 0.85 }, 200, c.headers);
      }
      const used = await usedToday(env);
      return new Response(statusPage(env, used), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (request.method !== 'POST') return fail('method', '只接受 POST', 405, c.headers);
    if (!c.ok) return fail('origin', '這個網站不在允許清單中（預設只允許本站呼叫；要開放其他網站請設定 ALLOWED_ORIGINS）', 403, c.headers);
    if (env.ACCESS_CODE && request.headers.get('x-access-code') !== env.ACCESS_CODE) return fail('auth', '存取碼不正確', 401, c.headers);
    if (!env.AI) return fail('config', '還沒有綁定 Workers AI（Pages 專案 Settings → Bindings → Add → Workers AI，變數名稱填 AI，再重新部署）', 500, c.headers);

    let body;
    try {
      const raw = await request.text();
      if (raw.length > 80000) return fail('too_large', '送出的內容太長', 413, c.headers);
      body = JSON.parse(raw);
    } catch (e) { return fail('bad_request', '無法解析送出的內容', 400, c.headers); }

    const task = body && body.task;
    if (task !== 'translate' && task !== 'summarize') return fail('bad_request', 'task 只能是 translate 或 summarize', 400, c.headers);

    // 額度守門：先保住「轉檢索式」這個核心功能
    const used = await usedToday(env);
    const budget = +env.DAILY_NEURONS || 9200;
    if (used != null) {
      if (task === 'summarize' && used >= budget * 0.85) return fail('quota', '今天的 AI 重點整理額度已用完（每天台灣時間早上 8 點重置）', 429, c.headers);
      if (used >= budget) return fail('quota', '今天的 AI 額度已用完（每天台灣時間早上 8 點重置）', 429, c.headers);
    }

    try {
      const res = task === 'translate' ? await doTranslate(env, body) : await doSummarize(env, body);
      Object.entries(c.headers).forEach(([k, v]) => res.headers.set(k, v));
      const left = used == null ? null : Math.max(0, budget - used);
      if (left != null) res.headers.set('x-neurons-left', String(left));
      return res;
    } catch (e) {
      const msg = String(e && e.message || e);
      if (e && e.quota || /neuron|quota|exceed|429/i.test(msg)) {
        return fail('quota', '今天的 AI 額度已用完（每天台灣時間早上 8 點重置）', 429, c.headers);
      }
      return fail('ai', 'AI 服務錯誤：' + msg.slice(0, 200), 502, c.headers);
    }
}
