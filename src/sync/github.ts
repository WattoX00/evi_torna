import type { GitHubConfig, StoredFile } from '../types';
import { getFile, getGitHubConfig, getSetting, listFiles, removeFile, saveFile, setSetting } from '../data/db';
import { fileMimeType } from '../files/mime';

interface RemoteEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: string;
  download_url: string | null;
}

const API = 'https://api.github.com';
let syncPromise: Promise<void> | undefined;

function headers(config: GitHubConfig, extra: Record<string, string> = {}): HeadersInit {
  return {
    Authorization: `Bearer ${config.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra
  };
}

function repoUrl(config: GitHubConfig, path = 'contents/files'): string {
  return `${API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/${path}`;
}

async function checkedFetch(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status === 401 || response.status === 403) {
    const message = response.status === 401 ? 'Token expired – enter a new one in Settings. Local files remain available offline.' : 'GitHub denied access. Check token permissions and rate limits.';
    throw new Error(message);
  }
  if (!response.ok && response.status !== 404) {
    const detail = await response.text();
    throw new Error(`GitHub request failed (${response.status}): ${detail.slice(0, 180)}`);
  }
  return response;
}

function safeName(name: string): string {
  return name.replace(/[\\/]/g, '_');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

export async function testGitHubConnection(config: GitHubConfig): Promise<void> {
  const response = await checkedFetch(repoUrl(config, ''), { headers: headers(config) });
  if (!response.ok) throw new Error('Repository was not found or is not accessible.');
  const info = await response.json() as { default_branch?: string };
  const branch = config.branch || info.default_branch || 'main';
  const folder = await checkedFetch(`${repoUrl(config)}?ref=${encodeURIComponent(branch)}`, { headers: headers(config) });
  if (folder.status === 404) {
    const root = await checkedFetch(`${repoUrl(config, '')}?ref=${encodeURIComponent(branch)}`, { headers: headers(config) });
    if (!root.ok) throw new Error('Cannot access the configured branch.');
  }
  window.dispatchEvent(new Event('sync-auth-ok'));
}

async function remoteEntries(config: GitHubConfig): Promise<RemoteEntry[]> {
  const response = await checkedFetch(`${repoUrl(config)}?ref=${encodeURIComponent(config.branch)}`, { headers: headers(config) });
  if (response.status === 404) return [];
  const value = await response.json() as RemoteEntry[] | { message?: string };
  if (!Array.isArray(value)) {
    if (value.message?.includes('Not Found')) return [];
    throw new Error('Unexpected GitHub files response.');
  }
  return value.filter((entry) => entry.type === 'file' && /\.(pdf|png|jpe?g|webp|gif|bmp|avif|svg|ico|tiff?)$/i.test(entry.name));
}

async function upload(config: GitHubConfig, file: StoredFile): Promise<string> {
  const content = toBase64(new Uint8Array(await file.data.arrayBuffer()));
  const existing = await checkedFetch(
    `${repoUrl(config, `contents/files/${encodeURIComponent(safeName(file.name))}`)}?ref=${encodeURIComponent(config.branch)}`,
    { headers: headers(config) }
  );
  let sha = file.remoteSha;
  if (existing.ok) {
    const record = await existing.json() as { sha: string };
    sha = record.sha;
  }
  const response = await checkedFetch(repoUrl(config, `contents/files/${encodeURIComponent(safeName(file.name))}`), {
    method: 'PUT',
    headers: headers(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      message: `Sync ${safeName(file.name)}`,
      content,
      branch: config.branch,
      ...(sha ? { sha } : {})
    })
  });
  const result = await response.json() as { content?: { sha?: string } };
  if (!result.content?.sha) throw new Error('GitHub accepted upload but returned no file checksum.');
  return result.content.sha;
}

async function deleteRemote(config: GitHubConfig, name: string, sha: string): Promise<void> {
  await checkedFetch(repoUrl(config, `contents/files/${encodeURIComponent(safeName(name))}`), {
    method: 'DELETE',
    headers: headers(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message: `Remove ${safeName(name)}`, sha, branch: config.branch })
  });
}

async function download(config: GitHubConfig, entry: RemoteEntry): Promise<Blob> {
  const response = await checkedFetch(
    repoUrl(config, `contents/files/${encodeURIComponent(safeName(entry.name))}`) + `?ref=${encodeURIComponent(config.branch)}`,
    { headers: headers(config, { Accept: 'application/vnd.github.raw' }) }
  );
  const data = await response.blob();
  if (data.size > 25 * 1024 * 1024) throw new Error(`${entry.name} exceeds the 25 MB safety limit.`);
  return data;
}

export async function queueRemoteDelete(file: StoredFile): Promise<void> {
  const queue = await getSetting<Array<{ name: string; sha: string }>>('deletion-queue') ?? [];
  if (file.remoteSha && !queue.some((item) => item.name === file.name)) queue.push({ name: file.name, sha: file.remoteSha });
  await setSetting('deletion-queue', queue);
  await removeFile(file.id);
}

export function syncFiles(): Promise<void> {
  if (syncPromise) return syncPromise;
  syncPromise = syncFilesInternal().finally(() => { syncPromise = undefined; });
  return syncPromise;
}

async function syncFilesInternal(): Promise<void> {
  const config = await getGitHubConfig();
  if (!config || !navigator.onLine) return;
  try {
    const queued = await getSetting<Array<{ name: string; sha: string }>>('deletion-queue') ?? [];
    for (const item of queued) {
      try { await deleteRemote(config, item.name, item.sha); }
      catch (error) {
        if (!(error instanceof Error && error.message.includes('(404)'))) throw error;
      }
    }
    await setSetting('deletion-queue', []);

    const files = await listFiles();
    for (const file of files) {
      if (file.syncState === 'error') await saveFile({ ...file, syncState: 'pending', error: undefined });
    }
    const queuedFiles = await listFiles();
    for (const local of queuedFiles) {
      if (local.syncState !== 'pending') continue;
      try {
        const sha = await upload(config, local);
        await saveFile({ ...local, syncState: 'synced', remoteSha: sha, error: undefined });
      } catch (error) {
        await saveFile({ ...local, syncState: 'error', error: error instanceof Error ? error.message : 'Upload failed' });
        throw error;
      }
    }

    const refreshedLocal = await listFiles();
    const localByName = new Map(refreshedLocal.map((file) => [file.name, file]));
    const refreshedRemote = await remoteEntries(config);
    const knownRemoteNames = new Set(refreshedRemote.map((entry) => entry.name));
    for (const entry of refreshedRemote) {
      const local = localByName.get(entry.name);
      if (!local || local.remoteSha !== entry.sha) {
        const data = await download(config, entry);
        const record: StoredFile = {
          id: local?.id ?? crypto.randomUUID(),
          name: entry.name,
          type: fileMimeType(entry.name, data.type),
          size: data.size,
          modified: Date.now(),
          data,
          syncState: 'synced',
          remoteSha: entry.sha
        };
        await saveFile(record);
      }
    }

    for (const local of refreshedLocal) {
      if (local.syncState !== 'pending' && local.syncState !== 'error' && local.remoteSha && !knownRemoteNames.has(local.name)) {
        await removeFile(local.id);
      }
    }
    window.dispatchEvent(new Event('sync-auth-ok'));
  } catch (error) {
    if (error instanceof Error && (error.message.includes('Token expired') || error.message.includes('denied access'))) {
      window.dispatchEvent(new CustomEvent('sync-auth-error', { detail: error.message }));
    }
    throw error;
  }
}

export async function removeSyncedFile(file: StoredFile): Promise<void> {
  if (!await getGitHubConfig()) {
    await removeFile(file.id);
    return;
  }
  await queueRemoteDelete(file);
  if (navigator.onLine) await syncFiles();
}

export async function retryFileUpload(id: string): Promise<void> {
  const file = await getFile(id);
  if (!file) return;
  await saveFile({ ...file, syncState: 'pending', error: undefined });
  await syncFiles();
}
