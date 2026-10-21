/**
 * 会话总览面板的离线冒烟测试：不启动 DSH、不联网、不需要真实浏览器。
 *
 * 用假的 `window` / `document` / React / `ctx` 评价 lib/client.js 这份 bundle，
 * 检查分组逻辑、状态点、当前会话识别、时间文案，以及两个座位的注册与
 * `openSession` 转发。渲染本身用桩 createElement 记录元素树，不做真实 DOM 渲染。
 *
 * 运行：node test/smoke.mjs
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

let definition;
const storage = new Map();
const windowStub = {
	__ModuleLoader__: {
		load: (value) => {
			definition = value;
		}
	},
	localStorage: {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value))
	}
};
new Function("window", source)(windowStub);

assert.ok(definition, "bundle 应当调用 __ModuleLoader__.load");
assert.equal(definition.id, "dsh-client-ui-session-panel");
assert.equal(typeof definition.factory, "function");

let styleAppends = 0;
/** 卡片栏是否"显示在屏幕上"，供按钮高亮与开关判断共用（真实环境里量 DOM 宽度）。 */
let railOnScreen = false;
globalThis.document = {
	getElementById: () => null,
	querySelector: (selector) =>
		String(selector).includes("session-panel-rail") && railOnScreen
			? { getBoundingClientRect: () => ({ width: 400, height: 600 }) }
			: null,
	querySelectorAll: (selector) =>
		String(selector).includes("session-panel-rail") && railOnScreen
			? [{ getBoundingClientRect: () => ({ width: 400, height: 600 }) }]
			: [],
	createElement: () => ({ id: "", textContent: "" }),
	head: {
		appendChild: () => {
			styleAppends += 1;
		}
	}
};

const reactStub = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useMemo: (factory) => factory(),
	useCallback: (fn) => fn,
	// 冒烟测试里不真正跑副作用：订阅与定时器交给浏览器端的检查脚本验证
	useEffect: () => undefined,
	Fragment: Symbol("Fragment")
};

const bundle = definition.factory((name) => {
	if (name === "react") return reactStub;
	throw new Error("未预期的 require: " + name);
});

//#region 数据
const listState = {
	ids: ["s1", "s2", "s3", "s4", "s5", "sub1"],
	byId: {
		s1: { id: "s1", title: "甲", displayTitle: "甲", running: false, updatedAt: 1_000, retainedBy: { mainView: 1 } },
		s2: { id: "s2", title: "乙", displayTitle: "乙", running: true, updatedAt: 3_000, retainedBy: {} },
		s3: { id: "s3", title: "丙", displayTitle: "丙", running: false, updatedAt: 2_000, retainedBy: {} },
		s4: { id: "s4", title: "", displayTitle: "", blank: true, running: false, updatedAt: 500, retainedBy: {} },
		s5: { id: "s5", title: "戊", displayTitle: "戊", running: false, updatedAt: 700, retainedBy: {} },
		sub1: { id: "sub1", title: "子代理", displayTitle: "子代理", origin: "subagent", running: false, updatedAt: 900, retainedBy: {} }
	},
	phase: "ready"
};
// 宿主给的工作区顺序故意是 w2 → w1，用来看泳道是否按最近活动重排
const workspaceState = {
	items: [
		{ workspaceId: "w2", title: "", path: "/tmp/w2/", sessionIds: ["s3"] },
		{ workspaceId: "w1", title: "工作区一", path: "/tmp/w1", sessionIds: ["s1", "s2", "s4"] }
	],
	archivedSessionIds: ["s3"]
};
//#endregion

