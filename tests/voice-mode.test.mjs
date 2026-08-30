import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import registerVoiceMode from "../extensions/voice-mode.ts";

const TOGGLE_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.toggle$/i;

async function listToggleFiles(stateDirectoryPath) {
	try {
		return (await readdir(stateDirectoryPath)).filter((name) => TOGGLE_FILE_PATTERN.test(name)).sort();
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

async function readPersistedMode(stateDirectoryPath) {
	return (await listToggleFiles(stateDirectoryPath)).length % 2 === 1;
}

async function createToggleEvent(stateDirectoryPath) {
	await mkdir(stateDirectoryPath, { recursive: true });
	const handle = await open(join(stateDirectoryPath, `${randomUUID()}.toggle`), "wx", 0o600);
	await handle.close();
}

async function createHarness(sharedStateDirectoryPath) {
	const directory = sharedStateDirectoryPath ? undefined : await mkdtemp(join(tmpdir(), "pi-voice-mode-"));
	const stateDirectoryPath = sharedStateDirectoryPath ?? join(directory, "state");
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
		stateDirectoryPath,
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
		stateDirectoryPath,
		statuses,
	};
}

test("/voice 是无参数的全局开关，并把每次切换持久化为唯一事件", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	assert.ok(harness.command, "应注册 /voice 命令");
	assert.match(harness.command.description, /切换.*语音|语音.*切换/);

	await harness.emit("session_start");
	assert.equal(harness.statuses.at(-1).value, "🔇");

	await harness.command.handler("   ", harness.ctx);
	assert.equal(harness.statuses.at(-1).value, "🎙");
	assert.equal(harness.notifications.at(-1).message, "🎙");
	assert.equal(await readPersistedMode(harness.stateDirectoryPath), true);
	assert.equal((await listToggleFiles(harness.stateDirectoryPath)).length, 1);

	await harness.command.handler("", harness.ctx);
	assert.equal(harness.statuses.at(-1).value, "🔇");
	assert.equal(harness.notifications.at(-1).message, "🔇");
	assert.equal(await readPersistedMode(harness.stateDirectoryPath), false);
	assert.equal((await listToggleFiles(harness.stateDirectoryPath)).length, 2);
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
	const stateDirectoryPath = join(directory, "state");
	const first = await createHarness(stateDirectoryPath);
	const second = await createHarness(stateDirectoryPath);

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

test("大量并行 /voice 操作不会丢失任何一次切换", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-voice-mode-concurrent-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const stateDirectoryPath = join(directory, "state");
	const harnesses = await Promise.all(
		Array.from({ length: 20 }, () => createHarness(stateDirectoryPath)),
	);

	await Promise.all(harnesses.map((harness) => harness.command.handler("", harness.ctx)));

	assert.equal((await listToggleFiles(stateDirectoryPath)).length, 20);
	assert.equal(await readPersistedMode(stateDirectoryPath), false);
	for (const harness of harnesses) {
		await harness.emit("before_agent_start", { prompt: "同步", systemPrompt: "BASE" });
		assert.equal(harness.statuses.at(-1).value, "🔇");
	}
});

test("每轮开始前重新读取全局状态，避免并行 Pi 会话使用旧值", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);
	await harness.emit("session_start");
	assert.equal(harness.statuses.at(-1).value, "🔇");

	await createToggleEvent(harness.stateDirectoryPath);
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
	assert.equal((await listToggleFiles(harness.stateDirectoryPath)).length, 0);
	assert.equal(
		await harness.emit("before_agent_start", {
			prompt: "普通输入",
			systemPrompt: "BASE",
		}),
		undefined,
	);
});

test("状态目录中的无关或损坏文件会被忽略，不会阻止 /voice 自助恢复", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);
	await mkdir(harness.stateDirectoryPath, { recursive: true });
	await writeFile(join(harness.stateDirectoryPath, "not-a-toggle.json"), "not-json");
	await writeFile(join(harness.stateDirectoryPath, "not-a-toggle.toggle"), "not-json");

	await assert.doesNotReject(harness.emit("session_start"));
	assert.equal(harness.statuses.at(-1).value, "🔇");
	assert.equal(harness.loggedErrors.length, 0);

	await harness.command.handler("", harness.ctx);
	assert.equal(await readPersistedMode(harness.stateDirectoryPath), true);
	assert.equal(harness.statuses.at(-1).value, "🎙");
});

test("状态目录和切换事件在支持权限位的平台上保持私有", async (t) => {
	if (process.platform === "win32") t.skip("Windows 不提供相同的权限位语义");
	const harness = await createHarness();
	t.after(harness.cleanup);
	await mkdir(harness.stateDirectoryPath, { mode: 0o755, recursive: true });

	await harness.command.handler("", harness.ctx);
	const [toggleFile] = await listToggleFiles(harness.stateDirectoryPath);
	assert.equal((await stat(harness.stateDirectoryPath)).mode & 0o777, 0o700);
	assert.equal((await stat(join(harness.stateDirectoryPath, toggleFile))).mode & 0o777, 0o600);
});
