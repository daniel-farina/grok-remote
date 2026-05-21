// Modifier-aware selection helper extracted for unit testing.
//
// Mirrors the standard file-manager behavior:
//   plain click             -> replace selection with {clicked}, anchor = clicked
//   ctrl/meta click         -> toggle clicked in current selection, anchor = clicked
//   shift click w/ anchor   -> select range from anchor..clicked (inclusive), anchor unchanged
//   shift click w/o anchor  -> behave like plain click

export interface SelectionModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface SelectionResult {
  next: Set<string>;
  anchor: string | null;
}

export function computeSelection(
  current: Set<string>,
  anchor: string | null,
  clicked: string,
  ev: SelectionModifiers,
  orderedIds: string[],
): SelectionResult {
  const ctrl = !!(ev.ctrlKey || ev.metaKey);
  const shift = !!ev.shiftKey;

  if (shift && anchor && orderedIds.includes(anchor) && orderedIds.includes(clicked)) {
    const a = orderedIds.indexOf(anchor);
    const b = orderedIds.indexOf(clicked);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const next = new Set<string>();
    for (let i = lo; i <= hi; i += 1) {
      const id = orderedIds[i];
      if (id) next.add(id);
    }
    return { next, anchor };
  }

  if (ctrl) {
    const next = new Set(current);
    if (next.has(clicked)) next.delete(clicked);
    else next.add(clicked);
    return { next, anchor: clicked };
  }

  return { next: new Set([clicked]), anchor: clicked };
}
