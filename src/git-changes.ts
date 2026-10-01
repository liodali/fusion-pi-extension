export function parsePorcelain(stdout: string): Map<string, string> {
	const paths = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		if (line.length < 4) continue;
		const status = line.slice(0, 2);
		let path = line.slice(3);
		if (status.includes("R") || status.includes("C")) {
			const arrow = path.indexOf(" -> ");
			if (arrow !== -1) {
				path = path.slice(arrow + 4);
			}
		}
		if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
			path = path.slice(1, -1);
		}
		if (path) paths.set(path, status);
	}
	return paths;
}

export function changedPaths(
	before: Map<string, string>,
	after: Map<string, string>,
): { modified: string[]; added: string[] } {
	const modified: string[] = [];
	const added: string[] = [];
	for (const [path, status] of after) {
		if (before.get(path) === status) continue;
		if (status === "??" || status.startsWith("A")) {
			added.push(path);
		} else {
			modified.push(path);
		}
	}
	return { modified, added };
}