//#region 分组
const model = bundle.buildModel(listState, workspaceState, []);
assert.deepEqual(
	model.groups.map((group) => group.key),
	["w1", "w2"],
	"泳道应按最近活动时间倒序：w1(3000) → w2(2000)；不再有「未分组」（官方左栏也看不到那些会话）"
);
assert.deepEqual(model.groups[0].sessionIds, ["s2", "s1"], "组内应按最后活动时间倒序");
assert.equal(model.groups[1].title, "w2", "工作区没有标题时应回退到路径末段");
assert.deepEqual(
	model.groups.some((group) => group.sessionIds.includes("s5")),
	false,
	"不在任何工作区里的会话不显示（对齐官方左栏）"
);
assert.deepEqual(model.groups[1].sessionIds, [], "已归档的会话不显示（官方默认过滤）");
assert.equal(model.blankHidden, 1, "非当前的空会话应被隐藏（同官方侧栏）");
assert.equal(
	model.groups.some((group) => group.sessionIds.includes("s4")),
	false,
	"空会话不该出现在任何泳道里"
);
assert.equal(model.currentId, "s1", "应通过 retainedBy.mainView 认出当前会话");
assert.equal(model.archived.has("s3"), true, "归档集合应来自工作区快照");
assert.equal(model.byId.sub1.origin, "subagent");

// 当前会话本身是空会话时应保留（官方也是只留当前这一条）
const currentBlankState = {
	...listState,
	byId: {
		...listState.byId,
		s1: { ...listState.byId.s1, retainedBy: {} },
		s4: { ...listState.byId.s4, retainedBy: { mainView: 1 } }
	}
};
const currentBlankModel = bundle.buildModel(currentBlankState, workspaceState, []);
assert.equal(currentBlankModel.currentId, "s4");
assert.deepEqual(currentBlankModel.groups[0].sessionIds, ["s2", "s1", "s4"], "当前的空会话仍要显示（组内按时间倒序）");
assert.equal(currentBlankModel.blankHidden, 0);

const manualModel = bundle.buildModel(listState, workspaceState, [], "manual");
assert.deepEqual(manualModel.groups[0].sessionIds, ["s1", "s2"], "手动模式应保持宿主保存的顺序");
assert.deepEqual(model.groups[0].manualSessionIds, ["s1", "s2"], "按最近活动显示时也要带出宿主保存的顺序");
assert.deepEqual(manualModel.groups[0].manualSessionIds, ["s1", "s2"]);
assert.deepEqual(manualModel.groups.map((group) => group.key), ["w1", "w2"], "手动模式泳道仍按最近活动倒序");

// 拖动落点 → 锚点：语义与 DOM insertBefore 一致，undefined 表示追加到末尾
const ids = ["a", "b", "c", "d"];
assert.equal(bundle.computeReorderAnchor(ids, "d", "b", "before"), "b", "落在左半 → 插到目标前面");
assert.equal(bundle.computeReorderAnchor(ids, "a", "c", "before"), "c");
assert.equal(bundle.computeReorderAnchor(ids, "a", "c", "after"), "d", "落在右半 → 锚点是目标的下一张");
assert.equal(bundle.computeReorderAnchor(ids, "d", "c", "after"), undefined, "落在末尾右边 → 追加");
assert.equal(bundle.computeReorderAnchor(ids, "b", "b", "before"), undefined, "落在自己身上不产生锚点");

// 面板内隐藏：默认不显示，打开「显示已隐藏」后带 isUserHidden 标记出现
const sessionHidden = bundle.buildModel(listState, workspaceState, [], undefined, { hiddenSessionIds: ["s2"] });
assert.equal(
	sessionHidden.groups.some((group) => group.sessionIds.includes("s2")),
	false,
	"手动隐藏的会话默认不显示"
);
assert.equal(sessionHidden.hiddenSessionCount, 1, "要能数出隐藏了几个");
const sessionRevealed = bundle.buildModel(listState, workspaceState, [], undefined, {
	hiddenSessionIds: ["s2"],
	revealHidden: true
});
assert.equal(
	sessionRevealed.groups[0].sessionIds.includes("s2"),
	true,
	"打开「显示已隐藏」后要能恢复显示"
);
assert.equal(sessionRevealed.hiddenSessionCount, 1);

// 视图筛选：全部 / 最近 N 个 / 近半小时有变化
const filteredRecent = bundle.buildModel(listState, workspaceState, [], undefined, {
	filterMode: "recentN"
});
assert.equal(filteredRecent.groups.length, 1, "筛选后空泳道不再显示");
assert.equal(
	filteredRecent.groups.reduce((count, group) => count + group.sessionIds.length, 0),
	2,
	"会话总数很少时，最近 N 个应全部保留"
);
assert.equal(filteredRecent.filterInfo.mode, "recentN");
assert.equal(filteredRecent.filterInfo.total, 2, "筛选前总数要如实报出来");
assert.equal(filteredRecent.filterInfo.shown, 2);

