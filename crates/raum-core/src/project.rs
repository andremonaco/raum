//! Project model helpers (slugging, color palette). Filled in by §5 in Wave 3B.

use std::path::Path;

use crate::config::ProjectConfig;

const DEFAULT_PALETTE: &[&str] = &[
    "#7dd3fc", "#fca5a5", "#86efac", "#fcd34d", "#c4b5fd", "#f9a8d4", "#fdba74", "#a5f3fc",
    "#bef264", "#fda4af",
];

#[must_use]
pub fn slug_from_path(root: &Path) -> String {
    let basename = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("project");
    slug::slugify(basename)
}

#[must_use]
pub fn pick_default_color(seed: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in seed.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    let idx = (h as usize) % DEFAULT_PALETTE.len();
    DEFAULT_PALETTE[idx].to_string()
}

#[must_use]
pub fn project_with_defaults(name: &str, root_path: std::path::PathBuf) -> ProjectConfig {
    let slug = slug_from_path(&root_path);
    let color = pick_default_color(&slug);
    ProjectConfig {
        slug: slug.clone(),
        name: name.to_string(),
        root_path,
        color,
        ..ProjectConfig::default()
    }
}
