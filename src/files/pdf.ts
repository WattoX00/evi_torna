import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { BASE_URL } from '../ui/paths';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const documents = new WeakMap<Blob, Promise<PDFDocumentProxy>>();
const THUMBNAIL_CACHE = 'anatomy-pdf-thumbnails-v1';

function thumbnailRequest(id: string): Request {
  return new Request(new URL(`${BASE_URL}__thumbnails/${encodeURIComponent(id)}`, location.origin));
}

export async function cacheThumbnail(id: string, thumbnail: Blob): Promise<void> {
  if (!('caches' in window)) return;
  const cache = await caches.open(THUMBNAIL_CACHE);
  await cache.put(thumbnailRequest(id), new Response(thumbnail, { headers: { 'Content-Type': 'image/jpeg' } }));
}

export async function cachedThumbnail(id: string): Promise<Blob | undefined> {
  if (!('caches' in window)) return undefined;
  const response = await (await caches.open(THUMBNAIL_CACHE)).match(thumbnailRequest(id));
  return response?.blob();
}

export async function pdfDocument(blob: Blob): Promise<PDFDocumentProxy> {
  let document = documents.get(blob);
  if (!document) {
    document = pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
    documents.set(blob, document);
  }
  return document;
}

export async function renderPdfPage(blob: Blob, pageNumber: number, canvas: HTMLCanvasElement, scale = 1): Promise<number> {
  const document = await pdfDocument(blob);
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable.');
  await page.render({ canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
  return document.numPages;
}

export async function createThumbnail(blob: Blob): Promise<Blob | undefined> {
  if (!blob.type.includes('pdf')) return undefined;
  const canvas = document.createElement('canvas');
  try {
    await renderPdfPage(blob, 1, canvas, 0.48);
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/jpeg', 0.78));
  } catch (error) {
    console.warn('Could not create PDF thumbnail.', error);
    return undefined;
  }
}
