import type { StoredFile } from '../types';

const MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp'
};

export function fileMimeType(name: string, declaredType = ''): string {
  const type = declaredType.trim().toLowerCase();
  if (type && type !== 'application/octet-stream' && type !== 'binary/octet-stream') return type;
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[extension] ?? (type || 'application/octet-stream');
}

export function typedFileBlob(file: StoredFile): Blob {
  return new Blob([file.data], { type: fileMimeType(file.name, file.type || file.data.type) });
}
