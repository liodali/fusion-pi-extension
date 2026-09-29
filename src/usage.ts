import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export function aggregateUsage(messages: AgentMessage[]): Usage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
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