// now = 3000 + 30 分钟，窗口起点正好落在 s2 的活动时间上：s2/s1 保留，更早的 s4/s3 落选
const filteredHalfHour = bundle.buildModel(listState, workspaceState, [], undefined, {
	filterMode: "halfHour",
	now: 3_000 + 30 * 60 * 1000
});
assert.deepEqual(
	filteredHalfHour.groups.map((group) => group.sessionIds).flat(),
	["s2", "s1"],
	"近半小时只留最后活动时间在窗口内的会话（当前会话始终保留）"
);
assert.equal(filteredHalfHour.filterInfo.total, 2);
assert.equal(filteredHalfHour.filterInfo.shown, 2);

const filteredAll = bundle.buildModel(listState, workspaceState, [], undefined, { filterMode: "all" });
assert.equal(
	filteredAll.groups.reduce((count, group) => count + group.sessionIds.length, 0),
	2,
	"全部模式不做任何过滤"
);

const hiddenModel = bundle.buildModel(listState, workspaceState, ["w1"]);
assert.deepEqual(hiddenModel.groups.map((group) => group.key), ["w2"]);
assert.deepEqual(hiddenModel.hiddenGroups.map((group) => group.key), ["w1"]);
//#endregion

//#region 文案
assert.equal(bundle.formatRelative(Date.now() - 30_000), "刚刚");
assert.equal(bundle.formatRelative(Date.now() - 5 * 60_000), "5 分钟前");
assert.equal(bundle.formatRelative(Date.now() - 3 * 3_600_000), "3 小时前");
assert.equal(bundle.formatRelative(0), "");
//#endregion

//#region 注册与切换
const seats = [];
const opened = [];
const railTypes = [];
const railCalls = [];
const makeRightbar = () => {
	const state = { open: false, expanded: true };
	return {
		state,
		active: () => (state.open ? { id: "tab-1", kind: bundle.RAIL_KIND } : undefined),
		isExpanded: () => state.expanded,
		openTab: (kind) => {
			railCalls.push(["openTab", kind]);
			state.open = true;
			state.expanded = true;
		},
		openTabIn: (sessionId, kind) => railCalls.push(["openTabIn", sessionId, kind]),
		close: (tabId) => {
			railCalls.push(["close", tabId]);
			state.open = false;
		},
		openTabs: undefined
	};
};
const rightbar = makeRightbar();
const ctx = {
	slots: {
		inject: (seat, callback) => {
			seats.push({ seat, entry: callback() });
		},
		register: (definition_, component) => ({ definition: definition_, component })
	},
	uiWorkspace: {
		openSession: (sessionId) => {
			opened.push(sessionId);
		}
	},
	sidebarRight: rightbar,
	sidebarRightTabs: {
		register: (definition_) => {
			railTypes.push(definition_);
			return () => {};
		}
	},
	effect: (callback) => {
		callback();
		return () => {};
	}
};
bundle.apply(ctx);

assert.deepEqual(seats.map((item) => item.seat), [
	"sidebar.panellist",
	"main",
	"shell.overlay",
	"sidebar.right.pane.tab",
	"conversation.session.header.utilities",
	"conversation.session.header.utilities"
]);
assert.equal(styleAppends, 1, "应只插入一次样式表");
assert.equal(seats[0].entry.definition.id, "session-panel");
assert.equal(seats[0].entry.definition.order, 30);
assert.equal(typeof seats[0].entry.definition.label(), "string");
assert.equal(seats[1].entry.definition.key, "session-panel");

const reorderCalls = [];
ctx.workspaces = {
	insertSessionBefore: (workspaceId, sessionId, beforeSessionId) => {
		reorderCalls.push([workspaceId, sessionId, beforeSessionId]);
		return Promise.resolve();
	}
};

