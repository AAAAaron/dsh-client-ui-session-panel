/**
 * 交互验证：折叠 / 隐藏 / 恢复 / 点击切会话，全部在真实 Chrome 里跑。
 * 每条断言都读真实 DOM 与 localStorage，不碰任何会话数据。
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const WebSocket = require(process.env.DSH_WS_MODULE || "ws");

const BASE = process.env.DSH_VERIFY_BASE || "http://127.0.0.1:3099";
const TOKEN = process.argv[2];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = await (await fetch((process.env.DSH_CDP || "http://127.0.0.1:9223") + "/json/list")).json();
const page = targets.find((target) => target.type === "page");
const socket = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((resolve, reject) => {
	socket.once("open", resolve);
	socket.once("error", reject);
});

let nextId = 1;
const pending = new Map();
/** 页面里冒出来的未捕获异常，最后作为一项断言（能抓到组件崩溃这类静默故障）。 */
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
function send(method, params = {}) {
	const id = nextId++;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	return result.result.value;
}

const results = [];
/** 轮询到表达式成立（最多约 6 秒），避免一次测量早于渲染造成假失败。 */
async function waitFor(expression, timeoutMs = 6000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await evaluate(expression);
		if (value) return true;
		if (Date.now() > deadline) return false;
		await sleep(250);
	}
}
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	results.push({ name, ok, actual, expected });
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: BASE + "/?token=" + TOKEN });
await sleep(7000);

// 关掉首次启动的「预览版说明」弹窗，避免挡点击
await evaluate(`(() => {
  const closer = [...document.querySelectorAll('button')].find((el) => (el.textContent || "").trim() === "继续");
  if (closer) closer.click();
  return true;
})()`);
await sleep(400);

// 清掉本面板的本机设置（折叠/隐藏/顺序模式），保证每次跑都是干净的初始状态
await evaluate(`(() => {
  for (const key of ["dsh.session-panel.hidden.v1", "dsh.session-panel.collapsed.v1", "dsh.session-panel.order.v1"]) {
    localStorage.removeItem(key);
  }
  return true;
})()`);
await send("Page.reload", { ignoreCache: true });
await sleep(7000);
await evaluate(`(() => {
  const closer = [...document.querySelectorAll('button')].find((el) => (el.textContent || "").trim() === "继续");
  if (closer) closer.click();
  return true;
})()`);
await sleep(400);

// 打开面板
await evaluate(`(() => {
  const entry = [...document.querySelectorAll('button,[role="button"],a')]
    .find((el) => (el.textContent || "").trim() === "会话");
  if (entry) entry.click();
  return Boolean(entry);
})()`);
await sleep(800);

const countGroups = `document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-group').length`;
const countRows = `document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-card').length`;

const groupsBefore = await evaluate(countGroups);
check("面板打开后有工作区分组", groupsBefore > 0, true);

// 空会话（点「新会话」留下的占位）只应保留当前那一条，其余不显示——同官方侧栏
const blanks = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-card')];
  const blank = cards.filter((card) => (card.querySelector(".dsp-card-title") || {}).textContent === "（新会话）");
  return { total: cards.length, blank: blank.length, blankCurrent: blank.filter((c) => c.classList.contains("is-current")).length };
})()`);
check("可见的空会话最多只有当前那一条", blanks.blank === blanks.blankCurrent && blanks.blank <= 1, true);
check("元信息里说明了隐藏了多少空会话", /隐藏 \d+ 个空会话/.test(await evaluate(`document.querySelector('[data-dsh-plugin="session-panel"] .dsp-meta').textContent`)), true);

// 3) 视图筛选：全部 / 最近 20 个 / 近半小时有变化（此时看板刚打开，状态最干净）
const filterButtons = await evaluate(`(() => {
  const roots = [...document.querySelectorAll('[data-dsh-plugin="session-panel"]')];
  const root = roots[0];
  const bar = root && root.querySelector(".dsp-filter");
  return {
    buttons: bar ? [...bar.querySelectorAll(".dsp-filter-btn")].map((b) => (b.textContent || "").trim()) : null,
    rootCount: roots.length,
    perRoot: roots.map((r) => ({ cards: r.querySelectorAll(".dsp-card").length, filters: r.querySelectorAll(".dsp-filter").length }))
  };
})()`);
check("看板有筛选条", filterButtons.buttons ? filterButtons.buttons.length : 0, 3);
const cardsBeforeFilter = await evaluate(
	`document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-card').length`
);
await evaluate(`(() => {
  const root = document.querySelector('[data-dsh-plugin="session-panel"]');
  const btn = [...root.querySelectorAll(".dsp-filter-btn")].find((b) => (b.textContent || "").indexOf("最近") >= 0);
  if (btn) btn.click();
  return Boolean(btn);
})()`);
await sleep(1200);
const cardsRecent = await evaluate(
	`document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-card').length`
);
check("选「最近 20 个」只剩 20 张卡", cardsRecent, 20);
await evaluate(`(() => {
  const root = document.querySelector('[data-dsh-plugin="session-panel"]');
  const btn = [...root.querySelectorAll(".dsp-filter-btn")].find((b) => (b.textContent || "").indexOf("全部") >= 0);
  if (btn) btn.click();
  return Boolean(btn);
})()`);
await sleep(1200);
const cardsRestored = await evaluate(
	`document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-card').length`
);
check("选「全部会话」恢复全量", cardsRestored, cardsBeforeFilter);

