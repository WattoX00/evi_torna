import { deleteSetting, getGitHubConfig, getSetting, listFiles, saveFile, setSetting } from '../data/db';
import { element, button, confirmAction, showMessage } from './dom';
import { syncFiles, testGitHubConnection } from '../sync/github';
import type { GitHubConfig } from '../types';

export function renderSettingsTab(onUpdate: () => void): HTMLElement {
  const section = element('section', { className: 'tab-panel settings-panel', attrs: { id: 'tab-settings', 'aria-label': 'Settings' } });
  const heading = element('div', { className: 'section-heading' });
  const headingText = element('div');
  headingText.append(element('h1', { text: 'Settings' }), element('p', { text: 'Storage, sync and app preferences' }));
  heading.append(headingText);

  const syncSection = element('section', { className: 'settings-card' });
  syncSection.append(element('h2', { text: 'Optional GitHub sync' }));
  const note = element('p', { className: 'muted', text: 'Use a fine-grained token restricted to your private data repository. The token is stored only in this browser.' });
  const owner = element('input', { attrs: { type: 'text', autocomplete: 'off', placeholder: 'GitHub owner', 'aria-label': 'GitHub owner' } });
  const repo = element('input', { attrs: { type: 'text', autocomplete: 'off', placeholder: 'Private repository', 'aria-label': 'Private repository' } });
  const branch = element('input', { attrs: { type: 'text', autocomplete: 'off', placeholder: 'Branch (usually main)', 'aria-label': 'Branch' } });
  const token = element('input', { attrs: { type: 'password', autocomplete: 'new-password', placeholder: 'Fine-grained personal access token', 'aria-label': 'Personal access token' } });
  const form = element('div', { className: 'settings-form' });
  form.append(owner, repo, branch, token);
  const save = button('Save sync settings', async () => {
    const saved = await getGitHubConfig();
    const config: GitHubConfig = { owner: owner.value.trim(), repo: repo.value.trim(), branch: branch.value.trim() || 'main', token: token.value.trim() || saved?.token || '' };
    if (!config.owner || !config.repo || !config.token) {
      showMessage('Owner, repository and token are required.', 'error');
      return;
    }
    try {
      const previous = await getGitHubConfig();
      const destinationChanged = Boolean(previous && (
        previous.owner !== config.owner || previous.repo !== config.repo || previous.branch !== config.branch
      ));
      if (destinationChanged && !confirmAction('The sync destination changed. All local files will be uploaded to the new destination; the previous repository will not be changed. Continue?')) return;
      await setSetting('github', config);
      const localFiles = await listFiles();
      for (const file of localFiles) {
        if (destinationChanged || file.syncState === 'local' || file.syncState === 'error') {
          await saveFile({ ...file, syncState: 'pending', remoteSha: destinationChanged ? undefined : file.remoteSha, error: undefined });
        }
      }
      token.value = '';
      showMessage('Sync credentials saved on this device.', 'success');
      window.dispatchEvent(new Event('sync-auth-ok'));
      void syncFiles().catch((error: unknown) => showMessage(error instanceof Error ? error.message : 'Sync failed.', 'error'));
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'Could not save sync settings.', 'error');
    }
  }, 'button button-primary');
  const test = button('Test connection', async () => {
    try {
      const config = await readFormConfig();
      if (!config) return;
      await testGitHubConnection(config);
      showMessage('Connected to the repository.', 'success');
    } catch (error) { showMessage(error instanceof Error ? error.message : 'Connection failed.', 'error'); }
  }, 'button button-secondary');
  const clear = button('Clear credentials', async () => {
    if (!confirmAction('Clear the saved GitHub token and sync settings from this device? Local files remain.')) return;
    try {
      await deleteSetting('github');
      await deleteSetting('deletion-queue');
      for (const file of await listFiles()) {
        await saveFile({ ...file, syncState: 'local', remoteSha: undefined, error: undefined });
      }
      showMessage('GitHub credentials cleared. Local files remain.', 'success');
      window.dispatchEvent(new Event('sync-auth-ok'));
    } catch (error) { showMessage(error instanceof Error ? error.message : 'Could not clear credentials.', 'error'); }
  }, 'button button-danger');
  async function readFormConfig(): Promise<GitHubConfig | undefined> {
    const saved = await getGitHubConfig();
    const config = {
      owner: owner.value.trim() || saved?.owner || '',
      repo: repo.value.trim() || saved?.repo || '',
      branch: branch.value.trim() || saved?.branch || 'main',
      token: token.value.trim() || saved?.token || ''
    };
    if (!config.owner || !config.repo || !config.token) {
      showMessage('Enter credentials or save sync settings first.', 'error');
      return undefined;
    }
    return config;
  }
  void getGitHubConfig().then((config) => {
    if (!config) return;
    owner.value = config.owner;
    repo.value = config.repo;
    branch.value = config.branch;
    token.placeholder = 'Saved token is present (enter a replacement to rotate it)';
  });
  const syncButtons = element('div', { className: 'button-row' });
  syncButtons.append(save, test, clear);
  syncSection.append(note, form, syncButtons);

  const storage = element('section', { className: 'settings-card' });
  storage.append(element('h2', { text: 'Storage' }));
  const storageUsage = element('p', { attrs: { id: 'storage-usage' }, text: 'Checking storage…' });
  const persistence = element('p', { attrs: { id: 'persistence-status' }, text: 'Persistent storage status: checking…' });
  storage.append(storageUsage, persistence);
  const persistButton = button('Request persistent storage', async () => {
    if (!navigator.storage?.persist) {
      persistence.textContent = 'Persistent storage is not supported by this browser.';
      return;
    }
    const granted = await navigator.storage.persist();
    persistence.textContent = granted ? 'Persistent storage is enabled.' : 'The browser did not grant persistent storage. Keep a ZIP backup.';
    showMessage(granted ? 'Persistent storage granted.' : 'Persistent storage was not granted.', granted ? 'success' : 'info');
  }, 'button button-secondary');
  const clearCache = button('Clear cached app data', async () => {
    if (!confirmAction('Clear cached offline app resources? Your saved files and settings will remain.')) return;
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
    showMessage('Offline cache cleared. Reload while online to cache the current version.', 'success');
  }, 'button button-secondary');
  const storageButtons = element('div', { className: 'button-row' });
  storageButtons.append(persistButton, clearCache);
  storage.append(storageButtons);
  void navigator.storage?.estimate?.().then((estimate) => {
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    storageUsage.textContent = `Used ${(usage / 1024 / 1024).toFixed(1)} MB of ${(quota / 1024 / 1024).toFixed(0)} MB available.`;
  }).catch(() => { storageUsage.textContent = 'Storage estimate is unavailable.'; });
  void navigator.storage?.persisted?.().then((persisted) => {
    persistence.textContent = `Persistent storage status: ${persisted ? 'enabled' : 'not granted'}.`;
  }).catch(() => { persistence.textContent = 'Persistent storage status is unavailable.'; });

  const appearance = element('section', { className: 'settings-card' });
  appearance.append(element('h2', { text: 'Appearance' }));
  const theme = element('select', { attrs: { 'aria-label': 'Color theme' } });
  for (const value of ['system', 'light', 'dark']) theme.add(new Option(value[0]?.toUpperCase() + value.slice(1), value));
  void getSetting<string>('theme').then((value) => {
    theme.value = value ?? 'system';
    document.documentElement.dataset.theme = theme.value;
  });
  theme.addEventListener('change', () => {
    document.documentElement.dataset.theme = theme.value;
    void setSetting('theme', theme.value);
  });
  appearance.append(theme);

  const about = element('section', { className: 'settings-card' });
  about.append(
    element('h2', { text: 'About & attribution' }),
    element('p', { text: 'Anatomy Study · Version 1.0.0' }),
    element('p', { text: 'Z-Anatomy model attribution: © Z-Anatomy contributors, licensed under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0). Preserve attribution and share adaptations under the same license.' }),
    element('p', { text: 'This application uses Three.js (MIT), pdf.js (Apache-2.0), idb (ISC), fflate (MIT), Vite and Workbox (MIT).' })
  );
  const update = button('Check for update', onUpdate, 'button button-secondary');
  about.append(update);
  section.append(heading, syncSection, storage, appearance, about);

  return section;
}
