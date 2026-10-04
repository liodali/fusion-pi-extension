import { MAX_SETTLE_NUDGES } from "./limits.ts";
import { FUSION_SUMMARY_HEADING } from "./prompts.ts";

export function needsContinuation(input: {
	executed: boolean;
	lastAssistantText: string;
	nudges: number;
	outcome: "completed" | "aborted" | "error";
	canContinue: boolean;
}): string | undefined {
	if (input.outcome !== "completed" || !input.canContinue) return undefined;
	if (input.nudges >= MAX_SETTLE_NUDGES) return undefined;
	if (input.executed && input.lastAssistantText.includes(FUSION_SUMMARY_HEADING)) {
		return undefined;
	}
	if (!input.executed) {
		return `The Fusion run is not finished: you have not delegated yet. Do not stop to ask the user questions; resolve ambiguity by inspecting the repository and choosing the most reasonable interpretation, then continue the protocol by calling fusion_delegate with action "execute".`;
	}
	return `The Fusion run is not finished: continue the protocol. Finish your review, run the final acceptance audit against the original task, call fusion_delegate with action "final_fix" if gaps remain, then write the final summary starting with "${FUSION_SUMMARY_HEADING}".`;
}