// 0) 泳道顺序：按各自最近一次活动时间倒序（用每条泳道第一张卡的时间做代理）
const laneOrder = await evaluate(`(() => {
  const parse = (text) => {
    const t = (text || "").trim();
    if (t === "刚刚") return 0;
    let m = /^(\\d+) 分钟前$/.exec(t); if (m) return Number(m[1]);
    m = /^(\\d+) 小时前$/.exec(t); if (m) return Number(m[1]) * 60 + 1;
    m = /^(\\d+) 天前$/.exec(t); if (m) return Number(m[1]) * 1440 + 2;
    m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(t); if (m) return 500000 - (Number(m[1]) * 372 + Number(m[2]) * 31 + Number(m[3]));
    m = /^(\\d{2})-(\\d{2})$/.exec(t); if (m) return 100000 - (Number(m[1]) * 31 + Number(m[2]));
    return Number.MAX_SAFE_INTEGER;
  };
  return [...document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-group')].map((group) => {
    const name = group.querySelector(".dsp-group-name");
    const firstTime = group.querySelector(".dsp-card .dsp-time");
    return { lane: name ? name.textContent : "?", age: parse(firstTime ? firstTime.textContent : "") };
  });
})()`);
console.log("泳道顺序:", JSON.stringify(laneOrder));
check(
	"泳道按最近活动时间倒序",
	laneOrder.length > 1 && laneOrder.every((item, index, list) => index === 0 || list[index - 1].age <= item.age),
	true
);

// 1) 隐藏第一个工作区
const hiddenOk = await evaluate(`(() => {
  const button = document.querySelector('[data-dsh-plugin="session-panel"] .dsp-group .dsp-icon-btn');
  if (!button) return false;
  button.click();
  return true;
})()`);
await sleep(400);
const groupsAfterHide = await evaluate(countGroups);
const hiddenStored = await evaluate(`localStorage.getItem("dsh.session-panel.hidden.v1")`);
check("点 ✕ 能隐藏工作区", hiddenOk, true);
check("隐藏后分组少一个", groupsAfterHide, groupsBefore - 1);
check("隐藏项写进了 localStorage", typeof hiddenStored === "string" && hiddenStored.length > 2, true);

// 2) 全部折叠
await evaluate(`(() => {
  const button = [...document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-btn')]
    .find((el) => (el.textContent || "").trim() === "全部折叠");
  if (button) button.click();
  return Boolean(button);
})()`);
await sleep(400);
const rowsCollapsed = await evaluate(countRows);
const collapsedStored = await evaluate(`localStorage.getItem("dsh.session-panel.collapsed.v1")`);
check("全部折叠后没有会话卡片", rowsCollapsed, 0);
check("折叠状态写进了 localStorage", typeof collapsedStored === "string" && collapsedStored.length > 2, true);

// 3) 全部展开
await evaluate(`(() => {
  const button = [...document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-btn')]
    .find((el) => (el.textContent || "").trim() === "全部展开");
  if (button) button.click();
  return Boolean(button);
})()`);
await sleep(400);
const rowsExpanded = await evaluate(countRows);
check("全部展开后会话卡片回来", rowsExpanded > 0, true);

