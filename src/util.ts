/**
 * returns a simple promise that can be awaited that resolves after a specific amount of time has passed
 */
export function sleep(time_ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, time_ms));
}