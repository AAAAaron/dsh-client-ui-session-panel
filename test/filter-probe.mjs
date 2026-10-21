import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const WebSocket = require("/Users/ray/.dsh-clean-test/profiles/web/node_modules/ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = process.env.DSH_CDP || "http://127.0.0.1:9222";
const targets = await (await fetch(CDP + "/json/list")).json();
const page = targets.find((t) => t.type === "page");
const socket = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { socket.once("open", res); socket.once("error", rej); });
let id = 1; const pending = new Map(); const pageErrors = [];
socket.on("message", (raw) => { const m = JSON.parse(raw.toString());
  if (m.method === "Runtime.exceptionThrown") pageErrors.push((m.params.exceptionDetails.exception?.description || "").slice(0, 200));
  if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const send = (method, params = {}) => { const n = id++; socket.send(JSON.stringify({ id: n, method, params })); return new Promise((resolve, reject) => pending.set(n, { resolve, reject })); };
const evaluate = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return "ERR:" + String(r.exceptionDetails.exception?.description).slice(0, 200); return r.result.value; };
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? "  OK   " : "  FAIL ") + name + (detail ? "  " + JSON.stringify(detail) : "")); };
const board = `document.querySelector('[data-dsh-plugin="session-panel"]')`;
const cardCount = () => evaluate(`(() => { const r = ${board}; return r ? r.querySelectorAll('.dsp-card').length : -1; })()`);

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const BASE = process.env.DSH_VERIFY_BASE || "http://127.0.0.1:3099";
await send("Page.navigate", { url: BASE + "/?token=" + process.argv[2] });
await sleep(8000);
await evaluate(`(() => { const c = [...document.querySelectorAll('button')].find((el) => (el.textContent||"").trim() === "继续"); if (c) c.click(); return true; })()`);
await sleep(600);
for (let i = 0; i < 3; i += 1) {
	const shown = await evaluate(`Boolean(${board})`);
	if (shown) break;
	await evaluate(`(() => { const e = [...document.querySelectorAll('button,[role="button"],a')].find((el) => (el.textContent||"").trim() === "会话"); if (e) e.click(); return Boolean(e); })()`);
	await sleep(2000);
}
await sleep(1500);
// 1) 筛选条存在
const bar = await evaluate(`(() => {
  const root = ${board};
  const group = root.querySelector('.dsp-filter');
  if (!group) return null;
  return [...group.querySelectorAll('.dsp-filter-btn')].map((b) => ({ label: (b.textContent||"").trim(), pressed: b.getAttribute("aria-pressed") }));
})()`);
check("看板有筛选条（全部/最近20/近半小时）", Array.isArray(bar) && bar.length === 3, bar);

// 起始状态归零：用 UI 点「全部会话」（筛选会存在本机，探针每次都从全量开始）
await evaluate(`(() => {
  const root = ${board};
  const btn = [...root.querySelectorAll('.dsp-filter-btn')].find((b) => (b.textContent||"").indexOf("全部") >= 0);
  if (btn) btn.click();
  return Boolean(btn);
})()`);
// 等会话目录真正加载完（刚打开看板有一小段空窗）
let all = 0;
for (let i = 0; i < 20; i += 1) {
	all = await cardCount();
	if (all > 0) break;
	await sleep(700);
}
check("全部模式显示全部会话", all > 50, all);

// 2) 点「最近 20 个」
await evaluate(`(() => {
  const root = ${board};
  const btn = [...root.querySelectorAll('.dsp-filter-btn')].find((b) => (b.textContent||"").indexOf("最近") >= 0);
  if (btn) btn.click();
  return Boolean(btn);
})()`);
await sleep(1200);
const recent = await cardCount();
check("点「最近 20 个」后只剩 20 张卡", recent === 20, { all, recent });

// 3) 点「近半小时有变化」
await evaluate(`(() => {
  const root = ${board};
  const btn = [...root.querySelectorAll('.dsp-filter-btn')].find((b) => (b.textContent||"").indexOf("近半小时") >= 0);
  if (btn) btn.click();
  return Boolean(btn);
})()`);
await sleep(1500);
const halfHour = await cardCount();
const halfMeta = await evaluate(`(() => { const m = document.querySelector('[data-dsh-plugin="session-panel"] .dsp-meta'); return m ? m.textContent : ""; })()`);
check("点「近半小时」后卡片变少且少于 20", halfHour < recent, { halfHour, recent });
check("页头显示筛选后计数", /筛选后显示/.test(halfMeta), halfMeta);

// 4) 点「全部会话」恢复
await evaluate(`(() => {
  const root = ${board};
  const btn = [...root.querySelectorAll('.dsp-filter-btn')].find((b) => (b.textContent||"").indexOf("全部") >= 0);
  if (btn) btn.click();
  return Boolean(btn);
})()`);
await sleep(1200);
const restored = await cardCount();
check("点「全部会话」恢复全量", restored === all, { restored, all });

// 5) 右栏筛选条存在（同一 store）
await evaluate(`(() => { const c = document.querySelector('[data-dsh-plugin="session-panel"] .dsp-card:not(.is-current)'); if (c) c.click(); return Boolean(c); })()`);
await sleep(2500);
for (let i = 0; i < 3; i += 1) {
	const shown = await evaluate(`(() => [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].some((n) => n.getBoundingClientRect().width > 0))()`);
	if (shown) break;
	await evaluate(`(() => { const b = document.querySelector('button[aria-label="会话卡片栏"]'); if (b) b.click(); return Boolean(b); })()`);
	await sleep(2500);
}
const railBar = await evaluate(`(() => {
  const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0);
  if (!rail) return null;
  const group = rail.querySelector('.dsp-filter');
  return group ? [...group.querySelectorAll('.dsp-filter-btn')].map((b) => (b.textContent||"").trim()) : null;
})()`);
check("右栏也有紧凑筛选条", Array.isArray(railBar) && railBar.length === 3, railBar);

// 6) 右栏点「20」→ 右栏卡片变 20
await evaluate(`(() => {
  const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0);
  const btn = [...rail.querySelectorAll('.dsp-filter-btn')].find((b) => (b.textContent||"").trim() === "20");
  if (btn) btn.click();
  return Boolean(btn);
})()`);
await sleep(1200);
const railCount = await evaluate(`(() => {
  const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0);
  return rail ? rail.querySelectorAll('.dsp-card').length : -1;
})()`);
check("右栏点「20」后只剩 20 张卡", railCount === 20, railCount);

// 7) 切回看板，验证筛选状态同步（共享同一个 store）
await evaluate(`(() => { const e = [...document.querySelectorAll('button,[role="button"],a')].find((el) => (el.textContent||"").trim() === "会话"); if (e) e.click(); return Boolean(e); })()`);
await sleep(2500);
const boardAfter = await cardCount();
const boardPressed = await evaluate(`(() => {
  const root = ${board};
  if (!root) return null;
  const btn = [...root.querySelectorAll('.dsp-filter-btn')].find((b) => (b.textContent||"").indexOf("最近") >= 0);
  return btn ? btn.getAttribute("aria-pressed") : null;
})()`);
check("看板与右栏筛选状态同步（卡片数一致）", boardAfter === 20, boardAfter);
check("看板上「最近 20 个」处于按下态", boardPressed === "true", boardPressed);

check("页面无 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 2));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(process.argv[3], Buffer.from(shot.data, "base64"));
console.log(JSON.stringify({ failed: results.filter((r) => !r.ok).length, total: results.length }));
socket.close();
