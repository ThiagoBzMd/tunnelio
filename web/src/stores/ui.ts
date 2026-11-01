// Transient UI state shared across the shell: which window is open (settings tab, language,
// keyboard shortcuts), the desktop sidebar's hover preview, and anonymous mode (a new chat that
// the computer will not keep; the shell shows its frame instead of the sidebar).

import { createStore } from "zustand/vanilla";

/** The agent / skills chosen for the next new chat, valid on that computer only (SPEC §9.4). */
export interface DraftSetup {
  deviceId: string | null;
  agentId: string | null;
  skillIds: string[];
}

export const NO_DRAFT_SETUP: DraftSetup = { deviceId: null, agentId: null, skillIds: [] };

export type SettingsTab = "general" | "account";
/** Phone: the page of the settings list on show (null: the list itself). */
export type SettingsPage = "profile" | "computers" | "sessions" | "security" | "conversations";

export interface UiState {
  settings: SettingsTab | null;
  settingsPage: SettingsPage | null;
  language: boolean;
  shortcuts: boolean;
  /** Desktop, sidebar not pinned: the sidebar shows as a floating panel while hovered. */
  peek: boolean;
  /** The next new chat is anonymous (set by the ghost, cleared when leaving it). */
  incognitoDraft: boolean;
  /** The screen on show is an anonymous chat (draft or conversation): the shell draws its frame. */
  incognitoFrame: boolean;
  draftSetup: DraftSetup;
  openSettings(tab?: SettingsTab, page?: SettingsPage | null): void;
  closeSettings(): void;
  setSettingsPage(page: SettingsPage | null): void;
  setLanguage(open: boolean): void;
  setShortcuts(open: boolean): void;
  setPeek(open: boolean): void;
  setIncognitoDraft(on: boolean): void;
  setIncognitoFrame(on: boolean): void;
  setDraftSetup(setup: DraftSetup): void;
}

export const uiStore = createStore<UiState>((set) => ({
  settings: null,
  settingsPage: null,
  language: false,
  shortcuts: false,
  peek: false,
  incognitoDraft: false,
  incognitoFrame: false,
  draftSetup: NO_DRAFT_SETUP,
  openSettings: (tab = "general", page = null) => set({ settings: tab, settingsPage: page }),
  closeSettings: () => set({ settings: null, settingsPage: null }),
  setSettingsPage: (settingsPage) => set({ settingsPage }),
  setLanguage: (language) => set({ language }),
  setShortcuts: (shortcuts) => set({ shortcuts }),
  setPeek: (peek) => set({ peek }),
  setIncognitoDraft: (incognitoDraft) => set({ incognitoDraft }),
  setIncognitoFrame: (incognitoFrame) => set({ incognitoFrame }),
  setDraftSetup: (draftSetup) => set({ draftSetup }),
}));
