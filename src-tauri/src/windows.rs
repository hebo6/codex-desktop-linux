use std::{
    collections::HashMap,
    fmt,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use uuid::Uuid;

use crate::{
    configuration::ServerId,
    window_state::{
        BindWindowServerRequest, UpdateWindowSessionRequest, WindowGeometry, WindowState,
        WindowStateRepository, WindowStateRepositoryError,
    },
};

pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
const APP_WINDOW_LABEL_PREFIX: &str = "app-";
const MAX_WINDOW_ID_LEN: usize = 64;
const DEFAULT_WINDOW_WIDTH: f64 = 1440.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 900.0;
const MIN_WINDOW_WIDTH: f64 = 960.0;
const MIN_WINDOW_HEIGHT: f64 = 640.0;
const WINDOW_SERVER_REFERENCES_CHANGED_EVENT: &str = "window-server-references-changed";
const WINDOW_GEOMETRY_SAVE_DELAY: Duration = Duration::from_millis(240);
const MIN_VISIBLE_WINDOW_EDGE: i64 = 64;

#[derive(Default)]
pub(crate) struct WindowGeometryTracker {
    next_token: AtomicU64,
    latest_tokens: Arc<Mutex<HashMap<String, u64>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Serialize)]
struct WindowServerReferencesChanged {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OpenAppWindowRequest {
    server_id: ServerId,
    #[serde(default, deserialize_with = "deserialize_optional_thread_id")]
    thread_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenAppWindowResponse {
    window_id: String,
    label: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    code: &'static str,
    message: &'static str,
}

impl CommandError {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    const fn creation_failed() -> Self {
        Self::new(
            "windowCreationFailed",
            "The application window could not be created",
        )
    }

    const fn invalid_window_context() -> Self {
        Self::new(
            "invalidWindowContext",
            "The command caller is not an application window",
        )
    }

    const fn window_closed() -> Self {
        Self::new(
            "windowClosed",
            "The application window closed before the command completed",
        )
    }
}

impl From<WindowStateRepositoryError> for CommandError {
    fn from(error: WindowStateRepositoryError) -> Self {
        match error {
            WindowStateRepositoryError::InvalidVersion => Self::new(
                "invalidWindowStateVersion",
                "The window state version is invalid",
            ),
            WindowStateRepositoryError::InvalidThreadId => {
                Self::new("invalidThreadId", "The current thread ID is invalid")
            }
            WindowStateRepositoryError::InvalidDraftKey => {
                Self::new("invalidDraftKey", "The draft key is invalid")
            }
            WindowStateRepositoryError::SessionWithoutServer => Self::new(
                "windowSessionRequiresServer",
                "A window without a server cannot select a session",
            ),
            WindowStateRepositoryError::WindowNotFound => {
                Self::new("windowStateNotFound", "The window state does not exist")
            }
            WindowStateRepositoryError::ServerNotFound => {
                Self::new("serverNotFound", "The server does not exist")
            }
            WindowStateRepositoryError::VersionConflict => Self::new(
                "windowStateVersionConflict",
                "The window state was modified concurrently",
            ),
            WindowStateRepositoryError::Corrupt => Self::new(
                "windowStateCorrupt",
                "The persisted window state is corrupt",
            ),
            WindowStateRepositoryError::Database(source) => {
                tracing::error!(error = %source, "window state database operation failed");
                Self::new(
                    "windowStateDatabaseFailed",
                    "The window state database operation failed",
                )
            }
        }
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for CommandError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WindowId(String);

impl WindowId {
    fn parse(value: String) -> Result<Self, CommandError> {
        if value.is_empty() {
            return Err(CommandError::new(
                "invalidWindowId",
                "windowId must not be empty",
            ));
        }

        if value.len() > MAX_WINDOW_ID_LEN {
            return Err(CommandError::new(
                "invalidWindowId",
                "windowId must not exceed 64 ASCII characters",
            ));
        }

        let bytes = value.as_bytes();
        let is_alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        let has_valid_boundaries = bytes.first().is_some_and(|byte| is_alphanumeric(*byte))
            && bytes.last().is_some_and(|byte| is_alphanumeric(*byte));
        let contains_only_allowed_characters = bytes
            .iter()
            .all(|byte| is_alphanumeric(*byte) || *byte == b'-');

        if !has_valid_boundaries || !contains_only_allowed_characters {
            return Err(CommandError::new(
                "invalidWindowId",
                "windowId must use lowercase ASCII letters, digits, or inner hyphens",
            ));
        }

        Ok(Self(value))
    }

    fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    fn from_window_label(label: &str) -> Result<Self, CommandError> {
        if label == MAIN_WINDOW_LABEL {
            return Ok(Self(MAIN_WINDOW_LABEL.to_owned()));
        }
        label
            .strip_prefix(APP_WINDOW_LABEL_PREFIX)
            .ok_or_else(CommandError::invalid_window_context)
            .and_then(|value| Self::parse(value.to_owned()))
            .map_err(|_| CommandError::invalid_window_context())
    }

    fn as_str(&self) -> &str {
        &self.0
    }

    fn label(&self) -> String {
        format!("{APP_WINDOW_LABEL_PREFIX}{}", self.as_str())
    }

    fn url(&self) -> WebviewUrl {
        WebviewUrl::App(PathBuf::from(format!(
            "index.html?windowId={}",
            self.as_str()
        )))
    }
}

impl WindowGeometryTracker {
    pub(crate) fn schedule<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
        repository: &WindowStateRepository,
    ) {
        let Ok((window_id, geometry)) = capture_window_geometry(window) else {
            return;
        };
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        self.latest_tokens
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(window_id.clone(), token);
        let latest_tokens = self.latest_tokens.clone();
        let repository = repository.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(WINDOW_GEOMETRY_SAVE_DELAY).await;
            {
                let mut tokens = latest_tokens
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if tokens.get(&window_id) != Some(&token) {
                    return;
                }
                tokens.remove(&window_id);
            }
            if let Err(error) = repository.save_geometry(&window_id, geometry).await {
                tracing::warn!(window_id, %error, "failed to save window geometry");
            }
        });
    }

