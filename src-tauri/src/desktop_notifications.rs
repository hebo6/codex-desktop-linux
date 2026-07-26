use std::collections::HashMap;

use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _, Runtime, State, WebviewWindow};
use tokio::sync::{OnceCell, mpsc, oneshot};
use zbus::{Connection, Message, Proxy, zvariant::Value};

use crate::windows;

const NOTIFICATION_SERVICE: &str = "org.freedesktop.Notifications";
const NOTIFICATION_PATH: &str = "/org/freedesktop/Notifications";
const NOTIFICATION_INTERFACE: &str = "org.freedesktop.Notifications";
const NOTIFICATION_APP_NAME: &str = "Codex Desktop";
const NOTIFICATION_ACTION: &str = "default";
const NOTIFICATION_QUEUE_CAPACITY: usize = 32;
const MAX_TITLE_CHARACTERS: usize = 96;
const MAX_BODY_CHARACTERS: usize = 256;
const MAX_TAG_CHARACTERS: usize = 128;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShowDesktopNotificationRequest {
    title: String,
    body: String,
    tag: String,
}

#[derive(Debug)]
struct ValidatedNotification {
    title: String,
    body: String,
    tag: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    code: &'static str,
    message: &'static str,
}

impl CommandError {
    const fn invalid_request() -> Self {
        Self {
            code: "invalidDesktopNotification",
            message: "The desktop notification request is invalid",
        }
    }

    const fn unavailable() -> Self {
        Self {
            code: "desktopNotificationsUnavailable",
            message: "The desktop notification service is unavailable",
        }
    }
}

struct ShowCommand {
    notification: ValidatedNotification,
    target_window_label: String,
    response: oneshot::Sender<Result<(), CommandError>>,
}

#[derive(Debug, PartialEq, Eq)]
struct NotificationActivation {
    target_window_label: String,
    activation_token: Option<String>,
}

#[derive(Debug)]
struct TrackedNotification {
    tag: String,
    target_window_label: String,
    activation_token: Option<String>,
}

#[derive(Default)]
struct NotificationRegistry {
    notification_ids_by_tag: HashMap<String, u32>,
    notifications_by_id: HashMap<u32, TrackedNotification>,
}

impl NotificationRegistry {
    fn replacement_id(&self, tag: &str) -> u32 {
        self.notification_ids_by_tag.get(tag).copied().unwrap_or(0)
    }

    fn track(&mut self, notification_id: u32, tag: String, target_window_label: String) {
        self.remove(notification_id);
        if let Some(replaced_id) = self.notification_ids_by_tag.get(&tag).copied() {
            self.remove(replaced_id);
        }
        self.notification_ids_by_tag
            .insert(tag.clone(), notification_id);
        self.notifications_by_id.insert(
            notification_id,
            TrackedNotification {
                tag,
                target_window_label,
                activation_token: None,
            },
        );
    }

    fn set_activation_token(&mut self, notification_id: u32, activation_token: String) -> bool {
        let Some(notification) = self.notifications_by_id.get_mut(&notification_id) else {
            return false;
        };
        notification.activation_token = Some(activation_token);
        true
    }

    fn take_activation(&mut self, notification_id: u32) -> Option<NotificationActivation> {
        self.remove(notification_id)
            .map(|notification| NotificationActivation {
                target_window_label: notification.target_window_label,
                activation_token: notification.activation_token,
            })
    }

    fn forget(&mut self, notification_id: u32) {
        self.remove(notification_id);
    }

    fn remove(&mut self, notification_id: u32) -> Option<TrackedNotification> {
        let notification = self.notifications_by_id.remove(&notification_id)?;
        if self.notification_ids_by_tag.get(&notification.tag) == Some(&notification_id) {
            self.notification_ids_by_tag.remove(&notification.tag);
        }
        Some(notification)
    }
}

#[derive(Default)]
pub(crate) struct DesktopNotificationManager {
    sender: OnceCell<mpsc::Sender<ShowCommand>>,
}

impl DesktopNotificationManager {
    async fn show<R: Runtime>(
        &self,
        app: AppHandle<R>,
        target_window_label: String,
        notification: ValidatedNotification,
    ) -> Result<(), CommandError> {
        let sender = self
            .sender
            .get_or_init(|| async {
                let (sender, receiver) = mpsc::channel(NOTIFICATION_QUEUE_CAPACITY);
                tauri::async_runtime::spawn(notification_worker(app, receiver));
                sender
            })
            .await;
        let (response, result) = oneshot::channel();
        sender
            .send(ShowCommand {
                notification,
                target_window_label,
                response,
            })
            .await
            .map_err(|_| CommandError::unavailable())?;
        result.await.map_err(|_| CommandError::unavailable())?
    }
}

#[tauri::command]
pub(crate) async fn desktop_notification_availability() -> bool {
    let Ok(connection) = Connection::session().await else {
        return false;
    };
    let Ok(proxy) = notification_proxy(&connection).await else {
        return false;
    };
    let capabilities: zbus::Result<Vec<String>> = proxy.call("GetCapabilities", &()).await;
    capabilities.is_ok()
}

