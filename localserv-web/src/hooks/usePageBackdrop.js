import { useEffect } from 'react';

/**
 * Turns on the faint illustrated backdrop behind a page.
 *   usePageBackdrop('cafe')     warm cafe + clock scene   (Browse, Things you're hosting)
 *   usePageBackdrop('couples')  soft couples illustration (Messages)
 * The artwork itself is pure CSS (`body[data-backdrop]` in euphoria-pages.css),
 * so it spans the full window behind the page column and goes away on unmount.
 */
export function usePageBackdrop(variant = 'cafe') {
  useEffect(() => {
    document.body.dataset.backdrop = variant;
    return () => {
      if (document.body.dataset.backdrop === variant) delete document.body.dataset.backdrop;
    };
  }, [variant]);
}