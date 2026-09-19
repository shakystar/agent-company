mod child;
mod install_lease;
mod lifecycle;
mod paths;
mod policy;
mod shell;
mod startup;
mod tray;
mod update;
mod update_menu;
mod update_menu_state;
mod window_close;

use child::ChildSession;
use lifecycle::Lifecycle;
use paths::{NodePaths, PayloadPaths, UserPaths};
use policy::{allow_top_navigation, SessionSecrets};
use shell::ShellState;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::RecvTimeoutError,
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    webview::NewWindowResponse, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use url::Url;

fn trace(phase: &'static str, origin: Option<&Url>) {
    // Development diagnostics contain fixed state labels and validated origins,
    // never protocol frames, cookies, tokens, paths or dependency error text.
    #[cfg(debug_assertions)]
    eprintln!(
        "desktop-native {}",
        serde_json::json!({ "phase": phase, "origin": origin.map(Url::as_str) })
    );
    #[cfg(not(debug_assertions))]
    let _ = (phase, origin);
}

#[derive(Default)]
struct ParentState {
    install_lease: Mutex<Option<install_lease::InstallLease>>,
    origin: Mutex<Option<Url>>,
    updates: Mutex<Option<update::UpdateClient>>,
    update_menu: Mutex<Option<update_menu::NativeUpdateMenu>>,
    closing: AtomicBool,
    finished: AtomicBool,
    failed: AtomicBool,
    tray_available: AtomicBool,
}

impl ParentState {
    fn close_update_menu(&self) {
        if let Ok(menu) = self.update_menu.lock() {
            if let Some(menu) = menu.as_ref() {
                menu.close();
            }
        }
    }

    fn finish(&self, successful: bool) {
        self.close_update_menu();
        if !successful {
            self.failed.store(true, Ordering::SeqCst);
        }
        self.finished.store(true, Ordering::SeqCst);
    }

    fn exit_code(&self, requested: i32) -> i32 {
        if self.failed.load(Ordering::SeqCst) {
            1
        } else {
            requested
        }
    }

    fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.close_update_menu();
        if let Ok(updates) = self.updates.lock() {
            if let Some(updates) = updates.as_ref() {
                updates.close_admission();
            }
        }
        if let Ok(mut origin) = self.origin.lock() {
            *origin = None;
        }
    }
}

fn locked(window: &WebviewWindow, state: &ParentState, shell: ShellState) {
    state.close_update_menu();
    if let Ok(mut origin) = state.origin.lock() {
        *origin = None;
    }
    let _ = window.set_title(shell.title());
    let _ = window.navigate(shell.url());
    if matches!(shell, ShellState::FailureStopping | ShellState::Failed) {
        // Do not leave a failed background controller invisible in the tray.
        tray::show(window.app_handle());
    }
}

fn install_cookie(
    window: &WebviewWindow,
    secrets: &SessionSecrets,
    origin: &Url,
) -> tauri::Result<()> {
    // This runs on the supervisor thread, not in a synchronous WebView callback.
    // Reading back establishes completion before navigation, including Windows.
    for previous in window.cookies_for_url(origin.clone())? {
        if previous.name().starts_with("ac_desktop_") {
            window.delete_cookie(previous)?;
        }
    }
    window.set_cookie(secrets.cookie())?;
    let cookies = window.cookies_for_url(origin.clone())?;
    let matching: Vec<_> = cookies
        .iter()
        .filter(|cookie| cookie.name() == secrets.cookie_name)
        .collect();
    if matching.len() != 1 || !secrets.cookie_matches(matching[0]) {
        return Err(std::io::Error::other("Private WebView cookie installation failed").into());
    }
    Ok(())
}

