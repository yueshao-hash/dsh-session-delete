/**
 * 浏览器半边（lib/client.js）的接线测试。
 *
 * 客户端插件不是 JSX 编译产物，而是自己调 window.__ModuleLoader__.load 注册工厂；
 * 这里用最小 stub 把它加载起来，检查：
 *   - 右键菜单项注册到 contextMenus（target "session"、order、danger、icon）
 *   - 确认弹窗挂在 shell.overlay，标题栏按钮仍挂在 conversation.session.header.actions
 *   - performDelete 的顺序：POST →（in-use 才离开会话重试）→ 刷新列表 → 必要时 reload
 * 纯内存 stub，不落盘，不写 C 盘。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'lib', 'client.js');
const ID = 'abcdef12-3456-7890-abcd-ef1234567890';

/** 造一份最小 require：react 的 hook 用空实现（组件不渲染，只检查接线）。 */
function makeRequire({ withPrimitives = true } = {}) {
	const noop = () => {};
	return (specifier) => {
		if (specifier === 'react/jsx-runtime') {
			return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
		}
		if (specifier === 'react') {
			return {
				useState: (initial) => [typeof initial === 'function' ? undefined : initial, noop],
				useRef: (initial) => ({ current: initial }),
				useEffect: noop,
				useCallback: (fn) => fn
			};
		}
		if (specifier === '@deepseek-ai/dsh-client-ui-primitives' && withPrimitives) {
			const Stub = (props) => ({ type: 'stub', props });
			return { Modal: Stub, Button: Stub, IconTrashOutlineRegular: Stub };
		}
		throw new Error(`unexpected require: ${specifier}`);
	};
}

/** 在 stub 环境里加载客户端 bundle，返回它的 exports。 */
function loadClient(options) {
	let loaded;
	globalThis.window = {
		__ModuleLoader__: {
			load: ({ id, factory }) => {
				loaded = { id, exports: factory(makeRequire(options)) };
			}
		},
		location: {
			reload: () => {
				globalThis.__reloaded = (globalThis.__reloaded ?? 0) + 1;
			}
		}
	};
	globalThis.document = {
		querySelector: () => null,
		createElement: () => ({ setAttribute() {}, set textContent(value) {}, head: true }),
		head: { appendChild() {} }
	};
	globalThis.__reloaded = 0;
	const source = readFileSync(CLIENT, 'utf8');
	// 直接当脚本执行：它自己会调 window.__ModuleLoader__.load。
	new Function('window', 'document', 'fetch', source)(
		globalThis.window,
		globalThis.document,
		// 转发到当前 globalThis.fetch：每个用例会换一份 stub。
		(...args) => globalThis.fetch(...args)
	);
	return loaded;
}

/** 跑 apply，收集注册出来的东西。 */
function mount(options) {
	const loaded = loadClient(options);
	const slots = new Map();
	const icons = new Map();
	const menus = [];
	const ctx = {
		effect: (fn) => fn(),
		slots: {
			inject: (_name, run) => {
				const result = run();
				if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
					// 图标那段是 function*，惰性 yield 注册。
					for (const _ of result) void _;
				}
				return result;
			},
			register: (desc, component) => {
				if (desc.name === 'contextMenu.icon') icons.set(desc.key, component);
				else slots.set(desc.id ?? desc.name, { desc, component });
				return () => {};
			}
		},
		contextMenus: {
			register: (input) => {
				menus.push(input);
				return () => {};
			}
		},
		uiWorkspace: { startSession: async () => {} },
		sessions: { refresh: async () => {}, list: { getSnapshot: () => ({ byId: {} }) } }
	};
	loaded.exports.apply(ctx);
	return { loaded, slots, icons, menus, ctx };
}

await test('接线：菜单项 + 弹窗 + 图标 + 标题栏按钮', () => {
	const { loaded, slots, icons, menus } = mount();
	assert.equal(loaded.id, 'dsh-session-delete');
	assert.deepEqual(loaded.exports.inject, ['slots', 'contextMenus', 'uiWorkspace', 'sessions']);

	assert.equal(menus.length, 1);
	const menu = menus[0];
	assert.equal(menu.id, 'session.delete');
	assert.equal(menu.target, 'session');
	assert.equal(menu.order, 700);

	const items = menu.resolve({ sessionId: ID, displayTitle: '测试会话' });
	assert.equal(items.length, 1);
	assert.equal(items[0].id, 'delete');
	assert.equal(items[0].label, '删除对话');
	assert.equal(items[0].danger, true);
	assert.equal(items[0].afterContent, true, '跟「归档会话」一起放底部那一组');
	assert.deepEqual(items[0].icon, { key: 'session.delete' });
	assert.equal(typeof items[0].run, 'function');

	assert.ok(slots.has('session-delete-confirm'), '确认弹窗要挂到 shell.overlay');
	assert.equal(slots.get('session-delete-confirm').desc.name, 'shell.overlay');
	assert.ok(slots.has('session-delete'), '标题栏按钮保留');
	assert.equal(slots.get('session-delete').desc.name, 'conversation.session.header.actions');
	assert.ok(icons.has('session.delete'), '菜单图标 keyed 槽要有 session.delete');
});

await test('performDelete：POST 成功 → 刷新，不 reload', async () => {
	const { slots } = mount();
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push(`fetch:${init.method}:${url}:${init.body}`);
		return { ok: true, status: 200, json: async () => ({ ok: true, removed: ['x'] }) };
	};
	await slots.get('session-delete-confirm').desc.inject().performDelete(ID);
	assert.deepEqual(calls, [`fetch:POST:/plugin/session-delete:{"sessionId":"${ID}"}`]);
	assert.equal(globalThis.__reloaded, 0);
});

await test('performDelete：列表里还赖着就 reload 兜底', async () => {
	const { slots, ctx } = mount();
	ctx.sessions.list.getSnapshot = () => ({ byId: { [ID]: {} } });
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
	await slots.get('session-delete-confirm').desc.inject().performDelete(ID);
	assert.equal(globalThis.__reloaded, 1);
});

await test('performDelete：in-use 就离开会话再重试到成功', async () => {
	const { slots, ctx } = mount();
	const calls = [];
	ctx.uiWorkspace.startSession = async () => {
		calls.push('startSession');
	};
	let attempts = 0;
	globalThis.fetch = async () => {
		attempts += 1;
		calls.push(`post:${attempts}`);
		if (attempts === 1) return { ok: false, status: 409, json: async () => ({ ok: false, code: 'in-use' }) };
		return { ok: true, status: 200, json: async () => ({ ok: true }) };
	};
	await slots.get('session-delete-confirm').desc.inject().performDelete(ID);
	assert.deepEqual(calls, ['post:1', 'startSession', 'post:2']);
	assert.equal(attempts, 2);
});

await test('performDelete：主机报错就抛出去（弹窗负责显示）', async () => {
	const { slots } = mount();
	globalThis.fetch = async () => ({
		ok: false,
		status: 409,
		json: async () => ({ ok: false, code: 'in-use', message: '会话还被占用' })
	});
	await assert.rejects(
		() => slots.get('session-delete-confirm').desc.inject().performDelete(ID),
		/会话还被占用/
	);
});

await test('没有 primitives 也能加载（弹窗退化成 null，不炸）', () => {
	const { slots, icons } = mount({ withPrimitives: false });
	assert.equal(typeof slots.get('session-delete-confirm').component, 'function');
	assert.equal(typeof icons.get('session.delete'), 'function');
});