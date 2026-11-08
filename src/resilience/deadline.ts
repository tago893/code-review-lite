/** Aborts the returned signal with a TimeoutError after `ms`. The reason is non-retryable (see classifyError). The timer is unref'd. */
export function startDeadline(ms: number): { readonly signal: AbortSignal } {
  const controller = new AbortController();
  setTimeout(() => controller.abort(Object.assign(new Error("run deadline exceeded"), { name: "TimeoutError" })), ms).unref();
  return { signal: controller.signal };
}
