import { listFiles, removeFile, saveFile } from '../data/db';
import type { StoredFile } from '../types';
import { button, confirmAction, element, showMessage } from '../ui/dom';
import { syncFiles, removeSyncedFile } from '../sync/github';
import { addLocalFiles, downloadBlob, exportZip, importZip } from './operations';
import { fileMimeType, typedFileBlob } from './mime';

const selected = new Set<string>();
let selectMode = false;
let query = '';
let allFiles: StoredFile[] = [];

function sizeLabel(size: number): string {
  return size < 1024 * 1024 ? `${(size / 1024).toFixed(0)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function syncLabel(file: StoredFile): string {
  return file.syncState === 'synced' ? 'Synced' : file.syncState === 'pending' ? 'Pending sync' : file.syncState === 'error' ? 'Sync error' : 'Local only';
}

function isMobileDevice(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

async function showPreview(file: StoredFile): Promise<void> {
  const type = fileMimeType(file.name, file.type || file.data.type);
  const data = typedFileBlob(file);
  const isPdf = type === 'application/pdf';
  const pdfTools = isPdf ? import('./pdf') : undefined;

  const dialog = element('dialog', { className: 'preview-dialog' });
  const header = element('header', { className: 'preview-header' });
  const title = element('strong', { text: file.name });
  const close = button('Close', () => dialog.close(), 'button button-secondary');
  header.append(title, close);

  const controls = element('div', { className: 'preview-controls' });
  const canvasWrap = element('div', { className: 'pdf-canvas-wrap' });
  const loading = element('p', { className: 'preview-loading', text: 'Loading file…' });
  const canvas = element('canvas');
  canvas.hidden = true;
  canvasWrap.append(loading, canvas);

  let page = 1;
  let count = 1;
  let scale = 1;
  let loaded = false;
  let busy = false;
  let dirty = false;
  const label = element('span', { text: 'Loading…' });
  const controlButtons: HTMLButtonElement[] = [];
  const control = (text: string, onClick: () => void): HTMLButtonElement => {
    const b = button(text, onClick, 'button button-secondary') as HTMLButtonElement;
    b.disabled = true;
    controlButtons.push(b);
    return b;
  };

  const renderCurrent = async (): Promise<void> => {
    if (isPdf) {
      const tools = await pdfTools!;
      count = await tools.renderPdfPage(data, page, canvas, scale);
      label.textContent = `Page ${page} of ${count}`;
      return;
    }
    const image = new Image();
    const url = URL.createObjectURL(data);
    try {
      image.src = url;
      await image.decode();
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.style.width = `${Math.min(image.naturalWidth, window.innerWidth - 32) * scale}px`;
      canvas.style.height = 'auto';
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      label.textContent = 'Image';
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const draw = async (): Promise<void> => {
    if (busy) { dirty = true; return; }
    busy = true;
    controlButtons.forEach((b) => { b.disabled = true; });
    if (!loaded) { loading.textContent = 'Loading file…'; loading.hidden = false; }
    try {
      do {
        dirty = false;
        await renderCurrent();
        loaded = true;
        canvas.hidden = false;
        canvas.style.transform = '';
      } while (dirty);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to render this file.';
      if (!loaded) loading.textContent = 'Unable to load this file.';
      showMessage(message, 'error');
    } finally {
      busy = false;
      loading.hidden = loaded;
      controlButtons.forEach((b) => { b.disabled = !loaded; });
    }
  };

  controls.append(
    control('−', () => { scale = Math.max(0.55, scale - 0.2); void draw(); }),
    label,
    control('+', () => { scale = Math.min(3, scale + 0.2); void draw(); }),
    control('Previous', () => { page = Math.max(1, page - 1); void draw(); }),
    control('Next', () => { page = Math.min(count, page + 1); void draw(); })
  );

  let initialDistance = 0;
  let initialScale = 1;
  const distanceBetweenTouches = (event: TouchEvent): number =>
    Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
  canvasWrap.addEventListener('touchstart', (event) => {
    if (loaded && event.touches.length === 2) {
      initialDistance = distanceBetweenTouches(event);
      initialScale = scale;
    }
  }, { passive: true });
  canvasWrap.addEventListener('touchmove', (event) => {
    if (event.touches.length !== 2 || !initialDistance) return;
    event.preventDefault();
    scale = Math.max(0.55, Math.min(3, initialScale * distanceBetweenTouches(event) / initialDistance));
    canvas.style.transformOrigin = 'top left';
    canvas.style.transform = `scale(${scale / initialScale})`;
  }, { passive: false });
  canvasWrap.addEventListener('touchend', () => {
    if (initialDistance) void draw();
    initialDistance = 0;
  });

  dialog.append(header, controls, canvasWrap);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  await draw();
}

function shareFiles(files: StoredFile[]): void {
  if (!files.length) return;
  if (isMobileDevice()) {
    void shareWithNativeSheet(files, files.length === 1 ? files[0].name : `${files.length} exercise files`);
    return;
  }
  for (const file of files) downloadBlob(typedFileBlob(file), file.name);
  const subject = files.length === 1 ? `Exercise file: ${files[0].name}` : `Exercise files (${files.length})`;
  const body = `Downloaded file${files.length === 1 ? '' : 's'} to attach:\r\n\r\n${files.map((file) => `- ${file.name}`).join('\r\n')}\r\n`;
  const link = document.createElement('a');
  link.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  document.body.append(link);
  link.click();
  link.remove();
  showMessage(`Downloaded ${files.length === 1 ? 'the file' : 'the files'} and opened your mail app. Attach the downloaded file${files.length === 1 ? '' : 's'} manually.`, 'info');
}

function shareWithNativeSheet(files: StoredFile[], title: string): void {
  if (!navigator.share || !navigator.canShare) {
    showMessage('File sharing is not supported by this browser.', 'error');
    return;
  }
  try {
    const shareable = files.map((file) =>
      new File([typedFileBlob(file)], file.name, { type: fileMimeType(file.name, file.type || file.data.type) })
    );
    if (!navigator.canShare({ files: shareable })) {
      showMessage('This browser cannot share these files.', 'error');
      return;
    }
    void navigator.share({ files: shareable, title }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      showMessage(error instanceof Error ? error.message : 'Could not share these files.', 'error');
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    showMessage(error instanceof Error ? error.message : 'Could not share these files.', 'error');
  }
}

function openInTab(file: StoredFile): void {
  const url = URL.createObjectURL(typedFileBlob(file));

const tab = window.open(url, '_blank');
if (!tab) {
  URL.revokeObjectURL(url);
  showMessage('Please allow pop-ups to open this file.', 'error');
  return;
}
  if (!tab) {
    URL.revokeObjectURL(url);
    showMessage('Please allow pop-ups to open this file.', 'error');
    return;
  }
  const timer = window.setInterval(() => {
    if (!tab.closed) return;
    window.clearInterval(timer);
    URL.revokeObjectURL(url);
  }, 5000);
}

function printFile(file: StoredFile): void {
  if (isMobileDevice()) {
    showMessage('Choose Print from the sharing sheet.', 'info');
    void shareWithNativeSheet([file], file.name);
    return;
  }
  openInTab(file);
}

function createCard(file: StoredFile): HTMLElement {
  const card = element('article', { className: 'file-card' });
  const selection = element('input', { attrs: { type: 'checkbox', 'aria-label': `Select ${file.name}` } });
  selection.checked = selected.has(file.id);
  selection.hidden = !selectMode;
  selection.addEventListener('change', () => {
    if (selection.checked) selected.add(file.id);
    else selected.delete(file.id);
    void renderFiles();
  });
  const preview = element('button', { className: 'thumbnail', attrs: { type: 'button', 'aria-label': `Preview ${file.name}` } });
  preview.addEventListener('click', () => { void showPreview(file); });
  if (file.thumbnail) {
    const image = element('img', { attrs: { alt: '', loading: 'lazy' } });
    image.src = URL.createObjectURL(file.thumbnail);
    preview.append(image);
  } else if (fileMimeType(file.name, file.type || file.data.type).startsWith('image/')) {
    const image = element('img', { attrs: { alt: '', loading: 'lazy' } });
    image.src = URL.createObjectURL(typedFileBlob(file));
    preview.append(image);
  } else {
    preview.append(element('span', { className: 'pdf-glyph', text: 'PDF' }));
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting || file.thumbnail) return;
      observer.disconnect();
      void import('./pdf').then(async ({ cachedThumbnail, createThumbnail }) => (await cachedThumbnail(file.id)) ?? createThumbnail(typedFileBlob(file))).then(async (thumbnail) => {
        if (!thumbnail) return;
        await saveFile({ ...file, thumbnail });
        const { cacheThumbnail } = await import('./pdf');
        try { await cacheThumbnail(file.id, thumbnail); }
        catch { showMessage('Thumbnail is saved with the file, but browser thumbnail caching is unavailable.', 'info'); }
        const image = element('img', { attrs: { alt: '', loading: 'lazy' } });
        image.src = URL.createObjectURL(thumbnail);
        preview.replaceChildren(image);
      });
    });
    observer.observe(preview);
  }
  const details = element('div', { className: 'file-details' });
  details.append(
    element('h3', { text: file.name }),
    element('p', { text: `${sizeLabel(file.size)} · ${new Date(file.modified).toLocaleDateString()}` }),
    element('span', { className: `sync-badge sync-${file.syncState}`, text: syncLabel(file) })
  );
  const actions = element('div', { className: 'file-actions' });
  actions.append(
    button('Share', () => shareFiles([file]), 'icon-button'),
    button('Print', () => printFile(file), 'icon-button'),
    button('Remove', () => { void removeOne(file); }, 'icon-button')
  );
  let pressTimer = 0;
  card.addEventListener('touchstart', () => { pressTimer = window.setTimeout(() => { selectMode = true; selected.add(file.id); void renderFiles(); }, 600); }, { passive: true });
  card.addEventListener('touchend', () => window.clearTimeout(pressTimer));
  card.addEventListener('touchmove', () => window.clearTimeout(pressTimer), { passive: true });
  card.append(selection, preview, details, actions);
  return card;
}

async function removeOne(file: StoredFile): Promise<void> {
  if (!confirmAction(`Remove "${file.name}"${file.remoteSha ? ' locally and from GitHub' : ''}?`)) return;
  try {
    if (file.remoteSha) await removeSyncedFile(file);
    else await removeFile(file.id);
    selected.delete(file.id);
    await renderFiles();
    if (file.remoteSha) void syncFiles().catch((error: unknown) => showMessage(error instanceof Error ? error.message : 'Sync failed.', 'error'));
  } catch (error) { showMessage(error instanceof Error ? error.message : 'Could not remove file.', 'error'); }
}

async function renderFiles(): Promise<void> {
  const host = document.querySelector<HTMLElement>('#tab-files');
  if (!host) return;
  allFiles = await listFiles();
  const files = allFiles.filter((file) => file.name.toLowerCase().includes(query.toLowerCase()));
  const grid = host.querySelector<HTMLElement>('.file-grid');
  if (!grid) return;
  grid.querySelectorAll<HTMLImageElement>('img[src^="blob:"]').forEach((image) => URL.revokeObjectURL(image.src));
  grid.replaceChildren();
  for (const file of files) grid.append(createCard(file));
  const count = host.querySelector<HTMLElement>('#file-count');
  if (count) count.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
  const selectionBar = host.querySelector<HTMLElement>('.selection-bar');
  if (selectionBar) selectionBar.hidden = !selectMode;
  const selectAll = host.querySelector<HTMLInputElement>('#select-all');
  if (selectAll) selectAll.checked = files.length > 0 && files.every((file) => selected.has(file.id));
  const selectedCount = host.querySelector<HTMLElement>('#selected-count');
  if (selectedCount) selectedCount.textContent = selected.size ? `${selected.size} selected` : '';
}

export function renderFilesTab(): HTMLElement {
  const section = element('section', { className: 'tab-panel', attrs: { id: 'tab-files', 'aria-label': 'Files' } });
  const heading = element('div', { className: 'section-heading' });
  const title = element('div');
  title.append(element('h1', { text: 'Files' }), element('p', { text: 'Your private exercise library' }));
  const toolbar = element('div', { className: 'toolbar' });
  const picker = element('input', { attrs: { type: 'file', accept: 'application/pdf,image/*', multiple: '', hidden: '' } });
  const add = button('Add files', () => picker.click(), 'button button-primary');
  picker.addEventListener('change', async () => {
    if (!picker.files?.length) return;
    try {
      const count = await addLocalFiles(picker.files);
      showMessage(`${count} file${count === 1 ? '' : 's'} added.`);
      await renderFiles();
      void syncFiles().then(renderFiles).catch((error: unknown) => showMessage(error instanceof Error ? error.message : 'Sync failed.', 'error'));
    } catch (error) { showMessage(error instanceof Error ? error.message : 'Could not add files.', 'error'); }
    picker.value = '';
  });
  const search = element('input', { className: 'search-input', attrs: { type: 'search', placeholder: 'Search files', 'aria-label': 'Search files' } });
  search.addEventListener('input', () => { query = search.value; void renderFiles(); });
  const importPicker = element('input', { attrs: { type: 'file', accept: '.zip,application/zip', hidden: '' } });
  const importButton = button('Import ZIP', () => importPicker.click(), 'button button-secondary');
  importPicker.addEventListener('change', async () => {
    const file = importPicker.files?.[0];
    if (!file) return;
    try {
      const count = await importZip(file);
      showMessage(`${count} files imported.`);
      await renderFiles();
    } catch (error) { showMessage(error instanceof Error ? error.message : 'Could not import ZIP.', 'error'); }
  });
  const exportButton = button('Export ZIP', async () => {
    try { downloadBlob(await exportZip(), 'anatomy-study-backup.zip'); }
    catch (error) { showMessage(error instanceof Error ? error.message : 'Export failed.', 'error'); }
  }, 'button button-secondary');
  const sync = button('Sync now', async () => {
    try { await syncFiles(); await renderFiles(); showMessage('Sync complete.', 'success'); }
    catch (error) { showMessage(error instanceof Error ? error.message : 'Sync failed.', 'error'); }
  }, 'button button-secondary');
  const mode = button('Select', () => { selectMode = !selectMode; if (!selectMode) selected.clear(); void renderFiles(); }, 'button button-secondary');
  toolbar.append(add, search, sync, exportButton, importButton, mode, picker, importPicker);
  heading.append(title, toolbar);
  const selectBar = element('div', { className: 'selection-bar' });
  const selectAll = element('input', { attrs: { id: 'select-all', type: 'checkbox', 'aria-label': 'Select all files' } });
  selectAll.addEventListener('change', () => {
    selectMode = true;
    selected.clear();
    if (selectAll.checked) allFiles.forEach((file) => selected.add(file.id));
    void renderFiles();
  });
  selectBar.append(selectAll, element('label', { text: 'Select all', attrs: { for: 'select-all' } }), element('span', { attrs: { id: 'selected-count' } }));
  const selectedFiles = (): StoredFile[] => allFiles.filter((file) => selected.has(file.id));
  selectBar.append(
    button('Share selected', () => shareFiles(selectedFiles()), 'button button-secondary'),
    button('Remove selected', async () => {
      const files = selectedFiles();
      if (!files.length || !confirmAction(`Remove ${files.length} selected files?`)) return;
      try {
        for (const file of files) {
          if (file.remoteSha) await removeSyncedFile(file);
          else await removeFile(file.id);
        }
        selected.clear();
        await renderFiles();
      } catch (error) { showMessage(error instanceof Error ? error.message : 'Could not remove selected files.', 'error'); }
    }, 'button button-secondary')
  );
  const grid = element('div', { className: 'file-grid' });
  section.append(heading, selectBar, element('p', { className: 'file-count', attrs: { id: 'file-count' } }), grid);
  void renderFiles();
  return section;
}

export async function refreshFileView(): Promise<void> {
  await renderFiles();
}
