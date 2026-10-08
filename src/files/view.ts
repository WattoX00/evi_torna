import { listFiles, removeFile, saveFile } from '../data/db';
import type { StoredFile } from '../types';
import { button, confirmAction, element, showMessage } from '../ui/dom';
import { syncFiles, removeSyncedFile } from '../sync/github';
import { addLocalFiles, downloadBlob, exportZip, importZip } from './operations';

const selected = new Set<string>();
let selectMode = false;
let query = '';

function sizeLabel(size: number): string {
  return size < 1024 * 1024 ? `${(size / 1024).toFixed(0)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function syncLabel(file: StoredFile): string {
  return file.syncState === 'synced' ? 'Synced' : file.syncState === 'pending' ? 'Pending sync' : file.syncState === 'error' ? 'Sync error' : 'Local only';
}

async function showPreview(file: StoredFile): Promise<void> {
  const pdfTools = file.type === 'application/pdf' ? import('./pdf') : undefined;
  const dialog = element('dialog', { className: 'preview-dialog' });
  const header = element('header', { className: 'preview-header' });
  const title = element('strong', { text: file.name });
  const close = button('Close', () => dialog.close(), 'button button-secondary');
  header.append(title, close);
  const controls = element('div', { className: 'preview-controls' });
  const canvasWrap = element('div', { className: 'pdf-canvas-wrap' });
  const canvas = element('canvas');
  canvasWrap.append(canvas);
  let page = 1;
  let count = 1;
  let scale = 1;
  const label = element('span', { text: 'Page 1' });
  const draw = async () => {
    try {
      if (file.type === 'application/pdf') {
        if (!pdfTools) return;
        count = await (await pdfTools).renderPdfPage(file.data, page, canvas, scale);
        label.textContent = `Page ${page} of ${count}`;
      } else {
        const image = new Image();
        image.src = URL.createObjectURL(file.data);
        await image.decode();
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.style.width = `${Math.min(image.naturalWidth, window.innerWidth - 32) * scale}px`;
        canvas.style.height = 'auto';
        canvas.getContext('2d')?.drawImage(image, 0, 0);
        URL.revokeObjectURL(image.src);
        label.textContent = 'Image';
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'Unable to render this file.', 'error');
    }
  };
  controls.append(
    button('−', () => { scale = Math.max(0.55, scale - 0.2); void draw(); }, 'button button-secondary'),
    label,
    button('+', () => { scale = Math.min(3, scale + 0.2); void draw(); }, 'button button-secondary'),
    button('Previous', () => { page = Math.max(1, page - 1); void draw(); }, 'button button-secondary'),
    button('Next', () => { page = Math.min(count, page + 1); void draw(); }, 'button button-secondary')
  );
  dialog.append(header, controls, canvasWrap);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  await draw();

  let initialDistance = 0;
  let initialScale = scale;
  canvasWrap.addEventListener('touchstart', (event) => {
    if (event.touches.length === 2) {
      initialDistance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
      initialScale = scale;
    }
  }, { passive: true });
  canvasWrap.addEventListener('touchmove', (event) => {
    if (event.touches.length !== 2 || !initialDistance) return;
    event.preventDefault();
    const distance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
    scale = Math.max(0.55, Math.min(3, initialScale * distance / initialDistance));
  }, { passive: false });
  canvasWrap.addEventListener('touchend', () => {
    if (initialDistance) void draw();
    initialDistance = 0;
  });
}

async function shareFiles(files: StoredFile[]): Promise<void> {
  const shareFiles = files.map((file) => new File([file.data], file.name, { type: file.type }));
  if (navigator.share && navigator.canShare?.({ files: shareFiles })) {
    try { await navigator.share({ files: shareFiles, title: 'Exercise files' }); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) showMessage('Sharing was not completed.', 'error'); }
    return;
  }

  const desktop = window.matchMedia('(pointer: fine)').matches && !/iPhone|iPad|iPod/i.test(navigator.userAgent);
  const subject = encodeURIComponent(files.length === 1 ? `Exercise file: ${files[0].name}` : `Exercise files (${files.length})`);
  const body = encodeURIComponent(
    `Please find the selected file${files.length === 1 ? '' : 's'} attached to this email.\n\n${files.map((file) => `- ${file.name}`).join('\n')}`
  );

  if (desktop) {
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&su=${subject}&body=${body}`;
    const draft = window.open(gmailUrl, '_blank', 'noopener,noreferrer');
    if (draft) {
      showMessage('Gmail draft opened. You can attach the selected file(s) from your device.', 'info');
      return;
    }
  }

  for (const file of files) downloadBlob(file.data, file.name);
  const fallbackBody = encodeURIComponent(`Please attach the downloaded file${files.length === 1 ? '' : 's'} manually.`);
  if (desktop) {
    window.location.href = `mailto:?subject=${subject}&body=${fallbackBody}`;
    showMessage('Downloaded a copy for your email client. Attach the file(s) manually if needed.', 'info');
    return;
  }

  window.location.href = `mailto:?subject=Exercise%20files&body=${fallbackBody}`;
  showMessage('Files downloaded. Add them to your email manually.', 'info');
}

