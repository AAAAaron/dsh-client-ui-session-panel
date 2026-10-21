/**
 * 右栏卡片拖动排序专项验证（需要真实浏览器，不用浮窗、就在原右栏里拖）。
 *
 * 用法：
 *   DSH_VERIFY_BASE=http://127.0.0.1:3099 DSH_CDP=http://127.0.0.1:9225 \
 *     node test/rail-drag-probe.mjs <token> [/tmp/rail-drag.png]
 *
 * 覆盖：右栏卡片可拖 → 拖到同组另一张卡前面 → 顺序真的变了 → 顺序模式切成「手动」
 *       → 再拖回原位 → 顺序还原。
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const WebSocket = require(process.env.DSH_WS_MODULE || "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = process.env.DSH_VERIFY_BASE || "http://127.0.0.1:3099";
const cdpBase = process.env.DSH_CDP || "http://127.0.0.1:9223";
const targets = await (await fetch(cdpBase + "/json/list")).json();
const page = targets.find((item) => item.type === "page");
const socket = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((resolve, reject) => {
	socket.once("open", resolve);
	socket.once("error", reject);
});
let nextId = 1;
const pending = new Map();
const pageErrors = [];
socket.on("message", (raw) => {
	const message = JSON.parse(raw.toString());
	if (message.method === "Runtime.exceptionThrown") {
		const details = message.params && message.params.exceptionDetails ? message.params.exceptionDetails : {};
		pageErrors.push((details.exception && details.exception.description) || details.text || "unknown");
	}
	if (message.id !== undefined && pending.has(message.id)) {
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) reject(new Error(JSON.stringify(message.error)));
		else resolve(message.result);
	}
});
const send = (method, params = {}) => {
	const id = nextId;
	nextId += 1;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) return "ERR:" + String(result.exceptionDetails.exception && result.exceptionDetails.exception.description).slice(0, 200);
	return result.result.value;
};
const results = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	results.push({ name, ok, actual });
	console.log((ok ? "  OK   " : "  FAIL ") + name + (ok ? "" : "  实际=" + JSON.stringify(actual)));
};

/** 右栏第一个工作区里的卡片顺序。 */
const railOrder = () =>
	evaluate(`(() => {
    const rail = document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    if (!rail) return null;
    const grid = rail.querySelector('.dsp-rail-grid');
    if (!grid) return null;
    return [...grid.querySelectorAll('.dsp-card')].map((card) => card.dataset.sessionId);
  })()`);

/** 在右栏里把一张卡拖到另一张卡的前/后。 */
async function dragInRail(fromId, toId, side) {
	await evaluate(`(() => {
    const rail = document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    const card = [...rail.querySelectorAll('.dsp-card')].find((item) => item.dataset.sessionId === ${JSON.stringify(fromId)});
    if (!card) return false;
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    return true;
  })()`);
	await sleep(400);
	await evaluate(`(() => {
    const rail = document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    const card = [...rail.querySelectorAll('.dsp-card')].find((item) => item.dataset.sessionId === ${JSON.stringify(toId)});
    if (!card) return false;
    const rect = card.getBoundingClientRect();
    const x = ${side === "before"} ? rect.left + 4 : rect.right - 4;
    const y = rect.top + rect.height / 2;
    card.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: new DataTransfer() }));
    return true;
  })()`);
	await sleep(350);
	await evaluate(`(() => {
    const rail = document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    const card = [...rail.querySelectorAll('.dsp-card')].find((item) => item.dataset.sessionId === ${JSON.stringify(toId)});
    if (!card) return false;
    const rect = card.getBoundingClientRect();
    const x = ${side === "before"} ? rect.left + 4 : rect.right - 4;
    const y = rect.top + rect.height / 2;
    card.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: new DataTransfer() }));
    const dragged = [...rail.querySelectorAll('.dsp-card')].find((item) => item.dataset.sessionId === ${JSON.stringify(fromId)});
    if (dragged) dragged.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    return true;
  })()`);
	await sleep(1500);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: base + "/?token=" + process.argv[2] });
