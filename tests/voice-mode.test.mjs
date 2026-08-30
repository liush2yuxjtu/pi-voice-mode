import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import registerVoiceMode from "../extensions/voice-mode.ts";

async function createHarness(sharedStateFilePath) {
	const directory = sharedStateFilePath ? undefined : await mkdtemp(join(tmpdir(), "pi-voice-mode-"));
	const stateFilePath = sharedStateFilePath ?? join(directory, "state.json");
	const commands = new Map();
	const handlers = new Map();
	const notifications = [];
	const statuses = [];
	const loggedErrors = [];

	const pi = {
		registerCommand(name, options) {
			commands.set(name, options);
		},
		on(eventName, handler) {
			const eventHandlers = handlers.get(eventName) ?? [];
			handlers.set(eventName, [...eventHandlers, handler]);
		},
	};

	registerVoiceMode(pi, {
		stateFilePath,
		reportError(message, error) {
			loggedErrors.push({ message, error });
		},
	});

	const ctx = {
		ui: {
			theme: {
				fg(_color, text) {
					return text;
				},
			},
			notify(message, level = "info") {
				notifications.push({ message, level });
			},
			setStatus(key, value) {
				statuses.push({ key, value });
			},
		},
	};

	async function emit(eventName, event = {}) {
		let result;
		for (const handler of handlers.get(eventName) ?? []) {
			const nextResult = await handler(event, ctx);
			if (nextResult !== undefined) result = nextResult;
		}
		return result;
	}

	return {
		cleanup: () => (directory ? rm(directory, { force: true, recursive: true }) : Promise.resolve()),
		command: commands.get("voice"),
		ctx,
		emit,
		loggedErrors,
		notifications,
		stateFilePath,
		statuses,
	};
}

test("/voice 是无参数的全局开关，并把状态持久化到 Pi 配置目录", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	assert.ok(harness.command, "应注册 /voice 命令");
	assert.match(harness.command.description, /切换.*语音|语音.*切换/);

	await harness.emit("session_start");
	assert.equal(harness.statuses.at(-1).value, "🔇");

	await harness.command.handler("   ", harness.ctx);
	assert.equal(harness.statuses.at(-1).value, "🎙");
	assert.equal(harness.notifications.at(-1).message, "🎙");
	assert.deepEqual(JSON.parse(await readFile(harness.stateFilePath, "utf8")), { enabled: true });

	await harness.command.handler("", harness.ctx);
	assert.equal(harness.statuses.at(-1).value, "🔇");
	assert.equal(harness.notifications.at(-1).message, "🔇");
	assert.deepEqual(JSON.parse(await readFile(harness.stateFilePath, "utf8")), { enabled: false });
});

test("状态栏只显示图标，不显示中文或英文", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	await harness.emit("session_start");
	await harness.command.handler("", harness.ctx);

	for (const status of harness.statuses) {
		assert.equal(/[\p{L}\p{N}]/u.test(status.value), false);
	}
});

test("开启后为每一轮注入 Typeless 转写容错提示", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);
	await harness.emit("session_start");
	await harness.command.handler("", harness.ctx);

	const result = await harness.emit("before_agent_start", {
		prompt: "帮我改这个问题",
		systemPrompt: "BASE SYSTEM PROMPT",
	});

	assert.ok(result?.systemPrompt.startsWith("BASE SYSTEM PROMPT"));
	assert.match(result.systemPrompt, /Typeless/);
	assert.match(result.systemPrompt, /同音|误识别|转写错误/);
	assert.match(result.systemPrompt, /自我纠正|后说/);
	assert.match(result.systemPrompt, /斜杠|slash/);
	assert.match(result.systemPrompt, /不可逆|高风险/);
	assert.match(result.systemPrompt, /不要.*复述|无需.*复述/);
});

test("一个会话开启后，其他会话和重启后的 Pi 都能读取同一份全局状态", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-voice-mode-shared-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const stateFilePath = join(directory, "state.json");
	const first = await createHarness(stateFilePath);
	const second = await createHarness(stateFilePath);

	await first.emit("session_start");
	await first.command.handler("", first.ctx);
	await second.emit("session_start");

	assert.equal(second.statuses.at(-1).value, "🎙");
	const result = await second.emit("before_agent_start", {
		prompt: "继续",
		systemPrompt: "BASE",
	});
	assert.match(result.systemPrompt, /Typeless/);
});

test("并行 Pi 会话同时切换时不会丢失任何一次取反", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-voice-mode-concurrent-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const stateFilePath = join(directory, "state.json");
	const first = await createHarness(stateFilePath);
	const second = await createHarness(stateFilePath);

	await Promise.all([
		first.command.handler("", first.ctx),
		second.command.handler("", second.ctx),
	]);

	assert.deepEqual(JSON.parse(await readFile(stateFilePath, "utf8")), { enabled: false });
	await first.emit("before_agent_start", { prompt: "同步", systemPrompt: "BASE" });
	await second.emit("before_agent_start", { prompt: "同步", systemPrompt: "BASE" });
	assert.equal(first.statuses.at(-1).value, "🔇");
	assert.equal(second.statuses.at(-1).value, "🔇");
});

test("每轮开始前重新读取全局状态，避免并行 Pi 会话使用旧值", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);
	await harness.emit("session_start");
	assert.equal(harness.statuses.at(-1).value, "🔇");

	await writeFile(harness.stateFilePath, '{"enabled":true}\n');
	const result = await harness.emit("before_agent_start", {
		prompt: "外部会话已经开启",
		systemPrompt: "BASE",
	});

	assert.equal(harness.statuses.at(-1).value, "🎙");
	assert.match(result.systemPrompt, /Typeless/);
});

test("/voice 后误带文本时不切换，也不把文本当成请求发送", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);
	await harness.emit("session_start");
	await harness.command.handler("帮我修复登录", harness.ctx);

	assert.equal(harness.notifications.at(-1).level, "warning");
	assert.equal(harness.notifications.at(-1).message, "⚠️ /voice");
	assert.rejects(readFile(harness.stateFilePath, "utf8"), { code: "ENOENT" });
	assert.equal(
		await harness.emit("before_agent_start", {
			prompt: "普通输入",
			systemPrompt: "BASE",
		}),
		undefined,
	);
});

test("损坏的状态文件不会让 Pi 启动失败，并能用下一次 /voice 自动修复", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);
	await writeFile(harness.stateFilePath, "not-json");

	await assert.doesNotReject(harness.emit("session_start"));
	assert.equal(harness.statuses.at(-1).value, "🔇");
	assert.equal(harness.notifications.at(-1).message, "⚠️🎙");
	assert.equal(harness.loggedErrors.length, 1);

	await harness.command.handler("", harness.ctx);
	assert.deepEqual(JSON.parse(await readFile(harness.stateFilePath, "utf8")), { enabled: true });
	assert.equal(harness.statuses.at(-1).value, "🎙");
});

test("持久化文件在支持权限位的平台上只允许当前用户读写", async (t) => {
	if (process.platform === "win32") t.skip("Windows 不提供相同的权限位语义");
	const harness = await createHarness();
	t.after(harness.cleanup);

	await harness.command.handler("", harness.ctx);
	assert.equal((await stat(harness.stateFilePath)).mode & 0o777, 0o600);
});
