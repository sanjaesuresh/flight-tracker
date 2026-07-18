// shared hover/tap/focus flight-card interaction machinery for a chart's hit targets:
// which item is active, the real-geometry card placement, and the document-level
// dismiss listener. Generic over the caller's own "active item" payload — card CONTENT,
// aria-labels, and hit-circle rendering stay with each chart; this hook only owns
// interaction state, refs, and placement.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

// touch devices synthesize a mouseenter right before click (W3C compat-event order), so a
// naive hover-sets/click-toggles pair fights itself: first tap opens via hover, then the
// click sees it already active and closes it. Gate hover on real hover capability so touch
// relies on click alone; matchMedia is missing in jsdom, so default to hover-capable there.
function supportsHover(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(hover: hover)').matches;
}

// any chart adopting this hook must render its hit targets with this class — it's the
// only way the document-level dismiss listener below can tell "pointerdown on the target
// itself" (which must not immediately dismiss the card the target's own handlers just
// opened) from "pointerdown elsewhere on the page" (which should dismiss it).
const HIT_TARGET_SELECTOR = '.hit-target';

type ActiveEntry<T> = { itemKey: string; payload: T; xFrac: number; yFrac: number };

export function useChartHoverCard<T>() {
  const [active, setActiveState] = useState<ActiveEntry<T> | null>(null);
  // a touch tap's mousedown focuses the (tabIndex 0) hit target, which fires onFocus and
  // opens the card before click's own toggle runs — so toggle-close must key off whether
  // the item was already active at pointerdown time, not at click time.
  const wasActiveOnPointerDownRef = useRef(false);

  // refs for measuring the real, rendered geometry of the card and its container so the
  // flight card can be placed by actual pixels rather than fixed viewBox-percentage rules.
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardPos, setCardPos] = useState({ left: 0, top: 0 });

  function close() {
    setActiveState(null);
  }

  useEffect(() => {
    if (!active) return;
    // document-level because touch has no mouseleave — this is the only way to
    // dismiss the card when the user taps elsewhere on the page.
    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (target instanceof Element && target.closest(HIT_TARGET_SELECTOR)) return;
      close();
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [active]);

  // the active item's position as a fraction of the viewBox — plain numbers (not the
  // `active` object) so the effect below has stable dependencies and doesn't loop:
  // callers may recompute an "active" payload's own containing model on every render
  // (e.g. from a freshly-filtered series list), so only value — not reference —
  // equality can be trusted here to stop the effect re-running forever.
  const activeXFrac = active ? active.xFrac : null;
  const activeYFrac = active ? active.yFrac : null;

  // measure the rendered card and its container after the card mounts/updates but before
  // the browser paints, so placement is correct on the first visible frame (no flash of a
  // wrong position). jsdom's getBoundingClientRect always returns all-zero rects, so every
  // input below is 0 there — the arithmetic must (and does) stay finite, never NaN.
  useLayoutEffect(() => {
    if (activeXFrac === null || activeYFrac === null) return;
    const wrap = wrapRef.current;
    const svg = svgRef.current;
    const card = cardRef.current;
    if (!wrap || !svg || !card) return;
    const wrapRect = wrap.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const gap = 14; // clearance between the point and the card, matches the old translate offset
    const margin = 8; // keep the card off chart-wrap's own edges even when centered near them
    // convert the point's viewBox-unit position to real px within chart-wrap, using the
    // svg's actual rendered box rather than assuming it fills the container 1:1. left/top
    // (as CSS values) are relative to chart-wrap's unscrolled content origin, but
    // getBoundingClientRect gives the current *visible* (post-scroll) position — chart-wrap
    // scrolls horizontally past its min-width 340px chart on phones under ~340px-wide, so the
    // gap between those two frames (wrap.scrollLeft) has to be added back in, or the card
    // renders scrollLeft px short of the point once the chart has been scrolled.
    const px = svgRect.left - wrapRect.left + activeXFrac * svgRect.width + wrap.scrollLeft;
    const py = svgRect.top - wrapRect.top + activeYFrac * svgRect.height;
    // prefer above; only drop below when the card's real height doesn't fit above the
    // container's top edge — replaces the old fixed "top quarter" heuristic.
    const fitsAbove = py - cardRect.height - gap >= 0;
    const rawTop = fitsAbove ? py - cardRect.height - gap : py + gap;
    // final fallback: on a container too short for the card to fit either above or
    // below, clamp top into the container's own bounds rather than let above/below
    // math push it past the bottom (or, in principle, top) edge. The card may then
    // partially cover the point it describes — acceptable; clipped card text is not.
    const maxTop = Math.max(margin, wrapRect.height - cardRect.height - margin);
    const top = clamp(rawTop, margin, maxTop);
    // center on the point, then clamp using the card's real width against the
    // container's real width so it can never clip past either edge. The clamp bounds are
    // shifted by scrollLeft too, to stay in the same content-relative frame as px above —
    // otherwise a scrolled chart-wrap would clamp against the unscrolled window instead of
    // the one the user is actually looking at.
    const minLeft = wrap.scrollLeft + margin;
    const maxLeft = Math.max(minLeft, wrap.scrollLeft + wrapRect.width - cardRect.width - margin);
    const left = clamp(px - cardRect.width / 2, minLeft, maxLeft);
    setCardPos({ left, top });
  }, [activeXFrac, activeYFrac]);

  const cardStyle: CSSProperties = { left: `${cardPos.left}px`, top: `${cardPos.top}px` };

  // handler props for one hit target. `itemKey` must be unique per hit target (e.g. a
  // chart's series key plus its point's date) so open/close toggling and the pointerdown
  // snapshot below can tell distinct items apart; `payload` is whatever the caller's card
  // content needs to render, returned back verbatim as `active` once this item is open.
  function getHitTargetProps(itemKey: string, payload: T, xFrac: number, yFrac: number) {
    function open() {
      setActiveState({ itemKey, payload, xFrac, yFrac });
    }
    return {
      onMouseEnter: () => {
        if (supportsHover()) open();
      },
      onMouseLeave: () => {
        if (supportsHover()) close();
      },
      onFocus: open,
      onBlur: close,
      onPointerDown: () => {
        wasActiveOnPointerDownRef.current = active?.itemKey === itemKey;
      },
      onClick: () => {
        if (wasActiveOnPointerDownRef.current) close();
        else open();
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') close();
      },
    };
  }

  return {
    wrapRef,
    svgRef,
    cardRef,
    active: active ? active.payload : null,
    cardStyle,
    getHitTargetProps,
  };
}
