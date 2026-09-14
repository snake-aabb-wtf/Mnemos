import { create } from "zustand";

export type ThemePreference = "system" | "light" | "dark";

interface UiState {
  sidebarCollapsed: boolean;
  mobileNavOpen: boolean;
  theme: ThemePreference;
  eventFilter: string;
  eventsPaused: boolean;
  toggleSidebar(): void;
  setMobileNavOpen(open: boolean): void;
  setTheme(theme: ThemePreference): void;
  setEventFilter(filter: string): void;
  setEventsPaused(paused: boolean): void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  mobileNavOpen: false,
  theme: "system",
  eventFilter: "all",
  eventsPaused: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
  setTheme: (theme) => set({ theme }),
  setEventFilter: (eventFilter) => set({ eventFilter }),
  setEventsPaused: (eventsPaused) => set({ eventsPaused }),
}));