// 4) 隐藏管理 → 恢复
await evaluate(`(() => {
  const button = [...document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-btn')]
    .find((el) => (el.textContent || "").trim() === "管理隐藏");
  if (button) button.click();
  return Boolean(button);
})()`);
await sleep(300);
const hiddenRowVisible = await evaluate(`document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-hidden-row').length`);
check("管理隐藏里能看到被隐藏的工作区", hiddenRowVisible, 1);

await evaluate(`(() => {
  const button = [...document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-hidden-row .dsp-btn')][0];
  if (button) button.click();
  return Boolean(button);
})()`);
await sleep(400);
const groupsRestored = await evaluate(countGroups);
check("恢复后分组回到原来的数量", groupsRestored, groupsBefore);

// 5) 点一张卡片应切回对话（面板卸载）
const rowClicked = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-card:not(.is-archived)')];
  const target = rows.find((row) => !row.classList.contains("is-current")) || rows[0];
  if (!target) return false;
  target.click();
  return true;
})()`);
await sleep(2500);
const panelGone = await evaluate(`document.querySelector('[data-dsh-plugin="session-panel"]') === null`);
check("点会话卡片后面板关闭并回到对话", rowClicked && panelGone, true);

const shot = await send("Page.captureScreenshot", { format: "png" });
const outPath = process.argv[3] || "/tmp/session-panel-after.png";
writeFileSync(outPath, Buffer.from(shot.data, "base64"));

// 6) 拖拽排序：同工作区内拖卡片会写回宿主顺序；跑完按原顺序还原
//    （会真的改一次宿主顺序，所以只挑卡最少的可用泳道，并断言已还原）
await evaluate(`(() => { const e = [...document.querySelectorAll('button,[role="button"],a')].find((el) => (el.textContent||"").trim() === "会话"); if (e) e.click(); return Boolean(e); })()`);
await sleep(1200);
await evaluate(`window.__dspDrag = {
  lanes() { return [...document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-group')]; },
  ids(lane) { return [...lane.querySelectorAll('.dsp-card')].map((c) => c.dataset.sessionId); },
  card(lane, id) { return [...lane.querySelectorAll('.dsp-card')].find((c) => c.dataset.sessionId === id) || null; },
  laneOf(id) { return window.__dspDrag.lanes().find((l) => window.__dspDrag.card(l, id)) || null; },
  orderOf(id) { const l = window.__dspDrag.laneOf(id); return l ? window.__dspDrag.ids(l) : null; },
  modeButton() { return [...document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-btn')].find((el) => (el.textContent||"").startsWith("卡片顺序")) || null; },
  mode() { const b = window.__dspDrag.modeButton(); return b ? b.textContent.trim() : null; },
  begin(id) {
    const lane = window.__dspDrag.laneOf(id);
    const card = lane ? window.__dspDrag.card(lane, id) : null;
    if (!card) return "no-card";
    window.__dspDrag.dt = new DataTransfer();
    if (!window.__dspDrag.card(lane, id).getAttribute("draggable")) return "not-draggable";
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: window.__dspDrag.dt }));
    return "ok";
  },
  drop(id, side) {
    const lane = window.__dspDrag.laneOf(id);
    const card = lane ? window.__dspDrag.card(lane, id) : null;
    if (!card) return "no-card";
    const dt = window.__dspDrag.dt || new DataTransfer();
    const rect = card.getBoundingClientRect();
    const clientX = side === "after" ? rect.right - 4 : rect.left + 4;
    const clientY = rect.top + rect.height / 2;
    card.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }));
    card.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }));
    card.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return "ok";
  }
}; true;`);
check("默认卡片顺序是「最近活动」", await evaluate(`window.__dspDrag.mode()`), "卡片顺序：最近活动");
const dragLane = await evaluate(`(() => {
  let best = null;
  for (const lane of window.__dspDrag.lanes()) {
    const n = [...lane.querySelectorAll('.dsp-card')].filter((c) => c.getAttribute("draggable") === "true").length;
    if (n < 2) continue;
    const name = lane.querySelector(".dsp-group-name");
    const info = { name: name ? name.textContent : "?", ids: window.__dspDrag.ids(lane), n };
    if (!best || n < best.n) best = info;
  }
  return best;
})()`);
if (dragLane) {
	// 先切「手动」读出宿主保存的顺序，再切回「最近活动」
	const modeButtonClicked = await evaluate(`(() => {
    const b = window.__dspDrag.modeButton();
    if (!b || b.textContent.trim() === "卡片顺序：手动") return false;
    b.click(); return true;
  })()`);
	await sleep(700);
	const manualOrder = await evaluate(`window.__dspDrag.orderOf(${JSON.stringify(dragLane.ids[0])})`);
	check("能切到「手动」并读出宿主顺序", modeButtonClicked && Array.isArray(manualOrder) && manualOrder.length === dragLane.ids.length, true);
	await evaluate(`window.__dspDrag.modeButton().click()`);
	await sleep(700);
	check("能切回「最近活动」", await evaluate(`window.__dspDrag.mode()`), "卡片顺序：最近活动");

	const dragged = dragLane.ids[0];
	const target = dragLane.ids[1];
	const started = await evaluate(`window.__dspDrag.begin(${JSON.stringify(dragged)})`);
	check("卡片可拖动（派发 dragstart）", started, "ok");
	await sleep(250);
	await evaluate(`window.__dspDrag.drop(${JSON.stringify(target)}, "after")`);
	await sleep(1500);
	check("拖过之后自动切到「手动」", await evaluate(`window.__dspDrag.mode()`), "卡片顺序：手动");
	const without = manualOrder.filter((x) => x !== dragged);
	const at = without.indexOf(target) + 1;
	const expected = without.slice(0, at).concat([dragged], without.slice(at));
	const actual = await evaluate(`window.__dspDrag.orderOf(${JSON.stringify(dragged)})`);
	check("宿主顺序按落点重排", actual, expected);

	const restoreAnchor = manualOrder[manualOrder.indexOf(dragged) + 1];
	if (JSON.stringify(actual) !== JSON.stringify(manualOrder)) {
		await evaluate(`window.__dspDrag.begin(${JSON.stringify(dragged)})`);
		await sleep(250);
		await evaluate(`window.__dspDrag.drop(${JSON.stringify(restoreAnchor)}, "before")`);
		await sleep(1500);
	}
	const restored = await evaluate(`window.__dspDrag.orderOf(${JSON.stringify(dragged)})`);
	check("已还原到拖动前的宿主顺序", restored, manualOrder);
} else {
	check("有可拖动的泳道", false, "至少一个泳道含 2 张可拖卡片");
}

// 7) 右侧栏卡片：对话头部按钮 → 卡片栏 → 点卡片切会话 → 栏不关
//    （第 5 步已经把一张卡片点开成真实会话，这里直接找对话头部）
// 先点开一张卡片变成真实会话：对话头部只在真实会话里渲染（空白新会话是 hero 页）
await evaluate(`(() => {
  const cards = [...document.querySelectorAll('[data-dsh-plugin="session-panel"] .dsp-card')];
  const pick = cards.find((card) => !card.classList.contains("is-archived") && !card.classList.contains("is-current"));
  if (pick) pick.click();
  return Boolean(pick);
})()`);
await sleep(2500);

const railButton = await evaluate(`(() => {
  const button = document.querySelector('button[aria-label="会话卡片栏"]');
  return button ? { found: true, pressed: button.getAttribute("aria-pressed") } : { found: false };
})()`);
check("对话头部出现「会话卡片栏」按钮", railButton.found, true);

if (railButton.found) {
	// 点按钮开右栏：tab 打开后还要等面板展开，必要时重试
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const visible = await evaluate(`(() => [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].some((n) => n.getBoundingClientRect().width > 0))()`);
		if (visible) break;
		await evaluate(`(() => { const b = document.querySelector('button[aria-label="会话卡片栏"]'); if (b) b.click(); return Boolean(b); })()`);
		await sleep(1800);
	}
	const railOpened = await evaluate(`(() => {
    const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    const button = document.querySelector('button[aria-label="会话卡片栏"]');
    const paneTabs = [...document.querySelectorAll('[class*=pane] [role=tab], [class*=tab]')].length;
    if (!rail) return { present: false, button: Boolean(button), paneTabs, location: location.href };
    const cards = [...rail.querySelectorAll(".dsp-card")];
    return {
      present: true,
      cards: cards.length,
      width: Math.round(rail.getBoundingClientRect().width),
      groups: rail.querySelectorAll(".dsp-rail-group").length,
      current: cards.filter((card) => card.classList.contains("is-current")).length,
      pressed: button ? button.getAttribute("aria-pressed") : null
    };
  })()`);
	if (!(railOpened.present && railOpened.cards > 0)) console.error("右栏诊断:", JSON.stringify(railOpened));
	if (!(railOpened.present && railOpened.cards > 0)) {
		const chain = await evaluate(`(() => {
      const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
      if (!rail) {
        const pane = document.querySelector('[class*=rightPane], [class*=Rightbar], [class*=rightbar]');
        return { rail: false, paneHtml: pane ? pane.innerHTML.slice(0, 260) : null };
      }
      const rows = [];
      let node = rail;
      for (let i = 0; i < 8 && node; i += 1) {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        rows.push({
          tag: node.tagName + (node.className ? "." + String(node.className).split(" ").slice(0, 2).join(".") : ""),
          w: Math.round(rect.width), display: style.display, visibility: style.visibility, overflow: style.overflow
        });
        node = node.parentElement;
      }
      return { rail: true, rows };
    })()`);
		console.error("祖先链:", JSON.stringify(chain));
	}
	check("右栏渲染出卡片栏", railOpened.present && railOpened.cards > 0, true);
	check("卡片栏按工作区分组且只有一条当前", railOpened.groups > 0 && railOpened.current === 1, true);
	check(
		"卡片栏开着时按钮仍在",
		Boolean(await waitFor(`Boolean(document.querySelector('button[aria-label="会话卡片栏"]'))`)),
		true
	);

	const railTarget = await evaluate(`(() => {
    const cards = [...(([...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]')) || { querySelectorAll: () => [] }).querySelectorAll('.dsp-card')];
    const pick = cards.find((card) => !card.classList.contains("is-current") && !card.classList.contains("is-archived"));
    return pick ? pick.dataset.sessionId : null;
  })()`);
	check("卡片栏里有可点的非当前会话", Boolean(railTarget), true);
	if (railTarget) {
		const clicked = await evaluate(`(() => {
      const cards = [...(([...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]')) || { querySelectorAll: () => [] }).querySelectorAll('.dsp-card')];
      const pick = cards.find((card) => card.dataset.sessionId === ${JSON.stringify(railTarget)});
      if (pick) pick.click();
      return Boolean(pick);
    })()`);
		check("点了卡片栏里的会话", clicked, true);
		await sleep(2500);
		const railAfter = await evaluate(`(() => {
      const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
      if (!rail) return { present: false };
      const current = [...rail.querySelectorAll(".dsp-card.is-current")];
      return { present: true, currentId: current.length ? current[0].dataset.sessionId : null };
    })()`);
		check("切会话后卡片栏仍在", railAfter.present, true);
		check("当前标记跟到了被点的会话", railAfter.currentId, railTarget);
	}

	await evaluate(`document.querySelector('button[aria-label="会话卡片栏"]').click()`);
	await sleep(1200);
	// keepMounted 会让卡片栏的 DOM 留着但隐藏，所以判「看不见」而不是「不存在」
	const railClosed = await evaluate(`(() => {
    const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    const rect = rail ? rail.getBoundingClientRect() : { width: 0 };
    const pressed = document.querySelector('button[aria-label="会话卡片栏"]').getAttribute("aria-pressed");
    return { visible: rect.width > 0, pressed };
  })()`);
	check(
		"再点按钮收起卡片栏",
		await waitFor(`(() => {
      const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
      return rail ? !(rail.getBoundingClientRect().width > 0) : true;
    })()`),
		true
	);

	// 收起后再点一次：右栏是被收起的，按钮要能把它重新展开（否则只开了 tab 看不见）
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const visible = await evaluate(`(() => [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].some((n) => n.getBoundingClientRect().width > 0))()`);
		if (visible) break;
		await evaluate(`(() => { const b = document.querySelector('button[aria-label="会话卡片栏"]'); if (b) b.click(); return Boolean(b); })()`);
		await sleep(1800);
	}
	const railReopened = await evaluate(`(() => {
    const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    const rect = rail ? rail.getBoundingClientRect() : { width: 0 };
    return { visible: rect.width > 0, cards: rail ? rail.querySelectorAll(".dsp-card").length : 0 };
  })()`);
	check(
		"右栏收起状态下点按钮能重新展开并出卡片",
		await waitFor(`(() => {
      const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
      if (!rail) return false;
      return rail.getBoundingClientRect().width > 0 && rail.querySelectorAll(".dsp-card").length > 0;
    })()`),
		true
	);
}

// 7.5) 右栏里直接拖动卡片排序（不用浮窗）
// 用第一个"有可拖卡片"的分组（未分组那条泳道不支持拖动，跳过）
const railDragOrder = () =>
	evaluate(`(() => {
    const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    if (!rail) return null;
    const grid = [...rail.querySelectorAll(".dsp-rail-grid")].find((item) => item.querySelector(".dsp-card.is-draggable"));
    if (!grid) return null;
    return [...grid.querySelectorAll(".dsp-card.is-draggable")].map((card) => card.dataset.sessionId);
  })()`);
const dragRail = async (fromId, toId, side) => {
	await evaluate(`(() => {
    const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    const card = [...rail.querySelectorAll(".dsp-card")].find((item) => item.dataset.sessionId === ${JSON.stringify(fromId)});
    if (!card) return false;
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    return true;
  })()`);
	await sleep(400);
	await evaluate(`(() => {
    const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    const card = [...rail.querySelectorAll(".dsp-card")].find((item) => item.dataset.sessionId === ${JSON.stringify(toId)});
    if (!card) return false;
    const rect = card.getBoundingClientRect();
    const x = ${side === "before"} ? rect.left + 4 : rect.right - 4;
    const y = rect.top + rect.height / 2;
    card.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: new DataTransfer() }));
    return true;
  })()`);
	await sleep(350);
	await evaluate(`(() => {
    const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
    const card = [...rail.querySelectorAll(".dsp-card")].find((item) => item.dataset.sessionId === ${JSON.stringify(toId)});
    if (!card) return false;
    const rect = card.getBoundingClientRect();
    const x = ${side === "before"} ? rect.left + 4 : rect.right - 4;
    const y = rect.top + rect.height / 2;
    card.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: new DataTransfer() }));
    const dragged = [...rail.querySelectorAll(".dsp-card")].find((item) => item.dataset.sessionId === ${JSON.stringify(fromId)});
    if (dragged) dragged.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    return true;
  })()`);
	await sleep(1500);
};
// 分组可能被折叠过，先全部展开
await evaluate(`(() => {
  const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
  if (!rail) return false;
  const button = [...rail.querySelectorAll(".dsp-btn")].find((item) => (item.textContent || "").trim() === "全部展开");
  if (button) button.click();
  return true;
})()`);
await sleep(900);
const railDragBefore = await railDragOrder();
check("右栏里有可拖动的卡片", Array.isArray(railDragBefore) && railDragBefore.length >= 2, true);
if (Array.isArray(railDragBefore) && railDragBefore.length >= 2) {
	const movedCard = railDragBefore[0];
	const targetCard = railDragBefore[1];
	check(
		"右栏卡片带 draggable 属性",
		await evaluate(`(() => {
      const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
      const card = [...rail.querySelectorAll(".dsp-card")].find((item) => item.dataset.sessionId === ${JSON.stringify(movedCard)});
      return Boolean(card && card.getAttribute("draggable") === "true");
    })()`),
		true
	);
	await dragRail(movedCard, targetCard, "after");
	const afterDrop = await railDragOrder();
	check(
		"右栏拖到 B 后面：A 紧跟 B",
		Array.isArray(afterDrop) && afterDrop.indexOf(movedCard) === afterDrop.indexOf(targetCard) + 1,
		true
	);
	check("右栏拖过之后顺序模式是「手动」", await evaluate(`localStorage.getItem("dsh.session-panel.order.v1")`), "manual");
	await dragRail(movedCard, targetCard, "before");
	const afterRestore = await railDragOrder();
	check(
		"右栏再拖回 B 前面：A 紧挨在 B 之前",
		Array.isArray(afterRestore) && afterRestore.indexOf(movedCard) === afterRestore.indexOf(targetCard) - 1,
		true
	);
}

// 8) 可拖动浮窗：右栏「浮动」→ 浮窗出现 → 拖标题栏移动 → 关掉
const floatButton = await evaluate(`(() => {
  document.querySelectorAll('[data-dsh-plugin="session-panel-float"]').forEach((el) => {
    const close = el.querySelector('[aria-label="关闭会话浮窗"]');
    if (close) close.click();
  });
  return true;
})()`);
await sleep(400);
// 先确保右栏卡片栏是开着的（上一段结束时它是开的）
const railReady = await evaluate(`(() => {
  const rail = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]')].find((n) => n.getBoundingClientRect().width > 0) || document.querySelector('[data-dsh-plugin="session-panel-rail"]');
  if (rail && rail.getBoundingClientRect().width > 0) return true;
  const button = document.querySelector('button[aria-label="会话卡片栏"]');
  if (button) button.click();
  return false;
})()`);
if (!railReady) await sleep(1800);
void floatButton;

const floated = await evaluate(`(() => {
  const button = [...document.querySelectorAll('[data-dsh-plugin="session-panel-rail"] .dsp-btn')]
    .find((el) => (el.textContent || "").trim() === "浮动");
  if (button) button.click();
  return Boolean(button);
})()`);
await sleep(1200);
const floatBox = await evaluate(`(() => {
  const el = document.querySelector('[data-dsh-plugin="session-panel-float"]');
  if (!el) return { present: false };
  const rect = el.getBoundingClientRect();
  return { present: true, left: Math.round(rect.left), top: Math.round(rect.top), cards: el.querySelectorAll(".dsp-card").length };
})()`);
check("点「浮动」出现浮窗并带卡片", floated && floatBox.present && floatBox.cards > 0, true);

if (floatBox.present) {
	// 拖动/缩放/位置记忆：改用真实鼠标事件在 test/float-probe.mjs 里单独验证，
	// 本流程里的合成指针事件驱动不了指针捕获，留着只会假失败。
	const floatStored = await evaluate(`(() => { try { return JSON.parse(localStorage.getItem("dsh.session-panel.float.v1")) || {}; } catch { return {}; } })()`);
	check(
		"浮窗开关写进了 localStorage",
		floatStored.open === true && (floatStored.left === null || typeof floatStored.left === "number"),
		true
	);

	await evaluate(`(() => { const close = document.querySelector('[data-dsh-plugin="session-panel-float"] [aria-label="关闭会话浮窗"]'); if (close) close.click(); return Boolean(close); })()`);
	await sleep(600);
	check("点 ✕ 关闭浮窗", await evaluate(`document.querySelector('[data-dsh-plugin="session-panel-float"]') === null`), true);
}

// 9) 对话头部的「会话浮窗」按钮：一下开、一下关，完全不碰右侧栏
const floatButtonOpened = await evaluate(`(() => {
  const button = document.querySelector('button[aria-label="会话浮窗"]');
  if (button) button.click();
  return Boolean(button);
})()`);
await sleep(1200);
check("点头部「浮窗」按钮直接出浮窗", floatButtonOpened && (await evaluate(`Boolean(document.querySelector('[data-dsh-plugin="session-panel-float"]'))`)), true);
const floatButtonClosed = await evaluate(`(() => {
  const button = document.querySelector('[data-dsh-plugin="session-panel-float"] [aria-label="关闭会话浮窗"]');
  if (button) button.click();
  return Boolean(button);
})()`);
await sleep(800);
check("浮窗里点 ✕ 收起", floatButtonClosed && (await evaluate(`document.querySelector('[data-dsh-plugin="session-panel-float"]') === null`)), true);

check("页面没有未捕获的 JS 异常", pageErrors.length === 0, true);
if (pageErrors.length > 0) console.error("页面异常:", pageErrors.slice(0, 3));

const failed = results.filter((item) => !item.ok);
console.log(JSON.stringify({ results, failed: failed.length, screenshot: outPath }, null, 2));
socket.close();
process.exit(failed.length === 0 ? 0 : 1);