fn supervise(window: WebviewWindow, state: Arc<ParentState>, paths: NodePaths) {
    let app = window.app_handle().clone();
    let run = || -> Result<(), &'static str> {
        let secrets = SessionSecrets::generate()?;
        let start = secrets.start_frame(&paths.resources, &paths.controller)?;
        if state.closing.load(Ordering::SeqCst) {
            state.finish(true);
            app.exit(0);
            return Ok(());
        }
        let mut session = ChildSession::spawn(&mut child::command(
            &paths.node,
            &paths.entry,
            &paths.resources,
        ))
        .map_err(|_| "개인 작업실의 제어 서버를 시작하지 못했습니다.")?;
        let mut lifecycle = Lifecycle::default();
        let (update_client, mut updates) = update::channel();
        // Private Rust access only; no WebView capability or remote invoke is added.
        if let Ok(mut current) = state.updates.lock() {
            *current = Some(update_client);
        } else {
            lifecycle.failed = true;
        }
        trace("child-spawned", None);
        if session.start(&start).is_err() {
            lifecycle.failed = true;
        }
        let started_at = Instant::now();
        let mut pipe_closed = false;
        loop {
            let closing = state.closing.load(Ordering::SeqCst);
            if !lifecycle.ready && started_at.elapsed() > Duration::from_secs(60) {
                lifecycle.failed = true;
            }
            if (closing || lifecycle.failed) && !lifecycle.shutdown_requested {
                updates.begin_close();
                lifecycle.shutdown_requested = true;
                trace("shutdown-requested", None);
                locked(
                    &window,
                    &state,
                    if lifecycle.failed {
                        ShellState::FailureStopping
                    } else {
                        ShellState::Stopping
                    },
                );
                if session.shutdown(&secrets).is_err() {
                    lifecycle.failed = true;
                }
            }
            if lifecycle.ready && !lifecycle.shutdown_requested {
                if let Some(frame) = updates.next_frame(&secrets) {
                    if state.closing.load(Ordering::SeqCst) {
                        updates.begin_close();
                    } else if session.control(&frame).is_err() {
                        updates.transport_failed();
                        lifecycle.failed = true;
                    }
                }
            }
            if !pipe_closed {
                match session.message(Duration::from_millis(50)) {
                    Ok(Ok(frame)) => {
                        match lifecycle.accept_with_updates(frame, &secrets, &mut updates) {
                            Ok(Some(origin)) => {
                                trace("ready-confirmed", Some(&origin));
                                if install_cookie(&window, &secrets, &origin).is_err() {
                                    trace("cookie-installation-failed", None);
                                    lifecycle.failed = true;
                                    continue;
                                }
                                trace("cookie-confirmed", Some(&origin));
                                if state.closing.load(Ordering::SeqCst) {
                                    continue;
                                }
                                match state.origin.lock() {
                                    Ok(mut current) => {
                                        if state.closing.load(Ordering::SeqCst) {
                                            continue;
                                        }
                                        *current = Some(origin.clone());
                                    }
                                    Err(_) => {
                                        lifecycle.failed = true;
                                        continue;
                                    }
                                }
                                if window.navigate(origin.clone()).is_err() {
                                    lifecycle.failed = true;
                                } else {
                                    trace("navigation-requested", Some(&origin));
                                    let title_window = window.clone();
                                    let title_state = state.clone();
                                    let title_origin = origin.clone();
                                    if window
                                        .run_on_main_thread(move || {
                                            // Recheck on the event thread: a queued ready
                                            // callback must not replace a closing title.
                                            if title_state.closing.load(Ordering::SeqCst)
                                                || title_state.finished.load(Ordering::SeqCst)
                                            {
                                                return;
                                            }
                                            let still_ready =
                                                title_state.origin.lock().is_ok_and(|current| {
                                                    current.as_ref() == Some(&title_origin)
                                                });
                                            if still_ready {
                                                let _ =
                                                    title_window.set_title("Agent Company Beta");
                                            }
                                        })
                                        .is_err()
                                    {
                                        lifecycle.failed = true;
                                        continue;
                                    }
                                    match updates.activate() {
                                        Ok(true) => {
                                            if let Ok(menu) = state.update_menu.lock() {
                                                if let Some(menu) = menu.as_ref() {
                                                    menu.activate();
                                                }
                                            }
                                        }
                                        Ok(false) => (),
                                        Err(_) => lifecycle.failed = true,
                                    }
                                }
                            }
                            Ok(None) => (),
                            Err(_) => {
                                lifecycle.failed = true;
                            }
                        }
                    }
                    Ok(Err(_)) => {
                        updates.transport_failed();
                        lifecycle.failed = true;
                    }
                    Err(RecvTimeoutError::Timeout) => (),
                    Err(RecvTimeoutError::Disconnected) => {
                        pipe_closed = true;
                        if !lifecycle.stopped {
                            updates.transport_failed();
                            lifecycle.failed = true;
                        }
                    }
                }
            } else {
                thread::sleep(Duration::from_millis(50));
            }
            match session.try_exit() {
                Ok(Some(status)) => {
                    // A process can exit before the reader thread delivers its last
                    // buffered stopped frame. Drain through pipe EOF before judging.
                    let pipe_deadline = Instant::now() + Duration::from_secs(2);
                    while !pipe_closed && Instant::now() < pipe_deadline {
                        match session.message(Duration::from_millis(50)) {
                            Ok(Ok(frame)) => {
                                if lifecycle
                                    .accept_with_updates(frame, &secrets, &mut updates)
                                    .is_err()
                                {
                                    lifecycle.failed = true;
                                }
                            }
                            Ok(Err(_)) => {
                                updates.transport_failed();
                                lifecycle.failed = true;
                            }
                            Err(RecvTimeoutError::Disconnected) => {
                                pipe_closed = true;
                            }
                            Err(RecvTimeoutError::Timeout) => (),
                        }
                    }
                    if !pipe_closed {
                        updates.transport_failed();
                        lifecycle.failed = true;
                    }
                    let clean = lifecycle.confirm_exit(status.success());
                    updates.begin_close();
                    trace(
                        if clean {
                            "child-exit-confirmed"
                        } else {
                            "child-exit-failed"
                        },
                        None,
                    );
                    let _ = window.delete_cookie(secrets.cookie());
                    locked(
                        &window,
                        &state,
                        if clean {
                            ShellState::Stopped
                        } else {
                            ShellState::Failed
                        },
                    );
                    state.finish(clean);
                    if state.closing.load(Ordering::SeqCst) {
                        app.exit(if clean { 0 } else { 1 });
                    }
                    return Ok(());
                }
                Ok(None) => (),
                Err(_) => {
                    // Keep the process handle and continue waiting. An observation
                    // error is never proof that a live DB owner has exited.
                    updates.transport_failed();
                    lifecycle.failed = true;
                }
            }
        }
    };
    if run().is_err() {
        trace("startup-failed-before-child", None);
        // This branch is reachable only before a child handle has been acquired.
        locked(&window, &state, ShellState::Failed);
        state.finish(false);
        if state.closing.load(Ordering::SeqCst) {
            app.exit(1);
        }
    }
}