    pub(crate) fn save_now<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
        repository: &WindowStateRepository,
    ) {
        let Ok((window_id, geometry)) = capture_window_geometry(window) else {
            return;
        };
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        self.latest_tokens
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(window_id.clone(), token);
        if let Err(error) =
            tauri::async_runtime::block_on(repository.save_geometry(&window_id, geometry))
        {
            tracing::warn!(window_id, %error, "failed to save final window geometry");
        }
        let mut tokens = self
            .latest_tokens
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if tokens.get(&window_id) == Some(&token) {
            tokens.remove(&window_id);
        }
    }
}

fn capture_window_geometry<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(String, WindowGeometry), tauri::Error> {
    let window_id =
        WindowId::from_window_label(window.label()).map_err(|_| tauri::Error::WindowNotFound)?;
    let is_maximized = window.is_maximized()?;
    let is_fullscreen = window.is_fullscreen()?;
    let (position, size) = if is_maximized || is_fullscreen {
        (None, None)
    } else {
        (
            window
                .outer_position()
                .ok()
                .map(|position| (position.x, position.y)),
            window
                .inner_size()
                .ok()
                .map(|size| (size.width, size.height)),
        )
    };
    Ok((
        window_id.0,
        WindowGeometry {
            position,
            size,
            is_maximized,
            is_fullscreen,
        },
    ))
}

