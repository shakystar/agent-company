//! Native tray controls. No frontend capabilities or credentials are exposed.
use crate::ParentState;
use std::sync::{atomic::Ordering, Arc};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub const OPEN: &str = "desktop-window-open";
pub const QUIT: &str = "desktop-app-quit";

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn quit(app: &AppHandle, state: &ParentState) {
    // Use the existing supervisor's checkpoint/child cleanup path. Never kill
    // the child or release the installation lease before its confirmed exit.
    state.shutdown();
    show(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("Agent Company Beta — 종료 중");
    }
    if state.finished.load(Ordering::SeqCst) {
        app.exit(state.exit_code(0));
    }
}

pub fn install(app: &AppHandle, state: Arc<ParentState>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN, "창 열기", true, None::<&str>)?;
    let hint = MenuItem::with_id(
        app,
        "desktop-tray-hint",
        "창을 닫아도 작업은 계속됩니다",
        false,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, QUIT, "완전 종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &hint, &quit_item])?;
    let icon = app
        .default_window_icon()
        .ok_or_else(|| std::io::Error::other("Tray icon unavailable"))?;
    let tray = TrayIconBuilder::with_id("agent-company-main")
        .icon(icon.clone())
        .tooltip("Agent Company Beta · 창을 닫아도 작업은 계속됩니다")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            OPEN => show(app),
            QUIT => quit(app, &state),
            _ => (),
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    // Retain the handle in application state for the lifetime of the tray.
    app.manage(tray);
    Ok(())
}
