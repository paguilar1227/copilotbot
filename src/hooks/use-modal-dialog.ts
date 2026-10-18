import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The dialog element needs `tabIndex={-1}` so it can take focus when it has no field to start in. */
export function useModalDialog(dialogRef: RefObject<HTMLElement | null>, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.contains(document.activeElement)) dialog.focus();
    const focusable = () => {
      const controls: HTMLElement[] = [];
      const visit = (root: Element | ShadowRoot) => {
        for (const child of root.children) {
          if (child instanceof HTMLElement && child.matches(FOCUSABLE) && !child.hasAttribute('hidden')) controls.push(child);
          visit(child.shadowRoot ?? child);
        }
      };
      visit(dialog);
      return controls;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return event.preventDefault();
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && (active === first || !event.composedPath().includes(dialog) || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKey);
    return () => {
      dialog.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dialogRef]);
}
