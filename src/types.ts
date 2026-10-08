export type SyncState = 'local' | 'pending' | 'synced' | 'error';

export interface StoredFile {
  id: string;
  name: string;
  type: string;
  size: number;
  modified: number;
  data: Blob;
  thumbnail?: Blob;
  syncState: SyncState;
  remoteSha?: string;
  error?: string;
}

export interface GitHubConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export interface PresentationStep {
  title: string;
  caption: string;
  region?: string;
  meshNames?: string[];
  cameraPosition: [number, number, number];
  target: [number, number, number];
}
