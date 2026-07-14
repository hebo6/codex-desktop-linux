use std::{
    collections::{BTreeMap, HashMap},
    ffi::{OsStr, OsString},
    fmt, io,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{
        Arc, Mutex, MutexGuard, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use rustix::process::{Pid, Signal, kill_process_group};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Runtime, State, WebviewWindow};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{Mutex as AsyncMutex, oneshot},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
use tokio_util::sync::CancellationToken;

use crate::{
    configuration::{SensitiveEnvironment, ServerConfiguration},
    sensitive::looks_sensitive_environment_name,
};

use super::{connection_id::ConnectionId, lifecycle::ConnectionLifecycle};

const MAX_ARGUMENT_COUNT: usize = 256;
const MAX_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_TOTAL_ARGUMENT_BYTES: usize = 1024 * 1024;
const MAX_PATH_BYTES: usize = 4 * 1024;
const MAX_ENVIRONMENT_VARIABLES: usize = 128;
const MAX_ENVIRONMENT_NAME_LEN: usize = 128;
const MAX_ENVIRONMENT_VALUE_BYTES: usize = 64 * 1024;
const MAX_PROTOCOL_LINE_BYTES: usize = 16 * 1024 * 1024;
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const MANAGER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

const INHERITED_ENVIRONMENT_ALLOWLIST: &[&str] = &[
    "CODEX_HOME",
    "COLORTERM",
    "HOME",
    "LANG",
    "LANGUAGE",
    "LC_ADDRESS",
    "LC_ALL",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_IDENTIFICATION",
    "LC_MEASUREMENT",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NAME",
    "LC_NUMERIC",
    "LC_PAPER",
    "LC_TELEPHONE",
    "LC_TIME",
    "LOGNAME",
    "NO_COLOR",
    "PATH",
    "SHELL",
    "TERM",
    "TZ",
    "USER",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
];

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectLocalStdioRequest {
    connection_id: String,
    executable_path: PathBuf,
    #[serde(default)]
    arguments: Vec<String>,
    working_directory: PathBuf,
    #[serde(default)]
    non_sensitive_environment: BTreeMap<String, String>,
}

#[cfg(test)]
impl ConnectLocalStdioRequest {
    fn validate(&self) -> Result<(), CommandError> {
        validate_local_process(
            &self.executable_path,
            &self.arguments,
            &self.working_directory,
            &self.non_sensitive_environment,
            None,
        )
    }
}

struct PreparedLocalStdioRequest {
    connection_id: String,
    executable_path: PathBuf,
    arguments: Vec<String>,
    working_directory: PathBuf,
    non_sensitive_environment: BTreeMap<String, String>,
    sensitive_environment: Option<SensitiveEnvironment>,
}

pub(super) struct ConfiguredLocalStdioRequest {
    pub(super) connection_id: String,
    pub(super) configuration: ServerConfiguration,
    pub(super) working_directory_override: Option<PathBuf>,
    pub(super) sensitive_environment: Option<SensitiveEnvironment>,
    pub(super) lifecycle: Arc<ConnectionLifecycle>,
}

impl PreparedLocalStdioRequest {
    fn from_configuration(
        connection_id: String,
        configuration: ServerConfiguration,
        working_directory_override: Option<PathBuf>,
        sensitive_environment: Option<SensitiveEnvironment>,
    ) -> Result<Self, CommandError> {
        let ServerConfiguration::LocalStdio {
            executable_path,
            arguments,
            default_working_directory,
            non_sensitive_environment,
        } = configuration
        else {
            return Err(CommandError::configuration_mismatch());
        };
        let working_directory = working_directory_override
            .or_else(|| default_working_directory.map(PathBuf::from))
            .ok_or_else(CommandError::working_directory_required)?;

        Ok(Self {
            connection_id,
            executable_path: PathBuf::from(executable_path),
            arguments,
            working_directory,
            non_sensitive_environment,
            sensitive_environment,
        })
    }

    fn validate(&self) -> Result<(), CommandError> {
        validate_local_process(
            &self.executable_path,
            &self.arguments,
            &self.working_directory,
            &self.non_sensitive_environment,
            self.sensitive_environment.as_ref(),
        )
    }
}

#[cfg(test)]
impl From<ConnectLocalStdioRequest> for PreparedLocalStdioRequest {
    fn from(request: ConnectLocalStdioRequest) -> Self {
        Self {
            connection_id: request.connection_id,
            executable_path: request.executable_path,
            arguments: request.arguments,
            working_directory: request.working_directory,
            non_sensitive_environment: request.non_sensitive_environment,
            sensitive_environment: None,
        }
    }
}

fn validate_local_process(
    executable_path: &Path,
    arguments: &[String],
    working_directory: &Path,
    non_sensitive_environment: &BTreeMap<String, String>,
    sensitive_environment: Option<&SensitiveEnvironment>,
) -> Result<(), CommandError> {
    validate_absolute_path(executable_path, "invalidExecutablePath")?;
    validate_absolute_path(working_directory, "invalidWorkingDirectory")?;

    if arguments.len() > MAX_ARGUMENT_COUNT {
        return Err(CommandError::invalid_arguments());
    }

    let mut total_argument_bytes = 0usize;
    for argument in arguments {
        if argument.contains('\0') || argument.len() > MAX_ARGUMENT_BYTES {
            return Err(CommandError::invalid_arguments());
        }
        total_argument_bytes = total_argument_bytes.saturating_add(argument.len());
    }
    if total_argument_bytes > MAX_TOTAL_ARGUMENT_BYTES {
        return Err(CommandError::invalid_arguments());
    }

    validate_environment(non_sensitive_environment)?;
    validate_sensitive_environment(non_sensitive_environment, sensitive_environment)
}

fn valid_environment_entry(name: &str, value: &str) -> bool {
    let mut characters = name.bytes();
    let valid_start = characters
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_');
    let valid_remainder = characters.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');

    valid_start
        && valid_remainder
        && name.len() <= MAX_ENVIRONMENT_NAME_LEN
        && !value.contains('\0')
        && value.len() <= MAX_ENVIRONMENT_VALUE_BYTES
}

fn validate_sensitive_environment(
    non_sensitive_environment: &BTreeMap<String, String>,
    sensitive_environment: Option<&SensitiveEnvironment>,
) -> Result<(), CommandError> {
    let Some(sensitive_environment) = sensitive_environment else {
        return Ok(());
    };

    let mut sensitive_count = 0usize;
    for (name, value) in sensitive_environment.iter() {
        sensitive_count = sensitive_count.saturating_add(1);
        if !valid_environment_entry(name, value)
            || non_sensitive_environment.contains_key(name)
            || non_sensitive_environment
                .len()
                .saturating_add(sensitive_count)
                > MAX_ENVIRONMENT_VARIABLES
        {
            return Err(CommandError::invalid_environment());
        }
    }
    if sensitive_count == 0 {
        return Err(CommandError::invalid_environment());
    }

    Ok(())
}

fn validate_absolute_path(path: &Path, error_code: &'static str) -> Result<(), CommandError> {
    let encoded = path.as_os_str().as_encoded_bytes();
    if !path.is_absolute()
        || encoded.is_empty()
        || encoded.len() > MAX_PATH_BYTES
        || encoded.contains(&0)
    {
        return Err(CommandError::new(
            error_code,
            "Local process paths must be absolute",
        ));
    }

    Ok(())
}

fn validate_environment(environment: &BTreeMap<String, String>) -> Result<(), CommandError> {
    if environment.len() > MAX_ENVIRONMENT_VARIABLES {
        return Err(CommandError::invalid_environment());
    }

    for (name, value) in environment {
        if !valid_environment_entry(name, value) || looks_sensitive_environment_name(name) {
            return Err(CommandError::invalid_environment());
        }
    }

    Ok(())
}

fn inherited_environment_is_allowed(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };

    INHERITED_ENVIRONMENT_ALLOWLIST.contains(&name)
}

