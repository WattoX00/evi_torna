export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; attrs?: Record<string, string> } = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
  return node;
}

export function button(label: string, action: () => void, className = 'button'): HTMLButtonElement {
  const node = element('button', { text: label, className, attrs: { type: 'button' } });
  node.addEventListener('click', action);
  return node;
}

export function showMessage(message: string, kind: 'error' | 'success' | 'info' = 'info'): void {
  const host = document.querySelector<HTMLElement>('#announcements');
  if (!host) return;
  host.textContent = message;
  host.dataset.kind = kind;
  host.hidden = false;
  window.setTimeout(() => { host.hidden = true; }, 5500);
}

export function confirmAction(message: string): boolean {
  return window.confirm(message);
}
