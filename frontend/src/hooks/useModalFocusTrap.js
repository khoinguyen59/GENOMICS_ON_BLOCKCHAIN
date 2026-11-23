import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled]):not([aria-disabled='true'])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function getFocusableElements(container) {
  if (!container) return [];
  const nodes = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
  return nodes.filter((el) => {
    if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    return el.offsetParent !== null || style.position === "fixed";
  });
}

/**
 * WCAG 2.2 AA modal focus trap with Escape dismissal and focus restoration.
 * Uses a ref for `onClose` so inline arrow callbacks never re-trigger focus jumps.
 *
 * @param {boolean} isOpen - Whether the modal dialog is currently open.
 * @param {Function} [onClose] - Callback invoked when the user presses Escape.
 * @returns {React.MutableRefObject<HTMLElement|null>} Ref to attach to the dialog element.
 */
export function useModalFocusTrap(isOpen, onClose) {
  const containerRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousFocusRef.current = previouslyFocused;

    const focusInitialElement = () => {
      const container = containerRef.current;
      if (!container) return;
      if (container.contains(document.activeElement)) return;
      const focusables = getFocusableElements(container);
      if (focusables.length > 0) {
        focusables[0].focus({ preventScroll: true });
      } else if (typeof container.focus === "function") {
        container.focus({ preventScroll: true });
      }
    };

    const rafId = window.requestAnimationFrame(focusInitialElement);

    const handleKeyDown = (event) => {
      const container = containerRef.current;
      if (!container) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (typeof onCloseRef.current === "function") {
          onCloseRef.current();
        }
        return;
      }

      if (event.key !== "Tab") return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        if (typeof container.focus === "function") {
          container.focus({ preventScroll: true });
        }
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (!container.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
        return;
      }

      if (event.shiftKey) {
        if (active === first || active === container) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.cancelAnimationFrame(rafId);
      document.removeEventListener("keydown", handleKeyDown, true);
      const prev = previousFocusRef.current;
      previousFocusRef.current = null;
      if (prev && prev.isConnected && typeof prev.focus === "function") {
        try {
          prev.focus({ preventScroll: true });
        } catch {
          // Ignore focus errors if trigger element became unfocusable
        }
      }
    };
  }, [isOpen]);

  return containerRef;
}

export default useModalFocusTrap;
