use std::{ffi::OsString, sync::Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter as _, Manager as _, Runtime, State, WebviewWindow};
use url::Url;

use crate::{configuration::ServerId, windows::MAIN_WINDOW_LABEL};

const DEEP_LINK_SCHEME: &str = "codex-desktop";
const DEEP_LINK_EVENT: &str = "deep-link-target-pending";
const MAX_THREAD_ID_BYTES: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeepLinkTarget {
    server_id: ServerId,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
}

#[derive(Default)]
pub(crate) struct DeepLinkState {
    pending: Mutex<Option<DeepLinkTarget>>,
}

impl DeepLinkState {
    pub(crate) fn from_environment() -> Self {
        Self {
            pending: Mutex::new(parse_arguments(std::env::args_os().skip(1))),
        }
    }

    pub(crate) fn receive_arguments<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        arguments: impl IntoIterator<Item = String>,
    ) {
        let Some(target) = parse_arguments(arguments.into_iter().map(OsString::from)) else {
            return;
        };
        *self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(target);
        let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
            return;
        };
        if let Err(error) = window.emit(DEEP_LINK_EVENT, ()) {
            tracing::warn!(%error, "failed to notify the main window about a deep link");
        }
    }

    fn take(&self) -> Option<DeepLinkTarget> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }
}

#[tauri::command]
pub(crate) fn take_pending_deep_link<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DeepLinkState>,
) -> Option<DeepLinkTarget> {
    (window.label() == MAIN_WINDOW_LABEL)
        .then(|| state.take())
        .flatten()
}

fn parse_arguments(arguments: impl IntoIterator<Item = OsString>) -> Option<DeepLinkTarget> {
    let mut target = None;
    for argument in arguments {
        let Some(argument) = argument.to_str() else {
            continue;
        };
        if !argument.starts_with("codex-desktop:") {
            continue;
        }
        let parsed = parse_deep_link(argument)?;
        if target.replace(parsed).is_some() {
            return None;
        }
    }
    target
}

fn parse_deep_link(value: &str) -> Option<DeepLinkTarget> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != DEEP_LINK_SCHEME
        || url.host_str() != Some("server")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let segments = url.path_segments()?.collect::<Vec<_>>();
    let (server_id, thread_id) = match segments.as_slice() {
        [server_id] => (*server_id, None),
        [server_id, "thread", thread_id] if valid_thread_id(thread_id) => {
            (*server_id, Some((*thread_id).to_owned()))
        }
        _ => return None,
    };
    Some(DeepLinkTarget {
        server_id: ServerId::parse_persisted(server_id)?,
        thread_id,
    })
}

fn valid_thread_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_THREAD_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use serde_json::json;

    use super::{parse_arguments, parse_deep_link};

    #[test]
    fn accepts_only_bounded_credential_free_server_and_thread_targets() {
        let server = "11111111-1111-4111-8111-111111111111";
        assert_eq!(
            serde_json::to_value(
                parse_deep_link(&format!("codex-desktop://server/{server}"))
                    .expect("server target should parse"),
            )
            .unwrap(),
            json!({ "serverId": server })
        );
        assert_eq!(
            serde_json::to_value(
                parse_deep_link(&format!("codex-desktop://server/{server}/thread/thread-7"))
                    .expect("thread target should parse"),
            )
            .unwrap(),
            json!({ "serverId": server, "threadId": "thread-7" })
        );

        for invalid in [
            format!("codex-desktop://server/{server}?token=secret"),
            format!("codex-desktop://user:password@server/{server}"),
            format!("codex-desktop://server/{server}/thread/a%2Fb"),
            format!("codex-desktop://server/{server}/unknown/value"),
            "https://server/11111111-1111-4111-8111-111111111111".to_owned(),
        ] {
            assert!(parse_deep_link(&invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn rejects_ambiguous_multiple_deep_link_arguments() {
        let link = OsString::from("codex-desktop://server/11111111-1111-4111-8111-111111111111");
        assert!(parse_arguments([OsString::from("codex-desktop"), link.clone()]).is_some());
        assert!(parse_arguments([link.clone(), link]).is_none());
    }
}
