import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export function createEmptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function aggregateUsage(messages: AgentMessage[]): Usage {
	const usage = createEmptyUsage();
	for (const message of messages) {
		if (message.role !== "assistant" && message.role !== "toolResult") continue;
		const messageUsage = message.usage;
		if (!messageUsage) continue;
		usage.input += messageUsage.input;
		usage.output += messageUsage.output;
		usage.cacheRead += messageUsage.cacheRead;
		usage.cacheWrite += messageUsage.cacheWrite;
		if (messageUsage.cacheWrite1h !== undefined) {
			usage.cacheWrite1h = (usage.cacheWrite1h ?? 0) + messageUsage.cacheWrite1h;
		}
		if (messageUsage.reasoning !== undefined) {
			usage.reasoning = (usage.reasoning ?? 0) + messageUsage.reasoning;
		}
		usage.totalTokens += messageUsage.input + messageUsage.output + messageUsage.cacheRead + messageUsage.cacheWrite;
		usage.cost.input += messageUsage.cost.input;
		usage.cost.output += messageUsage.cost.output;
		usage.cost.cacheRead += messageUsage.cost.cacheRead;
		usage.cost.cacheWrite += messageUsage.cost.cacheWrite;
		usage.cost.total +=
			messageUsage.cost.input + messageUsage.cost.output + messageUsage.cost.cacheRead + messageUsage.cost.cacheWrite;
	}
	return usage;
}

export function aggregateAssistantUsage(messages: AgentMessage[]): Usage {
	return aggregateUsage(messages.filter((message) => message.role === "assistant"));
}

export function addUsage(current: Usage, delta: Usage): Usage {
	const usage = createEmptyUsage();
	usage.input = current.input + delta.input;
	usage.output = current.output + delta.output;
	usage.cacheRead = current.cacheRead + delta.cacheRead;
	usage.cacheWrite = current.cacheWrite + delta.cacheWrite;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	usage.cost.input = current.cost.input + delta.cost.input;
	usage.cost.output = current.cost.output + delta.cost.output;
	usage.cost.cacheRead = current.cost.cacheRead + delta.cost.cacheRead;
	usage.cost.cacheWrite = current.cost.cacheWrite + delta.cost.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	if (current.cacheWrite1h !== undefined || delta.cacheWrite1h !== undefined) {
		usage.cacheWrite1h = (current.cacheWrite1h ?? 0) + (delta.cacheWrite1h ?? 0);
	}
	if (current.reasoning !== undefined || delta.reasoning !== undefined) {
		usage.reasoning = (current.reasoning ?? 0) + (delta.reasoning ?? 0);
	}
	return usage;
}

export function formatUsageSummary(usage: Usage): string {
	const tokens = (value: number): string => value.toLocaleString("en-US");
	const reasoning = usage.reasoning !== undefined ? ` | reasoning ${tokens(usage.reasoning)}` : "";
	return `in ${tokens(usage.input)} | out ${tokens(usage.output)}${reasoning} | cache ${tokens(
		usage.cacheRead + usage.cacheWrite,
	)} | total ${tokens(usage.totalTokens)} | $${usage.cost.total.toFixed(4)}`;
}
