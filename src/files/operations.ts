import { strToU8, unzipSync, zipSync } from 'fflate';
import { getGitHubConfig, listFiles, saveFile } from '../data/db';
import type { StoredFile } from '../types';

function uniqueName(name: string, existing: Set<string>): string {
  if (!existing.has(name.toLowerCase())) return name;
  const extension = name.match(/(\.[^.]+)$/)?.[1] ?? '';
  const stem = name.slice(0, name.length - extension.length);
  let index = 2;
  let candidate = `${stem} (${index})${extension}`;
  while (existing.has(candidate.toLowerCase())) candidate = `${stem} (${++index})${extension}`;
  return candidate;
}

export async function addLocalFiles(input: FileList | File[]): Promise<number> {
  let count = 0;
  const syncConfigured = Boolean(await getGitHubConfig());
  const existingNames = new Set((await listFiles()).map((item) => item.name.toLowerCase()));
  for (const file of Array.from(input)) {
    const isSupported = file.type === 'application/pdf' || file.type.startsWith('image/');
    if (!isSupported) continue;
    if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is larger than 25 MB.`);
    const name = uniqueName(file.name, existingNames);
    existingNames.add(name.toLowerCase());
    const record: StoredFile = {
      id: crypto.randomUUID(),
      name,
      type: file.type,
      size: file.size,
      modified: file.lastModified || Date.now(),
      data: file,
      syncState: syncConfigured ? 'pending' : 'local'
    };
    await saveFile(record);
    count++;
  }
  return count;
}

export async function exportZip(): Promise<Blob> {
  const files = await listFiles();
  const entries: Record<string, Uint8Array> = {};
  for (const [index, file] of files.entries()) {
    const name = file.name.replace(/[\\/]/g, '_');
    entries[`files/${index + 1}-${name}`] = new Uint8Array(await file.data.arrayBuffer());
  }
  entries['backup-info.txt'] = strToU8(`Anatomy Study backup\nCreated: ${new Date().toISOString()}\nFiles: ${files.length}\n`);
  return new Blob([zipSync(entries, { level: 6 })], { type: 'application/zip' });
}

export async function importZip(file: File): Promise<number> {
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const syncConfigured = Boolean(await getGitHubConfig());
  const existingNames = new Set((await listFiles()).map((item) => item.name.toLowerCase()));
  let imported = 0;
  for (const [path, bytes] of Object.entries(archive)) {
    if (path.endsWith('/') || path === 'backup-info.txt') continue;
    const name = path.split('/').pop()?.replace(/^\d+-/, '');
    if (!name) continue;
    const extension = name.split('.').pop()?.toLowerCase();
    const imageTypes: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
      gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml',
      ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff'
    };
    const type = extension === 'pdf' ? 'application/pdf' : imageTypes[extension ?? ''] ?? '';
    if (!type) continue;
    const uniqueFilename = uniqueName(name, existingNames);
    existingNames.add(uniqueFilename.toLowerCase());
    const blob = new Blob([bytes], { type });
    const record: StoredFile = {
      id: crypto.randomUUID(),
      name: uniqueFilename,
      type: blob.type,
      size: blob.size,
      modified: Date.now(),
      data: blob,
      syncState: syncConfigured ? 'pending' : 'local'
    };
    await saveFile(record);
    imported++;
  }
  return imported;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}
