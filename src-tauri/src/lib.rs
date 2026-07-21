mod authentication_policy;
mod configuration;
mod connection;
mod credentials;
mod deep_link;
mod diagnostics;
mod dialogs;
mod drafts;
mod header_policy;
mod local_data;
mod offline_cache;
mod preferences;
mod sensitive;
mod storage;
mod window_state;
mod windows;

use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};
use tauri::Manager as _;

const SHUTDOWN_RUNNING: u8 = 0;
const SHUTDOWN_IN_PROGRESS: u8 = 1;
const SHUTDOWN_READY_TO_EXIT: u8 = 2;
const RELEASE_SMOKE_ENVIRONMENT: &str = "CODEX_DESKTOP_RELEASE_SMOKE";

pub fn run() {
    diagnostics::init();
    let deep_link_state = deep_link::DeepLinkState::from_environment();

    let app = tauri::Builder::default()
        .manage(connection::LocalStdioConnectionManager::default())
        .manage(connection::RemoteWebSocketConnectionManager::default())
        .manage(connection::ConfiguredConnectionManager::default())
        .manage(connection::ServerConnectionTestManager::default())
        .manage(deep_link_state)
        // The single-instance plugin must be registered first so later plugins cannot
        // initialize in a process that is about to exit.
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, _cwd| {
                use tauri::Manager as _;

                app.state::<deep_link::DeepLinkState>()
                    .receive_arguments(app, arguments);
                windows::activate_main_window(app);
            },
        ))
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && std::env::var_os(RELEASE_SMOKE_ENVIRONMENT).is_some_and(|value| value == "1")
            {
                tracing::info!("release smoke page load completed");
                webview.app_handle().exit(0);
            }
        })
        .setup(|app| {
            use tauri::Manager;

            let app_data_directory = app.path().app_data_dir()?;
            let database_path = app_data_directory.join("configuration.sqlite3");
            let pool = tauri::async_runtime::block_on(storage::open_database(database_path))?;
            if !app.manage(configuration::CredentialManager::system(
                app_data_directory.join("credentials"),
            )) {
                return Err(std::io::Error::other(
                    "credential manager was already initialized",
                )
                .into());
            }
            let window_state_repository = window_state::WindowStateRepository::new(pool.clone());
            tauri::async_runtime::block_on(window_state_repository.initialize())?;
            if !app.manage(window_state_repository) {
                return Err(std::io::Error::other(
                    "window state repository was already initialized",
                )
                .into());
            }
            if !app.manage(windows::WindowGeometryTracker::default()) {
                return Err(std::io::Error::other(
                    "window geometry tracker was already initialized",
                )
                .into());
            }
            if !app.manage(configuration::ConfigurationRepository::new(pool.clone())) {
                return Err(std::io::Error::other(
                    "configuration repository was already initialized",
                )
                .into());
            }
            if !app.manage(offline_cache::OfflineCacheRepository::new(pool.clone())) {
                return Err(std::io::Error::other(
                    "offline cache repository was already initialized",
                )
                .into());
            }
            if !app.manage(drafts::DraftRepository::new(pool.clone())) {
                return Err(
                    std::io::Error::other("draft repository was already initialized").into(),
                );
            }
            if !app.manage(preferences::PreferencesRepository::new(pool)) {
                return Err(std::io::Error::other(
                    "preferences repository was already initialized",
                )
                .into());
            }

            let main_window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|configuration| configuration.label == windows::MAIN_WINDOW_LABEL)
                .cloned()
                .ok_or_else(|| std::io::Error::other("main window configuration is missing"))?;
            let main_window = tauri::WebviewWindowBuilder::from_config(app, &main_window_config)?
                .enable_clipboard_access()
                .build()?;
            let repository = app.state::<window_state::WindowStateRepository>();
            if let Err(error) = tauri::async_runtime::block_on(windows::restore_window_geometry(
                &main_window,
                repository.inner(),
            )) {
                tracing::warn!(%error, "failed to restore main window geometry");
            }

            tracing::info!(
                version = app.package_info().version.to_string(),
                "application shell initialized"
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::Manager;

            let window_state_repository = window
                .app_handle()
                .state::<window_state::WindowStateRepository>();
            let geometry_tracker = window
                .app_handle()
                .state::<windows::WindowGeometryTracker>();
            let webview_window = window.app_handle().get_webview_window(window.label());
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(webview_window) = &webview_window {
                    geometry_tracker.save_now(webview_window, window_state_repository.inner());
                }
            } else if matches!(
                event,
                tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
                    | tauri::WindowEvent::Focused(false)
            ) {
                if let Some(webview_window) = &webview_window {
                    geometry_tracker.schedule(webview_window, window_state_repository.inner());
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let window_state_repository = window_state_repository.inner().clone();
                let app_handle = window.app_handle().clone();
                let window_label = window.label().to_owned();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = windows::deactivate_window(
                        &app_handle,
                        &window_state_repository,
                        &window_label,
                    )
                    .await
                    {
                        tracing::warn!(
                            window_label = %window_label,
                            %error,
                            "failed to release the destroyed window server reference"
                        );
                    }
                });

                window
                    .app_handle()
                    .state::<connection::ConfiguredConnectionManager>()
                    .disconnect_window(window.label());
                window
                    .app_handle()
                    .state::<connection::ServerConnectionTestManager>()
                    .disconnect_window(window.label());
                window
                    .app_handle()
                    .state::<connection::LocalStdioConnectionManager>()
                    .disconnect_window(window.label());
                window
                    .app_handle()
                    .state::<connection::RemoteWebSocketConnectionManager>()
                    .disconnect_window(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            connection::configured::cancel_configured_server_connection,
            connection::configured::cancel_server_connection_test,
            connection::configured::connect_configured_server,
            connection::configured::connect_server_connection_test,
            connection::configured::disconnect_configured_server,
            connection::configured::send_configured_server_message,
            connection::configured::subscribe_configured_server_statuses,
            connection::configured::unsubscribe_configured_server_statuses,
            connection::local_stdio::send_local_stdio_message,
            connection::local_stdio::disconnect_local_stdio,
            connection::remote_websocket::disconnect_remote_websocket,
            connection::remote_websocket::send_remote_websocket_message,
            configuration::commands::credential_storage_status,
            configuration::commands::list_configuration_profiles,
            configuration::commands::create_server_profile,
            configuration::commands::update_server_profile,
            configuration::commands::delete_server_profile,
            configuration::commands::create_proxy_profile,
            configuration::commands::update_proxy_profile,
            configuration::commands::delete_proxy_profile,
            configuration::commands::set_server_credential,
            configuration::commands::clear_server_credential,
            configuration::commands::set_proxy_credential,
            configuration::commands::clear_proxy_credential,
            configuration::commands::remove_proxy_ssh_host_key,
            configuration::commands::confirm_proxy_ssh_host_key,
            configuration::commands::record_proxy_test,
            windows::load_window_state,
            windows::bind_window_server,
            windows::update_window_session,
            windows::open_app_window,
            dialogs::pick_local_directory,
            dialogs::open_external_url,
            dialogs::save_remote_file,
            deep_link::take_pending_deep_link,
            drafts::load_draft,
            drafts::save_draft,
            drafts::delete_draft,
            offline_cache::load_thread_cache,
            offline_cache::save_thread_cache,
            preferences::load_preferences,
            preferences::save_preferences,
            preferences::clear_thread_cache,
            preferences::clear_application_logs,
            preferences::clear_temporary_files,
            preferences::clear_all_local_data,
            diagnostics::read_system_diagnostics
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Codex Desktop");

    let shutdown_state = Arc::new(AtomicU8::new(SHUTDOWN_RUNNING));
    app.run(move |app_handle, event| {
        let tauri::RunEvent::ExitRequested { api, code, .. } = event else {
            return;
        };

        match shutdown_state.load(Ordering::Acquire) {
            SHUTDOWN_READY_TO_EXIT => {}
            SHUTDOWN_IN_PROGRESS => api.prevent_exit(),
            SHUTDOWN_RUNNING => {
                api.prevent_exit();
                if shutdown_state
                    .compare_exchange(
                        SHUTDOWN_RUNNING,
                        SHUTDOWN_IN_PROGRESS,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_err()
                {
                    return;
                }

                use tauri::Manager;

                let local_stdio_manager = app_handle
                    .state::<connection::LocalStdioConnectionManager>()
                    .inner()
                    .clone();
                let remote_websocket_manager = app_handle
                    .state::<connection::RemoteWebSocketConnectionManager>()
                    .inner()
                    .clone();
                let configuration_repository = app_handle
                    .state::<configuration::ConfigurationRepository>()
                    .inner()
                    .clone();
                let app_handle = app_handle.clone();
                let exit_code = code.unwrap_or(0);
                let shutdown_state = Arc::clone(&shutdown_state);
                tauri::async_runtime::spawn(async move {
                    tokio::join!(
                        local_stdio_manager.shutdown_all(),
                        remote_websocket_manager.shutdown_all(),
                        configuration_repository.close(),
                    );
                    shutdown_state.store(SHUTDOWN_READY_TO_EXIT, Ordering::Release);
                    app_handle.exit(exit_code);
                });
            }
            _ => unreachable!("invalid application shutdown state"),
        }
    });
}