pub(crate) async fn restore_window_geometry<R: Runtime>(
    window: &WebviewWindow<R>,
    repository: &WindowStateRepository,
) -> Result<(), WindowStateRepositoryError> {
    let window_id = WindowId::from_window_label(window.label())
        .map_err(|_| WindowStateRepositoryError::WindowNotFound)?;
    let Some(geometry) = repository.load_geometry(window_id.as_str()).await? else {
        return Ok(());
    };
    if let Some(size) = geometry.size {
        let monitors = match window.available_monitors() {
            Ok(monitors) => monitors,
            Err(error) => {
                tracing::warn!(%error, "failed to read monitor layout while restoring window");
                Vec::new()
            }
        };
        let work_areas: Vec<WorkArea> = monitors
            .iter()
            .map(|monitor| {
                let area = monitor.work_area();
                WorkArea {
                    x: area.position.x,
                    y: area.position.y,
                    width: area.size.width,
                    height: area.size.height,
                }
            })
            .filter(|area| area.width > 0 && area.height > 0)
            .collect();
        let primary = window
            .primary_monitor()
            .ok()
            .flatten()
            .and_then(|monitor| {
                let area = monitor.work_area();
                work_areas.iter().position(|candidate| {
                    candidate.x == area.position.x
                        && candidate.y == area.position.y
                        && candidate.width == area.size.width
                        && candidate.height == area.size.height
                })
            })
            .unwrap_or(0);
        let (position, size) = geometry.position.map_or_else(
            || {
                let target = work_areas.get(primary).or_else(|| work_areas.first());
                let size = target.map_or(size, |area| {
                    (
                        size.0
                            .clamp((MIN_WINDOW_WIDTH as u32).min(area.width), area.width),
                        size.1
                            .clamp((MIN_WINDOW_HEIGHT as u32).min(area.height), area.height),
                    )
                });
                (None, size)
            },
            |position| {
                let (position, size) =
                    normalize_window_geometry(position, size, &work_areas, primary);
                (Some(position), size)
            },
        );
        if let Err(error) = window.set_size(PhysicalSize::new(size.0, size.1)) {
            tracing::warn!(%error, "failed to restore window size");
        }
        if let Some(position) = position
            && let Err(error) = window.set_position(PhysicalPosition::new(position.0, position.1))
        {
            tracing::warn!(%error, "failed to restore window position");
        }
    }
    if geometry.is_maximized {
        if let Err(error) = window.maximize() {
            tracing::warn!(%error, "failed to restore maximized window state");
        }
    }
    if geometry.is_fullscreen {
        if let Err(error) = window.set_fullscreen(true) {
            tracing::warn!(%error, "failed to restore fullscreen window state");
        }
    }
    Ok(())
}

fn normalize_window_geometry(
    position: (i32, i32),
    size: (u32, u32),
    work_areas: &[WorkArea],
    primary_index: usize,
) -> ((i32, i32), (u32, u32)) {
    let Some(primary) = work_areas.get(primary_index).or_else(|| work_areas.first()) else {
        return (position, size);
    };
    let visible_area = work_areas.iter().find(|area| {
        intersection_length(
            i64::from(position.0),
            i64::from(size.0),
            i64::from(area.x),
            i64::from(area.width),
        ) >= MIN_VISIBLE_WINDOW_EDGE
            && intersection_length(
                i64::from(position.1),
                i64::from(size.1),
                i64::from(area.y),
                i64::from(area.height),
            ) >= MIN_VISIBLE_WINDOW_EDGE
    });
    let target = visible_area.unwrap_or(primary);
    let width = size
        .0
        .clamp((MIN_WINDOW_WIDTH as u32).min(target.width), target.width);
    let height = size
        .1
        .clamp((MIN_WINDOW_HEIGHT as u32).min(target.height), target.height);
    if visible_area.is_none() {
        return (
            (
                centered_coordinate(target.x, target.width, width),
                centered_coordinate(target.y, target.height, height),
            ),
            (width, height),
        );
    }
    let x = clamp_visible_coordinate(position.0, width, target.x, target.width);
    let y = clamp_visible_coordinate(position.1, height, target.y, target.height);
    ((x, y), (width, height))
}

fn intersection_length(start: i64, length: i64, area_start: i64, area_length: i64) -> i64 {
    (start + length).min(area_start + area_length) - start.max(area_start)
}

fn centered_coordinate(area_start: i32, area_length: u32, window_length: u32) -> i32 {
    let offset = (area_length.saturating_sub(window_length) / 2) as i64;
    i32::try_from(i64::from(area_start) + offset).unwrap_or(area_start)
}

fn clamp_visible_coordinate(
    coordinate: i32,
    window_length: u32,
    area_start: i32,
    area_length: u32,
) -> i32 {
    let minimum = i64::from(area_start) - i64::from(window_length) + MIN_VISIBLE_WINDOW_EDGE;
    let maximum = i64::from(area_start) + i64::from(area_length) - MIN_VISIBLE_WINDOW_EDGE;
    i32::try_from(i64::from(coordinate).clamp(minimum, maximum)).unwrap_or(area_start)
}

