const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export const visibleFocusableElements = (container: ParentNode) =>
  [...container.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter((element) =>
      !element.hidden
      && !element.closest("[hidden], [inert], [aria-hidden='true']")
      && window.getComputedStyle(element).visibility !== "hidden"
    );

export const trapDialogFocus = (dialog: HTMLElement, event: KeyboardEvent) => {
  if (event.key !== "Tab") return false;
  const focusable = visibleFocusableElements(dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return true;
  }
  const current = document.activeElement instanceof HTMLElement
    ? focusable.indexOf(document.activeElement)
    : -1;
  const next = event.shiftKey
    ? (current <= 0 ? focusable.length - 1 : current - 1)
    : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
  event.preventDefault();
  focusable[next].focus();
  return true;
};

export const createDialogFocusManager = (host: HTMLElement) => {
  let trigger: HTMLElement | null = null;

  return {
    activate(currentTrigger?: HTMLElement | null, initialSelector?: string) {
      if (!trigger && currentTrigger?.isConnected) trigger = currentTrigger;
      queueMicrotask(() => {
        const dialog = host.querySelector<HTMLElement>("[role='dialog']");
        const preferred = initialSelector
          ? host.querySelector<HTMLElement>(initialSelector)
          : null;
        (preferred ?? visibleFocusableElements(dialog ?? host)[0] ?? dialog)?.focus({ preventScroll: true });
      });
    },
    deactivate(fallback?: HTMLElement | null) {
      const target = trigger?.isConnected ? trigger : fallback?.isConnected ? fallback : null;
      trigger = null;
      queueMicrotask(() => target?.focus({ preventScroll: true }));
    },
    handleKeydown(event: KeyboardEvent) {
      const dialog = host.querySelector<HTMLElement>("[role='dialog']");
      return dialog ? trapDialogFocus(dialog, event) : false;
    }
  };
};