#[tauri::command]
pub(crate) async fn show_desktop_notification<R: Runtime>(
    window: WebviewWindow<R>,
    manager: State<'_, DesktopNotificationManager>,
    request: ShowDesktopNotificationRequest,
) -> Result<bool, CommandError> {
    let notification = validate_notification(request)?;
    let window_focused = window.is_focused().map_err(|error| {
        tracing::warn!(window_label = window.label(), %error, "failed to read notification window focus");
        CommandError::unavailable()
    })?;
    if window_focused {
        return Ok(false);
    }
    manager
        .show(
            window.app_handle().clone(),
            window.label().to_owned(),
            notification,
        )
        .await?;
    Ok(true)
}

async fn notification_worker<R: Runtime>(
    app: AppHandle<R>,
    mut receiver: mpsc::Receiver<ShowCommand>,
) {
    while let Some(command) = receiver.recv().await {
        let connection = match Connection::session().await {
            Ok(connection) => connection,
            Err(error) => {
                tracing::warn!(%error, "desktop notification session bus is unavailable");
                let _ = command.response.send(Err(CommandError::unavailable()));
                continue;
            }
        };
        let proxy = match notification_proxy(&connection).await {
            Ok(proxy) => proxy,
            Err(error) => {
                tracing::warn!(%error, "desktop notification service is unavailable");
                let _ = command.response.send(Err(CommandError::unavailable()));
                continue;
            }
        };
        let mut signals = match proxy.receive_all_signals().await {
            Ok(signals) => signals,
            Err(error) => {
                tracing::warn!(%error, "failed to subscribe to desktop notification signals");
                let _ = command.response.send(Err(CommandError::unavailable()));
                continue;
            }
        };
        let mut registry = NotificationRegistry::default();
        if send_notification(&proxy, &mut registry, command)
            .await
            .is_err()
        {
            continue;
        }

        loop {
            tokio::select! {
                command = receiver.recv() => {
                    let Some(command) = command else {
                        return;
                    };
                    if send_notification(&proxy, &mut registry, command).await.is_err() {
                        break;
                    }
                }
                signal = signals.next() => {
                    let Some(signal) = signal else {
                        tracing::warn!("desktop notification signal stream ended");
                        break;
                    };
                    handle_notification_signal(&app, &mut registry, signal).await;
                }
            }
        }
    }
}

async fn handle_notification_signal<R: Runtime>(
    app: &AppHandle<R>,
    registry: &mut NotificationRegistry,
    signal: Message,
) {
    let header = signal.header();
    let Some(signal_name) = header.member().map(|member| member.as_str()) else {
        tracing::warn!("desktop notification signal has no member");
        return;
    };
    match signal_name {
        "ActivationToken" => {
            let Ok((notification_id, activation_token)) =
                signal.body().deserialize::<(u32, String)>()
            else {
                tracing::warn!("desktop notification activation token payload is invalid");
                return;
            };
            if activation_token.is_empty() {
                tracing::warn!(
                    notification_id,
                    "desktop notification activation token is empty"
                );
                return;
            }
            if !registry.set_activation_token(notification_id, activation_token) {
                tracing::warn!(
                    notification_id,
                    "desktop notification activation token has no target window"
                );
            }
        }
        "ActionInvoked" => {
            let Ok((notification_id, action_key)) = signal.body().deserialize::<(u32, String)>()
            else {
                tracing::warn!("desktop notification action payload is invalid");
                return;
            };
            if action_key != NOTIFICATION_ACTION {
                return;
            }
            let Some(activation) = registry.take_activation(notification_id) else {
                tracing::warn!(
                    notification_id,
                    "desktop notification action has no target window"
                );
                return;
            };
            if let Err(error) = windows::activate_application_window_from_notification(
                app,
                &activation.target_window_label,
                activation.activation_token,
            )
            .await
            {
                tracing::warn!(%error, "failed to activate window from desktop notification");
            }
        }
        "NotificationClosed" => {
            let Ok((notification_id, _reason)) = signal.body().deserialize::<(u32, u32)>() else {
                tracing::warn!("desktop notification closure payload is invalid");
                return;
            };
            registry.forget(notification_id);
        }
        _ => {}
    }
}

async fn send_notification(
    proxy: &Proxy<'_>,
    registry: &mut NotificationRegistry,
    command: ShowCommand,
) -> Result<(), ()> {
    let replaces_id = registry.replacement_id(&command.notification.tag);
    let actions = vec![NOTIFICATION_ACTION, "打开"];
    let hints = HashMap::<&str, Value<'_>>::new();
    let result: zbus::Result<u32> = proxy
        .call(
            "Notify",
            &(
                NOTIFICATION_APP_NAME,
                replaces_id,
                "",
                command.notification.title.as_str(),
                command.notification.body.as_str(),
                actions,
                hints,
                -1_i32,
            ),
        )
        .await;
    match result {
        Ok(notification_id) => {
            registry.track(
                notification_id,
                command.notification.tag,
                command.target_window_label,
            );
            let _ = command.response.send(Ok(()));
            Ok(())
        }
        Err(error) => {
            tracing::warn!(%error, "failed to send desktop notification");
            let _ = command.response.send(Err(CommandError::unavailable()));
            Err(())
        }
    }
}

