// React bindings for the vanilla stores (the only file here that imports React/zustand-react).

import { useStore } from "zustand";
import { authStore, type AuthState } from "./auth";
import { catalogStore, type CatalogState } from "./catalog";
import { chatStore, type ChatState } from "./chat";
import { devicesStore, type DevicesState } from "./devices";
import { historyStore, type HistoryState } from "./history";
import { libraryStore, type LibraryState } from "./library";
import { modelsStore, type ModelsState } from "./models";
import { sessionsStore, type SessionsState } from "./sessions";
import { settingsStore, type SettingsState } from "./settings";
import { uiStore, type UiState } from "./ui";

export const useAuth = <T>(selector: (s: AuthState) => T): T => useStore(authStore, selector);
export const useDevices = <T>(selector: (s: DevicesState) => T): T => useStore(devicesStore, selector);
export const useSessions = <T>(selector: (s: SessionsState) => T): T => useStore(sessionsStore, selector);
export const useChat = <T>(selector: (s: ChatState) => T): T => useStore(chatStore, selector);
export const useModels = <T>(selector: (s: ModelsState) => T): T => useStore(modelsStore, selector);
export const useHistory = <T>(selector: (s: HistoryState) => T): T => useStore(historyStore, selector);
export const useLibrary = <T>(selector: (s: LibraryState) => T): T => useStore(libraryStore, selector);
export const useSettings = <T>(selector: (s: SettingsState) => T): T => useStore(settingsStore, selector);
export const useCatalog = <T>(selector: (s: CatalogState) => T): T => useStore(catalogStore, selector);
export const useUi = <T>(selector: (s: UiState) => T): T => useStore(uiStore, selector);