#[tauri::command]
pub(crate) async fn load_window_state<R: Runtime>(
    window: WebviewWindow<R>,
    repository: State<'_, WindowStateRepository>,
) -> Result<WindowState, CommandError> {
    let window_id = WindowId::from_window_label(window.label())?;
    let state = repository
        .load_and_activate(window_id.as_str())
        .await
        .map_err(CommandError::from)?;
    complete_window_reference_update(&window, repository.inner(), &window_id, state).await
}

#[tauri::command]
pub(crate) async fn bind_window_server<R: Runtime>(
    window: WebviewWindow<R>,
    repository: State<'_, WindowStateRepository>,
    request: BindWindowServerRequest,
) -> Result<WindowState, CommandError> {
    let window_id = WindowId::from_window_label(window.label())?;
    let state = repository
        .bind_server(window_id.as_str(), request)
        .await
        .map_err(CommandError::from)?;
    complete_window_reference_update(&window, repository.inner(), &window_id, state).await
}

#[tauri::command]
pub(crate) async fn update_window_session<R: Runtime>(
    window: WebviewWindow<R>,
    repository: State<'_, WindowStateRepository>,
    request: UpdateWindowSessionRequest,
) -> Result<WindowState, CommandError> {
    let window_id = WindowId::from_window_label(window.label())?;
    repository
        .update_session(window_id.as_str(), request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn open_app_window<R: Runtime>(
    app: AppHandle<R>,
    repository: State<'_, WindowStateRepository>,
    request: OpenAppWindowRequest,
) -> Result<OpenAppWindowResponse, CommandError> {
    let window_id = WindowId::new();
    let label = window_id.label();
    repository
        .reserve_new_window(
            window_id.as_str(),
            request.server_id,
            request.thread_id.as_deref(),
        )
        .await?;

    let build_result = WebviewWindowBuilder::new(&app, label.clone(), window_id.url())
        .disable_drag_drop_handler()
        .enable_clipboard_access()
        .title("Codex Desktop")
        .inner_size(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .center()
        .prevent_overflow()
        .build();

    match build_result {
        Ok(window) => {
            if let Err(error) = activate_window(&window) {
                tracing::warn!(window_label = %label, %error, "new application window was created but could not be focused");
            }
        }
        Err(build_error) => {
            tracing::error!(window_label = %label, error = %build_error, "failed to create application window");
            if let Err(cleanup_error) = repository.discard_reserved_window(window_id.as_str()).await
            {
                tracing::error!(
                    window_label = %label,
                    error = %cleanup_error,
                    "failed to discard state for an uncreated application window"
                );
            }
            return Err(CommandError::creation_failed());
        }
    }

    emit_server_reference_change(&app);

    tracing::info!(
        window_id = window_id.as_str(),
        window_label = %label,
        "application window opened"
    );

    Ok(OpenAppWindowResponse {
        window_id: window_id.0,
        label,
    })
}

fn deserialize_optional_thread_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

pub(crate) async fn deactivate_window<R: Runtime>(
    app: &AppHandle<R>,
    repository: &WindowStateRepository,
    label: &str,
) -> Result<(), CommandError> {
    let window_id = WindowId::from_window_label(label)?;
    repository
        .deactivate(window_id.as_str())
        .await
        .map_err(CommandError::from)?;
    emit_server_reference_change(app);
    Ok(())
}

async fn complete_window_reference_update<R: Runtime>(
    window: &WebviewWindow<R>,
    repository: &WindowStateRepository,
    window_id: &WindowId,
    state: WindowState,
) -> Result<WindowState, CommandError> {
    if window
        .app_handle()
        .get_webview_window(window.label())
        .is_none()
    {
        repository
            .deactivate(window_id.as_str())
            .await
            .map_err(CommandError::from)?;
        emit_server_reference_change(window.app_handle());
        return Err(CommandError::window_closed());
    }

    emit_server_reference_change(window.app_handle());
    Ok(state)
}

fn emit_server_reference_change<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = app.emit(
        WINDOW_SERVER_REFERENCES_CHANGED_EVENT,
        WindowServerReferencesChanged {},
    ) {
        tracing::warn!(%error, "failed to publish changed window server references");
    }
}

pub(crate) fn activate_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        tracing::warn!("single-instance activation could not find the main window");
        return;
    };

    if let Err(error) = activate_window(&window) {
        tracing::warn!(%error, "single-instance activation could not focus the main window");
    }
}