async fn notification_proxy(connection: &Connection) -> zbus::Result<Proxy<'_>> {
    Proxy::new(
        connection,
        NOTIFICATION_SERVICE,
        NOTIFICATION_PATH,
        NOTIFICATION_INTERFACE,
    )
    .await
}

fn validate_notification(
    request: ShowDesktopNotificationRequest,
) -> Result<ValidatedNotification, CommandError> {
    if !valid_text(&request.title, MAX_TITLE_CHARACTERS, false)
        || !valid_text(&request.body, MAX_BODY_CHARACTERS, true)
        || !valid_tag(&request.tag)
    {
        return Err(CommandError::invalid_request());
    }
    Ok(ValidatedNotification {
        title: request.title,
        body: request.body,
        tag: request.tag,
    })
}

fn valid_text(value: &str, max_characters: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.chars().count() <= max_characters
        && value.chars().all(|character| !character.is_control())
}

fn valid_tag(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_TAG_CHARACTERS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

#[cfg(test)]
mod tests {
    use super::{
        CommandError, NotificationActivation, NotificationRegistry, ShowDesktopNotificationRequest,
        validate_notification,
    };

    #[test]
    fn carries_activation_token_until_notification_action() {
        let mut registry = NotificationRegistry::default();
        registry.track(7, "task:main".to_owned(), "main".to_owned());

        assert!(registry.set_activation_token(7, "activation-token".to_owned()));
        assert_eq!(
            registry.take_activation(7),
            Some(NotificationActivation {
                target_window_label: "main".to_owned(),
                activation_token: Some("activation-token".to_owned()),
            })
        );
        assert_eq!(registry.replacement_id("task:main"), 0);
    }

    #[test]
    fn closed_notification_cannot_activate() {
        let mut registry = NotificationRegistry::default();
        registry.track(7, "task:main".to_owned(), "main".to_owned());
        registry.forget(7);

        assert!(!registry.set_activation_token(7, "activation-token".to_owned()));
        assert_eq!(registry.take_activation(7), None);
    }

    #[test]
    fn replacement_rebinds_notification_tag() {
        let mut registry = NotificationRegistry::default();
        registry.track(7, "task:main".to_owned(), "main".to_owned());
        registry.track(9, "task:main".to_owned(), "app-window".to_owned());

        assert_eq!(registry.replacement_id("task:main"), 9);
        assert_eq!(registry.take_activation(7), None);
        assert_eq!(
            registry.take_activation(9),
            Some(NotificationActivation {
                target_window_label: "app-window".to_owned(),
                activation_token: None,
            })
        );
    }

    #[test]
    fn replacement_can_reuse_notification_id() {
        let mut registry = NotificationRegistry::default();
        registry.track(7, "task:main".to_owned(), "main".to_owned());
        assert!(registry.set_activation_token(7, "stale-token".to_owned()));
        registry.track(7, "task:main".to_owned(), "app-window".to_owned());

        assert_eq!(registry.replacement_id("task:main"), 7);
        assert_eq!(
            registry.take_activation(7),
            Some(NotificationActivation {
                target_window_label: "app-window".to_owned(),
                activation_token: None,
            })
        );
    }

    #[test]
    fn accepts_bounded_plain_notification_content() {
        let notification = validate_notification(ShowDesktopNotificationRequest {
            title: "Codex 任务已完成".to_owned(),
            body: "返回对应窗口查看结果".to_owned(),
            tag: "task:main:thread-1".to_owned(),
        })
        .expect("notification should be valid");

        assert_eq!(notification.title, "Codex 任务已完成");
        assert_eq!(notification.body, "返回对应窗口查看结果");
        assert_eq!(notification.tag, "task:main:thread-1");
    }

    #[test]
    fn rejects_unbounded_or_control_character_content() {
        for request in [
            ShowDesktopNotificationRequest {
                title: String::new(),
                body: "正文".to_owned(),
                tag: "task:main".to_owned(),
            },
            ShowDesktopNotificationRequest {
                title: "标题\n注入".to_owned(),
                body: "正文".to_owned(),
                tag: "task:main".to_owned(),
            },
            ShowDesktopNotificationRequest {
                title: "标题".to_owned(),
                body: "正文".to_owned(),
                tag: "invalid tag".to_owned(),
            },
            ShowDesktopNotificationRequest {
                title: "标".repeat(97),
                body: "正文".to_owned(),
                tag: "task:main".to_owned(),
            },
        ] {
            assert_eq!(
                validate_notification(request).unwrap_err().code,
                CommandError::invalid_request().code,
            );
        }
    }
}
