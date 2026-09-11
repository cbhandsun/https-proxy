#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // Keeps release console hidden.

mod dpapi_helper;

fn main() {
    if !dpapi_helper::run_from_process_args() {
        app_lib::run();
    }
}