const face = seats[1].entry.definition.inject();
face.openSession("s2");
assert.deepEqual(opened, ["s2"], "面板的 openSession 应转发到 ctx.uiWorkspace.openSession");
face.insertSessionBefore("w1", "s4", "s2");
assert.deepEqual(reorderCalls, [["w1", "s4", "s2"]], "排序应转发到 ctx.workspaces.insertSessionBefore");

// 右侧栏：tab 类型 + 卡片栏座位 + 对话头部按钮
assert.equal(railTypes.length, 1, "应登记一个右栏 tab 类型");
assert.equal(railTypes[0].id, bundle.RAIL_ID);
assert.equal(railTypes[0].kind, bundle.RAIL_KIND);
assert.equal(railTypes[0].keepMounted, true, "切会话时卡片栏应保持挂载");
assert.equal(railTypes[0].patterns, undefined, "页类型不该声明地址匹配");
assert.equal(railTypes[0].title(), "会话");
assert.equal(railTypes[0].guide[0].title(), "会话卡片");

const railSeat = seats.find((item) => item.seat === "sidebar.right.pane.tab");
assert.equal(railSeat.entry.definition.key, bundle.RAIL_ID, "tab 座位按类型 id 作 key");
const railFace = railSeat.entry.definition.inject();
railFace.openSession("s3");
assert.equal(opened[opened.length - 1], "s3", "卡片点击应转发到 openSession");

const buttonSeat = seats.find((item) => item.seat === "conversation.session.header.utilities");
const buttonFace = buttonSeat.entry.definition.inject();
buttonFace.toggleRail();
assert.deepEqual(railCalls, [["openTab", bundle.RAIL_KIND]], "右栏没开时按钮应打开卡片栏");
rightbar.state.open = true;
railOnScreen = true;
buttonFace.toggleRail("s1");
assert.deepEqual(railCalls[railCalls.length - 1], ["close", "tab-1"], "卡片栏看得见时按钮应收起");
railOnScreen = false;
//#endregion

//#region 渲染
/** 桩 createElement 不展开数组、也不调用函数组件，这里手工展开一层子元素。 */
function kids(node) {
	const out = [];
	for (const child of node.children || []) {
		if (child === null || child === undefined || child === true || child === false) continue;
		if (Array.isArray(child)) {
			for (const item of child) if (item !== null && item !== undefined) out.push(item);
		} else {
			out.push(child);
		}
	}
	return out;
}

const statuses = new Map([
	["s2", { running: true, pendingInteraction: undefined, completionUnread: false }],
	["s3", { running: false, pendingInteraction: undefined, completionUnread: false }]
]);
const tree = bundle.SessionPanel({
	openSession: () => {},
	useSessions: (selector) => selector(listState),
	useWorkspaces: (selector) => selector(workspaceState),
	useSessionStatus: (selector) => selector(statuses)
});
assert.equal(tree.props.className, "dsp-page");

const inner = kids(tree)[0];
const head = kids(inner)[0];
const headText = kids(kids(head)[0]);
assert.equal(kids(headText[0])[0], "会话总览");
assert.match(kids(headText[1])[0], /2 个会话 · 2 个工作区/);

const groupElements = kids(inner).slice(1);
assert.equal(groupElements.length, 2);
assert.equal(groupElements[0].props.group.key, "w1");
assert.equal(groupElements[0].props.collapsed, false);
assert.equal(groupElements[0].props.currentId, "s1");
assert.equal(groupElements[0].props.archived.has("s3"), true);

/** 手工调用组件，拿到它真正渲染出的元素。 */
const render = (element) => element.type(element.props);

const groupOne = render(groupElements[0]);
const cardsBox = kids(groupOne)[1];
assert.equal(cardsBox.props.className, "dsp-grid", "泳道里应是卡片网格");
const cardElements = kids(cardsBox);
assert.equal(cardElements.length, 2);

const runningCard = render(cardElements[0]);
assert.equal(runningCard.props.className, "dsp-card is-draggable", "组内第一张应是最近活动的 s2，且可拖动");
const runningKids = kids(runningCard);
assert.equal(kids(runningKids[0])[0], "乙");
const runningFoot = kids(runningKids[1]);
assert.equal(runningFoot[0].props.className, "dsp-dot dsp-dot--running");
assert.equal(String(kids(runningFoot[1])[0]).length > 0, true, "卡片应显示相对时间");
assert.equal(runningFoot.length, 2, "运行中的卡片不带标签");

