//! Project sigils — a single mathematical Greek letter that identifies a
//! project alongside its color. The user may pick one explicitly; otherwise a
//! deterministic glyph is derived from the slug.

/// Curated pool of Greek letters that JetBrains Mono renders cleanly. Excludes
/// `ι o` (visually weak) and the variant forms `ϐ ϑ ϰ` that collide with bases.
pub const SIGIL_PALETTE: &[&str] = &[
    "α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "κ", "λ", "μ", "ν", "ξ", "π", "ρ", "σ", "τ", "φ", "χ",
    "ψ", "ω", "Γ", "Δ", "Θ", "Λ", "Ξ", "Π", "Σ", "Φ", "Ψ", "Ω",
];

/// Deterministically pick a sigil for a slug. Same slug → same glyph.
#[must_use]
pub fn derive_sigil(slug: &str) -> &'static str {
    let h = slug.bytes().fold(0u32, |acc, b| {
        acc.wrapping_mul(31).wrapping_add(u32::from(b))
    });
    SIGIL_PALETTE[(h as usize) % SIGIL_PALETTE.len()]
}

/// True iff `glyph` is one of the palette entries.
#[must_use]
pub fn is_valid_sigil(glyph: &str) -> bool {
    SIGIL_PALETTE.contains(&glyph)
}

/// Resolve a project's sigil: keep the explicit value when it is valid,
/// otherwise fall back to `derive_sigil(slug)`.
#[must_use]
pub fn resolve_sigil(slug: &str, explicit: Option<&str>) -> String {
    explicit
        .filter(|g| is_valid_sigil(g))
        .map_or_else(|| derive_sigil(slug).to_string(), str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_is_deterministic() {
        assert_eq!(derive_sigil("raum"), derive_sigil("raum"));
        assert_eq!(derive_sigil("backend"), derive_sigil("backend"));
    }

    #[test]
    fn derive_always_in_palette() {
        for seed in ["", "a", "raum", "backend", "ui-kit", "lots-of-words-here"] {
            let g = derive_sigil(seed);
            assert!(SIGIL_PALETTE.contains(&g), "{seed} → {g} not in palette");
        }
    }

    #[test]
    fn resolve_keeps_valid_explicit_value() {
        assert_eq!(resolve_sigil("raum", Some("Δ")), "Δ");
        assert_eq!(resolve_sigil("raum", Some("π")), "π");
    }

    #[test]
    fn resolve_falls_back_when_explicit_is_invalid() {
        let derived = derive_sigil("raum");
        assert_eq!(resolve_sigil("raum", Some("X")), derived);
        assert_eq!(resolve_sigil("raum", Some("")), derived);
        assert_eq!(resolve_sigil("raum", None), derived);
    }

    #[test]
    fn palette_has_no_duplicates() {
        for (i, a) in SIGIL_PALETTE.iter().enumerate() {
            for b in SIGIL_PALETTE.iter().skip(i + 1) {
                assert_ne!(a, b, "duplicate sigil {a}");
            }
        }
    }
}
