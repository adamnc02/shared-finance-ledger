// Picker-First Flows (App_Dev.md, 2026-09 session) — the one genuinely
// shared piece of logic behind Bills.tsx's and Loans.tsx's own local
// LocationPickerCard copies (each file keeps its own copy of the
// component itself, per this codebase's established per-page-file
// convention for small shared UI — see PersonPickerCard's own comment —
// but the SKIP decision is real logic worth having in one place rather
// than three near-identical inline boolean expressions).

/**
 * Whether the Location picker-first step is worth showing at all for a
 * given owner — Adam-specified (2026-09 session): skip the whole step
 * whenever Current Account is the only possible answer, i.e. neither
 * Joint nor any pot is genuinely available. If exactly one of the two IS
 * available, that's still a real choice worth asking about.
 */
export function shouldOfferLocationPicker(canBeJoint: boolean, ownerHasActivePot: boolean): boolean {
  return canBeJoint || ownerHasActivePot
}