const currentCard = render(cardElements[1]);
assert.equal(currentCard.props.className, "dsp-card is-current is-draggable", "第二张是当前会话 s1");
const currentKids = kids(currentCard);
assert.equal(kids(currentKids[0])[0], "甲");
const currentFoot = kids(currentKids[1]);
assert.equal(currentFoot[0].props.className, "dsp-dot dsp-dot--idle");
assert.equal(kids(currentFoot[2])[0], "当前");

// 卡片上有「隐藏」「归档」两个按钮，且隐藏只调面板回调、归档走宿主接口
assert.equal(typeof groupElements[0].props.onHideSession, "function");
assert.equal(typeof groupElements[0].props.onArchiveSession, "function");
const hiddenCalls = [];
const cardWithActions = render({
	...cardElements[0],
	props: { ...cardElements[0].props, onHide: (id) => hiddenCalls.push(id) }
});
const actionsBox = kids(cardWithActions).find(
	(element) => element && element.props && String(element.props.className).indexOf("dsp-card-acts") >= 0
);
assert.ok(actionsBox, "卡片里应有动作按钮区");
const actionButtons = kids(actionsBox);
assert.equal(actionButtons.length, 2, "隐藏 + 归档两个按钮");
assert.equal(actionButtons[0].props["aria-label"], "隐藏这个会话");
assert.equal(actionButtons[1].props["aria-label"], "归档这个会话");
actionButtons[0].props.onClick({ preventDefault: () => {}, stopPropagation: () => {} });
assert.deepEqual(hiddenCalls, ["s2"], "点隐藏应把会话 id 交给面板回调");


const archivedLane = kids(kids(render(groupElements[1]))[1]);
assert.equal(archivedLane.length, 0, "已归档会话不出现在任何泳道里");
assert.equal(
	JSON.stringify(model.groups).indexOf('"s3"'),
	-1,
	"归档会话连 id 都不该进分组结果"
);

const blankTree = bundle.SessionPanel({
	openSession: () => {},
	useSessions: (selector) => selector(currentBlankState),
	useWorkspaces: (selector) => selector(workspaceState),
	useSessionStatus: (selector) => selector(statuses)
});
const blankGroups = kids(kids(blankTree)[0]).slice(1);
const blankCard = render(
	kids(kids(render(blankGroups[0]))[1]).find((element) => element.props.row.id === "s4")
);
assert.equal(kids(kids(blankCard)[0])[0], "（新会话）", "当前是空会话时仍显示成「（新会话）」");
assert.equal(blankCard.props.className.indexOf("is-current") >= 0, true);

// 组表头的隐藏按钮：点击后把该组 key 交给 onHide。
const hiddenKeys = [];
const toggledKeys = [];
const groupHead = kids(
	render({
		type: groupElements[0].type,
		props: {
			...groupElements[0].props,
			onHide: (key) => hiddenKeys.push(key),
			onToggle: (key) => toggledKeys.push(key)
		}
	})
)[0];
const hideButton = kids(groupHead)[4];
assert.equal(String(hideButton.props.title).includes("隐藏"), true);
hideButton.props.onClick({ stopPropagation: () => {} });
assert.deepEqual(hiddenKeys, ["w1"], "点 ✕ 应隐藏该工作区");
assert.deepEqual(toggledKeys, [], "点 ✕ 不应触发展开/折叠");
//#endregion

//#region 右侧栏卡片渲染
// 卡片栏渲染：分组 + 卡片 + 点击切换
const railTree = bundle.SessionRail({
	openSession: (sessionId) => opened.push(sessionId),
	rightbar,
	useSessions: (selector) => selector(listState),
	useWorkspaces: (selector) => selector(workspaceState),
	useSessionStatus: (selector) => selector(statuses)
});
assert.equal(railTree.props["data-dsh-plugin"], "session-panel-rail");
const railBody = kids(railTree)[1];
const railGroupsRaw = render(kids(railBody)[0]);
const railGroups = Array.isArray(railGroupsRaw) ? railGroupsRaw : [railGroupsRaw];
assert.equal(railGroups.length, 2, "卡片栏也按工作区分组");

