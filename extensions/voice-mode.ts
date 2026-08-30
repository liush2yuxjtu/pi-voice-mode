import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-voice-mode";
const ENABLED_ICON = "🎙";
const DISABLED_ICON = "🔇";
const ERROR_ICON = "⚠️🎙";
const STATE_DIRECTORY_NAME = "pi-voice-mode";
const TOGGLE_FILE_SUFFIX = ".toggle";
const TOGGLE_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.toggle$/i;
const TOGGLE_CREATE_ATTEMPTS = 3;

const VOICE_MODE_PROMPT = `
<voice_input_mode>
当前用户正在通过外部语音转文字软件输入，通常是 Typeless。把用户消息视为语音转写的近似文本，而不是逐字、逐标点都精确的键盘输入。

意图恢复规则：
- 优先结合当前对话、项目术语、可见文件、命令和代码上下文恢复用户最可能表达的意图，不要机械照搬可疑字词。
- 静默容错同音词、近音词、漏词、错词、断句错误、中英文边界错误、技术名词误识别、口头填充词、重复、停顿和未说完便重来的句子。
- 识别自我纠正和口语回退；后说的明确修正覆盖前面的说法，例如“甲，不对，是乙”。
- 用户口述符号时，在上下文明确的情况下恢复字面符号。例如“斜杠 voice”或“slash voice”通常表示“/voice”，“横杠”或“dash”通常表示“-”。
- 对仓库名、产品名、文件名、路径、网址、命令、代码标识符、数字和版本号，先用上下文校正，但不要在证据不足时编造精确值。
- 如果用户明确要求逐字记录、引用原话或生成必须原样保留的内容，不要擅自润色那段内容。

行动规则：
- 不要评价转写质量，不要复述一份“清理后的转写”，也不要因为可能存在转写错误而拒绝行动；直接完成最可能的真实请求。
- 轻微歧义时选择最合理的解释并继续。只有不同解释会实质改变结果时，才用一个简短问题确认关键差异。
- 对删除、覆盖、发布、付款、凭据、安全设置、外部通信等高风险或不可逆操作，只要关键字词仍不确定，就先明确说明你的解释并请求确认。
- 语音模式只改变输入解释方式，不降低任何安全要求、验证要求或项目规则，也不把含糊转写当成额外授权。
</voice_input_mode>
`.trim();

interface VoiceModeOptions {
	stateDirectoryPath?: string;
	reportError?: (message: string, error: unknown) => void;
}

function getDefaultStateDirectoryPath(): string {
	const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.trim();
	const agentDir = configuredAgentDir || join(homedir(), ".pi", "agent");
	return join(agentDir, STATE_DIRECTORY_NAME);
}

function isErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}

async function readVoiceMode(stateDirectoryPath: string): Promise<boolean> {
	try {
		const entries = await readdir(stateDirectoryPath, { withFileTypes: true });
		const toggleCount = entries.filter(
			(entry) => entry.isFile() && TOGGLE_FILE_PATTERN.test(entry.name),
		).length;
		return toggleCount % 2 === 1;
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}

async function appendToggleEvent(stateDirectoryPath: string): Promise<void> {
	await mkdir(stateDirectoryPath, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await chmod(stateDirectoryPath, 0o700);
	for (let attempt = 0; attempt < TOGGLE_CREATE_ATTEMPTS; attempt++) {
		const eventPath = join(stateDirectoryPath, `${randomUUID()}${TOGGLE_FILE_SUFFIX}`);
		try {
			const handle = await open(eventPath, "wx", 0o600);
			await handle.close();
			return;
		} catch (error) {
			if (!isErrorCode(error, "EEXIST")) throw error;
		}
	}
	throw new Error("Unable to allocate a unique pi-voice-mode toggle event");
}

function errorSignature(error: unknown): string {
	if (error instanceof Error) return `${error.name}:${error.message}`;
	return String(error);
}

export default function registerVoiceMode(pi: ExtensionAPI, options: VoiceModeOptions = {}): void {
	const stateDirectoryPath = options.stateDirectoryPath ?? getDefaultStateDirectoryPath();
	const reportError = options.reportError ?? ((message, error) => console.error(message, error));
	let lastReportedError: string | undefined;

	function updateStatus(ctx: ExtensionContext, enabled: boolean): void {
		const icon = enabled ? ENABLED_ICON : DISABLED_ICON;
		const color = enabled ? "accent" : "dim";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, icon));
	}

	function reportStateError(ctx: ExtensionContext, error: unknown): void {
		const signature = errorSignature(error);
		if (signature === lastReportedError) return;
		lastReportedError = signature;
		reportError(`[pi-voice-mode] 无法读取或保存状态目录：${stateDirectoryPath}`, error);
		ctx.ui.notify(ERROR_ICON, "warning");
	}

	async function refreshFromDisk(ctx: ExtensionContext): Promise<boolean> {
		try {
			const enabled = await readVoiceMode(stateDirectoryPath);
			lastReportedError = undefined;
			updateStatus(ctx, enabled);
			return enabled;
		} catch (error) {
			reportStateError(ctx, error);
			updateStatus(ctx, false);
			return false;
		}
	}

	pi.registerCommand("voice", {
		description: "切换全局语音转写容错模式",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("⚠️ /voice", "warning");
				return;
			}

			try {
				await appendToggleEvent(stateDirectoryPath);
				const enabled = await readVoiceMode(stateDirectoryPath);
				lastReportedError = undefined;
				updateStatus(ctx, enabled);
				ctx.ui.notify(enabled ? ENABLED_ICON : DISABLED_ICON, "info");
			} catch (error) {
				reportStateError(ctx, error);
				await refreshFromDisk(ctx);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await refreshFromDisk(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!(await refreshFromDisk(ctx))) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${VOICE_MODE_PROMPT}`,
		};
	});
}
