/**
 * dsh-session-delete 主机半边单测（不依赖 DSH 运行时，纯 node 跑）。
 * 用法：node test/index.test.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { ENDPOINT, removeSessionDirs, sessionRoot, __test } from '../lib/index.js';

const failures = [];
async function test(name, body) {
  try {
    await body();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}: ${error?.message ?? error}`);
  }
}

const SID = '09c37dd0-4e4a-4717-aaa4-9a2eaba1f532';

/** 夹具目录：默认系统临时目录；想放别处就设 DSD_TEST_SCRATCH（跑完自动清）。 */
const SCRATCH = process.env.DSD_TEST_SCRATCH || join(tmpdir(), 'dsh-session-delete-tests');
const created = [];

/** 造一个假 root：<root>/<proj>/<sid>/session.v4.jsonl.zstd */
async function fixture() {
  await mkdir(SCRATCH, { recursive: true });
  const root = await mkdtemp(join(SCRATCH, 'dsd-test-'));
  created.push(root);
  const dir = join(root, '--proj--', SID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x'.repeat(64));
  const other = join(root, '--proj--', 'keep-me-0000');
  await mkdir(other, { recursive: true });
  await writeFile(join(other, 'session.v4.jsonl.zstd'), 'y');
  return root;
}

console.log('dsh-session-delete / host half');

await test('ENDPOINT 固定为 /plugin/session-delete', () => {
  assert.equal(ENDPOINT, '/plugin/session-delete');
});

await test('sessionRoot 优先用 ctx.sessionPersistence.root', () => {
  assert.equal(sessionRoot({ sessionPersistence: { root: '/fake/sessions' } }), '/fake/sessions');
});

await test('sessionRoot 退路是 DSH_HOME/sessions', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '/fake-home';
  try {
    assert.equal(sessionRoot({}), join('/fake-home', 'sessions'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

/**
 * 模拟 cordis 的 ctx：没声明的服务一读就抛
 * `cannot get property "x" without inject`。
 */
function cordisLikeCtx(source = {}) {
  return new Proxy(source, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in target) return Reflect.get(target, prop, receiver);
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    }
  });
}

await test('sessionRoot: 服务读不到（cordis 未注入）时退回 DSH_HOME', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '/fake-home';
  try {
    assert.equal(sessionRoot(cordisLikeCtx()), join('/fake-home', 'sessions'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

await test('handle: connection 读不到（未注入）→ 401 而不是抛异常', async () => {
  const { req, res } = fakeExchange({ body: { sessionId: SID } });
  await __test.handle(cordisLikeCtx(), req, res);
  assert.equal(res.statusCode, 401);
});

await test('removeSessionDirs 删掉目标会话、留下别的会话', async () => {
  const root = await fixture();
  const removed = await removeSessionDirs(root, SID);
  assert.equal(removed.length, 1);
  assert.equal(existsSync(join(root, '--proj--', SID)), false);
  assert.equal(existsSync(join(root, '--proj--', 'keep-me-0000', 'session.v4.jsonl.zstd')), true);
});

await test('removeSessionDirs 对不存在的会话返回空数组', async () => {
  const root = await fixture();
  assert.deepEqual(await removeSessionDirs(root, 'no-such-session'), []);
});

await test('removeSessionDirs 跨多个项目目录都能命中', async () => {
  const root = await fixture();
  const second = join(root, '--proj-b--', SID);
  await mkdir(second, { recursive: true });
  await writeFile(join(second, 'session.v4.jsonl.zstd'), 'z');
  const removed = await removeSessionDirs(root, SID);
  assert.equal(removed.length, 2);
  assert.equal(existsSync(second), false);
});

/** 造一个最小的 req/res 对。 */
function fakeExchange({ method = 'POST', body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = headers;
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(chunk) {
      if (typeof chunk === 'string') this.body += chunk;
      this.finished = true;
    }
  };
  return { req, res };
}

const handle = __test.handle;

await test('handle: 非 POST → 405', async () => {
  const root = await fixture();
  const ctx = { sessionPersistence: { root } };
  const { req, res } = fakeExchange({ method: 'GET' });
  await handle(ctx, req, res);
  assert.equal(res.statusCode, 405);
});

await test('handle: sessionId 不合法 → 400', async () => {
  const root = await fixture();
  const ctx = { sessionPersistence: { root } };
  for (const bad of ['', '../etc', 'short', 'a'.repeat(200), 42]) {
    const { req, res } = fakeExchange({ body: { sessionId: bad } });
    await handle(ctx, req, res);
    assert.equal(res.statusCode, 400, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

await test('handle: 正常删除 → 200 + removed 列表', async () => {
  const root = await fixture();
  const ctx = { sessionPersistence: { root } };
  const { req, res } = fakeExchange({ body: { sessionId: SID } });
  await handle(ctx, req, res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.removed.length, 1);
});

await test('handle: 会话不存在 → 404', async () => {
  const root = await fixture();
  const ctx = { sessionPersistence: { root } };
  const { req, res } = fakeExchange({ body: { sessionId: 'ghost-session-1' } });
  await handle(ctx, req, res);
  assert.equal(res.statusCode, 404);
});

await test('handle: 拿不到 root → 503', async () => {
  const previous = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    const { req, res } = fakeExchange({ body: { sessionId: SID } });
    await handle({}, req, res);
    assert.equal(res.statusCode, 503);
  } finally {
    if (previous !== undefined) process.env.DSH_HOME = previous;
  }
});

await test('handle: connection 拒绝 → 用它的状态码', async () => {
  const root = await fixture();
  const ctx = { sessionPersistence: { root }, connection: { requestRejection: () => 401 } };
  const { req, res } = fakeExchange({ body: { sessionId: SID } });
  await handle(ctx, req, res);
  assert.equal(res.statusCode, 401);
});

await test('handle: 请求体过大 → 400', async () => {
  const payload = { sessionId: 'x'.repeat(9000) };
  const req = Readable.from([Buffer.from(JSON.stringify(payload)).subarray(0, 5000), Buffer.from('padding'.repeat(400))]);
  req.method = 'POST';
  req.headers = {};
  const res = { setHeader() {}, end() { this.finished = true; } };
  await handle({ sessionPersistence: { root: '/fake' } }, req, res);
  assert.equal(res.statusCode, 400);
});

const leaked = [];
for (const dir of created) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  if (existsSync(dir)) leaked.push(dir);
}
if (leaked.length > 0) console.warn(`清理夹具失败：${leaked.join(', ')}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} 个用例失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}