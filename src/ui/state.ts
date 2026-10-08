export type TabName = 'files' | 'anatomy' | 'settings';

type Listener = () => void;

class AppState {
  activeTab: TabName = 'files';
  private listeners = new Set<Listener>();

  setTab(tab: TabName): void {
    this.activeTab = tab;
    this.listeners.forEach((listener) => listener());
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const appState = new AppState();