async function printFile(file: StoredFile): Promise<void> {
  const isMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile) {
    if (navigator.share && navigator.canShare?.({ files: [new File([file.data], file.name, { type: file.type })] })) {
      try {
        await navigator.share({ files: [new File([file.data], file.name, { type: file.type })], title: 'Print file' });
        showMessage('Choose Print from the sharing sheet.', 'info');
        return;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) showMessage('Sharing was not completed.', 'error');
      }
    }
    const url = URL.createObjectURL(file.data);
    const printWindow = window.open(url, '_blank', 'noopener,noreferrer');
    if (printWindow) {
      printWindow.focus();
      window.setTimeout(() => {
        try { printWindow.print(); }
        catch { showMessage('Printing was blocked by the browser. Please try again.', 'error'); }
        window.setTimeout(() => {
          try { printWindow.close(); }
          catch { /* no-op */ }
          URL.revokeObjectURL(url);
        }, 1200);
      }, 600);
      return;
    }
    showMessage('Please allow pop-ups to print this file.', 'error');
    return;
  }

  const printWindow = window.open('', '_blank', 'noopener,noreferrer');
  if (!printWindow) {
    showMessage('Please allow pop-ups to print this file.', 'error');
    return;
  }

  const blobUrl = URL.createObjectURL(file.data);
  printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${file.name}</title></head><body style="margin:0;display:flex;align-items:center;justify-content:center;background:#fff;min-height:100vh;"><img src="${blobUrl}" style="max-width:100%;max-height:100vh;object-fit:contain;" alt="${file.name}"></body></html>`);
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => {
    try { printWindow.print(); }
    catch { showMessage('Printing was blocked by the browser. Please try again.', 'error'); }
    window.setTimeout(() => {
      try { printWindow.close(); }
      catch { /* no-op */ }
      URL.revokeObjectURL(blobUrl);
    }, 1200);
  }, 300);
}

function createCard(file: StoredFile): HTMLElement {
  const card = element('article', { className: 'file-card' });
  const selection = element('input', { attrs: { type: 'checkbox', 'aria-label': `Select ${file.name}` } });
  selection.checked = selected.has(file.id);
  selection.hidden = !selectMode;
  selection.addEventListener('change', () => {
    if (selection.checked) selected.add(file.id);
    else selected.delete(file.id);
    renderFiles();
  });
  const preview = element('button', { className: 'thumbnail', attrs: { type: 'button', 'aria-label': `Preview ${file.name}` } });
  preview.addEventListener('click', () => { void showPreview(file); });
  if (file.thumbnail) {
    const image = element('img', { attrs: { alt: '', loading: 'lazy' } });
    image.src = URL.createObjectURL(file.thumbnail);
    preview.append(image);
  } else if (file.type.startsWith('image/')) {
    const image = element('img', { attrs: { alt: '', loading: 'lazy' } });
    image.src = URL.createObjectURL(file.data);
    preview.append(image);
  } else {
    preview.append(element('span', { className: 'pdf-glyph', text: 'PDF' }));
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting || file.thumbnail) return;
      observer.disconnect();
      void import('./pdf').then(async ({ cachedThumbnail, createThumbnail }) => (await cachedThumbnail(file.id)) ?? createThumbnail(file.data)).then(async (thumbnail) => {
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
    button('Share', () => { void shareFiles([file]); }, 'icon-button'),
    button('Print', () => { void printFile(file); }, 'icon-button'),
    button('Remove', () => { void removeOne(file); }, 'icon-button')
  );
  let pressTimer = 0;
  card.addEventListener('touchstart', () => { pressTimer = window.setTimeout(() => { selectMode = true; selected.add(file.id); renderFiles(); }, 600); }, { passive: true });
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
  const files = (await listFiles()).filter((file) => file.name.toLowerCase().includes(query.toLowerCase()));
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
  selectAll.addEventListener('change', async () => {
    const files = await listFiles();
    selectMode = true;
    selected.clear();
    if (selectAll.checked) files.forEach((file) => selected.add(file.id));
    void renderFiles();
  });
  selectBar.append(selectAll, element('label', { text: 'Select all', attrs: { for: 'select-all' } }), element('span', { attrs: { id: 'selected-count' } }));
  selectBar.append(
    button('Share selected', async () => {
      const files = (await listFiles()).filter((file) => selected.has(file.id));
      if (files.length) await shareFiles(files);
    }, 'button button-secondary'),
    button('Remove selected', async () => {
      const files = (await listFiles()).filter((file) => selected.has(file.id));
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
