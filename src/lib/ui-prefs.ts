// Client-only UI preferences (localStorage). Not synced to the server.
//
// toolsInChat: when true, tool-call cards render inline inside each
// conversation turn. When false, they live only in the tools side panel
// (hidden on mobile, so off = no tool cards in the chat stream).
//
// Unset: responsive default — inline on narrow viewports (≤720px), side
// panel on wide. Once the user picks a value, that choice wins everywhere.

export const TOOLS_IN_CHAT_KEY = 'grok-remote.ui.toolsInChat';
export const TOOLS_IN_CHAT_CHANGE = 'grok-remote:tools-in-chat-change';

const MOBILE_MAX = 720;

export type ToolsInChatPref = 'on' | 'off' | 'auto';

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX;
}

/** Stored preference: 'on' | 'off' | null (auto / unset). */
export function getToolsInChatPref(): ToolsInChatPref {
  try {
    const v = localStorage.getItem(TOOLS_IN_CHAT_KEY);
    if (v === '1' || v === 'on' || v === 'true') return 'on';
    if (v === '0' || v === 'off' || v === 'false') return 'off';
  } catch { /* ignore */ }
  return 'auto';
}

/** Effective boolean used by the chat view. */
export function getToolsInChat(isMobile?: boolean): boolean {
  const pref = getToolsInChatPref();
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return isMobile ?? isMobileViewport();
}

/**
 * Persist and broadcast. Pass true/false for an explicit choice.
 * Pass null to clear back to the responsive default.
 */
export function setToolsInChat(on: boolean | null): boolean {
  try {
    if (on === null) localStorage.removeItem(TOOLS_IN_CHAT_KEY);
    else localStorage.setItem(TOOLS_IN_CHAT_KEY, on ? '1' : '0');
  } catch { /* ignore */ }
  const effective = getToolsInChat();
  try {
    window.dispatchEvent(new CustomEvent(TOOLS_IN_CHAT_CHANGE, {
      detail: { pref: getToolsInChatPref(), enabled: effective },
    }));
  } catch { /* ignore */ }
  return effective;
}
