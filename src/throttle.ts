export interface Throttle {
	schedule: () => void;
	flush: () => void;
	cancel: () => void;
}

export function createThrottle(fn: () => void, ms: number): Throttle {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		schedule() {
			if (timer !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				fn();
			}, ms);
		},
		flush() {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			fn();
		},
		cancel() {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}
