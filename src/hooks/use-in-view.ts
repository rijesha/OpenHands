import React from "react";

/**
 * Whether the element is near the viewport. Once it has been, it stays true, so
 * a lazily loaded image is requested once and never dropped again.
 *
 * Without IntersectionObserver (old browsers, jsdom) every element counts as in
 * view, which loads everything at once rather than nothing.
 */
export function useInView<T extends Element>(rootMargin = "300px") {
  const hasObserver = typeof IntersectionObserver === "function";
  const [seen, setSeen] = React.useState(!hasObserver);
  const [node, setNode] = React.useState<T | null>(null);

  React.useEffect(() => {
    if (seen || !node) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, seen, rootMargin]);

  return { ref: setNode, inView: seen };
}