fn setup_window(
    app: &mut tauri::App,
    state: &Arc<ParentState>,
) -> Result<(WebviewWindow, NodePaths), startup::SetupFailure> {
    let local_root = startup::step("install-lease-dir", || app.path().local_data_dir())?;
    let lease = startup::step("install-lease", || {
        install_lease::InstallLease::acquire(&local_root)
    })?;
    startup::step("retain-install-lease", || {
        state
            .install_lease
            .lock()
            .map(|mut current| *current = Some(lease))
            .map_err(|_| std::io::Error::other("Desktop installation lease unavailable"))
    })?;
    let resources = startup::step("resource-dir", || app.path().resource_dir())?;
    let payload = startup::step("validate-payload", || PayloadPaths::discover(&resources))?;
    let local_data = startup::step("local-data-dir", || app.path().app_local_data_dir())?;
    let paths = startup::step("create-user-dir", || UserPaths::create(&local_data))?;
    let node_paths = startup::step("node-paths", || NodePaths::from_validated(&payload, &paths))?;
    let navigation_state = state.clone();
    let window = startup::step("webview-build", || {
        WebviewWindowBuilder::new(
            app,
            "main",
            WebviewUrl::App(ShellState::Starting.document().into()),
        )
        .title(ShellState::Starting.title())
        .inner_size(1280.0, 840.0)
        .min_inner_size(900.0, 600.0)
        .data_directory(paths.webview.clone())
        .devtools(false)
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if navigation_state.closing.load(Ordering::SeqCst) {
                return allow_top_navigation(url, None);
            }
            navigation_state
                .origin
                .lock()
                .map(|origin| allow_top_navigation(url, origin.as_ref()))
                .unwrap_or(false)
        })
        // Windows top-level NavigationStarting is separate from preview iframe navigation.
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()
    })?;
    let menu = startup::step("update-menu", || {
        update_menu::NativeUpdateMenu::install(&window)
    })?;
    startup::step("retain-update-menu", || {
        state
            .update_menu
            .lock()
            .map(|mut current| *current = Some(menu.clone()))
            .map_err(|_| std::io::Error::other("Native update menu unavailable"))
    })?;
    let menu_state = state.clone();
    window.on_menu_event(move |window, event| {
        if event.id().as_ref() == tray::QUIT {
            tray::quit(window.app_handle(), &menu_state);
            return;
        }
        if menu_state.closing.load(Ordering::SeqCst) {
            return;
        }
        let client = menu_state
            .updates
            .lock()
            .ok()
            .and_then(|current| current.clone());
        menu.handle(event.id().as_ref(), client);
    });
    // If the tray cannot be created, retain the previous safe close behavior.
    // The application menu still provides an explicit complete shutdown.
    let available = tray::install(app.handle(), state.clone()).is_ok();
    state.tray_available.store(available, Ordering::SeqCst);
    Ok((window, node_paths))
}

