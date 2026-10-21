/**
 * 浮窗专项验证（需要真实浏览器）：点「浮动」出窗、拖标题栏移动、拖右下角缩放、
 * 几何写进 localStorage、刷新后位置保留、点 ✕ 关闭。
 *
 * 用法：先起一个临时实例和 headless Chrome（见 README「验证」），然后
 *   DSH_VERIFY_BASE=http://127.0.0.1:3099 node test/float-probe.mjs <token> /tmp/float.png
 *
 * 为什么单独一个文件：浏览器检查主流程里合成指针事件驱动不了指针捕获，
 * 这里改用真实鼠标事件，能稳定复现用户的拖动。
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const WebSocket = require(process.env.DSH_WS_MODULE || "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await (await fetch((process.env.DSH_CDP || "http://127.0.0.1:9223") + "/json/list")).json();
const page = targets.find((t) => t.type === "page");
const socket = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { socket.once("open", res); socket.once("error", rej); });
let id = 1; const pending = new Map(); const errors = [];
socket.on("message", (raw) => { const m = JSON.parse(raw.toString());
  if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception?.description || "").slice(0, 200));
  if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const send = (method, params = {}) => { const n = id++; socket.send(JSON.stringify({ id: n, method, params })); return new Promise((resolve, reject) => pending.set(n, { resolve, reject })); };
const evaluate = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return "ERR:" + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 200); return r.result.value; };
const out = [];
const check = (name, ok, detail) => { out.push({ name, ok }); console.log((ok ? "  OK  " : "  FAIL") + " " + name + (detail ? "  " + String(detail).slice(0, 160) : "")); };
const boxOf = () => evaluate(`(() => {
  const el = document.querySelector('[data-dsh-plugin="session-panel-float"]');
  if (!el) return { present: false };
  const r = el.getBoundingClientRect();
  return { present: true, left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), cards: el.querySelectorAll('.dsp-card').length };
})()`);

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: (process.env.DSH_VERIFY_BASE || "http://127.0.0.1:3099") + "/?token=" + process.argv[2] });
await sleep(8000);
await evaluate(`(() => { const c = [...document.querySelectorAll('button')].find((el) => (el.textContent||"").trim() === "继续"); if (c) c.click(); return true; })()`);
await sleep(400);
await evaluate(`(() => { for (const k of ["dsh.session-panel.float.v1","dsh.session-panel.hidden.v1","dsh.session-panel.collapsed.v1"]) localStorage.removeItem(k); return true; })()`);
await send("Page.reload", { ignoreCache: true });
await sleep(8000);
await evaluate(`(() => { const c = [...document.querySelectorAll('button')].find((el) => (el.textContent||"").trim() === "继续"); if (c) c.click(); return true; })()`);
await sleep(400);
// 打开一个有内容的会话（hero 页没有对话头部，也就没有右栏按钮）
await evaluate(`(() => { const e = [...document.querySelectorAll('button,[role="button"],a')].find((el) => (el.textContent||"").trim() === "会话"); if (e) e.click(); return Boolean(e); })()`);
await sleep(1500);
await evaluate(`(() => { const cards=[...document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-card')]; const p=cards.find((c)=>!c.classList.contains("is-archived")&&!c.classList.contains("is-current")); if(p)p.click(); return Boolean(p); })()`);
await sleep(3000);

// 开右栏
for (let i = 0; i < 3; i += 1) {
  const shown = await evaluate(`Boolean(document.querySelector('[data-dsh-plugin="session-panel-rail"]') && document.querySelector('[data-dsh-plugin="session-panel-rail"]').getBoundingClientRect().width > 0)`);
  if (shown) break;
  await evaluate(`(() => { const b = document.querySelector('button[aria-label="会话卡片栏"]'); if (b) b.click(); return Boolean(b); })()`);
  await sleep(1800);
}
check("右栏卡片栏已打开", await evaluate(`(() => { const el = document.querySelector('[data-dsh-plugin="session-panel-rail"]'); return Boolean(el && el.getBoundingClientRect().width > 0); })()`));

// 点「浮动」
const floated = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"] .dsp-btn')].find((b) => (b.textContent || "").trim() === "浮动");
  if (btn) btn.click();
  return Boolean(btn);
})()`);
await sleep(1500);
const box1 = await boxOf();
check("出现可拖动浮窗（带卡片）", floated && box1.present && box1.cards > 0, JSON.stringify(box1));

if (box1.present) {
  // 拖动标题栏
  await evaluate(`(() => {
    const el = document.querySelector('[data-dsh-plugin="session-panel-float"]');
    const head = el.querySelector('.dsp-float-head');
    const r = el.getBoundingClientRect();
    const sx = r.left + 40, sy = r.top + 12;
    head.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: sx, clientY: sy }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: sx - 300, clientY: sy + 80 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: sx - 300, clientY: sy + 80 }));
    return true;
  })()`);
  await sleep(800);
  const box2 = await boxOf();
  check("拖标题栏浮窗位置变了", Math.abs(box2.left - box1.left) > 100 || Math.abs(box2.top - box1.top) > 40, JSON.stringify({ before: [box1.left, box1.top], after: [box2.left, box2.top] }));

  // 右下角缩放
  await evaluate(`(() => {
    const el = document.querySelector('[data-dsh-plugin="session-panel-float"]');
    const handle = el.querySelector('.dsp-float-resize');
    const r = el.getBoundingClientRect();
    const sx = r.right - 6, sy = r.bottom - 6;
    handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: sx, clientY: sy }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: sx - 120, clientY: sy + 100 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: sx - 120, clientY: sy + 100 }));
    return true;
  })()`);
  await sleep(800);
  const box3 = await boxOf();
  check("拖右下角能缩放", box3.w !== box2.w || box3.h !== box2.h, JSON.stringify({ before: [box2.w, box2.h], after: [box3.w, box3.h] }));

  const stored = await evaluate(`JSON.parse(localStorage.getItem("dsh.session-panel.float.v1"))`);
  check("几何已写进本机存储", Boolean(stored && stored.open === true && typeof stored.left === "number"), JSON.stringify(stored));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(process.argv[3], Buffer.from(shot.data, "base64"));

  // 刷新后位置应保留
  await send("Page.reload", { ignoreCache: true });
  await sleep(8000);
  await evaluate(`(() => { const c = [...document.querySelectorAll('button')].find((el) => (el.textContent||"").trim() === "继续"); if (c) c.click(); return true; })()`);
  await sleep(1200);
  const box4 = await boxOf();
  check("刷新后浮窗还在且位置保留", box4.present && Math.abs(box4.left - box3.left) <= 4 && Math.abs(box4.top - box3.top) <= 4, JSON.stringify({ saved: [box3.left, box3.top], reloaded: [box4.left, box4.top] }));

  if (box4.present) {
    await evaluate(`(() => { const b = document.querySelector('[aria-label="关闭会话浮窗"]'); if (b) b.click(); return Boolean(b); })()`);
    await sleep(700);
    check("点 ✕ 能关闭浮窗", await evaluate(`document.querySelector('[data-dsh-plugin="session-panel-float"]') === null`));
  }
}
console.log(JSON.stringify({ failed: out.filter((r) => !r.ok).length, total: out.length, errors: errors.slice(0, 3) }));
socket.close();