fn activate_window<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    if window.is_minimized()? {
        window.unminimize()?;
    }
    window.show()?;
    window.set_focus()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        APP_WINDOW_LABEL_PREFIX, MAX_WINDOW_ID_LEN, OpenAppWindowRequest, WindowId, WorkArea,
        normalize_window_geometry,
    };

    #[test]
    fn new_window_request_uses_an_optional_non_null_thread_id() {
        let without_thread: OpenAppWindowRequest = serde_json::from_value(json!({
            "serverId": "11111111-1111-4111-8111-111111111111"
        }))
        .unwrap();
        assert_eq!(without_thread.thread_id, None);

        let with_thread: OpenAppWindowRequest = serde_json::from_value(json!({
            "serverId": "11111111-1111-4111-8111-111111111111",
            "threadId": "thread-a"
        }))
        .unwrap();
        assert_eq!(with_thread.thread_id.as_deref(), Some("thread-a"));

        for invalid in [
            json!({
                "serverId": "11111111-1111-4111-8111-111111111111",
                "threadId": null
            }),
            json!({
                "serverId": "11111111-1111-4111-8111-111111111111",
                "threadId": "thread-a",
                "extra": true
            }),
        ] {
            assert!(serde_json::from_value::<OpenAppWindowRequest>(invalid).is_err());
        }
    }

    #[test]
    fn accepts_slug_and_uuid_window_ids() {
        for value in [
            "main",
            "workspace-7",
            "0198a708-8c47-7e56-8458-155a60c8945c",
        ] {
            let window_id = WindowId::parse(value.to_owned()).expect("window ID should be valid");
            assert_eq!(window_id.as_str(), value);
        }
    }

    #[test]
    fn derives_a_stable_internal_label() {
        let window_id = WindowId::parse("workspace-7".to_owned()).unwrap();

        assert_eq!(window_id.label(), "app-workspace-7");
        assert_eq!(window_id.label(), window_id.label());
        assert!(window_id.label().starts_with(APP_WINDOW_LABEL_PREFIX));
    }

    #[test]
    fn derives_window_identity_only_from_application_labels() {
        assert_eq!(
            WindowId::from_window_label("main").unwrap().as_str(),
            "main"
        );
        assert_eq!(
            WindowId::from_window_label("app-workspace-7")
                .unwrap()
                .as_str(),
            "workspace-7"
        );
        for label in ["settings", "app-", "app-Workspace", "other-workspace-7"] {
            assert!(WindowId::from_window_label(label).is_err());
        }
    }

    #[test]
    fn derives_a_local_entry_url_with_the_window_id() {
        let window_id = WindowId::parse("workspace-7".to_owned()).unwrap();

        assert_eq!(
            window_id.url().to_string(),
            "index.html?windowId=workspace-7"
        );
    }

    #[test]
    fn accepts_the_maximum_length() {
        let value = "a".repeat(MAX_WINDOW_ID_LEN);

        assert!(WindowId::parse(value).is_ok());
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_window_ids() {
        for value in [
            "",
            "-window",
            "window-",
            "Window",
            "window_name",
            "window.name",
            "window/name",
            "窗口",
            " window",
            "window ",
        ] {
            assert!(
                WindowId::parse(value.to_owned()).is_err(),
                "{value:?} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_ids_above_the_length_limit() {
        assert!(WindowId::parse("a".repeat(MAX_WINDOW_ID_LEN + 1)).is_err());
    }

    #[test]
    fn keeps_visible_geometry_on_the_selected_monitor() {
        let monitors = [
            WorkArea {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            WorkArea {
                x: -1280,
                y: 0,
                width: 1280,
                height: 1024,
            },
        ];

        assert_eq!(
            normalize_window_geometry((-1200, 80), (1000, 800), &monitors, 0),
            ((-1200, 80), (1000, 800))
        );
    }

    #[test]
    fn recenters_offscreen_geometry_and_clamps_it_to_the_primary_work_area() {
        let monitors = [WorkArea {
            x: 100,
            y: 50,
            width: 1280,
            height: 720,
        }];

        assert_eq!(
            normalize_window_geometry((4000, 3000), (2000, 1000), &monitors, 0),
            ((100, 50), (1280, 720))
        );
    }
}
