use serde::Serialize;
use tracing::Level;
use tracing_subscriber::{
    EnvFilter,
    filter::{FilterExt as _, filter_fn},
    layer::{Layer as _, SubscriberExt as _},
    util::SubscriberInitExt as _,
};

pub(crate) fn init() {
    let environment_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let dependency_secret_cap = filter_fn(|metadata| {
        !metadata.target().starts_with("russh")
            || matches!(*metadata.level(), Level::ERROR | Level::WARN | Level::INFO)
    });
    let filter = environment_filter.and(dependency_secret_cap);

    let _ = tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_target(true)
                .compact()
                .with_filter(filter),
        )
        .try_init();
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemDiagnostics {
    client_version: &'static str,
    protocol_baseline: &'static str,
    operating_system: &'static str,
    architecture: &'static str,
    webview_version: Option<String>,
    session_type: Option<String>,
    desktop: Option<String>,
}

#[tauri::command]
pub(crate) fn read_system_diagnostics() -> SystemDiagnostics {
    SystemDiagnostics {
        client_version: env!("CARGO_PKG_VERSION"),
        protocol_baseline: "ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c",
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        webview_version: tauri::webview_version().ok(),
        session_type: safe_environment_value("XDG_SESSION_TYPE"),
        desktop: safe_environment_value("XDG_CURRENT_DESKTOP"),
    }
}

fn safe_environment_value(name: &str) -> Option<String> {
    let value = std::env::var(name).ok()?;
    (!value.is_empty() && value.len() <= 128 && !value.contains(['\n', '\r', '\0']))
        .then_some(value)
}

#[cfg(test)]
mod tests {
    use super::read_system_diagnostics;

    #[test]
    fn exposes_only_fixed_non_sensitive_environment_summary() {
        let report = serde_json::to_value(read_system_diagnostics()).unwrap();
        assert_eq!(report.as_object().unwrap().len(), 7);
        assert_eq!(
            report["protocolBaseline"],
            "ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c"
        );
    }
}
