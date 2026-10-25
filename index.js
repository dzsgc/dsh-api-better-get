/**
 * dsh-moonshot-models —— 让 DSH 真正用 `GET /v1/models` 获取模型列表。
 *
 * ## 为什么需要这一层
 *
 * DSH 的「获取可用模型」（设置 → 模型 → 获取可用模型）调用
 * `ctx.llm.discoverModels(settingsNs, { provider })`，最终落到
 * `@deepseek-ai/dsh-llm-pi-ai` 的 `discoverModels()`。那段逻辑是：
 *
 * ```js
 * if (request.provider !== void 0) {
 *   const installed = catalogModels(request.provider);
 *   if (installed.size > 0) return [...installed.values()].map(...); // 直接返回，不发网络请求
 * }
 * ```
 *
 * 也就是说：只要 provider 名是 pi-ai 内置 catalog 描述过的路由（`moonshotai-cn`
 * 就是），DSH 立刻返回**随包发布的静态模型表**，永远不向
 * `https://api.moonshot.cn/v1/models` 发请求。于是出现这种现象：
 *
 * - `curl` 直接 GET 能拿到 `kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`
 * - DSH 的「获取可用模型」只给 4 个旧模型（`moonshotai-cn.json` 里就那 4 个）
 *
 * 本插件在 `llm` 服务上接管 `discoverModels`：对配置里指定的那个 provider，
 * 走一次真实的 `GET {baseURL}/models`，把返回的模型映射成 DSH 的
 * `LlmDiscoveredModel`；其余 provider 原样交给下游方法。
 *
 * ## 边界
 *
 * - 只覆盖 discovery 这一个方法，不碰 adapter、不碰 stream、不改配置。
 * - 拿到的候选模型仍由用户在「获取可用模型」界面勾选采纳，写回 `cordis.patch.yml`，
 *   之后由 `dsh-llm-pi-ai` 正常建成 route —— 本插件不写任何配置。
 * - 插件卸载时把方法还原（`delete` 实例属性，落回原型方法）。
 *
 * @module dsh-moonshot-models
 */

import fs from 'node:fs';
import path from 'node:path';

/** 插件名（与 package.json 保持一致）。 */
export const name = 'dsh-moonshot-models';

/**
 * 只注入 `llm`：本插件的方法挂在 llm 服务上。
 * `credentials` 不写进 inject —— 它缺失时应当退回到直接读凭证文件，而不是让整个插件不激活。
 * @type {string[]}
 */
export const inject = ['llm'];

/** 默认 provider 路由。 */
const DEFAULT_PROVIDER = 'moonshotai-cn';
/** 默认端点。 */
const DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1';
/** 默认凭证引用名（`.credentials.yaml` 的 `refs` 键）。 */
const DEFAULT_API_KEY_ENV = 'MOONSHOTAI_CN_API_KEY';
/** 接口没给上下文长度时的兜底值，与 DSH 自己的默认一致。 */
const DEFAULT_CONTEXT_WINDOW = 262144;

/**
 * 去掉末尾斜杠，避免拼出 `//models`。
 * @param {unknown} value
 * @returns {string}
 */
function trimTrailingSlash(value) {
	return String(value).replace(/\/+$/, '');
}

/**
 * 从 `$DSH_HOME/.credentials.yaml` 的 `refs:` 段读一个引用。
 * 只在 credentials 服务不可用时兜底：文件格式是 `refs:` 下一层 `KEY: value`。
 * @param {string} envName
 * @returns {string | undefined}
 */
