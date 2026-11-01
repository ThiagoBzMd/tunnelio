// Small navigation actions shared by the sidebar, the keyboard shortcuts and the anonymous frame.

import type { NavigateFunction } from "react-router";
import { chatStore } from "@/stores/chat";
import { settingsStore } from "@/stores/settings";
import { NO_DRAFT_SETUP, uiStore } from "@/stores/ui";

/** A fresh, normal (not anonymous) chat, without agent or skills. */
export function startNewChat(navigate: NavigateFunction): void {
  uiStore.getState().setIncognitoDraft(false);
  uiStore.getState().setDraftSetup(NO_DRAFT_SETUP);
  chatStore.getState().select(null);
  navigate("/");
}

/** A fresh anonymous chat: the computer keeps nothing of it. */
export function startIncognitoChat(navigate: NavigateFunction): void {
  uiStore.getState().setIncognitoDraft(true);
  uiStore.getState().setDraftSetup(NO_DRAFT_SETUP);
  chatStore.getState().select(null);
  navigate("/");
}

/** A fresh chat with an agent of that computer ("Use" on the Agents screen). */
export function startChatWithAgent(navigate: NavigateFunction, deviceId: string, agentId: string): void {
  void settingsStore.getState().update({ default_device_id: deviceId });
  uiStore.getState().setIncognitoDraft(false);
  uiStore.getState().setDraftSetup({ deviceId, agentId, skillIds: [] });
  chatStore.getState().select(null);
  navigate("/");
}
