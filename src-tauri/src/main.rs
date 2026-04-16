// Prevents an additional console window on Windows in release. Harmless on macOS/Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    raum_lib::run();
}
