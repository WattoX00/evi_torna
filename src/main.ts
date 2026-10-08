import { registerSW } from 'virtual:pwa-register';
import { renderFilesTab, refreshFileView } from './files/view';
import { renderSettingsTab } from './ui/settings';
import { appState, type TabName } from './ui/state';
import { element, showMessage } from './ui/dom';
import { syncFiles } from './sync/github';
import './style.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('App root element is missing.');

const shell = element('div', { className: 'app-shell' });
const main = element('main', { className: 'main-content' });
const nav = element('nav', { className: 'tab-navigation', attrs: { 'aria-label': 'Main navigation' } });
const tabs: Array<{ id: TabName; label: string; icon: string }> = [
  { id: 'files', label: 'Files', icon: '▤' },
  { id: 'anatomy', label: 'Anatomy', icon: '◉' },
  { id: 'settings', label: 'Settings', icon: '⚙' }
];
const tabButtons = new Map<TabName, HTMLButtonElement>();
const filePanel = renderFilesTab();
const anatomyPlaceholder = element('section', { className: 'tab-panel', attrs: { id: 'tab-anatomy', 'aria-label': 'Anatomy', hidden: '' } });
let anatomyLoading = false;
let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined;
let updatePrompt: HTMLElement | undefined;

const announcement = element('div', { className: 'announcement', attrs: { id: 'announcements', role: 'status', 'aria-live': 'polite', hidden: '' } });
const banner = element('div', { className: 'update-banner', attrs: { id: 'update-banner', hidden: '' } });
const authBanner = element('div', { className: 'auth-banner', attrs: { id: 'sync-auth-banner', role: 'alert', 'aria-live': 'assertive', hidden: '' } });
const authMessage = element('span');
const dismissAuthBanner = element('button', { className: 'button button-secondary', text: 'Dismiss', attrs: { type: 'button' } });
dismissAuthBanner.addEventListener('click', () => { authBanner.hidden = true; });
authBanner.append(authMessage, dismissAuthBanner);

for (const tab of tabs) {
  const button = element('button', { className: 'tab-button', attrs: { type: 'button', 'aria-controls': `tab-${tab.id}` } });
  button.append(element('span', { className: 'tab-icon', text: tab.icon, attrs: { 'aria-hidden': 'true' } }), element('span', { text: tab.label }));
  button.addEventListener('click', () => appState.setTab(tab.id));
  tabButtons.set(tab.id, button);
  nav.append(button);
}

main.append(filePanel, anatomyPlaceholder, renderSettingsTab(() => {
  if (updateServiceWorker) void updateServiceWorker(true);
  else showMessage('You are using the latest available app version.');
}));
shell.append(nav, main, banner, authBanner, announcement);
root.append(shell);
window.addEventListener('sync-auth-error', (event) => {
  authMessage.textContent = event instanceof CustomEvent && typeof event.detail === 'string'
    ? event.detail
    : 'Token expired – enter a new one in Settings. Local files remain available offline.';
  authBanner.hidden = false;
});
window.addEventListener('sync-auth-ok', () => { authBanner.hidden = true; });

function setTab(tab: TabName): void {
  for (const name of tabs.map((item) => item.id)) {
    const panel = document.querySelector<HTMLElement>(`#tab-${name}`);
    if (panel) panel.hidden = name !== tab;
    const button = tabButtons.get(name);
    button?.classList.toggle('active', name === tab);
    button?.setAttribute('aria-current', name === tab ? 'page' : 'false');
  }
  if (tab === 'anatomy' && !anatomyLoading && !anatomyPlaceholder.dataset.loaded) {
    anatomyLoading = true;
    void import('./anatomy/viewer').then(({ renderAnatomyTab }) => {
      const panel = renderAnatomyTab();
      panel.hidden = appState.activeTab !== 'anatomy';
      panel.dataset.loaded = 'true';
      anatomyPlaceholder.dataset.loaded = 'true';
      anatomyPlaceholder.replaceWith(panel);
      anatomyLoading = false;
    }).catch((error: unknown) => {
      anatomyLoading = false;
      showMessage(error instanceof Error ? error.message : 'Anatomy viewer could not be loaded.', 'error');
    });
  }
}
appState.subscribe(() => setTab(appState.activeTab));
setTab(appState.activeTab);

const register = registerSW({
  immediate: true,
  onNeedRefresh() {
    updatePrompt ??= element('div', { className: 'update-content' });
    updatePrompt.replaceChildren(
      element('span', { text: 'New version available.' }),
      element('button', { text: 'Reload', className: 'button button-primary', attrs: { type: 'button' } })
    );
    const reload = updatePrompt.querySelector('button');
    reload?.addEventListener('click', () => { void register(true); }, { once: true });
    banner.replaceChildren(updatePrompt);
    banner.hidden = false;
    updateServiceWorker = register;
  },
  onOfflineReady() { showMessage('App is ready to use offline.', 'success'); },
  onRegisteredSW(_url, registration) {
    updateServiceWorker = async (reloadPage = false) => {
      if (registration?.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        if (reloadPage) window.location.reload();
      } else if (registration) {
        await registration.update();
        showMessage('Checked for app updates.');
      }
    };
  },
  onRegisterError(error) { showMessage(`Offline service worker could not start: ${error.message}`, 'error'); }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('online', () => {
    void syncFiles().then(refreshFileView).catch((error: unknown) => showMessage(error instanceof Error ? error.message : 'Sync failed.', 'error'));
  });
  void syncFiles().then(refreshFileView).catch((error: unknown) => {
    if (navigator.onLine) showMessage(error instanceof Error ? error.message : 'Sync failed.', 'error');
  });
}

let startY = 0;
let startX = 0;
filePanel.addEventListener('touchstart', (event) => {
  if (filePanel.scrollTop === 0 && window.scrollY === 0) {
    startY = event.touches[0]?.clientY ?? 0;
    startX = event.touches[0]?.clientX ?? 0;
  }
}, { passive: true });
filePanel.addEventListener('touchend', (event) => {
  const endY = event.changedTouches[0]?.clientY ?? 0;
  const endX = event.changedTouches[0]?.clientX ?? 0;
  if (startY && endY - startY > 85 && Math.abs(endX - startX) < 65) {
    void syncFiles().then(refreshFileView).then(() => showMessage('Refresh complete.', 'success')).catch((error: unknown) => showMessage(error instanceof Error ? error.message : 'Refresh failed.', 'error'));
  }
  startY = 0;
}, { passive: true });

void navigator.storage?.persist?.().catch(() => false);