// 右栏卡片可以直接拖动排序（不用浮窗）
const railFirstGroup = railGroups[0];
const railGroupParts = kids(railFirstGroup);
const railGrid = railGroupParts[railGroupParts.length - 1];
const railCards = kids(railGrid).map((element) => render(element));
assert.ok(railCards.length >= 2, "第一个工作区至少有 2 张卡可拖");
assert.equal(railCards[0].props.draggable, true, "右栏卡片是可拖的");
assert.equal(typeof railCards[0].props.onDragStart, "function");
assert.equal(typeof railCards[0].props.onDragOver, "function");
assert.equal(typeof railCards[0].props.onDrop, "function");
assert.equal(typeof railGrid.props.onDrop, "function", "落到空白处会追加到末尾");
const firstRailGroup = railGroups[0];
const railCardElements = kids(kids(firstRailGroup)[1]);
assert.equal(railCardElements.length, 2);
const before = opened.length;
render(railCardElements[0]).props.onClick();
assert.equal(opened.length, before + 1, "点卡片应切会话");
//#endregion

//#region 可拖动浮窗
const floatProps = {
	openSession: () => {},
	useSessions: (selector) => selector(listState),
	useWorkspaces: (selector) => selector(workspaceState),
	useSessionStatus: (selector) => selector(statuses)
};
bundle.setFloatOpen(false);
assert.equal(bundle.FloatingCards(floatProps), null, "浮窗关着时不渲染任何东西");
bundle.setFloatOpen(true);
// 浮窗开着时才渲染内容组件，这里手工展开一层
const floatTree = render(bundle.FloatingCards(floatProps));
assert.equal(floatTree.props["data-dsh-plugin"], "session-panel-float");
assert.equal(floatTree.props.className, "dsp-float", "浮窗根节点是可拖动的容器");
assert.equal(typeof floatTree.props.style.left, "string", "位置来自记录（像素）");
assert.equal(typeof floatTree.props.style.width, "string");
const floatParts = kids(floatTree);
assert.equal(floatParts.length, 3, "浮窗 = 标题栏 + 卡片区 + 缩放手柄");
assert.equal(floatParts[0].props.className, "dsp-float-head");
assert.equal(typeof floatParts[0].props.onPointerDown, "function", "标题栏按下即可拖动");
assert.equal(floatParts[2].props.className, "dsp-float-resize");
const floatGroupsRaw = render(kids(floatParts[1])[0]);
const floatGroups = Array.isArray(floatGroupsRaw) ? floatGroupsRaw : [floatGroupsRaw];
assert.equal(floatGroups.length, 2, "浮窗里同样按工作区分组");
assert.equal(floatGroups[0].props.className, "dsp-rail-group");

// 几何写进本机存储
bundle.setFloatRect({ left: 120, top: 90, width: 400, height: 500 });
const storedFloat = JSON.parse(windowStub.localStorage.getItem("dsh.session-panel.float.v1"));
assert.equal(storedFloat.left, 120);
assert.equal(storedFloat.top, 90);
assert.equal(storedFloat.width, 400);
assert.equal(storedFloat.open, true);
bundle.setFloatOpen(false);
assert.equal(JSON.parse(windowStub.localStorage.getItem("dsh.session-panel.float.v1")).open, false);

// 对话头部的「浮窗」按钮：一下开、一下关，不经过右侧栏
const floatSeat = seats.filter((item) => item.seat === "conversation.session.header.utilities")[1];
assert.ok(floatSeat, "应该有一个独立的浮窗按钮座位");
const floatButtonFace = floatSeat.entry.definition.inject();
floatButtonFace.toggleFloat();
assert.equal(JSON.parse(windowStub.localStorage.getItem("dsh.session-panel.float.v1")).open, true);
floatButtonFace.toggleFloat();
assert.equal(JSON.parse(windowStub.localStorage.getItem("dsh.session-panel.float.v1")).open, false);
//#endregion

console.log("smoke ok: 分组/状态/当前会话/注册/渲染/右侧栏/浮窗 全部通过");