pub fn run() {
    let state = Arc::new(ParentState::default());
    let setup_state = state.clone();
    let event_state = state.clone();
    let application = tauri::Builder::default()
        // First plugin: duplicate instances never start a second controller.
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _directory| {
                tray::show(app);
            },
        ))
        .setup(move |app| {
            match setup_window(app, &setup_state) {
                Ok((window, paths)) => {
                    let supervisor_state = setup_state.clone();
                    thread::spawn(move || supervise(window, supervisor_state, paths));
                }
                Err(error) => {
                    // Tauri panics if its setup hook returns Err. This failure is
                    // before child acquisition, so no database owner needs a wait.
                    // Preserve normal event-loop cleanup and a nonzero exit code.
                    #[cfg(debug_assertions)]
                    eprintln!("desktop-native {}", error.diagnostic());
                    #[cfg(not(debug_assertions))]
                    let _ = error;
                    setup_state.shutdown();
                    setup_state.finish(false);
                    app.handle().exit(1);
                }
            }
            Ok(())
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                match window_close::requested(
                    event_state.tray_available.load(Ordering::SeqCst),
                    event_state.closing.load(Ordering::SeqCst),
                    event_state.finished.load(Ordering::SeqCst),
                ) {
                    window_close::CloseAction::Hide => {
                        api.prevent_close();
                        // A hide failure leaves the existing window available.
                        let _ = window.hide();
                    }
                    window_close::CloseAction::Shutdown => {
                        api.prevent_close();
                        event_state.shutdown();
                        let _ = window.set_title("Agent Company Beta — 종료 중");
                    }
                    window_close::CloseAction::Wait => api.prevent_close(),
                    window_close::CloseAction::Close => (),
                }
            }
        })
        // No invoke handler, frontend capabilities, remote grants or shell plugin.
        .build(tauri::generate_context!());
    match application {
        Ok(app) => {
            let outcome = state.clone();
            let exit_code = app.run_return(move |_app, event| {
                if let RunEvent::ExitRequested { api, .. } = event {
                    if !state.finished.load(Ordering::SeqCst) {
                        api.prevent_exit();
                        state.shutdown();
                    }
                }
            });
            // A later window close (and some platform event loops) can report
            // zero despite an earlier setup/child failure. Never erase it.
            std::process::exit(outcome.exit_code(exit_code));
        }
        Err(_) => {
            // Do not print underlying errors containing local credentials or paths.
            eprintln!("Agent Company Beta를 시작하지 못했습니다.");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_setup_or_child_exit_survives_later_window_close_and_zero_runtime_code() {
        let state = ParentState::default();
        state.finish(false);
        assert!(state.finished.load(Ordering::SeqCst));
        state.shutdown();
        assert_eq!(state.exit_code(0), 1);
        // Failure is monotonic even if a later cleanup succeeds.
        state.finish(true);
        assert_eq!(state.exit_code(0), 1);
        let clean = ParentState::default();
        clean.shutdown();
        clean.finish(true);
        assert_eq!(clean.exit_code(0), 0);
        assert_eq!(clean.exit_code(2), 2);
    }
}
