import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { GitHubConfig, PresentationStep, StoredFile } from '../types';

interface AnatomyDB extends DBSchema {
  files: { key: string; value: StoredFile; indexes: { 'by-name': string; 'by-modified': number } };
  settings: { key: string; value: unknown };
}

let database: Promise<IDBPDatabase<AnatomyDB>> | undefined;

export function getDB(): Promise<IDBPDatabase<AnatomyDB>> {
  database ??= openDB<AnatomyDB>('anatomy-study', 1, {
    upgrade(db) {
      const files = db.createObjectStore('files', { keyPath: 'id' });
      files.createIndex('by-name', 'name');
      files.createIndex('by-modified', 'modified');
      db.createObjectStore('settings');
    }
  });
  return database;
}

export async function listFiles(): Promise<StoredFile[]> {
  return (await getDB()).getAllFromIndex('files', 'by-name');
}

export async function saveFile(file: StoredFile): Promise<void> {
  await (await getDB()).put('files', file);
}

export async function removeFile(id: string): Promise<void> {
  await (await getDB()).delete('files', id);
}

export async function getFile(id: string): Promise<StoredFile | undefined> {
  return (await getDB()).get('files', id);
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await getDB()).get('settings', key) as Promise<T | undefined>;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await (await getDB()).put('settings', value, key);
}

export async function deleteSetting(key: string): Promise<void> {
  await (await getDB()).delete('settings', key);
}

export async function getGitHubConfig(): Promise<GitHubConfig | undefined> {
  return getSetting<GitHubConfig>('github');
}

export async function savePresentation(steps: PresentationStep[]): Promise<void> {
  await setSetting('presentation', steps);
}

export async function loadPresentation(): Promise<PresentationStep[]> {
  return (await getSetting<PresentationStep[]>('presentation')) ?? [];
}
