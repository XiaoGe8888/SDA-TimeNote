// =============================================================
// 行事曆／記事本系統（獨立新專案：程式碼、KV 資料庫都跟 SDA 分開）
// Phase 1：核心資料骨架與基本存取
// Phase 2：新增待辦清單／倒數日期／日期計算機（一樣是 LINE＋KV，不是App）
// Phase 3：改成「同一個LINE帳號」模式——不再需要自己的LINE官方帳號，
//          改由「日常小秘書」(SDA) 的 _worker.js 收到訊息後，把看起來像
//          calnote指令的訊息轉送過來這支 Worker 的 /internal/dispatch，
//          這支 Worker 處理完回傳文字，SDA 再統一回覆到 LINE。
//          使用者只需要加「日常小秘書」一個LINE好友，不用另外加好友。
//
// 涵蓋指令（詳見規格 #編號）：
//   行程：#01 #06 #10 #11 #12 #13 #14
//   記事：#22 #23 #31 #32 #40
//   待辦清單：#99 #100 #101 #102 #104（#103 提醒、#105 批次封存未做）
//   倒數日期：#106 #107 #108 #109 #111（#110 到期自動推播未做）
//   日期計算機：#112 #113 #114 #115 #116（全部完成，純計算無資料表）
//
// 本檔案的程式碼跟 KV 資料庫都還是跟 SDA 現有的 _worker.js 完全分開、
// 各自獨立；只有「同一個LINE帳號」這件事，是透過 SDA 那邊轉送訊息過來
// 做到的，不是把兩邊的程式碼合併成一份。
//
// 需要的 Cloudflare 設定（部署時由使用者自行建立，程式碼不內含
// 任何真實金鑰）：
//   - KV Namespace binding：CALNOTE_KV
//   - 環境變數（Phase 3「同一個LINE帳號」模式必填）：
//       CALNOTE_INTERNAL_SECRET  一組自己取的亂數字串，SDA那邊要設定
//                                一模一樣的值，兩邊用這組密鑰互相確認
//                                身分；不要跟任何LINE金鑰共用同一個值。
//   - 環境變數（選填——只有「不想透過SDA轉送、想讓calnote自己當一個
//     獨立LINE官方帳號」時才需要設定，兩套模式可以同時存在）：
//       LINE_CHANNEL_SECRET       LINE Messaging API 的 Channel secret
//       LINE_CHANNEL_ACCESS_TOKEN LINE Messaging API 的 Channel access token
//       BOT_MENTION_NAME          群組中用來標記本機器人的文字，預設 "@機器人"
//
// 鐵律（全系統 98 組指令共通，Phase 1 已落實的部分）：
//   - 時區：所有時間一律以 Asia/Taipei（GMT+8）為準。
//   - 流水號不補號：刪除後原編號永久保留，絕不回收或補號。
//   - 高風險二次確認：刪除行程／記事前，一律先回傳確認卡片，
//     點擊允許後才真正執行。
//   - 群組防誤觸：群組／多人聊天室模式下，一般聊天保持靜默，
//     只有透過「@機器人 指令」或 postback（卡片按鈕點擊）才會
//     被處理；1 對 1 聊天不受此限制。
// =============================================================

// ---------------------------------------------------------------
// 時間工具（Asia/Taipei, UTC+8，固定時差，不受夏令時間影響）
// ---------------------------------------------------------------

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 目前的台灣時間（回傳一個「本地欄位」物件，方便组字串與比較） */
function nowTaipeiParts() {
  return msToTaipeiParts(Date.now());
}

function msToTaipeiParts(ms) {
  const shifted = new Date(ms + TZ_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    dow: shifted.getUTCDay(), // 0=週日
  };
}

/** 將「台灣時間」的年月日時分，轉成對應的 UTC 毫秒時間戳（用於排序、比較） */
function taipeiPartsToMs(y, m, d, hh = 0, mm = 0) {
  const utcMs = Date.UTC(y, m - 1, d, hh, mm, 0) - TZ_OFFSET_MS;
  return utcMs;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtDate(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }
function fmtTime(hh, mm) { return `${pad2(hh)}:${pad2(mm)}`; }

/** 把一個毫秒時間戳格式化成台灣時間的 "YYYY-MM-DD HH:MM" */
function fmtTaipei(ms) {
  const p = msToTaipeiParts(ms);
  return `${fmtDate(p.y, p.m, p.d)} ${fmtTime(p.hh, p.mm)}`;
}

/** ISO 格式時間戳記（記錄新增／修改日期用），一律以台灣時間字串儲存，方便人眼閱讀與除錯 */
function nowIsoTaipei() {
  const p = nowTaipeiParts();
  return `${fmtDate(p.y, p.m, p.d)} ${fmtTime(p.hh, p.mm)}:00+08:00`;
}

/** 本週（週一～週日）在台灣時間下的起訖毫秒時間戳 */
function thisWeekRangeMs() {
  const p = nowTaipeiParts();
  const todayMs = taipeiPartsToMs(p.y, p.m, p.d, 0, 0);
  // dow: 0=週日...6=週六 → 轉成「距離本週一有幾天」
  const diffToMonday = (p.dow === 0) ? 6 : (p.dow - 1);
  const startMs = todayMs - diffToMonday * 86400000;
  const endMs = startMs + 7 * 86400000 - 1;
  return { startMs, endMs };
}

/** 本月在台灣時間下的起訖毫秒時間戳 */
function thisMonthRangeMs() {
  const p = nowTaipeiParts();
  return monthRangeMs(p.y, p.m);
}

function monthRangeMs(y, m) {
  const startMs = taipeiPartsToMs(y, m, 1, 0, 0);
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const endMs = taipeiPartsToMs(nextY, nextM, 1, 0, 0) - 1;
  return { startMs, endMs };
}

// -----------------------------------------------------------------------
// 新增查詢維度（今日／明日／指定日期／週報／月報／季報）共用的時間範圍工具
// ----------------------------------------------------------------------
// 這次新增的「今日／明日／指定日期／週報／月報／季報」，待辦／行事曆／記事／
// 倒數日 4 個模組都要用到同一套「算出某個時間範圍的起訖毫秒」邏輯，所以集中
// 寫在這裡，4 個模組各自的指令處理只需要呼叫，不必各自重算一次。
// 鐵律：跟檔案開頭所有時間函式一樣，一律以 Asia/Taipei（GMT+8）為準。

/** 今天在台灣時間下的起訖毫秒時間戳 */
function todayRangeMs() {
  const p = nowTaipeiParts();
  const startMs = taipeiPartsToMs(p.y, p.m, p.d, 0, 0);
  return { startMs, endMs: startMs + 86400000 - 1 };
}

/** 明天在台灣時間下的起訖毫秒時間戳 */
function tomorrowRangeMs() {
  const t = todayRangeMs();
  return { startMs: t.startMs + 86400000, endMs: t.endMs + 86400000 };
}

/** 指定單一日期（年/月/日）在台灣時間下的起訖毫秒時間戳 */
function dayRangeMs(y, m, d) {
  const startMs = taipeiPartsToMs(y, m, d, 0, 0);
  return { startMs, endMs: startMs + 86400000 - 1 };
}

/** 本季（1-3／4-6／7-9／10-12月，日曆季）在台灣時間下的起訖毫秒時間戳 */
function thisQuarterRangeMs() {
  const p = nowTaipeiParts();
  return quarterRangeMs(p.y, Math.ceil(p.m / 3));
}

function quarterRangeMs(y, q) {
  const startM = (q - 1) * 3 + 1; // 1, 4, 7, 10
  const start = monthRangeMs(y, startM);
  const end = monthRangeMs(y, startM + 2); // 季內最後一個月，startM+2 最大是12，不會跨年
  return { startMs: start.startMs, endMs: end.endMs };
}

/** 把 nowIsoTaipei() 固定格式（"YYYY-MM-DD HH:MM:SS+08:00"）的字串轉回毫秒時間戳。
 *  自己手動解析、不靠 Date 字串解析（不同引擎對非標準格式解讀不一致，這也是
 *  本檔案一開始所有時間函式都手刻、不直接用 new Date(...) 的同一個理由）。
 *  用在「週報/月報/季報」要比對 createdAt／completedAt 是否落在某個期間時。 */
function parseIsoTaipeiMs(s) {
  const m = typeof s === 'string' && s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\+08:00$/);
  if (!m) return null;
  const [, y, mo, d, hh, mi] = m;
  return taipeiPartsToMs(+y, +mo, +d, +hh, +mi);
}

function msInRange(ms, range) {
  return ms != null && ms >= range.startMs && ms <= range.endMs;
}

// ---------------------------------------------------------------
// KV 輔助：流水號（不補號）＋ 記錄存取
// ---------------------------------------------------------------
//
// Key 設計：
//   cnt:evt:{scope}        行程流水號計數器（純數字字串）
//   cnt:note:{scope}       記事流水號計數器
//   evt:{scope}:{id}       單筆行程 JSON
//   note:{scope}:{id}      單筆記事 JSON
//   pending:{scope}:{token} 待確認的高風險操作（刪除），有 TTL
//
// scope 設計：1 對 1 聊天用 "u:<userId>"，群組用 "g:<groupId>"，
// 多人聊天室用 "r:<roomId>" —— 各自的行程／記事完全獨立。
//
// 流水號「不補號」：一律用目前最大號 + 1 取號，刪除／修改後原編號
// 永久保留，絕不回收。
//
// 已知限制：Cloudflater KV 沒有原子遞增／鎖，此處用「讀取現值→寫回
// +1」的方式取號，並在偵測到目標 key 已存在時重試下一個號碼，作為
// 低流量（個人／小群組使用情境）下的務實折衷。若未來寫入並發量變高
// （例如多個群組同時搶號），建議升級為 Durable Object 實作真正的
// 原子計數器。
// ---------------------------------------------------------------

async function nextId(kv, scope, kind) {
  const counterKey = `cnt:${kind}:${scope}`;
  let current = parseInt((await kv.get(counterKey)) || '0', 10);
  if (!Number.isFinite(current) || current < 0) current = 0;

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = current + 1 + attempt;
    const recKey = `${kind === 'evt' ? 'evt' : 'note'}:${scope}:${candidate}`;
    const exists = await kv.get(recKey);
    if (!exists) {
      await kv.put(counterKey, String(candidate));
      return candidate;
    }
  }
  // 極端情況下（連續碰撞 5 次）直接往後跳一段，犧牲一點編號連續性換取可用性
  const fallback = current + 101;
  await kv.put(counterKey, String(fallback));
  return fallback;
}

function recordKey(kind, scope, id) {
  return `${kind}:${scope}:${id}`;
}

