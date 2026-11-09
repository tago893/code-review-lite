// Test only: a plugin that loads fine and records nothing, but whose prune hook throws before every request.
export const CraHistoryPlugin = async () => ({
  "experimental.chat.messages.transform": async () => { throw new Error("boom in prune hook"); },
});
