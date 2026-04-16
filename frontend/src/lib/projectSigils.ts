/**
 * Project sigils — a single mathematical Greek letter that identifies each
 * project alongside its color. Mirror of `raum_core::sigil` so the picker UI
 * can preview a derived sigil without a backend round-trip.
 *
 * The backend remains the source of truth: any persisted sigil arrives on
 * `ProjectListItem.sigil` already resolved.
 */

export const PROJECT_SIGIL_PALETTE = [
  "α",
  "β",
  "γ",
  "δ",
  "ε",
  "ζ",
  "η",
  "θ",
  "κ",
  "λ",
  "μ",
  "ν",
  "ξ",
  "π",
  "ρ",
  "σ",
  "τ",
  "φ",
  "χ",
  "ψ",
  "ω",
  "Γ",
  "Δ",
  "Θ",
  "Λ",
  "Ξ",
  "Π",
  "Σ",
  "Φ",
  "Ψ",
  "Ω",
] as const;

export type ProjectSigil = (typeof PROJECT_SIGIL_PALETTE)[number];

/** Sentinel sent to `project_update` to clear an explicit sigil back to derived. */
export const SIGIL_RESET = "";

export function isValidSigil(g: string): g is ProjectSigil {
  return (PROJECT_SIGIL_PALETTE as readonly string[]).includes(g);
}

/**
 * Deterministically pick a sigil for a slug. Matches `derive_sigil` in
 * `crates/raum-core/src/sigil.rs` byte-for-byte (UTF-8 bytes, u32 wrapping
 * `acc * 31 + byte`), so previews agree with backend output even for
 * non-ASCII slugs.
 */
export function deriveSigilFromSlug(slug: string): ProjectSigil {
  const bytes = new TextEncoder().encode(slug);
  let h = 0;
  for (const b of bytes) {
    h = (Math.imul(h, 31) + b) | 0;
  }
  const idx = ((h >>> 0) % PROJECT_SIGIL_PALETTE.length) | 0;
  return PROJECT_SIGIL_PALETTE[idx]!;
}
