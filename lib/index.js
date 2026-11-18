/**
 * dsh-session-delete —— 主机半边。
 *
 * 职责：注册一条 HTTP 路由 `POST /plugin/session-delete`，真的把某个会话的
 * 持久化目录（`<root>/<项目目录>/<sessionId>/`，里面是 session.vN.jsonl.zstd）
 * 从磁盘删掉。浏览器半边（lib/client.js）负责在会话标题栏放按钮并调用它。
 *
 * 为什么不走官方 RPC：会话控制器（host / client 两侧）都没有 delete API，
 * 只有 WorkspaceController.archiveSession（归档 = 从列表移走、可恢复）。
 * 硬删除只能落在文件系统上，所以这里直接用 node:fs。
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 路由路径；浏览器半边必须用同一个字符串。 */
export const ENDPOINT = '/plugin/session-delete';

/** 请求体上限：只收一个 sessionId。 */
const MAX_BODY_BYTES = 4 * 1024;

/** 会话 id 只允许安全字符，杜绝路径穿越。 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/;

/** Windows 上被占用的句柄会抛这些码：值得重试。 */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

/**
 * 主机侧需要的服务。
 * `connection` 必须显式声明：cordis 的 ctx 代理只允许读已注入的服务，
 * 不声明就去 `Reflect.get(ctx, 'connection')` 会抛异常（表现为路由 400 空响应）。
 */
export const inject = ['webServer', 'connection', 'sessionPersistence'];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 解析会话持久化根目录。
 * 首选 `sessionPersistence.root`（jsonl 后端把配置的 root 存在实例上）；
 * 退路是 DSH_HOME/sessions。
 * @param ctx - 主机上下文。
 * @returns 绝对路径，或 undefined（拿不到就报错而不是乱猜）。
 */
export function sessionRoot(ctx) {
  let persistence;
  try {
    persistence = Reflect.get(ctx, 'sessionPersistence');
  } catch {
    // 没注入这个服务时 cordis 的 ctx 代理会抛，退回到 DSH_HOME。
    persistence = undefined;
  }
  const root = persistence?.root ?? persistence?.config?.root;
  if (typeof root === 'string' && root.length > 0) return root;
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home.length > 0) return join(home, 'sessions');
  return undefined;
}

/**
 * 删掉某个会话在根目录下出现的所有会话目录（正常情况下只有一个）。
 * @param root - 会话持久化根目录。
 * @param sessionId - 会话 id。
 * @returns 被删掉的目录列表；不存在时为空数组。
 */
export async function removeSessionDirs(root, sessionId) {
  const removed = [];
  const projects = await readdir(root, { withFileTypes: true });
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name, sessionId);
    let present = false;
    try {
      present = (await stat(dir)).isDirectory();
    } catch {
      present = false;
    }
    if (!present) continue;
    await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    removed.push(dir);
  }
  return removed;
}

/**
 * 带重试地删除：句柄刚释放时 Windows 会短暂占用文件。
 * @param root - 会话持久化根目录。
 * @param sessionId - 会话 id。
 * @param attempts - 最多试几次。
 * @returns 被删掉的目录列表。
 */
async function removeWithRetry(root, sessionId, attempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await removeSessionDirs(root, sessionId);
    } catch (error) {
      lastError = error;
      if (!TRANSIENT.has(error?.code)) throw error;
      if (attempt < attempts) await delay(250 * attempt);
    }
  }
  throw lastError;
}

/** 写 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/** 读请求体（有上限）。 */
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (total === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 同源/鉴权守卫：优先用宿主自带的 connection 策略。 */
function rejectionOf(ctx, req) {
  let connection;
  try {
    connection = Reflect.get(ctx, 'connection');
  } catch {
    // 没声明/没注入 connection 时 cordis 代理会抛；这里直接拒绝（fail closed）更安全。
    return 401;
  }
  if (typeof connection?.requestRejection === 'function') {
    return connection.requestRejection(req);
  }
  return undefined;
}

/** 路由处理函数。 */
async function handle(ctx, req, res) {
  const rejection = rejectionOf(ctx, req);
  if (rejection !== undefined) {
    res.statusCode = rejection;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: '只接受 POST' });
    return;
  }
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, code: 'bad-body', message: `请求体无法解析：${String(error?.message ?? error)}` });
    return;
  }
  const sessionId = payload?.sessionId;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    sendJson(res, 400, { ok: false, code: 'bad-session-id', message: 'sessionId 不合法' });
    return;
  }
  const root = sessionRoot(ctx);
  if (root === undefined) {
    sendJson(res, 503, { ok: false, code: 'no-root', message: '拿不到会话持久化根目录，无法删除' });
    return;
  }
  try {
    const removed = await removeWithRetry(root, sessionId);
    if (removed.length === 0) {
      sendJson(res, 404, { ok: false, code: 'not-found', message: '磁盘上没有这个会话的日志目录' });
      return;
    }
    sendJson(res, 200, { ok: true, removed });
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'delete-failed';
    if (TRANSIENT.has(code)) {
      sendJson(res, 409, {
        ok: false,
        code: 'in-use',
        message: '会话日志正被进程占用，删不掉：先切到别的会话（或让它停跑）再删一次'
      });
      return;
    }
    sendJson(res, 500, { ok: false, code, message: String(error?.message ?? error) });
  }
}

/** 供单测使用的内部导出（不参与运行期装配）。 */
export const __test = { handle, rejectionOf, readJsonBody, removeWithRetry };

/** 插件入口：注册路由，随插件 fiber 一起卸载。 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ENDPOINT,
        handler: (req, res) => handle(ctx, req, res)
      }),
    `session-delete: POST ${ENDPOINT}`
  );
}