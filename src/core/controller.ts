import { delegationError, scoutLimitError, type DelegationAction, type DelegationState } from "./workflow.ts";

/** Owns the shared workflow transitions; adapters retain their native run data. */
export class FusionController {
	constructor(readonly state: DelegationState & { scoutCalls: number }) {}

	beginDelegation(action: DelegationAction): string | undefined {
		const error = delegationError(this.state, action);
		if (error) return error;
		this.state.delegating = true;
		if (action === "revise") this.state.revisions += 1;
		if (action === "final_fix") this.state.finalFixUsed = true;
		return undefined;
	}

	completeDelegation(): void {
		this.state.executed = true;
	}

	endDelegation(action: DelegationAction): void {
		this.state.delegating = false;
		if (action === "resume") this.state.resumePending = false;
	}

	beginScout(): string | undefined {
		const error = scoutLimitError(this.state.scoutCalls);
		if (!error) this.state.scoutCalls += 1;
		return error;
	}
}
