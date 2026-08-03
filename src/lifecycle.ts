const controller = new AbortController();

export const applicationSignal = controller.signal;

export function cancelApplication(): void {
  controller.abort();
}
