// /chat/completions 响应归因：把「HTTP 层 / 封套层 / 内容层」三类失败分开记，并保留原文。
//
// 旧写法（simulate-traffic.js / gen-redteam-weekly.js 各自内联）只有 `if (!res.ok)` 一道闸，
// 拿到 200 就直奔 data.choices[0].message.content，于是「200 但封套没有可用 choices」坍缩成
// 一条 TypeError，供应商写明的原因当场丢失（坑 p000056）；而模型 content 不是合法 JSON 数组
// 这类内容层失败也混在同一个 `exception:` 标签里，618 轮日志中占 322 次，长期被当成网络噪音。
// 守卫写法对齐 src/model/agens-adapter.js:106（该路径本就有 Array.isArray 校验）。
'use strict';

const LIMIT = 120;
const flat = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, LIMIT);

/** 供应商自述原因：OpenAI 兼容的 error 对象，退而取顶层 message/code */
function reasonOf(data) {
  const e = data && data.error;
  if (e && typeof e === 'object') return flat(e.message || e.code || '');
  return flat((data && (data.message || data.code)) || '');
}

/** HTTP 层 + 封套层：取到 choices[0].message.content，否则给一条带原文的归因
 *  标签集：HTTP <status>:<原因> / body_not_json(<摘要>):<原文>
 *          body_no_choice(null|missing|empty)[:<原因|原文>] */
function readChatResponse(raw, ok, status) {
  let data = null;
  let parseError = '';
  try { data = JSON.parse(raw); } catch (e) { parseError = e.message; }
  // 状态码优先：非 2xx 时 body 可能是 CDN 的 HTML，记成 body_not_json 会掩掉真正的事实
  if (!ok) {
    const r = data ? reasonOf(data) : '';
    return { error: `HTTP ${status}${r ? ': ' + r : ''}` };
  }
  if (parseError) return { error: `body_not_json(${parseError.slice(0, 40)}): ${flat(raw)}` };
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : undefined;
  if (!choice || !choice.message) {
    const shape = data && data.choices === null ? 'null'
      : data && data.choices === undefined ? 'missing' : 'empty';
    return { error: `body_no_choice(${shape}): ${reasonOf(data) || flat(raw)}` };
  }
  return { content: choice.message.content || '' };
}

/** 内容层：从 content 取字符串数组（沿用「最外层方括号」口径），失败按形态分桶
 *  注：切片起点必是 '['，故 JSON.parse 成功即数组——旧写法的 Array.isArray 分支不可达，已删 */
function readContentArray(content) {
  const text = String(content).replace(/```json|```/g, '').trim();
  if (!text) return { error: 'empty_content' };
  const i = text.indexOf('['), j = text.lastIndexOf(']');
  if (i === -1) return { error: `content_no_array: ${flat(text)}` };
  if (j < i) return { error: `content_truncated: ${flat(text)}` }; // 有开括号无闭括号＝max_tokens 吃光
  let arr;
  try { arr = JSON.parse(text.slice(i, j + 1)); } catch (e) {
    return { error: `content_bad_json(${e.message.slice(0, 60)}): ${flat(text)}` };
  }
  if (!arr.length) return { error: 'content_empty_array' };
  return { items: arr };
}

module.exports = { readChatResponse, readContentArray };