fn allowed_inherited_environment<I>(environment: I) -> BTreeMap<OsString, OsString>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    environment
        .into_iter()
        .filter(|(name, _)| inherited_environment_is_allowed(name))
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendLocalStdioMessageRequest {
    pub(super) connection_id: String,
    pub(super) json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DisconnectLocalStdioRequest {
    connection_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectLocalStdioResponse {
    connection_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionStatus {
    Connected,
    Disconnected,
    Exited,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminationReason {
    Requested,
    ProcessExited,
    InvalidUtf8,
    InvalidJson,
    LineTooLong,
    StdoutReadFailed,
    EventDeliveryFailed,
    ChildWaitFailed,
}

impl TerminationReason {
    fn status(self) -> ConnectionStatus {
        match self {
            Self::Requested => ConnectionStatus::Disconnected,
            Self::ProcessExited => ConnectionStatus::Exited,
            Self::InvalidUtf8
            | Self::InvalidJson
            | Self::LineTooLong
            | Self::StdoutReadFailed
            | Self::EventDeliveryFailed
            | Self::ChildWaitFailed => ConnectionStatus::Error,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ConnectionEvent {
    ProtocolMessage {
        connection_id: String,
        json: String,
    },
    Status {
        connection_id: String,
        status: ConnectionStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<TerminationReason>,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<i32>,
        stderr_bytes: u64,
        forced: bool,
    },
}

impl ConnectionEvent {
    fn connected(connection_id: &ConnectionId) -> Self {
        Self::Status {
            connection_id: connection_id.as_str().to_owned(),
            status: ConnectionStatus::Connected,
            reason: None,
            exit_code: None,
            signal: None,
            stderr_bytes: 0,
            forced: false,
        }
    }

    fn protocol_message(connection_id: &ConnectionId, json: String) -> Self {
        Self::ProtocolMessage {
            connection_id: connection_id.as_str().to_owned(),
            json,
        }
    }
}

pub(super) trait EventSink: Send + Sync {
    fn emit(&self, event: ConnectionEvent) -> Result<(), ()>;
}

type SharedStdin = Arc<AsyncMutex<Option<ChildStdin>>>;

struct ConnectionEntry {
    owner_window_label: String,
    generation: u64,
    stdin: SharedStdin,
    cancellation: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl Drop for ConnectionEntry {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

#[derive(Default)]
struct LocalStdioManagerState {
    connections: HashMap<ConnectionId, ConnectionEntry>,
    shutting_down: bool,
}

#[derive(Default)]
struct LocalStdioManagerInner {
    state: Mutex<LocalStdioManagerState>,
    next_generation: AtomicU64,
}

impl LocalStdioManagerInner {
    fn state(&self) -> MutexGuard<'_, LocalStdioManagerState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn remove_if_generation(&self, connection_id: &ConnectionId, generation: u64) {
        let mut state = self.state();
        let should_remove = state
            .connections
            .get(connection_id)
            .is_some_and(|entry| entry.generation == generation);
        if should_remove {
            state.connections.remove(connection_id);
        }
    }

    #[cfg(test)]
    fn connection_count(&self) -> usize {
        self.state().connections.len()
    }
}

#[derive(Clone, Default)]
pub(crate) struct LocalStdioConnectionManager {
    inner: Arc<LocalStdioManagerInner>,
}

impl LocalStdioConnectionManager {
    #[cfg(test)]
    async fn connect(
        &self,
        owner_window_label: String,
        request: ConnectLocalStdioRequest,
        event_sink: Arc<dyn EventSink>,
    ) -> Result<ConnectLocalStdioResponse, CommandError> {
        request.validate()?;
        self.connect_prepared(owner_window_label, request.into(), event_sink, None)
            .await
    }

    pub(super) async fn connect_configured(
        &self,
        owner_window_label: String,
        request: ConfiguredLocalStdioRequest,
        event_sink: Arc<dyn EventSink>,
    ) -> Result<ConnectLocalStdioResponse, CommandError> {
        let prepared = PreparedLocalStdioRequest::from_configuration(
            request.connection_id,
            request.configuration,
            request.working_directory_override,
            request.sensitive_environment,
        )?;
        self.connect_prepared(
            owner_window_label,
            prepared,
            event_sink,
            Some(&request.lifecycle),
        )
        .await
    }

    async fn connect_prepared(
        &self,
        owner_window_label: String,
        request: PreparedLocalStdioRequest,
        event_sink: Arc<dyn EventSink>,
        external_lifecycle: Option<&ConnectionLifecycle>,
    ) -> Result<ConnectLocalStdioResponse, CommandError> {
        request.validate()?;
        let connection_id = ConnectionId::parse(request.connection_id.clone())
            .map_err(|_| CommandError::invalid_connection_id())?;

        let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        let cancellation = external_lifecycle
            .map(ConnectionLifecycle::child_token)
            .unwrap_or_default();

        external_lifecycle
            .map(ConnectionLifecycle::begin_start)
            .transpose()
            .map_err(|_| CommandError::connect_cancelled())?;

        enum Preparation {
            Ready {
                start_sender: oneshot::Sender<()>,
            },
            EventDeliveryFailed {
                child: Child,
                process_group: ProcessGroup,
                stdin: SharedStdin,
            },
        }

        let preparation = {
            let mut state = self.inner.state();
            if state.shutting_down {
                return Err(CommandError::manager_shutting_down());
            }
            if state.connections.contains_key(&connection_id) {
                return Err(CommandError::already_connected());
            }

            let (child, stdin, stdout, stderr, process_group) = spawn_local_process(&request)
                .map_err(|error| {
                    tracing::warn!(
                        connection_id = connection_id.as_str(),
                        error_kind = ?error.kind(),
                        "failed to start local stdio process"
                    );
                    CommandError::process_start_failed()
                })?;
            let shared_stdin = Arc::new(AsyncMutex::new(Some(stdin)));

            if event_sink
                .emit(ConnectionEvent::connected(&connection_id))
                .is_err()
            {
                Preparation::EventDeliveryFailed {
                    child,
                    process_group,
                    stdin: shared_stdin,
                }
            } else {
                let (start_sender, start_receiver) = oneshot::channel();
                let supervisor = SupervisedProcess {
                    manager: Arc::downgrade(&self.inner),
                    connection_id: connection_id.clone(),
                    generation,
                    child,
                    process_group,
                    stdin: Arc::clone(&shared_stdin),
                    stdout,
                    stderr,
                    cancellation: cancellation.clone(),
                    event_sink: Arc::clone(&event_sink),
                };
                let task = tokio::spawn(async move {
                    if start_receiver.await.is_ok() {
                        supervisor.run().await;
                    }
                });

                state.connections.insert(
                    connection_id.clone(),
                    ConnectionEntry {
                        owner_window_label: owner_window_label.clone(),
                        generation,
                        stdin: shared_stdin,
                        cancellation,
                        task: Some(task),
                    },
                );
                Preparation::Ready { start_sender }
            }
        };
        let start_sender = match preparation {
            Preparation::Ready { start_sender } => start_sender,
            Preparation::EventDeliveryFailed {
                mut child,
                process_group,
                stdin,
            } => {
                close_stdin(&stdin).await;
                let _ = finish_child(&mut child, process_group, true).await;
                return Err(CommandError::event_delivery_failed());
            }
        };

        if start_sender.send(()).is_err() {
            self.inner.remove_if_generation(&connection_id, generation);
            return Err(CommandError::process_start_failed());
        }

        tracing::info!(
            connection_id = connection_id.as_str(),
            owner_window_label,
            "local stdio connection started"
        );

        Ok(ConnectLocalStdioResponse {
            connection_id: connection_id.into_string(),
        })
    }

    pub(super) async fn send(
        &self,
        owner_window_label: &str,
        request: SendLocalStdioMessageRequest,
    ) -> Result<(), CommandError> {
        let connection_id = ConnectionId::parse(request.connection_id)
            .map_err(|_| CommandError::invalid_connection_id())?;
        validate_outbound_json(&request.json)?;

        let (stdin, cancellation) = {
            let state = self.inner.state();
            let entry = state
                .connections
                .get(&connection_id)
                .ok_or_else(CommandError::not_connected)?;
            if entry.owner_window_label != owner_window_label {
                return Err(CommandError::not_owned());
            }
            (Arc::clone(&entry.stdin), entry.cancellation.clone())
        };

        let write_result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(CommandError::not_connected()),
            result = async {
                let mut stdin = stdin.lock().await;
                let stdin = stdin
                    .as_mut()
                    .ok_or(io::Error::from(io::ErrorKind::BrokenPipe))?;
                stdin.write_all(request.json.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await
            } => result,
        };

        if let Err(error) = write_result {
            cancellation.cancel();
            tracing::warn!(
                connection_id = connection_id.as_str(),
                error_kind = ?error.kind(),
                "failed to write local stdio protocol message"
            );
            return Err(CommandError::write_failed());
        }

        tracing::debug!(
            connection_id = connection_id.as_str(),
            message_bytes = request.json.len(),
            "local stdio protocol message sent"
        );

        Ok(())
    }

    fn disconnect(
        &self,
        owner_window_label: &str,
        request: DisconnectLocalStdioRequest,
    ) -> Result<(), CommandError> {
        let connection_id = ConnectionId::parse(request.connection_id)
            .map_err(|_| CommandError::invalid_connection_id())?;
        let cancellation = {
            let state = self.inner.state();
            let entry = state
                .connections
                .get(&connection_id)
                .ok_or_else(CommandError::not_connected)?;
            if entry.owner_window_label != owner_window_label {
                return Err(CommandError::not_owned());
            }
            entry.cancellation.clone()
        };

        cancellation.cancel();
        tracing::info!(
            connection_id = connection_id.as_str(),
            owner_window_label,
            "local stdio disconnect requested"
        );
        Ok(())
    }

    pub(crate) fn disconnect_window(&self, owner_window_label: &str) {
        let cancellations = {
            let state = self.inner.state();
            state
                .connections
                .iter()
                .filter(|(_, entry)| entry.owner_window_label == owner_window_label)
                .map(|(_, entry)| entry.cancellation.clone())
                .collect::<Vec<_>>()
        };

        let connection_count = cancellations.len();
        for cancellation in cancellations {
            cancellation.cancel();
        }
        if connection_count > 0 {
            tracing::info!(
                owner_window_label,
                connection_count,
                "requested closure of local stdio connections owned by destroyed window"
            );
        }
    }

    pub(crate) async fn shutdown_all(&self) {
        let mut tasks = {
            let mut state = self.inner.state();
            state.shutting_down = true;
            state
                .connections
                .values_mut()
                .filter_map(|entry| {
                    entry.cancellation.cancel();
                    entry.task.take()
                })
                .collect::<Vec<_>>()
        };

        let connection_count = tasks.len();
        let deadline = Instant::now() + MANAGER_SHUTDOWN_TIMEOUT;
        let mut timed_out = false;
        while let Some(mut task) = tasks.pop() {
            if timeout_at(deadline, &mut task).await.is_err() {
                timed_out = true;
                task.abort();
                for pending_task in &tasks {
                    pending_task.abort();
                }

                let _ = timeout(STDERR_DRAIN_TIMEOUT, task).await;
                for pending_task in tasks {
                    let _ = timeout(STDERR_DRAIN_TIMEOUT, pending_task).await;
                }
                break;
            }
        }

        let remaining_connections = {
            let mut state = self.inner.state();
            let remaining_connections = state.connections.len();
            state.connections.clear();
            remaining_connections
        };

        tracing::info!(
            connection_count,
            remaining_connections,
            timed_out,
            "local stdio connection manager shut down"
        );
    }
}

struct ProcessGroup {
    leader: Pid,
    armed: bool,
}

impl ProcessGroup {
    fn for_child(child: &Child) -> io::Result<Self> {
        let raw_pid = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .and_then(Pid::from_raw)
            .ok_or_else(|| io::Error::other("child process ID was unavailable"))?;
        Ok(Self {
            leader: raw_pid,
            armed: true,
        })
    }

    fn terminate(&mut self) {
        if !self.armed {
            return;
        }

        match kill_process_group(self.leader, Signal::KILL) {
            Ok(()) | Err(rustix::io::Errno::SRCH) => self.armed = false,
            Err(_) => {}
        }
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn spawn_local_process(
    request: &PreparedLocalStdioRequest,
) -> io::Result<(Child, ChildStdin, ChildStdout, ChildStderr, ProcessGroup)> {
    let mut command = Command::new(&request.executable_path);
    command
        .args(&request.arguments)
        .current_dir(&request.working_directory)
        .env_clear()
        .envs(allowed_inherited_environment(std::env::vars_os()))
        .envs(&request.non_sensitive_environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    if let Some(environment) = &request.sensitive_environment {
        command.envs(environment.iter());
    }

    let mut child = command.spawn()?;
    let process_group = ProcessGroup::for_child(&child)?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("child stdin was not piped"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("child stdout was not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("child stderr was not piped"))?;

    Ok((child, stdin, stdout, stderr, process_group))
}

fn validate_outbound_json(json: &str) -> Result<(), CommandError> {
    if json.len() > MAX_PROTOCOL_LINE_BYTES || json.contains(['\n', '\r']) {
        return Err(CommandError::invalid_protocol_message());
    }

    serde_json::from_str::<Value>(json)
        .map(|_| ())
        .map_err(|_| CommandError::invalid_protocol_message())
}

struct SupervisedProcess {
    manager: Weak<LocalStdioManagerInner>,
    connection_id: ConnectionId,
    generation: u64,
    child: Child,
    process_group: ProcessGroup,
    stdin: SharedStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
    cancellation: CancellationToken,
    event_sink: Arc<dyn EventSink>,
}

impl SupervisedProcess {
    async fn run(self) {
        let Self {
            manager,
            connection_id,
            generation,
            mut child,
            mut process_group,
            stdin,
            stdout,
            stderr,
            cancellation,
            event_sink,
        } = self;
        let stderr_bytes = Arc::new(AtomicU64::new(0));
        let stderr_task = tokio::spawn(count_stderr(stderr, Arc::clone(&stderr_bytes)));
        let mut stdout = BufReader::new(stdout);

        let mut observed_exit_status = None;
        let mut reason = loop {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => break TerminationReason::Requested,
                child_result = child.wait() => {
                    match child_result {
                        Ok(exit_status) => {
                            observed_exit_status = Some(exit_status);
                            break TerminationReason::ProcessExited;
                        }
                        Err(_) => break TerminationReason::ChildWaitFailed,
                    }
                }
                line_result = read_protocol_line(&mut stdout, MAX_PROTOCOL_LINE_BYTES) => {
                    match deliver_protocol_line(line_result, &connection_id, event_sink.as_ref()) {
                        Ok(true) => {}
                        Ok(false) => break TerminationReason::ProcessExited,
                        Err(reason) => break reason,
                    }
                }
            }
        };

        cancellation.cancel();
        close_stdin(&stdin).await;
        let (exit_status, forced) = if let Some(exit_status) = observed_exit_status {
            process_group.terminate();
            (Some(exit_status), false)
        } else {
            let terminate_immediately = !matches!(
                reason,
                TerminationReason::Requested | TerminationReason::ProcessExited
            );
            finish_child(&mut child, process_group, terminate_immediately).await
        };

        if matches!(reason, TerminationReason::ProcessExited)
            && let Some(drain_reason) =
                drain_protocol_stdout(&mut stdout, &connection_id, event_sink.as_ref()).await
        {
            reason = drain_reason;
        }
        finish_stderr_task(stderr_task).await;
        let stderr_bytes = stderr_bytes.load(Ordering::Relaxed);

        let event = ConnectionEvent::Status {
            connection_id: connection_id.as_str().to_owned(),
            status: reason.status(),
            reason: Some(reason),
            exit_code: exit_status.as_ref().and_then(ExitStatus::code),
            signal: exit_status.as_ref().and_then(exit_signal),
            stderr_bytes,
            forced,
        };

        if let Some(manager) = manager.upgrade() {
            manager.remove_if_generation(&connection_id, generation);
        }
        let _ = event_sink.emit(event);

        tracing::info!(
            connection_id = connection_id.as_str(),
            reason = ?reason,
            exit_code = exit_status.as_ref().and_then(ExitStatus::code),
            signal = exit_status.as_ref().and_then(exit_signal),
            stderr_bytes,
            forced,
            "local stdio connection finished"
        );
    }
}

fn deliver_protocol_line(
    result: Result<Option<String>, ProtocolLineError>,
    connection_id: &ConnectionId,
    event_sink: &dyn EventSink,
) -> Result<bool, TerminationReason> {
    match result {
        Ok(Some(json)) => event_sink
            .emit(ConnectionEvent::protocol_message(connection_id, json))
            .map(|_| true)
            .map_err(|_| TerminationReason::EventDeliveryFailed),
        Ok(None) => Ok(false),
        Err(ProtocolLineError::InvalidUtf8) => Err(TerminationReason::InvalidUtf8),
        Err(ProtocolLineError::InvalidJson) => Err(TerminationReason::InvalidJson),
        Err(ProtocolLineError::LineTooLong) => Err(TerminationReason::LineTooLong),
        Err(ProtocolLineError::Io(_)) => Err(TerminationReason::StdoutReadFailed),
    }
}

async fn drain_protocol_stdout<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    connection_id: &ConnectionId,
    event_sink: &dyn EventSink,
) -> Option<TerminationReason> {
    timeout(OUTPUT_DRAIN_TIMEOUT, async {
        loop {
            let result = read_protocol_line(reader, MAX_PROTOCOL_LINE_BYTES).await;
            match deliver_protocol_line(result, connection_id, event_sink) {
                Ok(true) => {}
                Ok(false) => return None,
                Err(reason) => return Some(reason),
            }
        }
    })
    .await
    .unwrap_or(None)
}

async fn close_stdin(stdin: &SharedStdin) {
    let mut stdin = stdin.lock().await;
    stdin.take();
}

async fn finish_child(
    child: &mut Child,
    mut process_group: ProcessGroup,
    terminate_immediately: bool,
) -> (Option<ExitStatus>, bool) {
    if terminate_immediately {
        process_group.terminate();
        let _ = child.start_kill();
        return (wait_for_child(child).await, true);
    }

    match timeout(GRACEFUL_SHUTDOWN_TIMEOUT, child.wait()).await {
        Ok(result) => {
            process_group.terminate();
            (result.ok(), false)
        }
        Err(_) => {
            process_group.terminate();
            let _ = child.start_kill();
            (wait_for_child(child).await, true)
        }
    }
}

async fn wait_for_child(child: &mut Child) -> Option<ExitStatus> {
    timeout(GRACEFUL_SHUTDOWN_TIMEOUT, child.wait())
        .await
        .ok()
        .and_then(Result::ok)
}

async fn count_stderr(mut stderr: ChildStderr, stderr_bytes: Arc<AtomicU64>) {
    let mut buffer = [0u8; 8192];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read_bytes) => {
                let _ = stderr_bytes.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |total| {
                    Some(total.saturating_add(read_bytes as u64))
                });
            }
            Err(error) => {
                tracing::warn!(
                    error_kind = ?error.kind(),
                    stderr_bytes = stderr_bytes.load(Ordering::Relaxed),
                    "failed to finish reading local process stderr"
                );
                break;
            }
        }
    }
}

async fn finish_stderr_task(mut stderr_task: JoinHandle<()>) {
    if timeout(STDERR_DRAIN_TIMEOUT, &mut stderr_task)
        .await
        .is_err()
    {
        stderr_task.abort();
        let _ = stderr_task.await;
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ProtocolLineError {
    Io(io::ErrorKind),
    InvalidUtf8,
    InvalidJson,
    LineTooLong,
}

async fn read_protocol_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    maximum_bytes: usize,
) -> Result<Option<String>, ProtocolLineError> {
    let bytes = read_bounded_line(reader, maximum_bytes).await?;
    let Some(mut bytes) = bytes else {
        return Ok(None);
    };

    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }

    let json = String::from_utf8(bytes).map_err(|_| ProtocolLineError::InvalidUtf8)?;
    serde_json::from_str::<Value>(&json).map_err(|_| ProtocolLineError::InvalidJson)?;
    Ok(Some(json))
}

async fn read_bounded_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    maximum_bytes: usize,
) -> Result<Option<Vec<u8>>, ProtocolLineError> {
    let mut line = Vec::with_capacity(maximum_bytes.min(8192));

    loop {
        let buffer = reader
            .fill_buf()
            .await
            .map_err(|error| ProtocolLineError::Io(error.kind()))?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }

        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(buffer.len(), |position| position + 1);
        let content = newline.map_or(buffer, |position| &buffer[..position]);
        if line.len().saturating_add(content.len()) > maximum_bytes {
            return Err(ProtocolLineError::LineTooLong);
        }

        line.extend_from_slice(content);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(Some(line));
        }
    }
}

#[cfg(unix)]
fn exit_signal(exit_status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;

    exit_status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_exit_status: &ExitStatus) -> Option<i32> {
    None
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    code: &'static str,
    message: &'static str,
}

impl CommandError {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    const fn invalid_connection_id() -> Self {
        Self::new(
            "invalidConnectionId",
            "connectionId must use 1 to 64 lowercase ASCII letters, digits, or inner hyphens",
        )
    }

    const fn invalid_arguments() -> Self {
        Self::new("invalidArguments", "Local process arguments are invalid")
    }

    const fn invalid_environment() -> Self {
        Self::new(
            "invalidEnvironment",
            "The local process environment is invalid",
        )
    }

    const fn working_directory_required() -> Self {
        Self::new(
            "workingDirectoryRequired",
            "A working directory is required for the local process",
        )
    }

    const fn configuration_mismatch() -> Self {
        Self::new(
            "serverConfigurationMismatch",
            "The server configuration is not a local stdio configuration",
        )
    }

    const fn invalid_protocol_message() -> Self {
        Self::new(
            "invalidProtocolMessage",
            "The protocol message must be valid single-line JSON within the size limit",
        )
    }

    const fn already_connected() -> Self {
        Self::new(
            "connectionAlreadyExists",
            "A connection with this connectionId already exists",
        )
    }

    const fn manager_shutting_down() -> Self {
        Self::new(
            "connectionManagerShuttingDown",
            "The connection manager is shutting down",
        )
    }

    const fn connect_cancelled() -> Self {
        Self::new(
            "connectionCancelled",
            "The connection attempt was cancelled",
        )
    }

    const fn not_connected() -> Self {
        Self::new("connectionNotFound", "The connection is not active")
    }

    const fn not_owned() -> Self {
        Self::new(
            "connectionNotOwned",
            "The connection belongs to a different application window",
        )
    }

    const fn process_start_failed() -> Self {
        Self::new(
            "processStartFailed",
            "The local app-server process could not be started",
        )
    }

    const fn event_delivery_failed() -> Self {
        Self::new(
            "eventDeliveryFailed",
            "The connection owner cannot receive connection events",
        )
    }

    const fn write_failed() -> Self {
        Self::new(
            "protocolWriteFailed",
            "The protocol message could not be written to the local process",
        )
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for CommandError {}

#[tauri::command]
pub(crate) async fn send_local_stdio_message<R: Runtime>(
    window: WebviewWindow<R>,
    manager: State<'_, LocalStdioConnectionManager>,
    request: SendLocalStdioMessageRequest,
) -> Result<(), CommandError> {
    manager.send(window.label(), request).await
}

#[tauri::command]
pub(crate) fn disconnect_local_stdio<R: Runtime>(
    window: WebviewWindow<R>,
    manager: State<'_, LocalStdioConnectionManager>,
    request: DisconnectLocalStdioRequest,
) -> Result<(), CommandError> {
    manager.disconnect(window.label(), request)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        ffi::OsString,
        path::PathBuf,
        sync::Arc,
        time::{Duration, Instant},
    };

    use serde_json::{Value, json};
    use tokio::{io::BufReader, sync::mpsc, time::timeout};

    use crate::configuration::{RemoteServerAuthentication, TlsCertificatePolicy};

    use super::{
        CommandError, ConfiguredLocalStdioRequest, ConnectLocalStdioRequest, ConnectionEvent,
        ConnectionId, ConnectionLifecycle, ConnectionStatus, DisconnectLocalStdioRequest,
        EventSink, LocalStdioConnectionManager, MAX_PATH_BYTES, ProtocolLineError,
        SendLocalStdioMessageRequest, SensitiveEnvironment, ServerConfiguration, TerminationReason,
        allowed_inherited_environment, looks_sensitive_environment_name, read_protocol_line,
        validate_outbound_json,
    };

    struct TestEventSink {
        sender: mpsc::UnboundedSender<ConnectionEvent>,
    }

    struct RejectStatusSink;

    impl EventSink for TestEventSink {
        fn emit(&self, event: ConnectionEvent) -> Result<(), ()> {
            self.sender.send(event).map_err(|_| ())
        }
    }

    impl EventSink for RejectStatusSink {
        fn emit(&self, _event: ConnectionEvent) -> Result<(), ()> {
            Err(())
        }
    }

    fn shell_request(connection_id: &str, script: &str) -> ConnectLocalStdioRequest {
        ConnectLocalStdioRequest {
            connection_id: connection_id.to_owned(),
            executable_path: PathBuf::from("/bin/sh"),
            arguments: vec!["-c".to_owned(), script.to_owned()],
            working_directory: PathBuf::from("/tmp"),
            non_sensitive_environment: BTreeMap::new(),
        }
    }

    fn local_configuration(
        script: &str,
        default_working_directory: Option<&str>,
        non_sensitive_environment: BTreeMap<String, String>,
    ) -> ServerConfiguration {
        ServerConfiguration::LocalStdio {
            executable_path: "/bin/sh".to_owned(),
            arguments: vec!["-c".to_owned(), script.to_owned()],
            default_working_directory: default_working_directory.map(str::to_owned),
            non_sensitive_environment,
        }
    }

    fn configured_request(
        connection_id: &str,
        configuration: ServerConfiguration,
        working_directory_override: Option<PathBuf>,
        sensitive_environment: Option<SensitiveEnvironment>,
    ) -> ConfiguredLocalStdioRequest {
        ConfiguredLocalStdioRequest {
            connection_id: connection_id.to_owned(),
            configuration,
            working_directory_override,
            sensitive_environment,
            lifecycle: Arc::new(ConnectionLifecycle::default()),
        }
    }

    fn sensitive_environment(
        entries: impl IntoIterator<Item = (String, String)>,
    ) -> SensitiveEnvironment {
        let values = entries
            .into_iter()
            .map(|(name, value)| (name, Value::String(value)))
            .collect::<serde_json::Map<_, _>>();
        serde_json::from_value(Value::Object(values))
            .expect("sensitive environment fixture should deserialize")
    }

    fn test_sink() -> (Arc<dyn EventSink>, mpsc::UnboundedReceiver<ConnectionEvent>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (Arc::new(TestEventSink { sender }), receiver)
    }

    async fn receive_event(
        receiver: &mut mpsc::UnboundedReceiver<ConnectionEvent>,
    ) -> ConnectionEvent {
        timeout(Duration::from_secs(5), receiver.recv())
            .await
            .expect("fixture event timed out")
            .expect("fixture event channel closed")
    }

    #[test]
    fn requires_absolute_executable_and_working_directory_paths() {
        let mut request = shell_request("local", "exit 0");
        request.executable_path = PathBuf::from("bin/sh");
        assert_eq!(
            request.validate().unwrap_err().code,
            "invalidExecutablePath"
        );

        request.executable_path = PathBuf::from("/bin/sh");
        request.working_directory = PathBuf::from("tmp");
        assert_eq!(
            request.validate().unwrap_err().code,
            "invalidWorkingDirectory"
        );

        request.working_directory = PathBuf::from(format!("/{}", "a".repeat(MAX_PATH_BYTES)));
        assert_eq!(
            request.validate().unwrap_err().code,
            "invalidWorkingDirectory"
        );

        request.working_directory = PathBuf::from("/tmp/\0invalid");
        assert_eq!(
            request.validate().unwrap_err().code,
            "invalidWorkingDirectory"
        );
    }

    #[test]
    fn rejects_sensitive_environment_variable_names() {
        for name in [
            "OPENAI_API_KEY",
            "openai_api_key",
            "GITHUB_TOKEN",
            "github_token",
            "SERVICE_PASSWORD",
            "SESSION_COOKIE",
            "SSH_AUTH_SOCK",
        ] {
            assert!(looks_sensitive_environment_name(name), "{name}");
        }

        for name in ["CODEX_HOME", "LOG_FORMAT", "RUST_LOG", "PATH"] {
            assert!(!looks_sensitive_environment_name(name), "{name}");
        }
    }

    #[test]
    fn request_has_no_sensitive_environment_field() {
        let request = json!({
            "connectionId": "local",
            "executablePath": "/bin/sh",
            "workingDirectory": "/tmp",
            "sensitiveEnvironment": {"OPENAI_API_KEY": "secret"}
        });

        assert!(serde_json::from_value::<ConnectLocalStdioRequest>(request).is_err());
    }

    #[tokio::test]
    async fn configured_connection_injects_sensitive_environment_into_controlled_child() {
        let manager = LocalStdioConnectionManager::default();
        let (sink, mut events) = test_sink();
        let configuration = local_configuration(
            r#"printf '{"sensitiveBytes":%s,"mode":"%s","workingDirectory":"%s"}\n' "${#APP_SERVER_TOKEN}" "$FIXTURE_MODE" "$PWD""#,
            Some("/"),
            BTreeMap::from([("FIXTURE_MODE".to_owned(), "local".to_owned())]),
        );
        let sensitive_environment = sensitive_environment([(
            "APP_SERVER_TOKEN".to_owned(),
            "controlled-secret".to_owned(),
        )]);

        manager
            .connect_configured(
                "main".to_owned(),
                configured_request(
                    "configured-local",
                    configuration,
                    Some(PathBuf::from("/tmp")),
                    Some(sensitive_environment),
                ),
                sink,
            )
            .await
            .unwrap();

        assert!(matches!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Connected,
                ..
            }
        ));
        match receive_event(&mut events).await {
            ConnectionEvent::ProtocolMessage { json, .. } => assert_eq!(
                json,
                r#"{"sensitiveBytes":17,"mode":"local","workingDirectory":"/tmp"}"#
            ),
            event => panic!("expected protocol message, got {event:?}"),
        }
        assert!(matches!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Exited,
                reason: Some(TerminationReason::ProcessExited),
                exit_code: Some(0),
                ..
            }
        ));
    }

    #[tokio::test]
    async fn configured_connection_rejects_environment_name_collisions_and_excess_total() {
        let manager = LocalStdioConnectionManager::default();
        let (sink, _events) = test_sink();
        let collision = manager
            .connect_configured(
                "main".to_owned(),
                configured_request(
                    "collision",
                    local_configuration(
                        "exit 0",
                        Some("/tmp"),
                        BTreeMap::from([("SHARED_NAME".to_owned(), "public".to_owned())]),
                    ),
                    None,
                    Some(sensitive_environment([(
                        "SHARED_NAME".to_owned(),
                        "private".to_owned(),
                    )])),
                ),
                sink,
            )
            .await
            .unwrap_err();
        assert_eq!(collision, CommandError::invalid_environment());

        let non_sensitive_environment = (0..65)
            .map(|index| (format!("PUBLIC_{index}"), "value".to_owned()))
            .collect();
        let sensitive_environment = sensitive_environment(
            (0..64).map(|index| (format!("PRIVATE_{index}"), "value".to_owned())),
        );
        let (sink, _events) = test_sink();
        let excessive = manager
            .connect_configured(
                "main".to_owned(),
                configured_request(
                    "excessive",
                    local_configuration("exit 0", Some("/tmp"), non_sensitive_environment),
                    None,
                    Some(sensitive_environment),
                ),
                sink,
            )
            .await
            .unwrap_err();
        assert_eq!(excessive, CommandError::invalid_environment());
    }

    #[tokio::test]
    async fn configured_connection_requires_a_working_directory() {
        let manager = LocalStdioConnectionManager::default();
        let (sink, _events) = test_sink();
        let error = manager
            .connect_configured(
                "main".to_owned(),
                configured_request(
                    "missing-working-directory",
                    local_configuration("exit 0", None, BTreeMap::new()),
                    None,
                    None,
                ),
                sink,
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, "workingDirectoryRequired");
    }

    #[tokio::test]
    async fn configured_connection_honors_window_cancellation_before_spawn() {
        let manager = LocalStdioConnectionManager::default();
        let (sink, mut events) = test_sink();
        let lifecycle = Arc::new(ConnectionLifecycle::default());
        lifecycle.cancel();
        let error = manager
            .connect_configured(
                "closed-window".to_owned(),
                ConfiguredLocalStdioRequest {
                    connection_id: "cancelled-local".to_owned(),
                    configuration: local_configuration("exit 0", Some("/tmp"), BTreeMap::new()),
                    working_directory_override: None,
                    sensitive_environment: None,
                    lifecycle,
                },
                sink,
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, "connectionCancelled");
        assert_eq!(manager.inner.connection_count(), 0);
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn configured_connection_rejects_a_remote_server_configuration() {
        let manager = LocalStdioConnectionManager::default();
        let (sink, _events) = test_sink();
        let error = manager
            .connect_configured(
                "main".to_owned(),
                configured_request(
                    "remote",
                    ServerConfiguration::RemoteWebSocket {
                        url: "wss://example.com/socket".to_owned(),
                        authentication: RemoteServerAuthentication::None,
                        non_sensitive_headers: BTreeMap::new(),
                        connect_timeout_ms: 1_000,
                        tls_certificate_policy: TlsCertificatePolicy::Strict,
                        plaintext_confirmed: false,
                        proxy_id: None,
                    },
                    Some(PathBuf::from("/tmp")),
                    None,
                ),
                sink,
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, "serverConfigurationMismatch");
    }

    #[test]
    fn rejects_sensitive_names_in_non_sensitive_environment() {
        let request = json!({
            "connectionId": "local",
            "executablePath": "/bin/sh",
            "workingDirectory": "/tmp",
            "nonSensitiveEnvironment": {"OPENAI_API_KEY": "secret"}
        });
        let request = serde_json::from_value::<ConnectLocalStdioRequest>(request).unwrap();

        assert_eq!(request.validate().unwrap_err().code, "invalidEnvironment");
    }

    #[test]
    fn inherits_only_the_reviewed_base_environment() {
        let environment = [
            ("HOME", "/home/example"),
            ("LC_CTYPE", "en_US.UTF-8"),
            ("LC_TOKEN", "locale-secret"),
            ("OPENAI_API_KEY", "secret"),
            ("SSH_AUTH_SOCK", "/tmp/agent.sock"),
            ("LD_PRELOAD", "/tmp/injected.so"),
        ]
        .into_iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)));

        let inherited = allowed_inherited_environment(environment);
        let names = inherited
            .keys()
            .map(|name| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(names, ["HOME", "LC_CTYPE"]);
        assert!(
            !inherited
                .values()
                .any(|value| value.to_string_lossy().contains("secret"))
        );
    }

    #[test]
    fn serializes_channel_events_as_a_tagged_union() {
        let connection_id =
            ConnectionId::parse("local".to_owned()).expect("connection ID should be valid");
        let event = ConnectionEvent::protocol_message(
            &connection_id,
            r#"{"id":1,"result":null}"#.to_owned(),
        );

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "kind": "protocolMessage",
                "connectionId": "local",
                "json": r#"{"id":1,"result":null}"#
            })
        );
    }

    #[test]
    fn validates_outbound_json_without_logging_or_rewriting_it() {
        assert!(validate_outbound_json(r#"{"id":1,"method":"initialize"}"#).is_ok());
        assert!(validate_outbound_json("not json").is_err());
        assert!(validate_outbound_json("{\n}").is_err());
    }

    #[tokio::test]
    async fn reads_crlf_json_and_rejects_invalid_utf8_or_json() {
        let mut valid = BufReader::new(&b"{\"id\":1}\r\n"[..]);
        assert_eq!(
            read_protocol_line(&mut valid, 1024).await.unwrap(),
            Some(r#"{"id":1}"#.to_owned())
        );

        let mut invalid_utf8 = BufReader::new(&[0xff, b'\n'][..]);
        assert_eq!(
            read_protocol_line(&mut invalid_utf8, 1024).await,
            Err(ProtocolLineError::InvalidUtf8)
        );

        let mut invalid_json = BufReader::new(&b"not-json\n"[..]);
        assert_eq!(
            read_protocol_line(&mut invalid_json, 1024).await,
            Err(ProtocolLineError::InvalidJson)
        );
    }

    #[tokio::test]
    async fn enforces_the_line_limit_before_growing_the_message_buffer() {
        let mut reader = BufReader::with_capacity(4, &b"123456789\n"[..]);

        assert_eq!(
            read_protocol_line(&mut reader, 8).await,
            Err(ProtocolLineError::LineTooLong)
        );
    }

    #[tokio::test]
    async fn controlled_shell_fixture_keeps_stdout_protocol_and_stderr_separate() {
        let manager = LocalStdioConnectionManager::default();
        let (sink, mut events) = test_sink();
        manager
            .connect(
                "main".to_owned(),
                shell_request(
                    "fixture",
                    "IFS= read -r line; printf '%s\\n' \"$line\"; printf '%s' 'diagnostic body' >&2",
                ),
                sink,
            )
            .await
            .unwrap();

        assert!(matches!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Connected,
                ..
            }
        ));

        let json = r#"{"id":1,"method":"initialize"}"#;
        manager
            .send(
                "main",
                SendLocalStdioMessageRequest {
                    connection_id: "fixture".to_owned(),
                    json: json.to_owned(),
                },
            )
            .await
            .unwrap();

        match receive_event(&mut events).await {
            ConnectionEvent::ProtocolMessage {
                json: event_json, ..
            } => assert_eq!(event_json, json),
            event => panic!("expected protocol message, got {event:?}"),
        }

        match receive_event(&mut events).await {
            ConnectionEvent::Status {
                status,
                reason,
                exit_code,
                stderr_bytes,
                forced,
                ..
            } => {
                assert_eq!(status, ConnectionStatus::Exited);
                assert_eq!(reason, Some(TerminationReason::ProcessExited));
                assert_eq!(exit_code, Some(0));
                assert_eq!(stderr_bytes, 15);
                assert!(!forced);
            }
            event => panic!("expected terminal status, got {event:?}"),
        }
    }

    #[tokio::test]
    async fn invalid_protocol_output_stops_delivery_before_later_lines() {
        let manager = LocalStdioConnectionManager::default();
        let (sink, mut events) = test_sink();
        manager
            .connect(
                "main".to_owned(),
                shell_request(
                    "invalid-output",
                    "printf '%s\\n' 'not-json' '{\"id\":1,\"result\":null}'",
                ),
                sink,
            )
            .await
            .unwrap();

        assert!(matches!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Connected,
                ..
            }
        ));
        assert!(matches!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Error,
                reason: Some(TerminationReason::InvalidJson),
                ..
            }
        ));
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn connected_status_always_precedes_a_fast_process_exit() {
        let manager = LocalStdioConnectionManager::default();
        let (sink, mut events) = test_sink();

        manager
            .connect(
                "main".to_owned(),
                shell_request("fast-exit", "exit 0"),
                sink,
            )
            .await
            .unwrap();

        assert!(matches!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Connected,
                ..
            }
        ));
        assert!(matches!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Exited,
                reason: Some(TerminationReason::ProcessExited),
                ..
            }
        ));
    }

    #[tokio::test]
    async fn observes_parent_exit_and_drains_output_when_a_descendant_keeps_pipes_open() {
        let manager = LocalStdioConnectionManager::default();
        let (sink, mut events) = test_sink();
        let started_at = Instant::now();

        manager
            .connect(
                "main".to_owned(),
                shell_request(
                    "inherited-pipe",
                    "sleep 3 & printf '%s\\n' '{\"id\":9,\"result\":null}'; exit 7",
                ),
                sink,
            )
            .await
            .unwrap();

        assert!(matches!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Connected,
                ..
            }
        ));

        let mut received_final_message = false;
        loop {
            match receive_event(&mut events).await {
                ConnectionEvent::ProtocolMessage { json, .. } => {
                    assert_eq!(json, r#"{"id":9,"result":null}"#);
                    received_final_message = true;
                }
                ConnectionEvent::Status {
                    status,
                    reason,
                    exit_code,
                    ..
                } => {
                    assert_eq!(status, ConnectionStatus::Exited);
                    assert_eq!(reason, Some(TerminationReason::ProcessExited));
                    assert_eq!(exit_code, Some(7));
                    break;
                }
            }
        }

        assert!(received_final_message);
        assert!(started_at.elapsed() < Duration::from_secs(2));
        assert_eq!(manager.inner.connection_count(), 0);

        let (replacement_sink, mut replacement_events) = test_sink();
        manager
            .connect(
                "main".to_owned(),
                shell_request("inherited-pipe", "exit 0"),
                replacement_sink,
            )
            .await
            .unwrap();
        assert!(matches!(
            receive_event(&mut replacement_events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Connected,
                ..
            }
        ));
        assert!(matches!(
            receive_event(&mut replacement_events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Exited,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn failed_connected_event_cleans_up_the_connection_reservation() {
        let manager = LocalStdioConnectionManager::default();
        let result = manager
            .connect(
                "main".to_owned(),
                shell_request("failed-event", "while IFS= read -r line; do :; done"),
                Arc::new(RejectStatusSink),
            )
            .await;

        assert_eq!(result.unwrap_err(), CommandError::event_delivery_failed());
        assert_eq!(manager.inner.connection_count(), 0);
    }

    #[tokio::test]
    async fn only_the_owner_window_can_send_or_disconnect() {
        let manager = LocalStdioConnectionManager::default();
        let (sink, mut events) = test_sink();
        manager
            .connect(
                "main".to_owned(),
                shell_request("owned", "while IFS= read -r line; do :; done"),
                sink,
            )
            .await
            .unwrap();
        let _ = receive_event(&mut events).await;

        let send_error = manager
            .send(
                "app-other",
                SendLocalStdioMessageRequest {
                    connection_id: "owned".to_owned(),
                    json: "{}".to_owned(),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(send_error, CommandError::not_owned());

        let disconnect_error = manager
            .disconnect(
                "app-other",
                DisconnectLocalStdioRequest {
                    connection_id: "owned".to_owned(),
                },
            )
            .unwrap_err();
        assert_eq!(disconnect_error, CommandError::not_owned());

        manager
            .disconnect(
                "main",
                DisconnectLocalStdioRequest {
                    connection_id: "owned".to_owned(),
                },
            )
            .unwrap();

        assert!(matches!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Disconnected,
                reason: Some(TerminationReason::Requested),
                ..
            }
        ));
    }

    #[tokio::test]
    async fn dropping_the_last_manager_cancels_its_owned_processes() {
        let manager = LocalStdioConnectionManager::default();
        let (sink, mut events) = test_sink();
        manager
            .connect(
                "main".to_owned(),
                shell_request("drop-cleanup", "while IFS= read -r line; do :; done"),
                sink,
            )
            .await
            .unwrap();
        let _ = receive_event(&mut events).await;

        drop(manager);

        assert!(matches!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Disconnected,
                reason: Some(TerminationReason::Requested),
                ..
            }
        ));
    }

    #[tokio::test]
    async fn manager_shutdown_waits_for_supervisors_and_rejects_new_connections() {
        let manager = LocalStdioConnectionManager::default();
        let (sink, mut events) = test_sink();
        manager
            .connect(
                "main".to_owned(),
                shell_request("shutdown", "while IFS= read -r line; do :; done"),
                sink,
            )
            .await
            .unwrap();
        let _ = receive_event(&mut events).await;

        manager.shutdown_all().await;

        assert!(matches!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Disconnected,
                reason: Some(TerminationReason::Requested),
                ..
            }
        ));
        assert_eq!(manager.inner.connection_count(), 0);

        let (sink, _events) = test_sink();
        let error = manager
            .connect(
                "main".to_owned(),
                shell_request("after-shutdown", "exit 0"),
                sink,
            )
            .await
            .unwrap_err();
        assert_eq!(error, CommandError::manager_shutting_down());
    }
}
