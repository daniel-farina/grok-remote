// What Enter does in the composer. On touch devices Enter adds a newline and
// the send button sends (like the Claude app); on desktop Enter sends and
// Shift+Enter adds a newline. Never send while an IME is composing.
export function enterAction(
  ev: { key: string; shiftKey: boolean; isComposing?: boolean },
  coarsePointer: boolean,
): 'send' | 'newline' {
  if (ev.key !== 'Enter' || ev.isComposing) return 'newline';
  if (coarsePointer) return 'newline';
  return ev.shiftKey ? 'newline' : 'send';
}
