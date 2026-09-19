//! Standard checks for the original native controller contract, without Tauri.
#[path = "../src-tauri/src/child.rs"]
pub mod child;
#[path = "../src-tauri/src/lifecycle.rs"]
pub mod lifecycle;
#[path = "../src-tauri/src/paths.rs"]
pub mod paths;
#[path = "../src-tauri/src/policy.rs"]
pub mod policy;
#[path = "../src-tauri/src/shell.rs"]
pub mod shell;
#[path = "../src-tauri/src/update.rs"]
pub mod update;
#[path = "../src-tauri/src/update_menu_state.rs"]
pub mod update_menu_state;
#[path = "../src-tauri/src/window_close.rs"]
pub mod window_close;
