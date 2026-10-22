"use client";

import { useEffect } from "react";

/**
 * Keyboard shortcut for the header search: "/" or Ctrl/Cmd+K focuses the search field. Ignored while
 * the visitor types in another field. Prefers the search page's own field, then a visible header
 * field; when none is visible (small screens) it opens the search page.
 */
function typingElsewhere(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

export function SearchShortcut({ hint }: { hint: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey;
      const k = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k";
      if ((!slash && !k) || e.defaultPrevented || typingElsewhere(e.target)) return;
      e.preventDefault();
      const fields = [...document.querySelectorAll<HTMLInputElement>("input[data-search]")].filter((el) => el.offsetParent !== null);
      const target = fields.find((el) => el.dataset.search === "page") ?? fields[0];
      if (target) {
        target.focus();
        target.select();
      } else {
        window.location.assign("/search");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <kbd className="cmdk-kbd" title={hint} aria-hidden="true">
      /
    </kbd>
  );
}
