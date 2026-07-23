const AM_TASK = /^\s*[-*+]\s\[([ xX])\].*?\[⚓\]\(https:\/\/app\.amazingmarvin\.com\/#t=([^)\s]+)/;

interface MarvinTaskLine {
	taskId: string;
	done: boolean;
}

export function marvinTaskIdFromCompletedLine(line: string): string | undefined {
	const task = parseMarvinTaskLine(line);
	return task?.done ? task.taskId : undefined;
}

export function isNewlyCompletedMarvinTask(
	before: string,
	after: string,
): string | undefined {
	const previous = parseMarvinTaskLine(before);
	const next = parseMarvinTaskLine(after);
	return (
		previous
		&& next
		&& previous.taskId === next.taskId
		&& !previous.done
		&& next.done
	)
		? next.taskId
		: undefined;
}

function parseMarvinTaskLine(line: string): MarvinTaskLine | undefined {
	const match = line.match(AM_TASK);
	if (!match?.[1] || !match[2]) {
		return undefined;
	}
	return {
		taskId: match[2],
		done: match[1].toLowerCase() === "x",
	};
}