function readRefFromCredentialsFile(envName) {
	const home = process.env.DSH_HOME;
	if (typeof home !== 'string' || home.length === 0) return undefined;
	let text;
	try {
		text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
	} catch {
		return undefined;
	}
	let inRefs = false;
	for (const rawLine of text.split(/\r?\n/)) {
		if (/^refs:\s*$/.test(rawLine)) {
			inRefs = true;
			continue;
		}
		if (!inRefs) continue;
		if (/^\S/.test(rawLine)) break;
		const match = /^\s+([A-Za-z0-9_.-]+)\s*:\s*(.+?)\s*$/.exec(rawLine);
		if (match === null) continue;
		if (match[1] !== envName) continue;
		return match[2].replace(/^["']|["']$/g, '');
	}
	return undefined;
}

/**
 * 解析这次探测要用的 key：调用方现填的 > credentials 服务 > 凭证文件。
 * @param {object} ctx
 * @param {string} envName
 * @param {object | undefined} request
 * @returns {Promise<string | undefined>}
 */
async function resolveApiKey(ctx, envName, request) {
	const supplied = request?.apiKey;
	if (typeof supplied === 'string' && supplied.trim().length > 0) return supplied.trim();
	try {
		const resolved = await ctx.credentials?.resolve?.(envName);
		const value = typeof resolved === 'string' ? resolved : resolved?.value;
		if (typeof value === 'string' && value.trim().length > 0) return value.trim();
	} catch {
		/* 服务不可用或引用不存在时继续兜底 */
	}
	return readRefFromFileSafe(envName);
}

/**
 * @param {string} envName
 * @returns {string | undefined}
 */
function readRefFromFileSafe(envName) {
	try {
		const value = readRefFromCredentialsFile(envName);
		return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 把 Moonshot 的 `data[]` 映射成 DSH 的候选模型。
 *
 * 只保留 DSH 认识的模态（`text` / `image`）；Moonshot 还会声明 `video`，
 * 那不是 DSH 当前模型列表能表达的输入模态。
 * @param {unknown} rows
 * @returns {{ id: string, name: string, contextWindow?: number, maxTokens?: number, inputModalities: string[] }[]}
 */
function mapDiscoveredModels(rows) {
	const out = [];
	if (!Array.isArray(rows)) return out;
	for (const row of rows) {
		if (row === null || typeof row !== 'object') continue;
		const id = row.id;
		if (typeof id !== 'string' || id.length === 0) continue;
		const contextWindow = Number.isFinite(row.context_length) ? row.context_length : undefined;
		const declared = Array.isArray(row?.modalities?.input) ? row.modalities.input : undefined;
		const source = declared ?? (row.supports_image_in === true ? ['text', 'image'] : ['text']);
		const inputModalities = source.filter((modality) => modality === 'text' || modality === 'image');
		out.push({
			id,
			name: id,
			...(contextWindow === undefined
				? {}
				: { contextWindow, maxTokens: contextWindow }),
			inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
		});
	}
	return out;
}

/**
 * @param {object} ctx
 * @param {object | undefined} config
 */
export function apply(ctx, config) {
	const provider = String(config?.provider ?? DEFAULT_PROVIDER);
	const baseURL = trimTrailingSlash(config?.baseURL ?? DEFAULT_BASE_URL);
	const apiKeyEnv = String(config?.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
	const llm = ctx.llm;
	const downstream = llm.discoverModels;

	/**
	 * 接管后的 `discoverModels`。签名与 `LlmRuntime.discoverModels` 一致。
	 * @param {string} settingsNs
	 * @param {{ provider?: string, baseURL?: string, api?: string, apiKey?: string }} request
	 * @param {AbortSignal | undefined} signal
	 */
	async function discoverViaGet(settingsNs, request, signal) {
		if (request?.provider !== provider) return downstream.call(this, settingsNs, request, signal);
		const url = `${baseURL}/models`;
		const headers = { accept: 'application/json' };
		const apiKey = await resolveApiKey(ctx, apiKeyEnv, request);
		if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;
		let response;
		try {
			response = await fetch(url, { method: 'GET', headers, ...(signal === undefined ? {} : { signal }) });
		} catch (error) {
			if (signal?.aborted === true) throw error;
			throw new Error(`无法连接 ${url}：${error instanceof Error ? error.message : String(error)}`);
		}
		if (!response.ok) {
			const hint = response.status === 401 || response.status === 403 ? '，请检查 API key' : '';
			throw new Error(`${url} 返回 ${response.status}${hint}`);
		}
		let body;
		try {
			body = await response.json();
		} catch (error) {
			throw new Error(`${url} 没有返回 JSON：${error instanceof Error ? error.message : String(error)}`);
		}
		const models = mapDiscoveredModels(body?.data);
		if (models.length === 0) throw new Error(`${url} 没有返回任何模型`);
		return models;
	}

	ctx.effect(() => {
		llm.discoverModels = discoverViaGet;
		return () => {
			try {
				if (llm.discoverModels === discoverViaGet) delete llm.discoverModels;
			} catch {
				/* 服务已被拆除时无需还原 */
			}
		};
	}, 'moonshot-models: discover models over GET');
}
