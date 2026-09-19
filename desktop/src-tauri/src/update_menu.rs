//! Native-only menu adapter. Remote documents receive no new capability.
use crate::update::{UpdateClient, UpdateError};
use crate::update_menu_state::{MenuAction, MenuRequest, MenuState};
use std::{
    sync::{mpsc::RecvTimeoutError, Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    WebviewWindow,
};

const PREPARE: &str = "desktop-update-prepare";
const STATUS: &str = "desktop-update-status";
const CANCEL: &str = "desktop-update-cancel";

#[derive(Clone)]
pub struct NativeUpdateMenu {
    window: WebviewWindow,
    state: Arc<Mutex<MenuState>>,
    heading: Submenu<tauri::Wry>,
    summary: MenuItem<tauri::Wry>,
    counts: MenuItem<tauri::Wry>,
    hint: MenuItem<tauri::Wry>,
    prepare: MenuItem<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    cancel: MenuItem<tauri::Wry>,
}

impl NativeUpdateMenu {
    pub fn install(window: &WebviewWindow) -> tauri::Result<Self> {
        let model = MenuState::default();
        let view = model.view();
        let summary = MenuItem::with_id(
            window,
            "desktop-update-summary",
            view.summary,
            false,
            None::<&str>,
        )?;
        let counts = MenuItem::with_id(
            window,
            "desktop-update-counts",
            view.counts,
            false,
            None::<&str>,
        )?;
        let hint = MenuItem::with_id(
            window,
            "desktop-update-hint",
            view.hint,
            false,
            None::<&str>,
        )?;
        let prepare = MenuItem::with_id(window, PREPARE, view.prepare_label, false, None::<&str>)?;
        let status = MenuItem::with_id(window, STATUS, "상태 확인(&S)", false, None::<&str>)?;
        let cancel = MenuItem::with_id(window, CANCEL, "준비 취소(&C)", false, None::<&str>)?;
        let separator = PredefinedMenuItem::separator(window)?;
        let heading = Submenu::with_id_and_items(
            window,
            "desktop-update-menu",
            view.heading,
            true,
            &[
                &summary, &counts, &hint, &separator, &prepare, &status, &cancel,
            ],
        )?;
        let quit = MenuItem::with_id(window, crate::tray::QUIT, "완전 종료(&Q)", true, None::<&str>)?;
        let application = Submenu::with_items(window, "앱(&A)", true, &[&quit])?;
        window.set_menu(Menu::with_items(window, &[&application, &heading])?)?;
        Ok(Self {
            window: window.clone(),
            state: Arc::new(Mutex::new(model)),
            heading,
            summary,
            counts,
            hint,
            prepare,
            status,
            cancel,
        })
    }

    pub fn activate(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.activate();
        }
        self.render();
    }

    pub fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.close();
        }
        self.render();
    }

    pub fn handle(&self, id: &str, client: Option<UpdateClient>) {
        let action = match id {
            PREPARE => MenuAction::Prepare,
            STATUS => MenuAction::Status,
            CANCEL => MenuAction::Cancel,
            _ => return,
        };
        let request = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.begin(action));
        self.render();
        let Some(request) = request else { return };
        let worker = self.clone();
        // Nothing is submitted until this thread starts. Failure to create it is
        // a local rejection, while a receiver timeout retains the in-flight slot.
        if thread::Builder::new()
            .name("desktop-update-menu".into())
            .spawn(move || {
                worker.request(request, client);
            })
            .is_err()
        {
            self.submission_failed(request, UpdateError::Unavailable);
        }
    }

    fn request(&self, request: MenuRequest, client: Option<UpdateClient>) {
        let receiver = match client
            .ok_or(UpdateError::Unavailable)
            .and_then(|client| client.submit(request.action.wire(), request.update_id))
        {
            Ok(receiver) => receiver,
            Err(error) => {
                self.submission_failed(request, error);
                return;
            }
        };
        if let Ok(mut state) = self.state.lock() {
            state.submitted(request);
        }
        let reply = match receiver.recv_timeout(Duration::from_secs(10)) {
            Ok(reply) => reply,
            Err(RecvTimeoutError::Timeout) => {
                if let Ok(mut state) = self.state.lock() {
                    state.slow(request);
                }
                self.render();
                receiver.recv().unwrap_or(Err(UpdateError::Transport))
            }
            Err(RecvTimeoutError::Disconnected) => Err(UpdateError::Transport),
        };
        if let Ok(mut state) = self.state.lock() {
            state.complete(request, reply);
        }
        self.render();
    }

    fn submission_failed(&self, request: MenuRequest, error: UpdateError) {
        if let Ok(mut state) = self.state.lock() {
            state.submission_failed(request, error);
        }
        self.render();
    }

    fn render(&self) {
        let menu = self.clone();
        // Read current state on the event thread: queued renders cannot restore
        // an obsolete ready state after close. No mutex is held across a UI call.
        let _ = self.window.run_on_main_thread(move || {
            let view = match menu.state.lock() {
                Ok(state) => state.view(),
                Err(_) => return,
            };
            let _ = menu.heading.set_text(view.heading);
            let _ = menu.summary.set_text(view.summary);
            let _ = menu.counts.set_text(view.counts);
            let _ = menu.hint.set_text(view.hint);
            let _ = menu.prepare.set_text(view.prepare_label);
            let _ = menu.prepare.set_enabled(view.prepare_enabled);
            let _ = menu.status.set_enabled(view.status_enabled);
            let _ = menu.cancel.set_enabled(view.cancel_enabled);
        });
    }
}
