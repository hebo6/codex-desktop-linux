use std::collections::HashMap;

use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _, Runtime, State, WebviewWindow};
use tokio::sync::{OnceCell, mpsc, oneshot};
use zbus::{Connection, Proxy, zvariant::Value};

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
        let mut actions = match proxy.receive_signal("ActionInvoked").await {
            Ok(actions) => actions,
            Err(error) => {
                tracing::warn!(%error, "failed to subscribe to desktop notification actions");
                let _ = command.response.send(Err(CommandError::unavailable()));
                continue;
            }
        };
        let mut closures = match proxy.receive_signal("NotificationClosed").await {
            Ok(closures) => closures,
            Err(error) => {
                tracing::warn!(%error, "failed to subscribe to desktop notification closures");
                let _ = command.response.send(Err(CommandError::unavailable()));
                continue;
            }
        };
        let mut notification_ids_by_tag = HashMap::new();
        let mut notification_tags_by_id = HashMap::new();
        let mut target_windows_by_id = HashMap::new();
        if send_notification(
            &proxy,
            &mut notification_ids_by_tag,
            &mut notification_tags_by_id,
            &mut target_windows_by_id,
            command,
        )
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
                    if send_notification(
                        &proxy,
                        &mut notification_ids_by_tag,
                        &mut notification_tags_by_id,
                        &mut target_windows_by_id,
                        command,
                    )
                    .await
                    .is_err()
                    {
                        break;
                    }
                }
                action = actions.next() => {
                    let Some(action) = action else {
                        tracing::warn!("desktop notification action stream ended");
                        break;
                    };
                    let Ok((notification_id, action_key)) =
                        action.body().deserialize::<(u32, String)>()
                    else {
                        tracing::warn!("desktop notification action payload is invalid");
                        continue;
                    };
                    if action_key != NOTIFICATION_ACTION {
                        continue;
                    }
                    let Some(target_window_label) =
                        target_windows_by_id.remove(&notification_id)
                    else {
                        tracing::warn!(notification_id, "desktop notification action has no target window");
                        continue;
                    };
                    forget_notification(
                        notification_id,
                        &mut notification_ids_by_tag,
                        &mut notification_tags_by_id,
                    );
                    if let Err(error) =
                        windows::activate_application_window_by_label(&app, &target_window_label)
                    {
                        tracing::warn!(%error, "failed to activate window from desktop notification");
                    }
                }
                closure = closures.next() => {
                    let Some(closure) = closure else {
                        tracing::warn!("desktop notification closure stream ended");
                        break;
                    };
                    let Ok((notification_id, _reason)) =
                        closure.body().deserialize::<(u32, u32)>()
                    else {
                        tracing::warn!("desktop notification closure payload is invalid");
                        continue;
                    };
                    target_windows_by_id.remove(&notification_id);
                    forget_notification(
                        notification_id,
                        &mut notification_ids_by_tag,
                        &mut notification_tags_by_id,
                    );
                }
            }
        }
    }
}

async fn send_notification(
    proxy: &Proxy<'_>,
    notification_ids_by_tag: &mut HashMap<String, u32>,
    notification_tags_by_id: &mut HashMap<u32, String>,
    target_windows_by_id: &mut HashMap<u32, String>,
    command: ShowCommand,
) -> Result<(), ()> {
    let replaces_id = notification_ids_by_tag
        .get(&command.notification.tag)
        .copied()
        .unwrap_or(0);
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
            if replaces_id != 0 && replaces_id != notification_id {
                notification_tags_by_id.remove(&replaces_id);
                target_windows_by_id.remove(&replaces_id);
            }
            notification_ids_by_tag.insert(command.notification.tag.clone(), notification_id);
            notification_tags_by_id.insert(notification_id, command.notification.tag);
            target_windows_by_id.insert(notification_id, command.target_window_label);
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

fn forget_notification(
    notification_id: u32,
    notification_ids_by_tag: &mut HashMap<String, u32>,
    notification_tags_by_id: &mut HashMap<u32, String>,
) {
    let Some(tag) = notification_tags_by_id.remove(&notification_id) else {
        return;
    };
    if notification_ids_by_tag.get(&tag) == Some(&notification_id) {
        notification_ids_by_tag.remove(&tag);
    }
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
    use super::{CommandError, ShowDesktopNotificationRequest, validate_notification};

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
