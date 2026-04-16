//! File read / write commands — allows the frontend file editor to read and
//! write files on the user's behalf. No path validation beyond the OS: raum
//! already trusts the user with their own filesystem.

/// Read the UTF-8 contents of `path` and return them as a string.
#[tauri::command]
pub fn file_read(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Overwrite `path` with `content`.
#[tauri::command]
pub fn file_write(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}