await sleep(8000);
await evaluate(`(() => { const c = [...document.querySelectorAll('button')].find((el) => (el.textContent || "").trim() === "继续"); if (c) c.click(); return true; })()`);
await sleep(500);
// 打开一个有内容的会话（空白新会话是 hero 页，没有对话头部）
await evaluate(`(() => { const entry = [...document.querySelectorAll('button,[role="button"],a')].find((el) => (el.textContent || "").trim() === "会话"); if (entry) entry.click(); return Boolean(entry); })()`);
await sleep(1500);
for (let attempt = 0; attempt < 4; attempt += 1) {
	const opened = await evaluate(`(() => {
    if (document.querySelector('button[aria-label="会话卡片栏"]')) return true;
    const entry = [...document.querySelectorAll('button,[role="button"],a')].find((el) => (el.textContent || "").trim() === "会话");
    if (entry) entry.click();
    const cards = [...document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-card')]
      .filter((card) => !card.classList.contains("is-archived"));
    const pick = cards[attempt] || cards[0];
    if (pick) pick.click();
    return false;
  })()`);
	if (opened) break;
	await sleep(2600);
}
// 打开右栏卡片栏（先等应用把状态恢复完，再判断要不要点）
await sleep(1500);
for (let attempt = 0; attempt < 3; attempt += 1) {
	const shown = await evaluate(`(() => {
    const rail = document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    return Boolean(rail && rail.getBoundingClientRect().width > 0);
  })()`);
	if (shown) break;
	await evaluate(`(() => { const button = document.querySelector('button[aria-label="会话卡片栏"]'); if (button) button.click(); return Boolean(button); })()`);
	await sleep(2600);
}
let railShown = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
	if (await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')];
    return nodes.some((node) => node.getBoundingClientRect().width > 0);
  })()`)) {
		railShown = true;
		break;
	}
	await sleep(300);
}
check("右栏卡片栏已打开", railShown, true);
if (!railShown) {
	console.error("诊断:", JSON.stringify(await evaluate(`(() => {
    const button = document.querySelector('button[aria-label="会话卡片栏"]');
    return {
      button: Boolean(button),
      pressed: button ? button.getAttribute("aria-pressed") : null,
      panes: [...document.querySelectorAll("[data-sidebar-right-session]")].map((node) => Math.round(node.getBoundingClientRect().width)),
      rails: [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].map((node) => Math.round(node.getBoundingClientRect().width))
    };
  })()`)));
}

// 分组可能被折叠过（状态会持久化），先全部展开再取顺序
await evaluate(`(() => {
  const rail = document.querySelector('[data-dsh-plugin="session-panel-rail"]');
  if (!rail) return false;
  const button = [...rail.querySelectorAll('.dsp-btn')].find((item) => (item.textContent || "").trim() === "全部展开");
  if (button) button.click();
  return true;
})()`);
await sleep(900);

const before = await railOrder();
if (!Array.isArray(before) || before.length < 2) {
	console.error("诊断:", JSON.stringify(await evaluate(`(() => {
    const rail = document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    if (!rail) return { rail: false };
    return {
      rail: true,
      width: Math.round(rail.getBoundingClientRect().width),
      groups: rail.querySelectorAll(".dsp-rail-group").length,
      grids: rail.querySelectorAll(".dsp-rail-grid").length,
      cards: rail.querySelectorAll(".dsp-card").length,
      buttons: [...rail.querySelectorAll("button")].map((b) => (b.textContent || "").trim()),
      collapsed: localStorage.getItem("dsh.session-panel.collapsed.v1")
    };
  })()`)));
}
check("右栏第一个工作区有至少 2 张卡", Array.isArray(before) && before.length >= 2, true);

if (Array.isArray(before) && before.length >= 2) {
	const movedCard = before[0];
	const originalSuccessor = before[1];
	check("卡片本身是可拖的", await evaluate(`(() => {
    const rail = document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    const card = [...rail.querySelectorAll('.dsp-card')].find((item) => item.dataset.sessionId === ${JSON.stringify(movedCard)});
    return Boolean(card && card.getAttribute("draggable") === "true");
  })()`), true);

	// 把第一张拖到第二张后面：写回宿主后 A 应该紧跟 B（与宿主原来的相对位置无关）
	await dragInRail(movedCard, originalSuccessor, "after");
	const after = await railOrder();
	check(
		"拖到 B 后面：A 紧跟 B",
		Array.isArray(after) && after.indexOf(movedCard) === after.indexOf(originalSuccessor) + 1,
		true
	);
	check("拖过之后顺序模式是「手动」", await evaluate(`localStorage.getItem("dsh.session-panel.order.v1")`), "manual");

	// 再拖回 B 前面：A 应该紧挨在 B 之前
	await dragInRail(movedCard, originalSuccessor, "before");
	const restored = await railOrder();
	check(
		"再拖回 B 前面：A 紧挨在 B 之前",
		Array.isArray(restored) && restored.indexOf(movedCard) === restored.indexOf(originalSuccessor) - 1,
		true
	);

	const shot = await send("Page.captureScreenshot", { format: "png" });
	if (process.argv[3]) writeFileSync(process.argv[3], Buffer.from(shot.data, "base64"));
}
check("页面没有未捕获的 JS 异常", pageErrors.length === 0, true);
if (pageErrors.length > 0) console.error("页面异常:", pageErrors.slice(0, 3));
const failed = results.filter((item) => !item.ok).length;
console.log(JSON.stringify({ failed, total: results.length }));
socket.close();
