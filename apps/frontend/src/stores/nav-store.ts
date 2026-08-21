import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Ephemeral shell UI state — sidebar collapse, mobile drawer, current
 * interface. Not sync/session data. */
interface NavUiState {
  sidebarCollapsed: boolean;
  mobileMenuOpen: boolean;
  /**
   * The interface (`lib/nav.ts` `INTERFACES`) the user was last unambiguously
   * in. Only used to resolve SHARED surfaces: `/delivery` belongs to both
   * gudang and the office, so whoever opens it keeps the sidebar they came
   * from rather than being dropped into the other interface. Not persisted —
   * a fresh tab should resolve from the URL, not from last week's state.
   */
  currentInterfaceId: string | null;
  toggleSidebar: () => void;
  setMobileMenuOpen: (open: boolean) => void;
  setCurrentInterfaceId: (id: string | null) => void;
}

export const useNavStore = create<NavUiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      mobileMenuOpen: false,
      currentInterfaceId: null,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setMobileMenuOpen: (mobileMenuOpen) => set({ mobileMenuOpen }),
      setCurrentInterfaceId: (currentInterfaceId) =>
        set((s) => (s.currentInterfaceId === currentInterfaceId ? s : { currentInterfaceId })),
    }),
    { name: 'mimi-nav-ui', partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed }) },
  ),
);