async function getRecord(kv, kind, scope, id) {
  const raw = await kv.get(recordKey(kind, scope, id));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function putRecord(kv, kind, scope, id, data) {
  await kv.put(recordKey(kind, scope, id), JSON.stringify(data));
}

async function deleteRecord(kv, kind, scope, id) {
  await kv.delete(recordKey(kind, scope, id));
}

/** 列出某個 scope 下某種資料全部現存的記錄（Phase 1 資料量小，直接 list+get） */
async function listRecords(kv, kind, scope) {
  const prefix = `${kind}:${scope}:`;
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      try { out.push(JSON.parse(raw)); } catch { /* 忽略壞資料 */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------
// 來源 scope 判斷 ＋ 群組防誤觸（鐵律：一般聊天保持靜默）
// ---------------------------------------------------------------

function scopeFromSource(source) {
  if (source.type === 'group') return `g:${source.groupId}`;
  if (source.type === 'room') return `r:${source.roomId}`;
  return `u:${source.userId}`;
}

function isGroupish(source) {
  return source.type === 'group' || source.type === 'room';
}

/**
 * 群組／聊天室中，必須明確 @機器人 才會觸發文字指令；1 對 1 聊天不受限制。
 * 回傳：
 *   - null：群組中沒有被 @機器人，應保持靜默（不處理、不回覆）
 *   - 字串：已去除 mention 片段後，真正要拿去比對指令的文字
 */
function extractCommandText(text, event, source, env) {
  if (!isGroupish(source)) return text;

  // 優先使用 LINE 官方的 mention 物件（使用者在輸入框點選 @ 選單帶出的真正 mention）
  const mention = event?.message?.mention;
  if (mention && Array.isArray(mention.mentionees)) {
    const selfMention = mention.mentionees.find(
      (m) => m.isSelf === true || (env.LINE_BOT_USER_ID && m.userId === env.LINE_BOT_USER_ID)
    );
    if (selfMention) {
      const before = text.slice(0, selfMention.index);
      const after = text.slice(selfMention.index + selfMention.length);
      return (before + after).trim();
    }
    return null; // 有 mention 物件，但沒有一個是標記本機器人 → 不處理
  }

  // 後備方案：使用者手動輸入的純文字 "@機器人 指令"（沒有真正點選 mention UI 時）
  const triggerName = (env.BOT_MENTION_NAME || '@機器人').trim();
  if (text.startsWith(triggerName)) {
    return text.slice(triggerName.length).trim();
  }
  return null;
}

// ---------------------------------------------------------------
// 指令解析：行程（Event）
// ---------------------------------------------------------------

/** #01 快速一行建檔：2026-12-31  10:00  金門—廈門，待訂船票 */
const RE_EVT_CREATE = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$/;

/** #06 查詢指定區間行程 */
const RE_EVT_QUERY_BARE = /^查詢行事曆$/;
const RE_EVT_QUERY_WEEK = /^本週行程$/;
const RE_EVT_QUERY_MONTH_BARE = /^本月行程$/;
const RE_EVT_QUERY_MONTH = /^查詢行事曆\s+(\d{4})-(\d{2})$/;

/** 這次新增：今日／明日／指定日期／週報／月報／季報（AI先暫緩，這裡先做
 *  純數字統計版，不含AI生成文字）。跟上面「查詢行事曆 YYYY-MM」同一個
 *  「查詢行事曆+空格+參數」句型，多一組「日」；今日/明日比照「本週行程」
 *  「本月行程」的 bare 片語習慣；週報/月報/季報比照「XX選單」的
 *  「模組名稱在前」構詞，跟「本週行程」分開，一個是列清單、一個是算統計。 */
const RE_EVT_QUERY_TODAY = /^今日行程$/;
const RE_EVT_QUERY_TOMORROW = /^明日行程$/;
const RE_EVT_QUERY_DAY = /^查詢行事曆\s+(\d{4})-(\d{2})-(\d{2})$/;
const RE_EVT_DIGEST_WEEK = /^行事曆週報$/;
const RE_EVT_DIGEST_MONTH = /^行事曆月報$/;
const RE_EVT_DIGEST_QUARTER = /^行事曆季報$/;

/** 行事曆選單（核心進入點卡片，跟待辦選單同一套做法） */
const RE_EVT_MENU = /^行事曆選單$/;

/** #10 更新行程進度狀態 */
const RE_EVT_SET_STATUS = /^行事曆\s*#(\d+)\s*改為\s*(.+)$/;
const RE_EVT_COMPLETE = /^完成行程\s*#(\d+)$/;

/** #11 修改行程時間／刪除行程 */
const RE_EVT_SET_TIME = /^修改行程\s*#(\d+)\s*時間改為\s*(\d{1,2}):(\d{2})$/;
const RE_EVT_DELETE = /^刪除行程\s*#(\d+)$/;

/** #12 綁定地點 */
const RE_EVT_SET_LOCATION = /^行事曆\s*#(\d+)\s*地點設為\s*(.+)$/;

/** #13 附加備註 */
const RE_EVT_SET_NOTE = /^行事曆\s*#(\d+)\s*備註\s*(.+)$/;

/** #14 標記緊急 */
const RE_EVT_MARK_URGENT = /^將行程\s*#(\d+)\s*設為緊急$/;

function splitTitleStatus(rest) {
  // "金門—廈門，待訂船票" → title="金門—廈門" status="待訂船票"
  // 全半形逗號都接受；若沒有逗號，整段都是標題，狀態留空
  const idx = Math.max(rest.lastIndexOf('，'), rest.lastIndexOf(','));
  if (idx === -1) return { title: rest.trim(), status: '' };
  return { title: rest.slice(0, idx).trim(), status: rest.slice(idx + 1).trim() };
}

function newEventSkeleton() {
  const ts = nowIsoTaipei();
  return {
    title: '', status: '', startAtMs: null, location: '', note: '',
    urgent: false, createdAt: ts, updatedAt: ts,
  };
}

function mapsLink(place) {
  return `https://maps.google.com/?q=${encodeURIComponent(place)}`;
}

function fmtEventLine(id, ev) {
  const when = ev.startAtMs != null ? fmtTaipei(ev.startAtMs) : '(未設定時間)';
  let line = `#${id} [${when}] ${ev.title}`;
  if (ev.status) line += `（${ev.status}）`;
  if (ev.urgent) line = `❗ ${line}`;
  if (ev.location) line += `\n   📍 ${ev.location} ${mapsLink(ev.location)}`;
  if (ev.note) line += `\n   備註：${ev.note}`;
  return line;
}

async function handleEventCommand(text, ctx) {
  const { kv, scope } = ctx;
  let m;

  if (RE_EVT_MENU.test(text)) {
    return flexMessage('行事曆選單', eventMenuBubble(ctx));
  }

  if ((m = text.match(RE_EVT_CREATE))) {
    const [, y, mo, d, hh, mi, rest] = m;
    const { title, status } = splitTitleStatus(rest);
    const id = await nextId(kv, scope, 'evt');
    const ev = newEventSkeleton();
    ev.title = title;
    ev.status = status;
    ev.startAtMs = taipeiPartsToMs(+y, +mo, +d, +hh, +mi);
    await putRecord(kv, 'evt', scope, id, ev);
    return textReply(`已新增行程 #${id}\n${fmtEventLine(id, ev)}`);
  }

  if (RE_EVT_QUERY_BARE.test(text)) {
    return queryEvents(ctx, { fromNowOnward: true, label: '所有未來行程' });
  }
  if (RE_EVT_QUERY_WEEK.test(text)) {
    const r = thisWeekRangeMs();
    return queryEvents(ctx, { ...r, label: '本週行程' });
  }
  if (RE_EVT_QUERY_MONTH_BARE.test(text)) {
    const r = thisMonthRangeMs();
    return queryEvents(ctx, { ...r, label: '本月行程' });
  }
  if ((m = text.match(RE_EVT_QUERY_MONTH))) {
    const [, y, mo] = m;
    const r = monthRangeMs(+y, +mo);
    return queryEvents(ctx, { ...r, label: `${y}-${mo} 行程` });
  }
  if (RE_EVT_QUERY_TODAY.test(text)) {
    return queryEvents(ctx, { ...todayRangeMs(), label: '今日行程' });
  }
  if (RE_EVT_QUERY_TOMORROW.test(text)) {
    return queryEvents(ctx, { ...tomorrowRangeMs(), label: '明日行程' });
  }
  if ((m = text.match(RE_EVT_QUERY_DAY))) {
    const [, y, mo, d] = m;
    return queryEvents(ctx, { ...dayRangeMs(+y, +mo, +d), label: `${y}-${mo}-${d} 行程` });
  }
  if (RE_EVT_DIGEST_WEEK.test(text)) {
    return eventDigest(ctx, thisWeekRangeMs(), '行事曆週報');
  }
  if (RE_EVT_DIGEST_MONTH.test(text)) {
    return eventDigest(ctx, thisMonthRangeMs(), '行事曆月報');
  }
  if (RE_EVT_DIGEST_QUARTER.test(text)) {
    return eventDigest(ctx, thisQuarterRangeMs(), '行事曆季報');
  }

  if ((m = text.match(RE_EVT_SET_STATUS))) {
    return updateEventField(ctx, +m[1], (ev) => { ev.status = m[2].trim(); }, '已更新狀態');
  }
  if ((m = text.match(RE_EVT_COMPLETE))) {
    return updateEventField(ctx, +m[1], (ev) => { ev.status = '已完成'; }, '已標記完成');
  }
  if ((m = text.match(RE_EVT_SET_TIME))) {
    const [, idStr, hh, mi] = m;
    return updateEventField(ctx, +idStr, (ev) => {
      const base = ev.startAtMs != null ? msToTaipeiParts(ev.startAtMs) : nowTaipeiParts();
      ev.startAtMs = taipeiPartsToMs(base.y, base.m, base.d, +hh, +mi);
    }, '已更新時間');
  }
  if ((m = text.match(RE_EVT_SET_LOCATION))) {
    return updateEventField(ctx, +m[1], (ev) => { ev.location = m[2].trim(); }, '已設定地點');
  }
  if ((m = text.match(RE_EVT_SET_NOTE))) {
    return updateEventField(ctx, +m[1], (ev) => { ev.note = m[2].trim(); }, '已新增備註');
  }
  if ((m = text.match(RE_EVT_MARK_URGENT))) {
    return updateEventField(ctx, +m[1], (ev) => { ev.urgent = true; }, '已標記為緊急');
  }
  if ((m = text.match(RE_EVT_DELETE))) {
    return requestDeleteConfirm(ctx, 'evt', +m[1]);
  }

  return null;
}

async function updateEventField(ctx, id, mutate, okLabel) {
  const { kv, scope } = ctx;
  const ev = await getRecord(kv, 'evt', scope, id);
  if (!ev) return textReply(`找不到行程 #${id}（可能已被刪除或編號錯誤）`);
  mutate(ev);
  ev.updatedAt = nowIsoTaipei();
  await putRecord(kv, 'evt', scope, id, ev);
  return textReply(`${okLabel}：\n${fmtEventLine(id, ev)}`);
}

async function queryEvents(ctx, range) {
  const { kv, scope } = ctx;
  // listRecords 只回傳值不帶 id，查詢列表需要顯示 #id，所以改用帶 id 版本
  let rows = await listEventsWithIds(kv, scope);
  if (range.fromNowOnward) {
    const nowMs = Date.now();
    rows = rows.filter((r) => r.ev.startAtMs == null || r.ev.startAtMs >= nowMs);
  } else {
    rows = rows.filter((r) => r.ev.startAtMs != null && r.ev.startAtMs >= range.startMs && r.ev.startAtMs <= range.endMs);
  }
  rows.sort((a, b) => (a.ev.startAtMs ?? Infinity) - (b.ev.startAtMs ?? Infinity));
  rows = rows.slice(0, 20);
  if (rows.length === 0) return textReply(`${range.label}：目前沒有符合的行程`);
  const body = rows.map((r) => fmtEventLine(r.id, r.ev)).join('\n\n');
  return textReply(`${range.label}（共 ${rows.length} 筆）：\n\n${body}`);
}

/** 週報／月報／季報：純數字統計版（AI先暫緩，不含AI生成文字，只先誠實列數字）。
 *  跟 queryEvents 不一樣的地方：這裡不列出每一筆行程，只算「這段期間內
 *  共幾場、已完成幾場、標記緊急幾場」這幾個聚合數字。 */
async function eventDigest(ctx, range, label) {
  const { kv, scope } = ctx;
  const rows = await listEventsWithIds(kv, scope);
  const inRange = rows.filter((r) => msInRange(r.ev.startAtMs, range));
  const done = inRange.filter((r) => r.ev.status === '已完成').length;
  const urgent = inRange.filter((r) => r.ev.urgent).length;
  return textReply(
    `${label}：\n共 ${inRange.length} 場行程\n已完成 ${done} 場\n標記緊急 ${urgent} 場`
  );
}

async function listEventsWithIds(kv, scope) {
  const prefix = `evt:${scope}:`;
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      const id = k.name.slice(prefix.length);
      try { out.push({ id, ev: JSON.parse(raw) }); } catch { /* 忽略壞資料 */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------
// 指令解析：記事（Note）
// ---------------------------------------------------------------

/** #22 隨手文字記事（完整保留原文 Emoji，不可用上面的全系統 Icon 規則處理這裡） */
const RE_NOTE_CREATE = /^記事\s+(.+)$/s;

/** #23 追加補充內容 */
const RE_NOTE_APPEND = /^補充記事\s*#(\d+)[:：]\s*(.+)$/s;

/** #31 修改或刪除指定記事 */
const RE_NOTE_SET_CONTENT = /^修改記事\s*#(\d+)\s*內容改為\s*(.+)$/s;
const RE_NOTE_DELETE = /^刪除記事\s*#(\d+)$/;

/** #32 置頂重要備忘記事（無既有觸發詞表示取消置頂，這裡做成切換） */
const RE_NOTE_PIN = /^置頂記事\s*#(\d+)$/;

/** #40 輸出純文字訊息（方便手機長按複製：純文字訊息，不加任何系統裝飾） */
const RE_NOTE_EXPORT_PLAIN = /^輸出純文字記事\s*#(\d+)$/;

/** 這兩個是這次新加的：記事本原本沒有「列出全部」的指令（跟行事曆／待辦／
 *  倒數日期都不一樣），選單卡片要有東西可以查，所以補上最基本的查詢，
 *  排序規則跟其他模組查詢一致：置頂的在前，其餘依最後更新時間新到舊。 */
const RE_NOTE_QUERY_ALL = /^查詢記事$/;
const RE_NOTE_MENU = /^記事選單$/;

/** 這次新增：今日／指定日期／週報／月報／季報（AI先暫緩，純數字統計版）。
 *  記事沒有「明日」——記事只有 createdAt（建立時間），不像行事曆/待辦/倒數日
 *  有「未來某個日期」的欄位，不會有「明天才建立」這種事，所以不做這一個，
 *  避免做一個永遠查不到東西、語意也說不通的指令。 */
const RE_NOTE_QUERY_TODAY = /^今日記事$/;
const RE_NOTE_QUERY_DAY = /^查詢記事\s+(\d{4})-(\d{2})-(\d{2})$/;
const RE_NOTE_DIGEST_WEEK = /^記事週報$/;
const RE_NOTE_DIGEST_MONTH = /^記事月報$/;
const RE_NOTE_DIGEST_QUARTER = /^記事季報$/;

function newNoteSkeleton(content) {
  const ts = nowIsoTaipei();
  return { content, pinned: false, createdAt: ts, updatedAt: ts };
}

function fmtNoteLine(id, note) {
  let line = `#${id}${note.pinned ? ' 📌' : ''}\n${note.content}`;
  return line;
}

async function listNotesWithIds(kv, scope) {
  const prefix = `note:${scope}:`;
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      const id = k.name.slice(prefix.length);
      try { out.push({ id, note: JSON.parse(raw) }); } catch { /* 忽略壞資料 */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function queryNotes(ctx) {
  const { kv, scope } = ctx;
  const rows = await listNotesWithIds(kv, scope);
  if (rows.length === 0) return textReply('記事：目前沒有任何紀錄');
  // 置頂優先，其餘按最後更新時間新到舊（跟行事曆／倒數日期的查詢結果排序邏輯一致：
  // 都是「最該先看到的排前面」，不是單純依編號排序）
  rows.sort((a, b) => {
    if (a.note.pinned !== b.note.pinned) return a.note.pinned ? -1 : 1;
    return (b.note.updatedAt || '').localeCompare(a.note.updatedAt || '');
  });
  const shown = rows.slice(0, 20);
  const more = rows.length > 20 ? `，僅顯示最近20筆` : '';
  const body = shown.map((r) => fmtNoteLine(r.id, r.note)).join('\n\n');
  return textReply(`記事（共 ${rows.length} 筆）${more}：\n\n${body}`);
}

/** 今日／指定日期：依 createdAt（建立時間）落在範圍內篩選，排序跟 queryNotes 一致 */
async function queryNotesByRange(ctx, range, label) {
  const { kv, scope } = ctx;
  const rows = await listNotesWithIds(kv, scope);
  const inRange = rows.filter((r) => msInRange(parseIsoTaipeiMs(r.note.createdAt), range));
  if (inRange.length === 0) return textReply(`${label}：目前沒有符合的記事`);
  inRange.sort((a, b) => {
    if (a.note.pinned !== b.note.pinned) return a.note.pinned ? -1 : 1;
    return (b.note.updatedAt || '').localeCompare(a.note.updatedAt || '');
  });
  const body = inRange.map((r) => fmtNoteLine(r.id, r.note)).join('\n\n');
  return textReply(`${label}（共 ${inRange.length} 筆）：\n\n${body}`);
}

/** 週報／月報／季報：純數字統計版（AI先暫緩，不含AI生成文字） */
async function noteDigest(ctx, range, label) {
  const { kv, scope } = ctx;
  const rows = await listNotesWithIds(kv, scope);
  const inRange = rows.filter((r) => msInRange(parseIsoTaipeiMs(r.note.createdAt), range));
  const pinnedNow = rows.filter((r) => r.note.pinned).length;
  return textReply(
    `${label}：\n本期新增 ${inRange.length} 筆記事\n目前置頂 ${pinnedNow} 筆（現況，不分期間）`
  );
}

async function handleNoteCommand(text, ctx) {
  const { kv, scope } = ctx;
  let m;

  if (RE_NOTE_MENU.test(text)) {
    return flexMessage('記事選單', noteMenuBubble(ctx));
  }
  if (RE_NOTE_QUERY_ALL.test(text)) {
    return queryNotes(ctx);
  }
  if (RE_NOTE_QUERY_TODAY.test(text)) {
    return queryNotesByRange(ctx, todayRangeMs(), '今日記事');
  }
  if ((m = text.match(RE_NOTE_QUERY_DAY))) {
    const [, y, mo, d] = m;
    return queryNotesByRange(ctx, dayRangeMs(+y, +mo, +d), `${y}-${mo}-${d} 記事`);
  }
  if (RE_NOTE_DIGEST_WEEK.test(text)) {
    return noteDigest(ctx, thisWeekRangeMs(), '記事週報');
  }
  if (RE_NOTE_DIGEST_MONTH.test(text)) {
    return noteDigest(ctx, thisMonthRangeMs(), '記事月報');
  }
  if (RE_NOTE_DIGEST_QUARTER.test(text)) {
    return noteDigest(ctx, thisQuarterRangeMs(), '記事季報');
  }

  // 先比對更specific 的指令，避免被寬鬆的「記事 ...」規則誤吃
  if ((m = text.match(RE_NOTE_EXPORT_PLAIN))) {
    const note = await getRecord(kv, 'note', scope, +m[1]);
    if (!note) return textReply(`找不到記事 #${m[1]}`);
    // 鐵律 #40：純文字輸出，不加任何系統裝飾字樣，方便手機長按整段複製
    return textReply(note.content);
  }
  if ((m = text.match(RE_NOTE_APPEND))) {
    const note = await getRecord(kv, 'note', scope, +m[1]);
    if (!note) return textReply(`找不到記事 #${m[1]}`);
    note.content = `${note.content}\n${m[2]}`;
    note.updatedAt = nowIsoTaipei();
    await putRecord(kv, 'note', scope, +m[1], note);
    return textReply(`已補充記事：\n${fmtNoteLine(m[1], note)}`);
  }
  if ((m = text.match(RE_NOTE_SET_CONTENT))) {
    const note = await getRecord(kv, 'note', scope, +m[1]);
    if (!note) return textReply(`找不到記事 #${m[1]}`);
    note.content = m[2];
    note.updatedAt = nowIsoTaipei();
    await putRecord(kv, 'note', scope, +m[1], note);
    return textReply(`已修改記事：\n${fmtNoteLine(m[1], note)}`);
  }
  if ((m = text.match(RE_NOTE_PIN))) {
    const note = await getRecord(kv, 'note', scope, +m[1]);
    if (!note) return textReply(`找不到記事 #${m[1]}`);
    note.pinned = !note.pinned;
    note.updatedAt = nowIsoTaipei();
    await putRecord(kv, 'note', scope, +m[1], note);
    return textReply(`${note.pinned ? '已置頂' : '已取消置頂'}：\n${fmtNoteLine(m[1], note)}`);
  }
  if ((m = text.match(RE_NOTE_DELETE))) {
    return requestDeleteConfirm(ctx, 'note', +m[1]);
  }
  if ((m = text.match(RE_NOTE_CREATE))) {
    const id = await nextId(kv, scope, 'note');
    const note = newNoteSkeleton(m[1]);
    await putRecord(kv, 'note', scope, id, note);
    return textReply(`已新增記事 #${id}\n${note.content}`);
  }

  return null;
}

// ---------------------------------------------------------------
// 指令解析：待辦清單（Todo）—— #99 #100 #101 #102 #104
// （#103 提醒、#105 批次封存這次沒做，見檔案最後的說明）
//
// 跟行事曆（evt）最大的不同：dueAtMs 可以是 null（沒有期限），
// 這正是待辦清單存在的理由——「有空再看」這種事，塞進一定要有
// 日期時間的行事曆反而是異類。
// ---------------------------------------------------------------

const PRIORITY_SUFFIX_RE = /[，,]\s*(高|中|低)優先\s*$/;
const ASSIGNEE_SUFFIX_RE = /[，,]\s*負責人[:：]?\s*(\S+)\s*$/;

/** 從「待辦」指令的剩餘文字裡，剝離可選的「，高優先」「，負責人：XX」
 *  後綴（兩種都可能出現，順序不限），回傳乾淨的標題 */
function parseTodoRest(rest) {
  let title = rest.trim();
  let priority = '';
  let assignee = '';
  for (let i = 0; i < 2; i++) {
    let m;
    if (!priority && (m = title.match(PRIORITY_SUFFIX_RE))) {
      priority = m[1];
      title = title.slice(0, m.index).trim();
      continue;
    }
    if (!assignee && (m = title.match(ASSIGNEE_SUFFIX_RE))) {
      assignee = m[1];
      title = title.slice(0, m.index).trim();
      continue;
    }
    break;
  }
  return { title, priority, assignee };
}

const RE_TODO_CREATE_DATETIME = /^待辦\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$/s;
const RE_TODO_CREATE_DATE = /^待辦\s+(\d{4})-(\d{2})-(\d{2})\s+(.+)$/s;
const RE_TODO_CREATE_BARE = /^待辦\s+(.+)$/s;

const RE_TODO_MENU = /^待辦選單$/;
const RE_TODO_QUERY_ALL = /^查詢待辦$/;
const RE_TODO_QUERY_TODAY = /^今天該做的待辦$/;
const RE_TODO_QUERY_OVERDUE = /^已逾期待辦$/;
const RE_TODO_QUERY_PRIORITY = /^(高|中|低)優先待辦$/;
const RE_TODO_QUERY_ASSIGNEE = /^(.+)的待辦$/;

/** 這次新增：今日／明日／指定日期／週報／月報／季報（AI先暫緩，純數字統計版）。
 *  「今日待辦」是「今天該做的待辦」的新別名，查詢邏輯完全相同，只是換一個
 *  跟行事曆「今日行程」、倒數日「今日倒數日」一致的講法，方便記；原本
 *  「今天該做的待辦」繼續保留，不拿掉。這3個新的 QUERY regex 都是數字
 *  開頭或固定詞開頭，不會跟上面「(.+)的待辦」衝突，但比照既有慣例（見下面
 *  dispatch 裡的註解）仍然排在 ASSIGNEE 判斷之前比對，不留模糊地帶。 */
const RE_TODO_QUERY_TODAY_ALIAS = /^今日待辦$/;
const RE_TODO_QUERY_TOMORROW = /^明日待辦$/;
const RE_TODO_QUERY_DAY = /^查詢待辦\s+(\d{4})-(\d{2})-(\d{2})$/;
const RE_TODO_DIGEST_WEEK = /^待辦週報$/;
const RE_TODO_DIGEST_MONTH = /^待辦月報$/;
const RE_TODO_DIGEST_QUARTER = /^待辦季報$/;

const RE_TODO_COMPLETE = /^完成待辦\s*#(\d+)$/;
const RE_TODO_SET_STATUS = /^待辦\s*#(\d+)\s*改[為回]\s*(.+)$/;
const RE_TODO_SET_DUE = /^修改待辦\s*#(\d+)\s*期限改為\s*(\d{4})-(\d{2})-(\d{2})$/;
const RE_TODO_DELETE = /^刪除待辦\s*#(\d+)$/;
const RE_TODO_TO_EVENT = /^把待辦\s*#(\d+)\s*轉成行事曆\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/;

function newTodoSkeleton(title) {
  const ts = nowIsoTaipei();
  return {
    title, status: '未開始', priority: '', dueAtMs: null, hasDueTime: false,
    assignee: '', note: '', createdAt: ts, updatedAt: ts,
    completedAt: null, // 這次新增：只有「完成待辦」真的觸發時才會寫入，供週報/月報/季報統計「本期完成幾筆」用；舊資料沒有這個欄位一律視為 null，不會被誤算進任何一期
  };
}

function fmtTodoLine(id, t) {
  let line = `#${id} ${t.title}`;
  if (t.priority) line += `（${t.priority}優先）`;
  line += ` [${t.status}]`;
  if (t.dueAtMs != null) {
    const p = msToTaipeiParts(t.dueAtMs);
    line += t.hasDueTime
      ? `\n   期限：${fmtDate(p.y, p.m, p.d)} ${fmtTime(p.hh, p.mm)}`
      : `\n   期限：${fmtDate(p.y, p.m, p.d)}`;
  }
  if (t.assignee) line += `\n   負責人：${t.assignee}`;
  return line;
}

async function handleTodoCommand(text, ctx) {
  const { kv, scope } = ctx;
  let m;

  if (RE_TODO_MENU.test(text)) {
        return flexMessage('時光筆記選單', todoMenuBubble(ctx));
  }

  // 先比對更specific 的指令，避免被寬鬆的「待辦 ...」規則誤吃
  if ((m = text.match(RE_TODO_COMPLETE))) {
    return updateTodoField(ctx, +m[1], (t) => { t.status = '已完成'; t.completedAt = nowIsoTaipei(); }, '已標記完成');
  }
  if ((m = text.match(RE_TODO_SET_STATUS))) {
    // 改成別的狀態（含改回「未開始」之類）就不算完成了，completedAt 要跟著清掉，
    // 不然週報/月報/季報會把「已經改口的舊完成紀錄」誤算進去
    return updateTodoField(ctx, +m[1], (t) => { t.status = m[2].trim(); if (t.status !== '已完成') t.completedAt = null; }, '已更新狀態');
  }
  if ((m = text.match(RE_TODO_SET_DUE))) {
    const [, idStr, y, mo, d] = m;
    return updateTodoField(ctx, +idStr, (t) => {
      t.dueAtMs = taipeiPartsToMs(+y, +mo, +d, 0, 0);
      t.hasDueTime = false;
    }, '已更新期限');
  }
  if ((m = text.match(RE_TODO_TO_EVENT))) {
    return convertTodoToEvent(ctx, +m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  }
  if ((m = text.match(RE_TODO_DELETE))) {
    return requestDeleteConfirm(ctx, 'todo', +m[1]);
  }

  if (RE_TODO_QUERY_ALL.test(text)) {
    return queryTodos(ctx, (t) => t.status !== '已完成', '時光筆記');
  }
  if (RE_TODO_QUERY_TODAY.test(text)) {
    const p = nowTaipeiParts();
    const endMs = taipeiPartsToMs(p.y, p.m, p.d, 0, 0) + 86400000 - 1;
    return queryTodos(ctx, (t) => t.status !== '已完成' && t.dueAtMs != null && t.dueAtMs <= endMs, '今天該做的待辦');
  }
  if (RE_TODO_QUERY_OVERDUE.test(text)) {
    const nowMs = Date.now();
    return queryTodos(ctx, (t) => t.status !== '已完成' && t.dueAtMs != null && t.dueAtMs < nowMs, '已逾期待辦');
  }
  if ((m = text.match(RE_TODO_QUERY_PRIORITY))) {
    const pr = m[1];
    return queryTodos(ctx, (t) => t.status !== '已完成' && t.priority === pr, `${pr}優先待辦`);
  }
  if (RE_TODO_QUERY_TODAY_ALIAS.test(text)) {
    // 跟「今天該做的待辦」完全同一條邏輯（含逾期）：這個查詢的用意是「今天該
    // 動手處理的事」，本來就該把過期還沒做的也一起顯示，不是只看今天到期的
    const endMs = todayRangeMs().endMs;
    return queryTodos(ctx, (t) => t.status !== '已完成' && t.dueAtMs != null && t.dueAtMs <= endMs, '今日待辦');
  }
  if (RE_TODO_QUERY_TOMORROW.test(text)) {
    // 跟「今日待辦」刻意不同：這裡只看「剛好明天到期」這一天的範圍，不累加
    // 今天／逾期的（那些「今日待辦」已經看得到），單純當作「預覽明天」用
    const r = tomorrowRangeMs();
    return queryTodos(ctx, (t) => t.status !== '已完成' && t.dueAtMs != null && t.dueAtMs >= r.startMs && t.dueAtMs <= r.endMs, '明日待辦');
  }
  if ((m = text.match(RE_TODO_QUERY_DAY))) {
    const [, y, mo, d] = m;
    const r = dayRangeMs(+y, +mo, +d);
    return queryTodos(ctx, (t) => t.status !== '已完成' && t.dueAtMs != null && t.dueAtMs >= r.startMs && t.dueAtMs <= r.endMs, `${y}-${mo}-${d} 該做的待辦`);
  }
  if (RE_TODO_DIGEST_WEEK.test(text)) {
    return todoDigest(ctx, thisWeekRangeMs(), '待辦週報');
  }
  if (RE_TODO_DIGEST_MONTH.test(text)) {
    return todoDigest(ctx, thisMonthRangeMs(), '待辦月報');
  }
  if (RE_TODO_DIGEST_QUARTER.test(text)) {
    return todoDigest(ctx, thisQuarterRangeMs(), '待辦季報');
  }

  if ((m = text.match(RE_TODO_CREATE_DATETIME))) {
    const [, y, mo, d, hh, mi, rest] = m;
    const { title, priority, assignee } = parseTodoRest(rest);
    return createTodo(ctx, title, { dueAtMs: taipeiPartsToMs(+y, +mo, +d, +hh, +mi), hasDueTime: true, priority, assignee });
  }
  if ((m = text.match(RE_TODO_CREATE_DATE))) {
    const [, y, mo, d, rest] = m;
    const { title, priority, assignee } = parseTodoRest(rest);
    return createTodo(ctx, title, { dueAtMs: taipeiPartsToMs(+y, +mo, +d, 0, 0), hasDueTime: false, priority, assignee });
  }

  // 負責人查詢跟「待辦 建立」用的都是「開頭/結尾很寬鬆」的形狀，刻意放在
  // 明確的建立／查詢指令都比對失敗之後才試，兩者之間的極端邊界情況
  // （例如標題本身就叫「X的待辦」）接受有歧義，不過度設計正規表達式。
  if ((m = text.match(RE_TODO_QUERY_ASSIGNEE))) {
    const who = m[1].trim();
    return queryTodos(ctx, (t) => t.status !== '已完成' && t.assignee === who, `${who}的待辦`);
  }

  if ((m = text.match(RE_TODO_CREATE_BARE))) {
    const { title, priority, assignee } = parseTodoRest(m[1]);
    return createTodo(ctx, title, { dueAtMs: null, hasDueTime: false, priority, assignee });
  }

  return null;
}

async function createTodo(ctx, title, extra) {
  const { kv, scope } = ctx;
  const id = await nextId(kv, scope, 'todo');
  const t = newTodoSkeleton(title);
  Object.assign(t, extra);
  await putRecord(kv, 'todo', scope, id, t);
  return todoResultReply(`已新增待辦 #${id}\n${fmtTodoLine(id, t)}`, id, t, ctx);
}

async function updateTodoField(ctx, id, mutate, okLabel) {
  const { kv, scope } = ctx;
  const t = await getRecord(kv, 'todo', scope, id);
  if (!t) return textReply(`找不到待辦 #${id}（可能已被刪除或編號錯誤）`);
  mutate(t);
  t.updatedAt = nowIsoTaipei();
  await putRecord(kv, 'todo', scope, id, t);
  return todoResultReply(`${okLabel}：\n${fmtTodoLine(id, t)}`, id, t, ctx);
}

async function listTodosWithIds(kv, scope) {
  const prefix = `todo:${scope}:`;
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      const id = k.name.slice(prefix.length);
      try { out.push({ id, t: JSON.parse(raw) }); } catch { /* 忽略壞資料 */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function queryTodos(ctx, filterFn, label) {
  const { kv, scope } = ctx;
  let rows = await listTodosWithIds(kv, scope);
  rows = rows.filter((r) => filterFn(r.t));
  rows.sort((a, b) => (a.t.dueAtMs ?? Infinity) - (b.t.dueAtMs ?? Infinity));
  rows = rows.slice(0, 20);
  return todoCarouselReply(ctx, rows, label);
}

/** 週報／月報／季報：純數字統計版（AI先暫緩，不含AI生成文字）。
 *  「本期新增」「本期完成」依 createdAt／completedAt 落在期間內計算；
 *  「目前未完成」「目前已逾期」是現況快照，不分期間（逾期是累積出來的，
 *  不會因為查的是「週報」就只看這週到期的，誠實反映現在真正卡著幾筆）。
 *  completedAt 是這次新增的欄位，這次之前就已完成的舊資料沒有這個時間戳，
 *  一律不計入「本期完成」（但完成狀態本身不受影響，不影響「未完成」計數）。 */
async function todoDigest(ctx, range, label) {
  const { kv, scope } = ctx;
  const rows = await listTodosWithIds(kv, scope);
  const created = rows.filter((r) => msInRange(parseIsoTaipeiMs(r.t.createdAt), range)).length;
  const completed = rows.filter((r) => msInRange(parseIsoTaipeiMs(r.t.completedAt), range)).length;
  const nowMs = Date.now();
  const openNow = rows.filter((r) => r.t.status !== '已完成').length;
  const overdueNow = rows.filter((r) => r.t.status !== '已完成' && r.t.dueAtMs != null && r.t.dueAtMs < nowMs).length;
  return textReply(
    `${label}：\n本期新增 ${created} 筆\n本期完成 ${completed} 筆\n目前未完成 ${openNow} 筆（現況，不分期間）\n目前已逾期 ${overdueNow} 筆（現況，不分期間）`
  );
}

async function convertTodoToEvent(ctx, todoId, y, mo, d, hh, mi) {
  const { kv, scope } = ctx;
  const t = await getRecord(kv, 'todo', scope, todoId);
  if (!t) return textReply(`找不到待辦 #${todoId}（可能已被刪除或編號錯誤）`);
  const evId = await nextId(kv, scope, 'evt');
  const ev = newEventSkeleton();
  ev.title = t.title;
  ev.startAtMs = taipeiPartsToMs(y, mo, d, hh, mi);
  if (t.note) ev.note = t.note;
  await putRecord(kv, 'evt', scope, evId, ev);
  // 轉成行事曆後原待辦直接刪除（不是這個鐵律講的「高風險刪除」，是使用者
  // 透過同一個指令要求的轉換動作，所以不另外跑二次確認流程）；流水號
  // 不補號的鐵律仍然適用——#{todoId} 這個待辦編號不會被下一筆待辦用掉。
  await deleteRecord(kv, 'todo', scope, todoId);
  return textReply(`已將待辦 #${todoId} 轉成行事曆 #${evId}（原待辦編號不會再被使用）\n${fmtEventLine(evId, ev)}`);
}

// ---------------------------------------------------------------
// 指令解析：倒數日期（Countdown）—— #106 #107 #108 #109 #111
// （#110 到期自動主動推播這次沒做，見檔案最後的說明）
//
// 不存「倒數／正算」方向——每次顯示時直接拿 targetYmd 跟今天比較、
// 即時算出來，這樣「倒數日」的日期一旦過了，下次查詢會自動變成
// 「正算」顯示，不需要額外程式碼去處理這個轉換。
// ---------------------------------------------------------------

const RE_CD_CREATE = /^(倒數日|紀念日)\s+(\d{4})-(\d{2})-(\d{2})\s+(.+)$/s;
const RE_CD_QUERY = /^(查詢倒數日|我的倒數日清單)$/;
const RE_CD_MENU = /^倒數日選單$/;
const RE_CD_SET_REPEAT = /^倒數日\s*#(\d+)\s*設為每年重複$/;
const RE_CD_SET_TITLE = /^修改倒數日\s*#(\d+)\s*標題改為\s*(.+)$/s;
const RE_CD_DELETE = /^刪除倒數日\s*#(\d+)$/;
const RE_CD_LINK = /^將倒數日\s*#(\d+)\s*關聯到(行事曆|記事)\s*#(\d+)$/;

/** 這次新增：今日／明日／指定日期／週報／月報／季報（AI先暫緩，純數字統計版）。
 *  今日/明日/指定日期這3個是依「目標日期」篩選（而不是建立時間）——
 *  意思是「今天/明天/那天就是倒數日到期的那天」，這樣才有實際提醒的用處；
 *  如果設定了「每年重複」，目標日期用今年或明年最近的下一次生效，邏輯
 *  跟既有的 cdDaysInfo() 一致（見下面 effectiveCountdownTargetMs，刻意
 *  另外寫一份、不去改 cdDaysInfo 本體，降低這次異動對既有功能的風險）。 */
const RE_CD_QUERY_TODAY = /^今日倒數日$/;
const RE_CD_QUERY_TOMORROW = /^明日倒數日$/;
const RE_CD_QUERY_DAY = /^查詢倒數日\s+(\d{4})-(\d{2})-(\d{2})$/;
const RE_CD_DIGEST_WEEK = /^倒數日週報$/;
const RE_CD_DIGEST_MONTH = /^倒數日月報$/;
const RE_CD_DIGEST_QUARTER = /^倒數日季報$/;

function newCountdownSkeleton(title, y, m, d) {
  const ts = nowIsoTaipei();
  return { title, y, m, d, repeatYearly: false, linkKind: '', linkId: null, createdAt: ts, updatedAt: ts };
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 年份／月份往後退一天找安全日期（處理 2/29 遇到平年的情況：退回2/28） */
function safeYmdMs(y, m, d) {
  return taipeiPartsToMs(y, m, Math.min(d, daysInMonth(y, m)), 0, 0);
}

function cdDaysInfo(cd, todayP) {
  const todayMs = taipeiPartsToMs(todayP.y, todayP.m, todayP.d, 0, 0);
  let targetMs = safeYmdMs(cd.y, cd.m, cd.d);
  if (cd.repeatYearly && targetMs < todayMs) {
    let ny = todayP.y;
    let candMs = safeYmdMs(ny, cd.m, cd.d);
    if (candMs < todayMs) { ny += 1; candMs = safeYmdMs(ny, cd.m, cd.d); }
    targetMs = candMs;
  }
  const diffDays = Math.round((targetMs - todayMs) / 86400000);
  return diffDays >= 0 ? { days: diffDays, direction: '後' } : { days: -diffDays, direction: '前' };
}

function fmtCountdownLine(id, cd, todayP) {
  const { days, direction } = cdDaysInfo(cd, todayP);
  let line = `#${id} ${cd.title}${cd.repeatYearly ? '（每年重複）' : ''}\n   ${fmtDate(cd.y, cd.m, cd.d)} · ${days} 天${direction}`;
  if (cd.linkKind) line += `\n   關聯：${cd.linkKind} #${cd.linkId}`;
  return line;
}

/** 算出這筆倒數日「真正會顯示的目標日期」毫秒時間戳：沒設定每年重複的話
 *  就是存的那個日期；設定了每年重複、而且那個日期已經過了，就跳到今年或
 *  明年最近的下一次——邏輯特意跟 cdDaysInfo() 內部算法保持一致，但另外
 *  獨立寫一份（不把 cdDaysInfo 改成呼叫共用函式），降低這次異動動到
 *  既有「查詢倒數日」排序/顯示邏輯的風險。 */
function effectiveCountdownTargetMs(cd, todayP) {
  const todayMs = taipeiPartsToMs(todayP.y, todayP.m, todayP.d, 0, 0);
  let targetMs = safeYmdMs(cd.y, cd.m, cd.d);
  if (cd.repeatYearly && targetMs < todayMs) {
    let ny = todayP.y;
    let candMs = safeYmdMs(ny, cd.m, cd.d);
    if (candMs < todayMs) { ny += 1; candMs = safeYmdMs(ny, cd.m, cd.d); }
    targetMs = candMs;
  }
  return targetMs;
}

/** 今日／明日／指定日期：依「目標日期」（而非建立時間）篩選 */
async function queryCountdownsByTargetRange(ctx, range, label) {
  const { kv, scope } = ctx;
  const rows = await listCountdownsWithIds(kv, scope);
  const todayP = nowTaipeiParts();
  const inRange = rows.filter((r) => msInRange(effectiveCountdownTargetMs(r.cd, todayP), range));
  if (inRange.length === 0) return textReply(`${label}：目前沒有符合的倒數日`);
  inRange.sort((a, b) => effectiveCountdownTargetMs(a.cd, todayP) - effectiveCountdownTargetMs(b.cd, todayP));
  const body = inRange.map((r) => fmtCountdownLine(r.id, r.cd, todayP)).join('\n\n');
  return textReply(`${label}（共 ${inRange.length} 筆）：\n\n${body}`);
}

/** 週報／月報／季報：純數字統計版（AI先暫緩，不含AI生成文字）。
 *  「本期到期」依目標日期落在期間內計算；「本期新增」依 createdAt；
 *  「目前共幾筆」是現況快照，不分期間。 */
async function countdownDigest(ctx, range, label) {
  const { kv, scope } = ctx;
  const rows = await listCountdownsWithIds(kv, scope);
  const todayP = nowTaipeiParts();
  const dueInRange = rows.filter((r) => msInRange(effectiveCountdownTargetMs(r.cd, todayP), range)).length;
  const createdInRange = rows.filter((r) => msInRange(parseIsoTaipeiMs(r.cd.createdAt), range)).length;
  return textReply(
    `${label}：\n本期到期 ${dueInRange} 筆\n本期新增 ${createdInRange} 筆\n目前共 ${rows.length} 筆（現況，不分期間）`
  );
}

async function handleCountdownCommand(text, ctx) {
  const { kv, scope } = ctx;
  let m;

  if (RE_CD_MENU.test(text)) {
    return flexMessage('倒數日選單', countdownMenuBubble(ctx));
  }

  if ((m = text.match(RE_CD_SET_REPEAT))) {
    return updateCountdownField(ctx, +m[1], (cd) => { cd.repeatYearly = true; }, '已設定每年重複');
  }
  if ((m = text.match(RE_CD_SET_TITLE))) {
    return updateCountdownField(ctx, +m[1], (cd) => { cd.title = m[2].trim(); }, '已修改標題');
  }
  if ((m = text.match(RE_CD_LINK))) {
    const [, idStr, kindLabel, linkIdStr] = m;
    return updateCountdownField(ctx, +idStr, (cd) => { cd.linkKind = kindLabel; cd.linkId = +linkIdStr; }, '已設定關聯');
  }
  if ((m = text.match(RE_CD_DELETE))) {
    return requestDeleteConfirm(ctx, 'cd', +m[1]);
  }
  if (RE_CD_QUERY.test(text)) {
    const rows = await listCountdownsWithIds(kv, scope);
    if (rows.length === 0) return textReply('倒數日期：目前沒有任何紀錄');
    const todayP = nowTaipeiParts();
    rows.sort((a, b) => cdDaysInfo(a.cd, todayP).days - cdDaysInfo(b.cd, todayP).days);
    const body = rows.map((r) => fmtCountdownLine(r.id, r.cd, todayP)).join('\n\n');
    return textReply(`倒數日期（共 ${rows.length} 筆）：\n\n${body}`);
  }
  if (RE_CD_QUERY_TODAY.test(text)) {
    return queryCountdownsByTargetRange(ctx, todayRangeMs(), '今日倒數日');
  }
  if (RE_CD_QUERY_TOMORROW.test(text)) {
    return queryCountdownsByTargetRange(ctx, tomorrowRangeMs(), '明日倒數日');
  }
  if ((m = text.match(RE_CD_QUERY_DAY))) {
    const [, y, mo, d] = m;
    return queryCountdownsByTargetRange(ctx, dayRangeMs(+y, +mo, +d), `${y}-${mo}-${d} 倒數日`);
  }
  if (RE_CD_DIGEST_WEEK.test(text)) {
    return countdownDigest(ctx, thisWeekRangeMs(), '倒數日週報');
  }
  if (RE_CD_DIGEST_MONTH.test(text)) {
    return countdownDigest(ctx, thisMonthRangeMs(), '倒數日月報');
  }
  if (RE_CD_DIGEST_QUARTER.test(text)) {
    return countdownDigest(ctx, thisQuarterRangeMs(), '倒數日季報');
  }
  if ((m = text.match(RE_CD_CREATE))) {
    const [, , y, mo, d, title] = m;
    const id = await nextId(kv, scope, 'cd');
    const cd = newCountdownSkeleton(title.trim(), +y, +mo, +d);
    await putRecord(kv, 'cd', scope, id, cd);
    const todayP = nowTaipeiParts();
    return textReply(`已新增倒數日 #${id}\n${fmtCountdownLine(id, cd, todayP)}`);
  }

  return null;
}

async function updateCountdownField(ctx, id, mutate, okLabel) {
  const { kv, scope } = ctx;
  const cd = await getRecord(kv, 'cd', scope, id);
  if (!cd) return textReply(`找不到倒數日 #${id}（可能已被刪除或編號錯誤）`);
  mutate(cd);
  cd.updatedAt = nowIsoTaipei();
  await putRecord(kv, 'cd', scope, id, cd);
  const todayP = nowTaipeiParts();
  return textReply(`${okLabel}：\n${fmtCountdownLine(id, cd, todayP)}`);
}

async function listCountdownsWithIds(kv, scope) {
  const prefix = `cd:${scope}:`;
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      const id = k.name.slice(prefix.length);
      try { out.push({ id, cd: JSON.parse(raw) }); } catch { /* 忽略壞資料 */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------
// 指令解析：日期計算機（Date Calculator）—— #112 #113 #114 #115 #116
// 完全無狀態，不碰 KV，純粹計算完直接回覆文字。
// ---------------------------------------------------------------

function addMonthsClamped(y, m, d, delta) {
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (((total % 12) + 12) % 12) + 1;
  return { y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) };
}

const WEEKDAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'];
function weekdayCharToDow(ch) {
  if (ch === '天') return 0;
  const i = WEEKDAY_CHARS.indexOf(ch);
  return i === -1 ? null : i;
}
function dowToWeekdayLabel(dow) { return '星期' + WEEKDAY_CHARS[dow]; }
function mondayOfThisWeekMs() { return thisWeekRangeMs().startMs; }

const RE_DC_RANGE = /^計算\s+(\d{4})-(\d{2})-(\d{2})\s+到\s+(\d{4})-(\d{2})-(\d{2})\s+中間幾天$/;
const RE_DC_UNTIL = /^到\s+(\d{4})-(\d{2})-(\d{2})\s+還有幾天$/;
const RE_DC_ADD_FROM_DATE = /^(\d{4})-(\d{2})-(\d{2})\s+(加|減)\s*(\d+)\s*(天|週|個月|月|年)\s*是幾號$/;
const RE_DC_ADD_FROM_TODAY = /^今天(加|減)\s*(\d+)\s*(天|週|個月|月|年)\s*是幾號$/;
const RE_DC_WEEKDAY_OF = /^(\d{4})-(\d{2})-(\d{2})\s+星期幾$/;
const RE_DC_AGE = /^(\d{4})-(\d{2})-(\d{2})\s+出生[，,]?\s*現在幾歲$/;
const RE_DC_TENURE = /^(\d{4})-(\d{2})-(\d{2})\s+到職[，,]?\s*現在年資幾年$/;
const RE_DC_NEXT_WEEKDAY_N = /^下(\d+)個星期([一二三四五六日天])是幾號$/;
const RE_DC_NEXT_WEEKDAY_2 = /^下下週([一二三四五六日天])是幾號$/;
const RE_DC_NEXT_WEEKDAY_1 = /^下週([一二三四五六日天])是幾號$/;
const RE_DC_LAST_WEEKDAY_OF_MONTH = /^這個月最後一個星期([一二三四五六日天])是幾號$/;
const RE_DC_MENU = /^日期計算選單$/;

function handleDateCalcCommand(text, ctx) {
  let m;

  if (RE_DC_MENU.test(text)) {
    return flexMessage('日期計算選單', datecalcMenuBubble(ctx));
  }

  if ((m = text.match(RE_DC_RANGE))) {
    const ms1 = taipeiPartsToMs(+m[1], +m[2], +m[3], 0, 0);
    const ms2 = taipeiPartsToMs(+m[4], +m[5], +m[6], 0, 0);
    const days = Math.round((ms2 - ms1) / 86400000);
    return textReply(`${m[1]}-${m[2]}-${m[3]} 到 ${m[4]}-${m[5]}-${m[6]} 中間共 ${Math.abs(days)} 天`);
  }
  if ((m = text.match(RE_DC_UNTIL))) {
    const p = nowTaipeiParts();
    const todayMs = taipeiPartsToMs(p.y, p.m, p.d, 0, 0);
    const targetMs = taipeiPartsToMs(+m[1], +m[2], +m[3], 0, 0);
    const days = Math.round((targetMs - todayMs) / 86400000);
    return textReply(days >= 0 ? `到 ${m[1]}-${m[2]}-${m[3]} 還有 ${days} 天` : `${m[1]}-${m[2]}-${m[3]} 已經過了 ${-days} 天`);
  }
  if ((m = text.match(RE_DC_ADD_FROM_DATE))) {
    return replyDateAdd(+m[1], +m[2], +m[3], m[4], +m[5], m[6]);
  }
  if ((m = text.match(RE_DC_ADD_FROM_TODAY))) {
    const p = nowTaipeiParts();
    return replyDateAdd(p.y, p.m, p.d, m[1], +m[2], m[3]);
  }
  if ((m = text.match(RE_DC_WEEKDAY_OF))) {
    const dow = msToTaipeiParts(taipeiPartsToMs(+m[1], +m[2], +m[3], 12, 0)).dow;
    return textReply(`${m[1]}-${m[2]}-${m[3]} 是${dowToWeekdayLabel(dow)}`);
  }
  if ((m = text.match(RE_DC_AGE))) {
    const p = nowTaipeiParts();
    let age = p.y - (+m[1]);
    const hadBirthdayThisYear = (p.m > +m[2]) || (p.m === +m[2] && p.d >= +m[3]);
    if (!hadBirthdayThisYear) age -= 1;
    return textReply(`${m[1]}-${m[2]}-${m[3]} 出生，現在 ${age} 歲`);
  }
  if ((m = text.match(RE_DC_TENURE))) {
    const p = nowTaipeiParts();
    const startMs = taipeiPartsToMs(+m[1], +m[2], +m[3], 0, 0);
    const todayMs = taipeiPartsToMs(p.y, p.m, p.d, 0, 0);
    const totalDays = Math.round((todayMs - startMs) / 86400000);
    let years = p.y - (+m[1]);
    const hadAnniversaryThisYear = (p.m > +m[2]) || (p.m === +m[2] && p.d >= +m[3]);
    if (!hadAnniversaryThisYear) years -= 1;
    return textReply(`${m[1]}-${m[2]}-${m[3]} 到職，現在年資 ${years} 年（共 ${totalDays} 天）`);
  }
  if ((m = text.match(RE_DC_NEXT_WEEKDAY_N))) {
    return replyNextWeekday(+m[1], weekdayCharToDow(m[2]));
  }
  if ((m = text.match(RE_DC_NEXT_WEEKDAY_2))) {
    return replyNextWeekday(2, weekdayCharToDow(m[1]));
  }
  if ((m = text.match(RE_DC_NEXT_WEEKDAY_1))) {
    return replyNextWeekday(1, weekdayCharToDow(m[1]));
  }
  if ((m = text.match(RE_DC_LAST_WEEKDAY_OF_MONTH))) {
    const targetDow = weekdayCharToDow(m[1]);
    const { endMs } = thisMonthRangeMs();
    let curMs = taipeiPartsToMs(msToTaipeiParts(endMs).y, msToTaipeiParts(endMs).m, msToTaipeiParts(endMs).d, 0, 0);
    // endMs 是「下月1號0時減1毫秒」，上面那行先把它正規化回本月最後一天的0時
    for (let i = 0; i < 7; i++) {
      if (msToTaipeiParts(curMs).dow === targetDow) {
        const pp = msToTaipeiParts(curMs);
        return textReply(`這個月最後一個${dowToWeekdayLabel(targetDow)}是 ${fmtDate(pp.y, pp.m, pp.d)}`);
      }
      curMs -= 86400000;
    }
    return textReply('找不到符合的日期（不應該發生，請回報）');
  }

  return null;
}

function replyDateAdd(y, m, d, opWord, amount, unit) {
  const sign = opWord === '減' ? -1 : 1;
  let ry, rm, rd;
  if (unit === '天' || unit === '週') {
    const days = unit === '週' ? amount * 7 : amount;
    const ms = taipeiPartsToMs(y, m, d, 0, 0) + sign * days * 86400000;
    const p = msToTaipeiParts(ms);
    ry = p.y; rm = p.m; rd = p.d;
  } else if (unit === '個月' || unit === '月') {
    ({ y: ry, m: rm, d: rd } = addMonthsClamped(y, m, d, sign * amount));
  } else {
    ({ y: ry, m: rm, d: rd } = addMonthsClamped(y, m, d, sign * amount * 12));
  }
  return textReply(`${fmtDate(y, m, d)} ${opWord} ${amount}${unit}是 ${fmtDate(ry, rm, rd)}`);
}

function replyNextWeekday(weeksAhead, targetDow) {
  if (targetDow == null) return textReply('看不懂指定的星期，請用一二三四五六日');
  const mondayMs = mondayOfThisWeekMs(); // 本週（含今天）的週一
  const dowOffsetFromMonday = targetDow === 0 ? 6 : targetDow - 1;
  // 「下週」="下一個完整的下個星期"，所以要從本週一再往後跳 weeksAhead 個
  // 7天（不是 weeksAhead-1），否則「下週三」會算到本週三去。
  const targetMs = mondayMs + (weeksAhead * 7 + dowOffsetFromMonday) * 86400000;
  const p = msToTaipeiParts(targetMs);
  const label = weeksAhead === 1 ? '下週' : weeksAhead === 2 ? '下下週' : `下${weeksAhead}個星期`;
  return textReply(`${label}${WEEKDAY_CHARS[targetDow]}是 ${fmtDate(p.y, p.m, p.d)}`);
}

// ---------------------------------------------------------------
// 高風險操作：刪除二次確認（鐵律：必須先回傳預覽確認卡片，點擊允許後才執行）
// ---------------------------------------------------------------

const PENDING_TTL_SEC = 5 * 60; // 5 分鐘，與規格 #72 的復原時間窗一致
const KIND_LABELS = { evt: '行程', note: '記事', todo: '待辦', cd: '倒數日' };

function fmtRecordLine(kind, id, rec) {
  if (kind === 'evt') return fmtEventLine(id, rec);
  if (kind === 'note') return fmtNoteLine(id, rec);
  if (kind === 'todo') return fmtTodoLine(id, rec);
  if (kind === 'cd') return fmtCountdownLine(id, rec, nowTaipeiParts());
  return `#${id}`;
}

async function requestDeleteConfirm(ctx, kind, id) {
  const { kv, scope, userId } = ctx;
  const rec = await getRecord(kv, kind, scope, id);
  if (!rec) {
    return textReply(`找不到${KIND_LABELS[kind] || kind} #${id}（可能已被刪除或編號錯誤）`);
  }
  const token = crypto.randomUUID();
  await kv.put(
    `pending:${scope}:${token}`,
    JSON.stringify({ action: 'delete', kind, id, requesterId: userId }),
    { expirationTtl: PENDING_TTL_SEC }
  );
  const label = KIND_LABELS[kind] || kind;
  const summary = fmtRecordLine(kind, id, rec);
  return confirmTemplateReply(
    `確定要刪除${label} #${id} 嗎？\n\n${summary}`,
    { label: '確認刪除', data: JSON.stringify({ a: 'del', t: token }) },
    { label: '取消', data: JSON.stringify({ a: 'cancel', t: token }) }
  );
}

async function handlePostback(dataStr, ctx) {
  const { kv, scope, userId } = ctx;
  let data;
  try { data = JSON.parse(dataStr); } catch { return null; }
  if (!data) return null;

  // 待辦清單 Flex 卡片上的「完成」／「刪除」按鈕——跟下面既有的
  // pending-token 二次確認流程是兩條分開的路：這兩個 action 不帶
  // data.t（不是在回應某張已經發出的確認卡片），而是使用者直接在
  // 清單／卡片上點按鈕觸發的第一步動作。
  if (data.a === 'todo_complete') {
    return updateTodoField(ctx, data.id, (t) => { t.status = '已完成'; t.completedAt = nowIsoTaipei(); }, '已標記完成');
  }
  if (data.a === 'todo_delreq') {
    // 刪除一律要先出二次確認卡片（鐵律），所以卡片上的刪除按鈕直接
    // 呼叫跟文字指令「刪除待辦 #id」完全相同的函式，確保兩種進入點
    // （打字 or 點卡片）共用同一套風險控管，不是另外寫一套較寬鬆的。
    return requestDeleteConfirm(ctx, 'todo', data.id);
  }

  if (!data.t) return null;

  const pendingKey = `pending:${scope}:${data.t}`;
  const raw = await kv.get(pendingKey);
  if (!raw) return textReply('這個確認卡片已經過期或已被處理，請重新操作一次。');
  const pending = JSON.parse(raw);

  // 僅限原始發出刪除指令的人可以點擊確認／取消，避免群組內被他人誤觸
  if (pending.requesterId && userId && pending.requesterId !== userId) {
    return null; // 保持靜默，不洩漏任何資訊給非當事人
  }

  await kv.delete(pendingKey);

  if (data.a === 'cancel') {
    return textReply('已取消，沒有任何變更。');
  }
  if (data.a === 'del') {
    const label = KIND_LABELS[pending.kind] || pending.kind;
    await deleteRecord(kv, pending.kind, scope, pending.id);
    // 鐵律：流水號不補號 —— 這裡只刪除資料本身，完全不動計數器，
    // 所以 #{id} 這個編號永遠不會再被用掉。
    return textReply(`已刪除${label} #${pending.id}（編號不會被重複使用）`);
  }
  return null;
}

// ---------------------------------------------------------------
// LINE 回覆訊息格式
// ---------------------------------------------------------------

function textReply(text) {
  return [{ type: 'text', text }];
}

function confirmTemplateReply(altSummary, yes, no) {
  return [{
    type: 'template',
    altText: altSummary.slice(0, 400),
    template: {
      type: 'confirm',
      text: altSummary.slice(0, 240), // LINE confirm template 文字長度上限
      actions: [
        { type: 'postback', label: yes.label, data: yes.data },
        { type: 'postback', label: no.label, data: no.data },
      ],
    },
  }];
}

// ---------------------------------------------------------------
// 待辦清單 LINE 核心畫面（Flex Message）—— Icon化介面
//
// Icon 圖檔跟著這支 Worker 自己的 public/icons/ 一起部署（沿用 SDA
// 「日常小秘書」同一套手法：lucide-static 線條圖示，統一改色成
// #8b7355），網址用「這次請求打進來的 origin」組出來，不寫死網域——
// 不管使用者把這支 Worker 取名叫什麼、部署到哪個 *.workers.dev 子網域，
// 圖示網址都自動對，不會因為忘記改設定而整批失效。
// 透過 /internal/dispatch 被 SDA 轉送進來的請求，origin 一樣是這支
// Worker 自己的網址（SDA 是打「這支 Worker 的網址」+ /internal/dispatch，
// 不是打 SDA 自己的網址），所以兩種進線方式圖示都抓得到。
// ---------------------------------------------------------------

const BRAND_BG = '#ffffff';
const BRAND_BORDER = '#d9cfc2';
const BRAND_TEXT = '#5c4b37';
const BRAND_SUBTLE = '#a89c8a';
const BRAND_OVERDUE = '#c0392b';

function iconUrl(ctx, slug) {
  return `${ctx.origin || ''}/icons/${encodeURIComponent(slug)}.png`;
}

/** 「長得像按鈕的 box」：圖示＋文字，底色／邊框跟SDA既有風格一致，action 掛在整個 box 上 */
function iconButtonBox(ctx, { slug, text, action, flex }) {
  return {
    type: 'box', layout: 'horizontal', flex: flex ?? 1,
    backgroundColor: BRAND_BG, borderColor: BRAND_BORDER, borderWidth: '1px',
    cornerRadius: 'md', paddingAll: '8px', spacing: 'xs',
    alignItems: 'center', justifyContent: 'center',
    action,
    contents: [
      { type: 'image', url: iconUrl(ctx, slug), size: '18px', flex: 0, aspectMode: 'fit' },
      { type: 'text', text, size: 'sm', color: BRAND_TEXT, flex: 0, gravity: 'center' },
    ],
  };
}

function iconRow(ctx, slug, text, color) {
  return {
    type: 'box', layout: 'horizontal', spacing: 'xs', alignItems: 'center',
    contents: [
      { type: 'image', url: iconUrl(ctx, slug), size: '14px', flex: 0, aspectMode: 'fit' },
      { type: 'text', text, size: 'xs', color: color || BRAND_TEXT, wrap: true, flex: 1 },
    ],
  };
}

function msgTextAction(label, text) {
  return { type: 'message', label, text };
}

/** 單筆待辦 → 一張 Flex 卡片（bubble）：標題列、期限／優先／負責人（有才顯示）、完成／刪除按鈕 */
function todoBubble(ctx, id, t) {
  const done = t.status === '已完成';
  const body = [
    {
      type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
      contents: [
        { type: 'image', url: iconUrl(ctx, done ? 'todo_checked' : 'todo_unchecked'), size: '20px', flex: 0, aspectMode: 'fit' },
        { type: 'text', text: t.title || '(無標題)', weight: 'bold', wrap: true, flex: 1, color: BRAND_TEXT, size: 'md' },
      ],
    },
    { type: 'text', text: `#${id}${t.status && !done ? '・' + t.status : done ? '・已完成' : ''}`, size: 'xxs', color: BRAND_SUBTLE },
  ];
  if (t.dueAtMs != null) {
    const overdue = !done && t.dueAtMs < Date.now();
    const p = msToTaipeiParts(t.dueAtMs);
    const dueStr = t.hasDueTime ? `${fmtDate(p.y, p.m, p.d)} ${fmtTime(p.hh, p.mm)}` : fmtDate(p.y, p.m, p.d);
    body.push(iconRow(ctx, overdue ? 'todo_overdue' : 'todo_due', overdue ? `${dueStr}（已逾期）` : dueStr, overdue ? BRAND_OVERDUE : BRAND_TEXT));
  }
  if (t.priority) body.push(iconRow(ctx, 'todo_priority', `${t.priority}優先`));
  if (t.assignee) body.push(iconRow(ctx, 'todo_assignee', t.assignee));

  const footerButtons = [];
  if (!done) {
    footerButtons.push(iconButtonBox(ctx, {
      slug: 'todo_checked', text: '完成',
      action: { type: 'postback', label: '完成', data: JSON.stringify({ a: 'todo_complete', id }), displayText: `完成待辦 #${id}` },
    }));
  }
  footerButtons.push(iconButtonBox(ctx, {
    slug: 'todo_delete', text: '刪除',
    action: { type: 'postback', label: '刪除', data: JSON.stringify({ a: 'todo_delreq', id }), displayText: `刪除待辦 #${id}` },
  }));

  return {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: body },
    footer: { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '8px', contents: footerButtons },
  };
}

function flexMessage(altText, contents) {
  return [{ type: 'flex', altText: altText.slice(0, 400), contents }];
}

/** 單筆待辦的操作結果：原本就有的那行文字確認（格式不變，既有測試沿用）＋ 該筆的 Flex 卡片 */
function todoResultReply(fullText, id, t, ctx) {
  return [...textReply(fullText), ...flexMessage(`#${id} ${t.title}`, todoBubble(ctx, id, t))];
}

const TODO_CAROUSEL_MAX = 10;

/** 待辦清單查詢結果 → Flex carousel（多張卡片橫滑），取代純文字清單 */
function todoCarouselReply(ctx, rows, label) {
  if (rows.length === 0) return textReply(`${label}：目前沒有符合的待辦`);
  const shown = rows.slice(0, TODO_CAROUSEL_MAX);
  const bubbles = shown.map((r) => todoBubble(ctx, r.id, r.t));
  const more = rows.length > TODO_CAROUSEL_MAX ? `，僅顯示前${TODO_CAROUSEL_MAX}筆，請用更精確的條件縮小範圍` : '';
  return flexMessage(`${label}（共 ${rows.length} 筆）${more}`, { type: 'carousel', contents: bubbles });
}

/** 待辦選單（核心進入點卡片）：五顆Icon按鈕，沿用SDA一致的視覺風格 */
function todoMenuBubble(ctx) {
  const row = (slug, text, action) => iconButtonBox(ctx, { slug, text, action });
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', paddingAll: '12px',
      contents: [
        { type: 'image', url: iconUrl(ctx, 'todo_menu'), size: '22px', flex: 0, aspectMode: 'fit' },
        { type: 'text', text: '時光筆記', weight: 'bold', size: 'lg', color: BRAND_TEXT },      ],
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
      contents: [
        // 用 postback + inputOption/fillInText（LINE 官方文件明確支援這個組合的動作類型）
        // 幫使用者把輸入框先打上「待辦 」再打開鍵盤，不用自己記格式；這顆按鈕本身的
        // postback data 刻意給一個 handlePostback 認不得、會安全忽略的值（不觸發任何動作），
        // 真正的新增動作是使用者自己把標題打完、按下送出之後才發生。
        row('todo_add', '新增待辦', { type: 'postback', label: '新增待辦', data: JSON.stringify({ a: 'noop' }), inputOption: 'openKeyboard', fillInText: '待辦 ' }),
        row('todo_query', '查詢待辦', msgTextAction('查詢待辦', '查詢待辦')),
        row('todo_due', '今天該做的', msgTextAction('今天該做的待辦', '今天該做的待辦')),
        row('todo_overdue', '已逾期', msgTextAction('已逾期待辦', '已逾期待辦')),
        row('todo_priority', '高優先', msgTextAction('高優先待辦', '高優先待辦')),
      ],
    },
  };
}

// ---------------------------------------------------------------
// 下面4個是這次新增的選單（行事曆／記事本／倒數日期／日期計算機），
// 做法跟上面 todoMenuBubble 完全一樣的套路。幾個共同的設計決定：
//
// 1.「新增」「查詢」兩顆通用按鈕直接沿用 todo_add／todo_query 這兩個
//    圖示——按鈕上顯示的文字（iconButtonBox 的 text 參數）才是使用者
//    看到的字，跟圖示檔名完全無關，所以沿用舊圖示不會讓畫面看起來
//    「跑錯模組」。
// 2. 按鈕視覺上顯示的文字，可以跟實際送出的指令文字不一樣（action 的
//    text/label 才是真正送出去的指令）——例如「全部行程」按下去實際
//    送出的是「查詢行事曆」，這樣按鈕才不會因為指令本身比較長而太擠。
// 3. 記事本原本沒有「查詢記事」這個指令（跟其他3個模組都不一樣），
//    這次補在 handleNoteCommand 那邊一起加上，選單才有東西可查。
// 4. 行事曆的新增指令沒有固定字首（就是「YYYY-MM-DD HH:MM 標題」），
//    沒辦法比照待辦／記事／倒數日預填一個關鍵字，改預填「今天的日期」
//    當起點；日期計算機每種算法需要的格式都不同、也沒有「不用打字」
//    版本，所以5顆按鈕全部都是「預填今天日期的完整範例指令」，使用者
//    改掉日期數字就能用，不用自己記10種語法。
// ---------------------------------------------------------------

/** 行事曆選單 */
function eventMenuBubble(ctx) {
  const row = (slug, text, action) => iconButtonBox(ctx, { slug, text, action });
  const today = nowTaipeiParts();
  const todayStr = fmtDate(today.y, today.m, today.d);
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', paddingAll: '12px',
      contents: [
        { type: 'image', url: iconUrl(ctx, 'evt_menu'), size: '22px', flex: 0, aspectMode: 'fit' },
        { type: 'text', text: '行事曆', weight: 'bold', size: 'lg', color: BRAND_TEXT },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
      contents: [
        row('todo_add', '新增行程', { type: 'postback', label: '新增行程', data: JSON.stringify({ a: 'noop' }), inputOption: 'openKeyboard', fillInText: `${todayStr} ` }),
        row('evt_week', '本週行程', msgTextAction('本週行程', '本週行程')),
        row('evt_month', '本月行程', msgTextAction('本月行程', '本月行程')),
        row('todo_query', '全部行程', msgTextAction('查詢行事曆', '查詢行事曆')),
      ],
    },
  };
}

/** 記事選單 */
function noteMenuBubble(ctx) {
  const row = (slug, text, action) => iconButtonBox(ctx, { slug, text, action });
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', paddingAll: '12px',
      contents: [
        { type: 'image', url: iconUrl(ctx, 'note_menu'), size: '22px', flex: 0, aspectMode: 'fit' },
        { type: 'text', text: '記事本', weight: 'bold', size: 'lg', color: BRAND_TEXT },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
      contents: [
        row('todo_add', '新增記事', { type: 'postback', label: '新增記事', data: JSON.stringify({ a: 'noop' }), inputOption: 'openKeyboard', fillInText: '記事 ' }),
        row('todo_query', '查詢記事', msgTextAction('查詢記事', '查詢記事')),
      ],
    },
  };
}

/** 倒數日選單 */
function countdownMenuBubble(ctx) {
  const row = (slug, text, action) => iconButtonBox(ctx, { slug, text, action });
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', paddingAll: '12px',
      contents: [
        { type: 'image', url: iconUrl(ctx, 'cd_menu'), size: '22px', flex: 0, aspectMode: 'fit' },
        { type: 'text', text: '倒數日期', weight: 'bold', size: 'lg', color: BRAND_TEXT },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
      contents: [
        row('todo_add', '新增倒數日', { type: 'postback', label: '新增倒數日', data: JSON.stringify({ a: 'noop' }), inputOption: 'openKeyboard', fillInText: '倒數日 ' }),
        row('todo_query', '查詢倒數日', msgTextAction('查詢倒數日', '查詢倒數日')),
      ],
    },
  };
}

/** 日期計算選單——5顆按鈕都是「預填今天日期的完整範例指令」，不是關鍵字開頭 */
function datecalcMenuBubble(ctx) {
  const row = (slug, text, action) => iconButtonBox(ctx, { slug, text, action });
  const today = nowTaipeiParts();
  const todayStr = fmtDate(today.y, today.m, today.d);
  const fill = (label, template) => ({ type: 'postback', label, data: JSON.stringify({ a: 'noop' }), inputOption: 'openKeyboard', fillInText: template });
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', paddingAll: '12px',
      contents: [
        { type: 'image', url: iconUrl(ctx, 'dc_menu'), size: '22px', flex: 0, aspectMode: 'fit' },
        { type: 'text', text: '日期計算機', weight: 'bold', size: 'lg', color: BRAND_TEXT },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
      contents: [
        row('dc_until', '到期還有幾天', fill('到期還有幾天', `到 ${todayStr} 還有幾天`)),
        row('dc_range', '計算天數區間', fill('計算天數區間', `計算 ${todayStr} 到 ${todayStr} 中間幾天`)),
        row('dc_addsub', '日期加減', fill('日期加減', '今天加7天是幾號')),
        row('dc_weekday', '查星期幾', fill('查星期幾', `${todayStr} 星期幾`)),
        row('dc_age', '算年齡', fill('算年齡', `${todayStr} 出生，現在幾歲`)),
      ],
    },
  };
}

async function lineReply(replyToken, messages, env) {
  if (!messages || messages.length === 0) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

// ---------------------------------------------------------------
// LINE 簽章驗證
// ---------------------------------------------------------------

async function verifyLineSignature(rawBody, signatureHeader, channelSecret) {
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computed = base64FromArrayBuffer(sigBuf);
  return timingSafeEqual(computed, signatureHeader);
}

function base64FromArrayBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------
// 單一事件處理（text message / postback）—— 供 webhook 入口與測試共用
// ---------------------------------------------------------------

async function handleSingleEvent(event, env, origin) {
  const source = event.source || {};
  const scope = scopeFromSource(source);
  const userId = source.userId || null;
  const kv = env.CALNOTE_KV;
  const ctx = { kv, scope, userId, env, origin };

  if (event.type === 'message' && event.message?.type === 'text') {
    const raw = event.message.text || '';
    const cmdText = extractCommandText(raw, event, source, env);
    if (cmdText == null) return null; // 群組中未被 @機器人 → 保持靜默

    let reply = await handleEventCommand(cmdText, ctx);
    if (!reply) reply = await handleNoteCommand(cmdText, ctx);
    if (!reply) reply = await handleTodoCommand(cmdText, ctx);
    if (!reply) reply = await handleCountdownCommand(cmdText, ctx);
    if (!reply) reply = handleDateCalcCommand(cmdText, ctx); // 計算本身無狀態，不吃 kv/scope；ctx 只給「日期計算選單」組圖示網址跟預填今天日期用
    return reply; // 沒有任何指令比對成功 → null，不回覆（避免群組洗版）
  }

  if (event.type === 'postback') {
    const data = event.postback?.data || '';
    return handlePostback(data, ctx);
  }

  return null;
}

// ---------------------------------------------------------------
// Worker 入口
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// 內部派送端點（V2 新增）：給「日常小秘書」(SDA) 的 _worker.js 用同一個
// LINE 官方帳號轉送過來——使用者改成只加一個LINE好友，不用另外加 calnote
// 這個機器人。SDA 那邊轉送來的請求不帶 LINE 簽章（因為不是 LINE 直接送
// 來的），改成比對共用密鑰 env.CALNOTE_INTERNAL_SECRET。
//
// 刻意不改動、不刪除下面既有的 LINE webhook 分支：如果之後想改回獨立
// LINE帳號，原本的路直接還能用，不用重寫。
// ---------------------------------------------------------------
async function handleInternalDispatch(request, env) {
  const secret = env.CALNOTE_INTERNAL_SECRET;
  if (!secret || request.headers.get('x-internal-secret') !== secret) {
    return new Response('unauthorized', { status: 401 });
  }
  let body;
  try { body = JSON.parse(await request.text()); } catch { return new Response('bad request', { status: 400 }); }
  const text = body && body.text;
  const source = body && body.source;
  if (!text || !source || !source.type) {
    return new Response(JSON.stringify({ handled: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const event = { type: 'message', message: { type: 'text', text, mention: body.mention }, source };
  // origin 用「這支 Worker 自己被打進來的網址」算出來（SDA 轉送時，打的也是
  // 這支 calnote Worker 的 /internal/dispatch，不是 SDA 自己的網址），待辦清單
  // 卡片裡的圖示網址才能正確組出來，不用另外寫死網域。
  const origin = new URL(request.url).origin;
  let reply = null;
  try {
    reply = await handleSingleEvent(event, env, origin);
  } catch (err) {
    console.error('internal dispatch 處理失敗', err);
    return new Response(JSON.stringify({ handled: false, error: 'internal error' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (!reply) {
    return new Response(JSON.stringify({ handled: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ handled: true, reply }), { status: 200, headers: { 'content-type': 'application/json' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/internal/dispatch') {
      return handleInternalDispatch(request, env);
    }

    if (request.method !== 'POST') {
      return new Response('行事曆／記事本系統 Webhook（獨立新專案，Phase 1）', { status: 200 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get('x-line-signature');
    const ok = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
    if (!ok) {
      return new Response('signature validation failed', { status: 401 });
    }

    let payload;
    try { payload = JSON.parse(rawBody); } catch { return new Response('bad request', { status: 400 }); }

    const events = payload.events || [];
    for (const event of events) {
      try {
        const reply = await handleSingleEvent(event, env, url.origin);
        if (reply && event.replyToken) {
          await lineReply(event.replyToken, reply, env);
        }
      } catch (err) {
        // 單一事件處理失敗不應影響其他事件；記錄後繼續
        console.error('事件處理失敗', err);
      }
    }

    return new Response('OK', { status: 200 });
  },
};

// ---------------------------------------------------------------
// 測試用匯出（正式運作不受影響，純粹方便 Node 測試直接呼叫內部函式）
// ---------------------------------------------------------------
export const __TEST__ = {
  nowTaipeiParts, msToTaipeiParts, taipeiPartsToMs, fmtTaipei, nowIsoTaipei,
  thisWeekRangeMs, thisMonthRangeMs, monthRangeMs,
  nextId, getRecord, putRecord, deleteRecord, listRecords, listEventsWithIds,
  scopeFromSource, isGroupish, extractCommandText,
  handleEventCommand, handleNoteCommand, handlePostback, requestDeleteConfirm,
  handleSingleEvent, verifyLineSignature, splitTitleStatus,
  // 待辦清單／倒數日期／日期計算機（calnote+App 合併後新增的三個模組）
  handleTodoCommand, handleCountdownCommand, handleDateCalcCommand,
  parseTodoRest, fmtTodoLine, listTodosWithIds, convertTodoToEvent,
  cdDaysInfo, fmtCountdownLine, listCountdownsWithIds,
  daysInMonth, addMonthsClamped, weekdayCharToDow, dowToWeekdayLabel,
  replyDateAdd, replyNextWeekday, mondayOfThisWeekMs,
  // 內部派送端點（給 SDA 轉送用）
  handleInternalDispatch,
  // 待辦清單 LINE 核心畫面（Flex Message／Icon化介面）
  iconUrl, todoBubble, todoMenuBubble, todoCarouselReply, todoResultReply, flexMessage,
  // 行事曆／記事本／倒數日期／日期計算機 這4個新增的選單卡片，以及補上的「查詢記事」
  eventMenuBubble, noteMenuBubble, countdownMenuBubble, datecalcMenuBubble,
  queryNotes, listNotesWithIds,
  // 這次新增：今日/明日/指定日期/週報/月報/季報（4模組共用的時間範圍工具＋各模組統計函式）
  todayRangeMs, tomorrowRangeMs, dayRangeMs, thisQuarterRangeMs, quarterRangeMs,
  parseIsoTaipeiMs, msInRange,
  eventDigest, todoDigest, noteDigest, countdownDigest,
  queryNotesByRange, queryCountdownsByTargetRange, effectiveCountdownTargetMs,
};
