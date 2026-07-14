use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::ipc::Channel;
use tokio::sync::watch;
use uuid::Uuid;

use crate::configuration::{ProxyId, ServerId};

use super::{
    connection_id::ConnectionId, lifecycle::ConnectionLifecycle, local_stdio, remote_websocket,
};

pub(super) const PHYSICAL_CONNECTION_OWNER: &str = "configured-connection-pool";
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PRE_CANCELLED_CONNECTIONS_PER_WINDOW: usize = 64;
const MAX_PRE_CANCELLED_CONNECTIONS: usize = 1_024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConfiguredTransport {
    LocalStdio,
    RemoteWebSocket,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConfiguredConnectionPath {
    LocalStdio,
    Direct,
    HttpConnect,
    Socks5,
    SshDirectTcpip,
}

impl ConfiguredConnectionPath {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::LocalStdio => "localStdio",
            Self::Direct => "direct",
            Self::HttpConnect => "httpConnect",
            Self::Socks5 => "socks5",
            Self::SshDirectTcpip => "sshDirectTcpip",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "transport",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ConfiguredConnectionEvent {
    LocalStdio {
        server_id: ServerId,
        event: local_stdio::ConnectionEvent,
    },
    RemoteWebSocket {
        server_id: ServerId,
        event: remote_websocket::ConnectionEvent,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct PhysicalConnectionKey {
    server_id: ServerId,
    server_version: u64,
    proxy: Option<(ProxyId, u64)>,
}

impl PhysicalConnectionKey {
    pub(super) const fn new(
        server_id: ServerId,
        server_version: u64,
        proxy: Option<(ProxyId, u64)>,
    ) -> Self {
        Self {
            server_id,
            server_version,
            proxy,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct PhysicalConnectionMetadata {
    pub(super) server_id: ServerId,
    pub(super) server_version: u64,
    pub(super) transport: ConfiguredTransport,
    pub(super) connection_path: ConfiguredConnectionPath,
    pub(super) proxy_id: Option<ProxyId>,
    pub(super) proxy_version: Option<u64>,
}

#[derive(Clone)]
pub(super) struct PhysicalConnectionHandle {
    pub(super) connection_id: ConnectionId,
    pub(super) transport: ConfiguredTransport,
    pub(super) lifecycle: Arc<ConnectionLifecycle>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PhysicalStartState {
    Connecting,
    Connected,
    Failed,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum SharedPoolError {
    AlreadyConnected,
    Cancelled,
    NotFound,
    NotOwned,
    InvalidMessage,
    StartFailed,
    EventDeliveryFailed,
}

#[derive(Clone, Copy)]
struct PhysicalAttachment {
    key: PhysicalConnectionKey,
    generation: u64,
}

struct LogicalConnectionEntry {
    owner_window_label: String,
    generation: u64,
    lifecycle: Arc<ConnectionLifecycle>,
    attachment: Option<PhysicalAttachment>,
}

struct PreCancelledConnection {
    owner_window_label: String,
    connection_id: ConnectionId,
}

enum SharedInitializationState {
    Awaiting,
    InFlight {
        primary_key: String,
        waiters: Vec<(ConnectionId, Value)>,
    },
    Ready {
        result: Value,
        initialized_forwarded: bool,
    },
    Failed,
}

struct PhysicalConnectionEntry {
    generation: u64,
    connection_id: ConnectionId,
    metadata: PhysicalConnectionMetadata,
    lifecycle: Arc<ConnectionLifecycle>,
    start: watch::Sender<PhysicalStartState>,
    connection_stage: Option<remote_websocket::RemoteConnectionStage>,
    subscribers: HashMap<ConnectionId, Channel<ConfiguredConnectionEvent>>,
    idle_token: Option<Uuid>,
    initialization: SharedInitializationState,
    request_routes: HashMap<String, ConnectionId>,
    thread_request_routes: HashMap<String, PendingThreadRequest>,
    thread_subscriptions: HashMap<ConnectionId, HashSet<String>>,
    server_requests: HashMap<String, HashSet<ConnectionId>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConfiguredServerStatusPhase {
    Connecting,
    Ready,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfiguredServerStatus {
    server_id: ServerId,
    phase: ConfiguredServerStatusPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<remote_websocket::RemoteConnectionStage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfiguredServerStatusesEvent {
    statuses: Vec<ConfiguredServerStatus>,
}

struct StatusSubscriber {
    generation: u64,
    events: Channel<ConfiguredServerStatusesEvent>,
}

enum PendingThreadRequest {
    Subscribe,
    Unsubscribe {
        connection_id: ConnectionId,
        thread_id: String,
    },
}

#[derive(Default)]
struct ConfiguredConnectionManagerState {
    logical_connections: HashMap<ConnectionId, LogicalConnectionEntry>,
    physical_connections: HashMap<PhysicalConnectionKey, PhysicalConnectionEntry>,
    pre_cancelled: VecDeque<PreCancelledConnection>,
    status_subscribers: HashMap<String, StatusSubscriber>,
}

impl ConfiguredConnectionManagerState {
    fn take_pre_cancellation(
        &mut self,
        owner_window_label: &str,
        connection_id: &ConnectionId,
    ) -> bool {
        let position = self.pre_cancelled.iter().position(|entry| {
            entry.owner_window_label == owner_window_label && entry.connection_id == *connection_id
        });
        position
            .and_then(|position| self.pre_cancelled.remove(position))
            .is_some()
    }

    fn record_pre_cancellation(&mut self, owner_window_label: &str, connection_id: &ConnectionId) {
        if self.pre_cancelled.iter().any(|entry| {
            entry.owner_window_label == owner_window_label && entry.connection_id == *connection_id
        }) {
            return;
        }
        let owner_count = self
            .pre_cancelled
            .iter()
            .filter(|entry| entry.owner_window_label == owner_window_label)
            .count();
        if owner_count >= MAX_PRE_CANCELLED_CONNECTIONS_PER_WINDOW
            && let Some(position) = self
                .pre_cancelled
                .iter()
                .position(|entry| entry.owner_window_label == owner_window_label)
        {
            self.pre_cancelled.remove(position);
        }
        if self.pre_cancelled.len() >= MAX_PRE_CANCELLED_CONNECTIONS {
            self.pre_cancelled.pop_front();
        }
        self.pre_cancelled.push_back(PreCancelledConnection {
            owner_window_label: owner_window_label.to_owned(),
            connection_id: connection_id.clone(),
        });
    }
}

#[derive(Default)]
struct ConfiguredConnectionManagerInner {
    state: Mutex<ConfiguredConnectionManagerState>,
    next_logical_generation: AtomicU64,
    next_physical_generation: AtomicU64,
    next_status_subscriber_generation: AtomicU64,
}

impl ConfiguredConnectionManagerInner {
    fn state(&self) -> MutexGuard<'_, ConfiguredConnectionManagerState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn notify_status_subscribers(&self) {
        let (event, subscribers) = {
            let state = self.state();
            let event = configured_server_statuses(&state);
            let subscribers = state
                .status_subscribers
                .iter()
                .map(|(window_label, subscriber)| {
                    (
                        window_label.clone(),
                        subscriber.generation,
                        subscriber.events.clone(),
                    )
                })
                .collect::<Vec<_>>();
            (event, subscribers)
        };
        let failed = subscribers
            .into_iter()
            .filter_map(|(window_label, generation, events)| {
                events
                    .send(event.clone())
                    .is_err()
                    .then_some((window_label, generation))
            })
            .collect::<Vec<_>>();
        if failed.is_empty() {
            return;
        }
        let mut state = self.state();
        for (window_label, generation) in failed {
            if state
                .status_subscribers
                .get(&window_label)
                .is_some_and(|subscriber| subscriber.generation == generation)
            {
                state.status_subscribers.remove(&window_label);
            }
        }
    }

    fn remove_logical_if_generation(
        self: &Arc<Self>,
        connection_id: &ConnectionId,
        generation: u64,
    ) {
        let idle = {
            let mut state = self.state();
            let should_remove = state
                .logical_connections
                .get(connection_id)
                .is_some_and(|entry| entry.generation == generation);
            if !should_remove {
                return;
            }
            let entry = state
                .logical_connections
                .remove(connection_id)
                .expect("checked logical connection must exist");
            entry.lifecycle.cancel();
            detach_subscriber(&mut state, connection_id, entry.attachment)
        };
        if let Some(idle) = idle {
            self.schedule_idle(idle);
        }
        self.notify_status_subscribers();
    }

    fn schedule_idle(self: &Arc<Self>, idle: IdleExpiry) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(IDLE_TIMEOUT).await;
            manager.expire_idle(idle);
        });
    }

    fn expire_idle(&self, idle: IdleExpiry) {
        let lifecycle = {
            let mut state = self.state();
            let should_expire = state
                .physical_connections
                .get(&idle.key)
                .is_some_and(|entry| {
                    entry.generation == idle.generation
                        && entry.idle_token == Some(idle.token)
                        && entry.subscribers.is_empty()
                        && *entry.start.borrow() == PhysicalStartState::Connected
                });
            should_expire
                .then(|| state.physical_connections.remove(&idle.key))
                .flatten()
                .map(|entry| entry.lifecycle)
        };
        if let Some(lifecycle) = lifecycle {
            lifecycle.cancel();
            self.notify_status_subscribers();
        }
    }

    fn fail_start(&self, key: PhysicalConnectionKey, generation: u64) {
        let entry = {
            let mut state = self.state();
            let matches = state
                .physical_connections
                .get(&key)
                .is_some_and(|entry| entry.generation == generation);
            let entry = matches
                .then(|| state.physical_connections.remove(&key))
                .flatten();
            if let Some(entry) = &entry {
                for logical in state.logical_connections.values() {
                    if logical.attachment.is_some_and(|attachment| {
                        attachment.key == key && attachment.generation == generation
                    }) {
                        logical.lifecycle.cancel();
                    }
                }
                state.logical_connections.retain(|_, logical| {
                    logical.attachment.is_none_or(|attachment| {
                        attachment.key != key || attachment.generation != generation
                    })
                });
                entry.start.send_replace(PhysicalStartState::Failed);
            }
            entry
        };
        if let Some(entry) = entry {
            entry.lifecycle.cancel();
            self.notify_status_subscribers();
        }
    }

    fn handle_local_event(
        self: &Arc<Self>,
        key: PhysicalConnectionKey,
        generation: u64,
        event: local_stdio::ConnectionEvent,
    ) {
        match event {
            local_stdio::ConnectionEvent::ProtocolMessage { json, .. } => {
                self.route_protocol_message(key, generation, json, ConfiguredTransport::LocalStdio);
            }
            local_stdio::ConnectionEvent::Status {
                status,
                reason,
                exit_code,
                signal,
                stderr_bytes,
                forced,
                ..
            } => {
                let terminal = status != local_stdio::ConnectionStatus::Connected;
                let targets = if terminal {
                    self.take_terminal_subscribers(key, generation)
                } else {
                    self.mark_connected_and_subscribers(key, generation)
                };
                self.notify_status_subscribers();
                deliver_events(
                    self,
                    targets.into_iter().map(|(id, channel, server_id)| {
                        (
                            id.clone(),
                            channel,
                            ConfiguredConnectionEvent::LocalStdio {
                                server_id,
                                event: local_stdio::ConnectionEvent::Status {
                                    connection_id: id.into_string(),
                                    status,
                                    reason,
                                    exit_code,
                                    signal,
                                    stderr_bytes,
                                    forced,
                                },
                            },
                        )
                    }),
                );
            }
        }
    }

    fn handle_remote_event(
        self: &Arc<Self>,
        key: PhysicalConnectionKey,
        generation: u64,
        event: remote_websocket::ConnectionEvent,
    ) {
        match event {
            remote_websocket::ConnectionEvent::Progress { stage, .. } => {
                let targets = self.mark_progress_and_subscribers(key, generation, stage);
                self.notify_status_subscribers();
                deliver_events(
                    self,
                    targets.into_iter().map(|(id, channel, server_id)| {
                        (
                            id.clone(),
                            channel,
                            ConfiguredConnectionEvent::RemoteWebSocket {
                                server_id,
                                event: remote_websocket::ConnectionEvent::Progress {
                                    connection_id: id.into_string(),
                                    stage,
                                },
                            },
                        )
                    }),
                );
            }
            remote_websocket::ConnectionEvent::ProtocolMessage { json, .. } => {
                self.route_protocol_message(
                    key,
                    generation,
                    json,
                    ConfiguredTransport::RemoteWebSocket,
                );
            }
            remote_websocket::ConnectionEvent::Status {
                status,
                reason,
                close_code,
                forced,
                ..
            } => {
                let terminal = status != remote_websocket::ConnectionStatus::Connected;
                let targets = if terminal {
                    self.take_terminal_subscribers(key, generation)
                } else {
                    self.mark_connected_and_subscribers(key, generation)
                };
                self.notify_status_subscribers();
                deliver_events(
                    self,
                    targets.into_iter().map(|(id, channel, server_id)| {
                        (
                            id.clone(),
                            channel,
                            ConfiguredConnectionEvent::RemoteWebSocket {
                                server_id,
                                event: remote_websocket::ConnectionEvent::Status {
                                    connection_id: id.into_string(),
                                    status,
                                    reason,
                                    close_code,
                                    forced,
                                },
                            },
                        )
                    }),
                );
            }
        }
    }

    fn mark_progress_and_subscribers(
        &self,
        key: PhysicalConnectionKey,
        generation: u64,
        stage: remote_websocket::RemoteConnectionStage,
    ) -> Vec<(ConnectionId, Channel<ConfiguredConnectionEvent>, ServerId)> {
        let mut state = self.state();
        let Some(entry) = state.physical_connections.get_mut(&key) else {
            return Vec::new();
        };
        if entry.generation != generation
            || entry.metadata.transport != ConfiguredTransport::RemoteWebSocket
            || *entry.start.borrow() != PhysicalStartState::Connecting
        {
            return Vec::new();
        }
        entry.connection_stage = Some(stage);
        entry
            .subscribers
            .iter()
            .map(|(id, channel)| (id.clone(), channel.clone(), entry.metadata.server_id))
            .collect()
    }

    fn mark_connected_and_subscribers(
        &self,
        key: PhysicalConnectionKey,
        generation: u64,
    ) -> Vec<(ConnectionId, Channel<ConfiguredConnectionEvent>, ServerId)> {
        let mut state = self.state();
        let Some(entry) = state.physical_connections.get_mut(&key) else {
            return Vec::new();
        };
        if entry.generation != generation {
            return Vec::new();
        }
        entry.start.send_replace(PhysicalStartState::Connected);
        entry
            .subscribers
            .iter()
            .map(|(id, channel)| (id.clone(), channel.clone(), entry.metadata.server_id))
            .collect()
    }

    fn take_terminal_subscribers(
        &self,
        key: PhysicalConnectionKey,
        generation: u64,
    ) -> Vec<(ConnectionId, Channel<ConfiguredConnectionEvent>, ServerId)> {
        let mut state = self.state();
        let matches = state
            .physical_connections
            .get(&key)
            .is_some_and(|entry| entry.generation == generation);
        let Some(entry) = matches
            .then(|| state.physical_connections.remove(&key))
            .flatten()
        else {
            return Vec::new();
        };
        entry.start.send_replace(PhysicalStartState::Failed);
        entry.lifecycle.cancel();
        for logical in state.logical_connections.values() {
            if logical.attachment.is_some_and(|attachment| {
                attachment.key == key && attachment.generation == generation
            }) {
                logical.lifecycle.cancel();
            }
        }
        state.logical_connections.retain(|_, logical| {
            logical.attachment.is_none_or(|attachment| {
                attachment.key != key || attachment.generation != generation
            })
        });
        entry
            .subscribers
            .into_iter()
            .map(|(id, channel)| (id, channel, entry.metadata.server_id))
            .collect()
    }

    fn route_protocol_message(
        self: &Arc<Self>,
        key: PhysicalConnectionKey,
        generation: u64,
        json: String,
        transport: ConfiguredTransport,
    ) {
        let deliveries = {
            let mut state = self.state();
            let Some(entry) = state.physical_connections.get_mut(&key) else {
                return;
            };
            if entry.generation != generation || entry.metadata.transport != transport {
                return;
            }
            route_inbound(entry, json)
        };
        deliver_events(self, deliveries);
    }

    fn remove_failed_subscribers(self: &Arc<Self>, failed: Vec<ConnectionId>) {
        for connection_id in failed {
            let generation = self
                .state()
                .logical_connections
                .get(&connection_id)
                .map(|entry| entry.generation);
            if let Some(generation) = generation {
                self.remove_logical_if_generation(&connection_id, generation);
            }
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct ConfiguredConnectionManager {
    inner: Arc<ConfiguredConnectionManagerInner>,
}

impl ConfiguredConnectionManager {
    pub(super) fn subscribe_statuses(
        &self,
        owner_window_label: String,
        events: Channel<ConfiguredServerStatusesEvent>,
    ) -> Result<u64, SharedPoolError> {
        let generation = self
            .inner
            .next_status_subscriber_generation
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_add(1);
        let initial = {
            let mut state = self.inner.state();
            state.status_subscribers.insert(
                owner_window_label.clone(),
                StatusSubscriber {
                    generation,
                    events: events.clone(),
                },
            );
            configured_server_statuses(&state)
        };
        if events.send(initial).is_ok() {
            return Ok(generation);
        }
        let mut state = self.inner.state();
        if state
            .status_subscribers
            .get(&owner_window_label)
            .is_some_and(|subscriber| subscriber.generation == generation)
        {
            state.status_subscribers.remove(&owner_window_label);
        }
        Err(SharedPoolError::EventDeliveryFailed)
    }

    pub(super) fn unsubscribe_statuses(&self, owner_window_label: &str, generation: u64) {
        let mut state = self.inner.state();
        if state
            .status_subscribers
            .get(owner_window_label)
            .is_some_and(|subscriber| subscriber.generation == generation)
        {
            state.status_subscribers.remove(owner_window_label);
        }
    }

    pub(super) fn reserve(
        &self,
        owner_window_label: String,
        connection_id: ConnectionId,
    ) -> Result<LogicalConnectionReservation, SharedPoolError> {
        let generation = self
            .inner
            .next_logical_generation
            .fetch_add(1, Ordering::Relaxed);
        let mut state = self.inner.state();
        if state.logical_connections.contains_key(&connection_id) {
            return Err(SharedPoolError::AlreadyConnected);
        }
        if state.take_pre_cancellation(&owner_window_label, &connection_id) {
            return Err(SharedPoolError::Cancelled);
        }
        let lifecycle = Arc::new(ConnectionLifecycle::default());
        state.logical_connections.insert(
            connection_id.clone(),
            LogicalConnectionEntry {
                owner_window_label,
                generation,
                lifecycle: Arc::clone(&lifecycle),
                attachment: None,
            },
        );
        drop(state);
        Ok(LogicalConnectionReservation {
            manager: Arc::clone(&self.inner),
            connection_id,
            generation,
            lifecycle,
            committed: false,
        })
    }

    pub(super) fn attach(
        &self,
        reservation: &mut LogicalConnectionReservation,
        key: PhysicalConnectionKey,
        metadata: PhysicalConnectionMetadata,
        events: Channel<ConfiguredConnectionEvent>,
    ) -> Result<SharedConnectionAttachment, SharedPoolError> {
        let mut replay_event = None;
        let attachment = {
            let mut state = self.inner.state();
            let logical = state
                .logical_connections
                .get(&reservation.connection_id)
                .filter(|entry| entry.generation == reservation.generation)
                .ok_or(SharedPoolError::Cancelled)?;
            if logical.lifecycle.cancellation().is_cancelled() {
                return Err(SharedPoolError::Cancelled);
            }

            if let Some(physical) = state.physical_connections.get_mut(&key) {
                if physical.metadata != metadata
                    || *physical.start.borrow() == PhysicalStartState::Failed
                    || matches!(physical.initialization, SharedInitializationState::Failed)
                {
                    return Err(SharedPoolError::StartFailed);
                }
                physical.idle_token = None;
                physical
                    .subscribers
                    .insert(reservation.connection_id.clone(), events.clone());
                let physical_generation = physical.generation;
                let physical_handle = PhysicalConnectionHandle {
                    connection_id: physical.connection_id.clone(),
                    transport: physical.metadata.transport,
                    lifecycle: Arc::clone(&physical.lifecycle),
                };
                let start = physical.start.subscribe();
                let physical_metadata = physical.metadata;
                let connected = *physical.start.borrow() == PhysicalStartState::Connected;
                let connection_stage = physical.connection_stage;
                let physical_attachment = PhysicalAttachment {
                    key,
                    generation: physical_generation,
                };
                state
                    .logical_connections
                    .get_mut(&reservation.connection_id)
                    .expect("reserved logical connection must remain present")
                    .attachment = Some(physical_attachment);
                if connected {
                    replay_event = Some(configured_connected_event(
                        physical_metadata,
                        &reservation.connection_id,
                    ));
                } else if let Some(stage) = connection_stage {
                    replay_event = Some(configured_progress_event(
                        physical_metadata,
                        &reservation.connection_id,
                        stage,
                    ));
                }
                SharedConnectionAttachment {
                    created: false,
                    key,
                    generation: physical_generation,
                    physical: physical_handle,
                    start,
                    metadata: physical_metadata,
                }
            } else {
                let generation = self
                    .inner
                    .next_physical_generation
                    .fetch_add(1, Ordering::Relaxed);
                let physical_id = ConnectionId::parse(format!("pool-{}", Uuid::new_v4()))
                    .expect("generated physical connection ID must satisfy the internal contract");
                let lifecycle = Arc::new(ConnectionLifecycle::default());
                let (start, receiver) = watch::channel(PhysicalStartState::Connecting);
                let mut subscribers = HashMap::new();
                subscribers.insert(reservation.connection_id.clone(), events.clone());
                state.physical_connections.insert(
                    key,
                    PhysicalConnectionEntry {
                        generation,
                        connection_id: physical_id.clone(),
                        metadata,
                        lifecycle: Arc::clone(&lifecycle),
                        start,
                        connection_stage: None,
                        subscribers,
                        idle_token: None,
                        initialization: SharedInitializationState::Awaiting,
                        request_routes: HashMap::new(),
                        thread_request_routes: HashMap::new(),
                        thread_subscriptions: HashMap::new(),
                        server_requests: HashMap::new(),
                    },
                );
                state
                    .logical_connections
                    .get_mut(&reservation.connection_id)
                    .expect("reserved logical connection must remain present")
                    .attachment = Some(PhysicalAttachment { key, generation });
                SharedConnectionAttachment {
                    created: true,
                    key,
                    generation,
                    physical: PhysicalConnectionHandle {
                        connection_id: physical_id,
                        transport: metadata.transport,
                        lifecycle,
                    },
                    start: receiver,
                    metadata,
                }
            }
        };

        self.inner.notify_status_subscribers();

        if let Some(event) = replay_event
            && events.send(event).is_err()
        {
            self.inner
                .remove_logical_if_generation(&reservation.connection_id, reservation.generation);
            return Err(SharedPoolError::EventDeliveryFailed);
        }
        Ok(attachment)
    }

    pub(super) fn fail_start(&self, key: PhysicalConnectionKey, generation: u64) {
        self.inner.fail_start(key, generation);
    }

    pub(super) fn cancel_connection(&self, owner_window_label: &str, connection_id: &ConnectionId) {
        let generation = {
            let mut state = self.inner.state();
            match state.logical_connections.get(connection_id) {
                Some(entry) if entry.owner_window_label == owner_window_label => {
                    entry.lifecycle.cancel();
                    Some(entry.generation)
                }
                Some(_) => None,
                None => {
                    state.record_pre_cancellation(owner_window_label, connection_id);
                    None
                }
            }
        };
        if let Some(generation) = generation {
            self.inner
                .remove_logical_if_generation(connection_id, generation);
        }
    }

    pub(super) fn release(
        &self,
        owner_window_label: &str,
        connection_id: &ConnectionId,
    ) -> Result<(), SharedPoolError> {
        let generation = {
            let state = self.inner.state();
            let entry = state
                .logical_connections
                .get(connection_id)
                .ok_or(SharedPoolError::NotFound)?;
            if entry.owner_window_label != owner_window_label {
                return Err(SharedPoolError::NotOwned);
            }
            entry.lifecycle.cancel();
            entry.generation
        };
        self.inner
            .remove_logical_if_generation(connection_id, generation);
        Ok(())
    }

    pub(crate) fn disconnect_window(&self, owner_window_label: &str) {
        let connections = {
            let mut state = self.inner.state();
            state.status_subscribers.remove(owner_window_label);
            state
                .pre_cancelled
                .retain(|entry| entry.owner_window_label != owner_window_label);
            state
                .logical_connections
                .iter()
                .filter(|(_, entry)| entry.owner_window_label == owner_window_label)
                .map(|(connection_id, entry)| {
                    entry.lifecycle.cancel();
                    (connection_id.clone(), entry.generation)
                })
                .collect::<Vec<_>>()
        };
        for (connection_id, generation) in connections {
            self.inner
                .remove_logical_if_generation(&connection_id, generation);
        }
    }

    pub(super) fn prepare_outbound(
        &self,
        owner_window_label: &str,
        connection_id: &ConnectionId,
        json: &str,
    ) -> Result<OutboundDisposition, SharedPoolError> {
        let value: Value =
            serde_json::from_str(json).map_err(|_| SharedPoolError::InvalidMessage)?;
        let object = value.as_object().ok_or(SharedPoolError::InvalidMessage)?;
        let mut synthetic = None;
        let disposition = {
            let mut state = self.inner.state();
            let logical = state
                .logical_connections
                .get(connection_id)
                .ok_or(SharedPoolError::NotFound)?;
            if logical.owner_window_label != owner_window_label {
                return Err(SharedPoolError::NotOwned);
            }
            let logical_generation = logical.generation;
            let attachment = logical.attachment.ok_or(SharedPoolError::StartFailed)?;
            let physical = state
                .physical_connections
                .get_mut(&attachment.key)
                .filter(|entry| entry.generation == attachment.generation)
                .ok_or(SharedPoolError::StartFailed)?;
            if *physical.start.borrow() != PhysicalStartState::Connected {
                return Err(SharedPoolError::StartFailed);
            }
            let action = prepare_outbound_for_physical(physical, connection_id, object)?;
            match action {
                MultiplexedOutbound::Forward => {
                    OutboundDisposition::Forward(PhysicalConnectionHandle {
                        connection_id: physical.connection_id.clone(),
                        transport: physical.metadata.transport,
                        lifecycle: Arc::clone(&physical.lifecycle),
                    })
                }
                MultiplexedOutbound::Suppress => OutboundDisposition::Suppress,
                MultiplexedOutbound::Synthetic(response) => {
                    let channel = physical
                        .subscribers
                        .get(connection_id)
                        .cloned()
                        .ok_or(SharedPoolError::NotFound)?;
                    synthetic = Some((
                        channel,
                        configured_protocol_event(physical.metadata, connection_id, response),
                        logical_generation,
                    ));
                    OutboundDisposition::Suppress
                }
            }
        };
        if let Some((channel, event, generation)) = synthetic
            && channel.send(event).is_err()
        {
            self.inner
                .remove_logical_if_generation(connection_id, generation);
            return Err(SharedPoolError::EventDeliveryFailed);
        }
        Ok(disposition)
    }

    pub(super) fn local_event_sink(
        &self,
        attachment: &SharedConnectionAttachment,
    ) -> Arc<dyn local_stdio::EventSink> {
        Arc::new(SharedLocalEventSink {
            manager: Arc::clone(&self.inner),
            key: attachment.key,
            generation: attachment.generation,
        })
    }

    pub(super) fn remote_event_sink(
        &self,
        attachment: &SharedConnectionAttachment,
    ) -> Arc<dyn remote_websocket::EventSink> {
        Arc::new(SharedRemoteEventSink {
            manager: Arc::clone(&self.inner),
            key: attachment.key,
            generation: attachment.generation,
        })
    }
}

pub(super) struct LogicalConnectionReservation {
    manager: Arc<ConfiguredConnectionManagerInner>,
    connection_id: ConnectionId,
    generation: u64,
    lifecycle: Arc<ConnectionLifecycle>,
    committed: bool,
}

impl LogicalConnectionReservation {
    pub(super) fn lifecycle(&self) -> &Arc<ConnectionLifecycle> {
        &self.lifecycle
    }

    pub(super) fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for LogicalConnectionReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.manager
                .remove_logical_if_generation(&self.connection_id, self.generation);
        }
    }
}

pub(super) struct SharedConnectionAttachment {
    created: bool,
    pub(super) key: PhysicalConnectionKey,
    pub(super) generation: u64,
    pub(super) physical: PhysicalConnectionHandle,
    start: watch::Receiver<PhysicalStartState>,
    pub(super) metadata: PhysicalConnectionMetadata,
}

impl SharedConnectionAttachment {
    pub(super) const fn created(&self) -> bool {
        self.created
    }

    pub(super) async fn wait_until_connected(
        &mut self,
        lifecycle: &ConnectionLifecycle,
    ) -> Result<(), SharedPoolError> {
        loop {
            match *self.start.borrow() {
                PhysicalStartState::Connected => return Ok(()),
                PhysicalStartState::Failed => return Err(SharedPoolError::StartFailed),
                PhysicalStartState::Connecting => {}
            }
            tokio::select! {
                biased;
                _ = lifecycle.cancellation().cancelled() => return Err(SharedPoolError::Cancelled),
                changed = self.start.changed() => {
                    if changed.is_err() {
                        return Err(SharedPoolError::StartFailed);
                    }
                }
            }
        }
    }
}

pub(super) enum OutboundDisposition {
    Forward(PhysicalConnectionHandle),
    Suppress,
}

#[derive(Clone, Copy)]
struct IdleExpiry {
    key: PhysicalConnectionKey,
    generation: u64,
    token: Uuid,
}

fn configured_server_statuses(
    state: &ConfiguredConnectionManagerState,
) -> ConfiguredServerStatusesEvent {
    let mut by_server = HashMap::<ServerId, ConfiguredServerStatus>::new();
    for physical in state.physical_connections.values() {
        let (phase, stage) = match *physical.start.borrow() {
            PhysicalStartState::Connecting => (
                ConfiguredServerStatusPhase::Connecting,
                physical.connection_stage,
            ),
            PhysicalStartState::Connected => (ConfiguredServerStatusPhase::Ready, None),
            PhysicalStartState::Failed => continue,
        };
        let status = ConfiguredServerStatus {
            server_id: physical.metadata.server_id,
            phase,
            stage,
        };
        by_server
            .entry(status.server_id)
            .and_modify(|current| {
                if status.phase == ConfiguredServerStatusPhase::Ready
                    || (current.phase == ConfiguredServerStatusPhase::Connecting
                        && current.stage.is_none())
                {
                    *current = status;
                }
            })
            .or_insert(status);
    }
    let mut statuses = by_server.into_values().collect::<Vec<_>>();
    statuses.sort_by_key(|status| status.server_id.to_persisted_string());
    ConfiguredServerStatusesEvent { statuses }
}

fn detach_subscriber(
    state: &mut ConfiguredConnectionManagerState,
    connection_id: &ConnectionId,
    attachment: Option<PhysicalAttachment>,
) -> Option<IdleExpiry> {
    let attachment = attachment?;
    let physical = state.physical_connections.get_mut(&attachment.key)?;
    if physical.generation != attachment.generation {
        return None;
    }
    physical.subscribers.remove(connection_id);
    physical
        .request_routes
        .retain(|_, owner| owner != connection_id);
    physical
        .thread_request_routes
        .retain(|request_id, _| physical.request_routes.contains_key(request_id));
    physical.thread_subscriptions.remove(connection_id);
    for responders in physical.server_requests.values_mut() {
        responders.remove(connection_id);
    }
    physical
        .server_requests
        .retain(|_, responders| !responders.is_empty());
    if !physical.subscribers.is_empty() {
        return None;
    }
    if *physical.start.borrow() == PhysicalStartState::Connecting {
        let physical = state.physical_connections.remove(&attachment.key)?;
        physical.start.send_replace(PhysicalStartState::Failed);
        physical.lifecycle.cancel();
        return None;
    }
    let token = Uuid::new_v4();
    physical.idle_token = Some(token);
    Some(IdleExpiry {
        key: attachment.key,
        generation: attachment.generation,
        token,
    })
}

enum MultiplexedOutbound {
    Forward,
    Suppress,
    Synthetic(String),
}

fn prepare_outbound_for_physical(
    physical: &mut PhysicalConnectionEntry,
    connection_id: &ConnectionId,
    object: &Map<String, Value>,
) -> Result<MultiplexedOutbound, SharedPoolError> {
    let method = object.get("method").and_then(Value::as_str);
    let id = object.get("id");
    if method == Some("initialize") {
        let id = id.cloned().ok_or(SharedPoolError::InvalidMessage)?;
        let id_key = rpc_id_key(&id).ok_or(SharedPoolError::InvalidMessage)?;
        return match &mut physical.initialization {
            SharedInitializationState::Awaiting => {
                physical
                    .request_routes
                    .insert(id_key.clone(), connection_id.clone());
                physical.initialization = SharedInitializationState::InFlight {
                    primary_key: id_key,
                    waiters: Vec::new(),
                };
                Ok(MultiplexedOutbound::Forward)
            }
            SharedInitializationState::InFlight { waiters, .. } => {
                waiters.push((connection_id.clone(), id));
                Ok(MultiplexedOutbound::Suppress)
            }
            SharedInitializationState::Ready { result, .. } => Ok(MultiplexedOutbound::Synthetic(
                response_json(id, "result", result.clone())?,
            )),
            SharedInitializationState::Failed => Err(SharedPoolError::StartFailed),
        };
    }

    if method == Some("initialized") && id.is_none() {
        return match &mut physical.initialization {
            SharedInitializationState::Ready {
                initialized_forwarded,
                ..
            } if !*initialized_forwarded => {
                *initialized_forwarded = true;
                Ok(MultiplexedOutbound::Forward)
            }
            SharedInitializationState::Ready { .. } => Ok(MultiplexedOutbound::Suppress),
            _ => Err(SharedPoolError::InvalidMessage),
        };
    }

    if !matches!(
        physical.initialization,
        SharedInitializationState::Ready { .. }
    ) {
        return Err(SharedPoolError::InvalidMessage);
    }

    if method.is_some() {
        if let Some(id) = id {
            let id_key = rpc_id_key(id).ok_or(SharedPoolError::InvalidMessage)?;
            if method == Some("thread/unsubscribe") {
                let thread_id = object
                    .get("params")
                    .and_then(Value::as_object)
                    .and_then(|params| params.get("threadId"))
                    .and_then(Value::as_str)
                    .ok_or(SharedPoolError::InvalidMessage)?;
                let is_subscribed = physical
                    .thread_subscriptions
                    .get(connection_id)
                    .is_some_and(|threads| threads.contains(thread_id));
                if !is_subscribed {
                    return Ok(MultiplexedOutbound::Synthetic(response_json(
                        id.clone(),
                        "result",
                        serde_json::json!({ "status": "notSubscribed" }),
                    )?));
                }
                if let Some(threads) = physical.thread_subscriptions.get_mut(connection_id) {
                    threads.remove(thread_id);
                    if threads.is_empty() {
                        physical.thread_subscriptions.remove(connection_id);
                    }
                }
                let remaining_subscribers = physical
                    .thread_subscriptions
                    .values()
                    .filter(|threads| threads.contains(thread_id))
                    .count();
                if remaining_subscribers > 0 {
                    return Ok(MultiplexedOutbound::Synthetic(response_json(
                        id.clone(),
                        "result",
                        serde_json::json!({ "status": "unsubscribed" }),
                    )?));
                }
                physical.thread_request_routes.insert(
                    id_key.clone(),
                    PendingThreadRequest::Unsubscribe {
                        connection_id: connection_id.clone(),
                        thread_id: thread_id.to_owned(),
                    },
                );
            } else if matches!(
                method,
                Some("thread/start" | "thread/resume" | "thread/fork" | "thread/rollback")
            ) {
                physical
                    .thread_request_routes
                    .insert(id_key.clone(), PendingThreadRequest::Subscribe);
            }
            if physical
                .request_routes
                .insert(id_key, connection_id.clone())
                .is_some()
            {
                return Err(SharedPoolError::InvalidMessage);
            }
        }
        return Ok(MultiplexedOutbound::Forward);
    }

    if let Some(id) = id {
        let id_key = rpc_id_key(id).ok_or(SharedPoolError::InvalidMessage)?;
        let Some(responders) = physical.server_requests.get_mut(&id_key) else {
            return Ok(MultiplexedOutbound::Suppress);
        };
        if !responders.remove(connection_id) {
            return Ok(MultiplexedOutbound::Suppress);
        }
        physical.server_requests.remove(&id_key);
        return Ok(MultiplexedOutbound::Forward);
    }

    Err(SharedPoolError::InvalidMessage)
}

fn route_inbound(
    physical: &mut PhysicalConnectionEntry,
    json: String,
) -> Vec<(
    ConnectionId,
    Channel<ConfiguredConnectionEvent>,
    ConfiguredConnectionEvent,
)> {
    let Ok(value) = serde_json::from_str::<Value>(&json) else {
        return broadcast_protocol(physical, json);
    };
    let Some(object) = value.as_object() else {
        return broadcast_protocol(physical, json);
    };
    let method = object.get("method").and_then(Value::as_str);
    let id = object.get("id");
    if method.is_some() {
        let targets = protocol_targets(physical, method, object);
        if let Some(id) = id.and_then(rpc_id_key) {
            physical
                .server_requests
                .insert(id, targets.iter().cloned().collect());
        }
        return deliver_protocol_to_targets(physical, targets, json);
    }

    let Some(id_value) = id.cloned() else {
        return broadcast_protocol(physical, json);
    };
    let Some(id_key) = rpc_id_key(&id_value) else {
        return broadcast_protocol(physical, json);
    };

    let initialization = std::mem::replace(
        &mut physical.initialization,
        SharedInitializationState::Failed,
    );
    if let SharedInitializationState::InFlight {
        primary_key,
        waiters,
    } = initialization
    {
        if primary_key == id_key {
            let response_field = if let Some(result) = object.get("result") {
                physical.initialization = SharedInitializationState::Ready {
                    result: result.clone(),
                    initialized_forwarded: false,
                };
                Some(("result", result.clone()))
            } else if let Some(error) = object.get("error") {
                physical.initialization = SharedInitializationState::Failed;
                physical.lifecycle.cancel();
                Some(("error", error.clone()))
            } else {
                physical.initialization = SharedInitializationState::Failed;
                physical.lifecycle.cancel();
                None
            };
            let mut deliveries = deliver_protocol_to(physical, &id_key, json);
            if let Some((field, body)) = response_field {
                for (connection_id, waiter_id) in waiters {
                    if let Ok(response) = response_json(waiter_id, field, body.clone())
                        && let Some(channel) = physical.subscribers.get(&connection_id)
                    {
                        deliveries.push((
                            connection_id.clone(),
                            channel.clone(),
                            configured_protocol_event(physical.metadata, &connection_id, response),
                        ));
                    }
                }
            }
            return deliveries;
        }
        physical.initialization = SharedInitializationState::InFlight {
            primary_key,
            waiters,
        };
    } else {
        physical.initialization = initialization;
    }

    apply_thread_request_response(physical, &id_key, object);
    deliver_protocol_to(physical, &id_key, json)
}

fn apply_thread_request_response(
    physical: &mut PhysicalConnectionEntry,
    id_key: &str,
    object: &Map<String, Value>,
) {
    let Some(request) = physical.thread_request_routes.remove(id_key) else {
        return;
    };
    let Some(connection_id) = physical.request_routes.get(id_key).cloned() else {
        return;
    };
    match request {
        PendingThreadRequest::Subscribe => {
            let Some(thread_id) = object
                .get("result")
                .and_then(Value::as_object)
                .and_then(|result| result.get("thread"))
                .and_then(Value::as_object)
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
            else {
                return;
            };
            physical
                .thread_subscriptions
                .entry(connection_id)
                .or_default()
                .insert(thread_id.to_owned());
        }
        PendingThreadRequest::Unsubscribe {
            connection_id,
            thread_id,
        } => {
            if object.get("error").is_some() {
                physical
                    .thread_subscriptions
                    .entry(connection_id)
                    .or_default()
                    .insert(thread_id);
            }
        }
    }
}

fn protocol_targets(
    physical: &PhysicalConnectionEntry,
    method: Option<&str>,
    object: &Map<String, Value>,
) -> Vec<ConnectionId> {
    let thread_id = object
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("threadId"))
        .and_then(Value::as_str);
    if thread_id.is_none() || method.is_some_and(is_global_thread_notification) {
        return physical.subscribers.keys().cloned().collect();
    }
    let thread_id = thread_id.expect("thread id was checked");
    physical
        .subscribers
        .keys()
        .filter(|connection_id| {
            physical
                .thread_subscriptions
                .get(*connection_id)
                .is_some_and(|threads| threads.contains(thread_id))
        })
        .cloned()
        .collect()
}

fn is_global_thread_notification(method: &str) -> bool {
    matches!(
        method,
        "thread/started"
            | "thread/status/changed"
            | "thread/archived"
            | "thread/deleted"
            | "thread/unarchived"
            | "thread/closed"
            | "thread/name/updated"
    )
}

fn deliver_protocol_to_targets(
    physical: &PhysicalConnectionEntry,
    targets: Vec<ConnectionId>,
    json: String,
) -> Vec<(
    ConnectionId,
    Channel<ConfiguredConnectionEvent>,
    ConfiguredConnectionEvent,
)> {
    targets
        .into_iter()
        .filter_map(|connection_id| {
            let channel = physical.subscribers.get(&connection_id)?;
            Some((
                connection_id.clone(),
                channel.clone(),
                configured_protocol_event(physical.metadata, &connection_id, json.clone()),
            ))
        })
        .collect()
}

fn deliver_protocol_to(
    physical: &mut PhysicalConnectionEntry,
    id_key: &str,
    json: String,
) -> Vec<(
    ConnectionId,
    Channel<ConfiguredConnectionEvent>,
    ConfiguredConnectionEvent,
)> {
    let Some(connection_id) = physical.request_routes.remove(id_key) else {
        return Vec::new();
    };
    let Some(channel) = physical.subscribers.get(&connection_id) else {
        return Vec::new();
    };
    vec![(
        connection_id.clone(),
        channel.clone(),
        configured_protocol_event(physical.metadata, &connection_id, json),
    )]
}

fn broadcast_protocol(
    physical: &PhysicalConnectionEntry,
    json: String,
) -> Vec<(
    ConnectionId,
    Channel<ConfiguredConnectionEvent>,
    ConfiguredConnectionEvent,
)> {
    physical
        .subscribers
        .iter()
        .map(|(connection_id, channel)| {
            (
                connection_id.clone(),
                channel.clone(),
                configured_protocol_event(physical.metadata, connection_id, json.clone()),
            )
        })
        .collect()
}

fn configured_connected_event(
    metadata: PhysicalConnectionMetadata,
    connection_id: &ConnectionId,
) -> ConfiguredConnectionEvent {
    match metadata.transport {
        ConfiguredTransport::LocalStdio => ConfiguredConnectionEvent::LocalStdio {
            server_id: metadata.server_id,
            event: local_stdio::ConnectionEvent::Status {
                connection_id: connection_id.as_str().to_owned(),
                status: local_stdio::ConnectionStatus::Connected,
                reason: None,
                exit_code: None,
                signal: None,
                stderr_bytes: 0,
                forced: false,
            },
        },
        ConfiguredTransport::RemoteWebSocket => ConfiguredConnectionEvent::RemoteWebSocket {
            server_id: metadata.server_id,
            event: remote_websocket::ConnectionEvent::Status {
                connection_id: connection_id.as_str().to_owned(),
                status: remote_websocket::ConnectionStatus::Connected,
                reason: None,
                close_code: None,
                forced: false,
            },
        },
    }
}

fn configured_progress_event(
    metadata: PhysicalConnectionMetadata,
    connection_id: &ConnectionId,
    stage: remote_websocket::RemoteConnectionStage,
) -> ConfiguredConnectionEvent {
    ConfiguredConnectionEvent::RemoteWebSocket {
        server_id: metadata.server_id,
        event: remote_websocket::ConnectionEvent::Progress {
            connection_id: connection_id.as_str().to_owned(),
            stage,
        },
    }
}

fn configured_protocol_event(
    metadata: PhysicalConnectionMetadata,
    connection_id: &ConnectionId,
    json: String,
) -> ConfiguredConnectionEvent {
    match metadata.transport {
        ConfiguredTransport::LocalStdio => ConfiguredConnectionEvent::LocalStdio {
            server_id: metadata.server_id,
            event: local_stdio::ConnectionEvent::ProtocolMessage {
                connection_id: connection_id.as_str().to_owned(),
                json,
            },
        },
        ConfiguredTransport::RemoteWebSocket => ConfiguredConnectionEvent::RemoteWebSocket {
            server_id: metadata.server_id,
            event: remote_websocket::ConnectionEvent::ProtocolMessage {
                connection_id: connection_id.as_str().to_owned(),
                json,
            },
        },
    }
}

fn deliver_events<I>(manager: &Arc<ConfiguredConnectionManagerInner>, deliveries: I)
where
    I: IntoIterator<
        Item = (
            ConnectionId,
            Channel<ConfiguredConnectionEvent>,
            ConfiguredConnectionEvent,
        ),
    >,
{
    let failed = deliveries
        .into_iter()
        .filter_map(|(connection_id, channel, event)| {
            channel.send(event).is_err().then_some(connection_id)
        })
        .collect::<Vec<_>>();
    manager.remove_failed_subscribers(failed);
}

fn rpc_id_key(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(format!("s:{value}")),
        Value::Number(value) => Some(format!("n:{value}")),
        _ => None,
    }
}

fn response_json(id: Value, field: &str, body: Value) -> Result<String, SharedPoolError> {
    let mut response = Map::new();
    response.insert("id".to_owned(), id);
    response.insert(field.to_owned(), body);
    serde_json::to_string(&Value::Object(response)).map_err(|_| SharedPoolError::InvalidMessage)
}

struct SharedLocalEventSink {
    manager: Arc<ConfiguredConnectionManagerInner>,
    key: PhysicalConnectionKey,
    generation: u64,
}

impl local_stdio::EventSink for SharedLocalEventSink {
    fn emit(&self, event: local_stdio::ConnectionEvent) -> Result<(), ()> {
        self.manager
            .handle_local_event(self.key, self.generation, event);
        Ok(())
    }
}

struct SharedRemoteEventSink {
    manager: Arc<ConfiguredConnectionManagerInner>,
    key: PhysicalConnectionKey,
    generation: u64,
}

impl remote_websocket::EventSink for SharedRemoteEventSink {
    fn emit(&self, event: remote_websocket::ConnectionEvent) -> Result<(), ()> {
        self.manager
            .handle_remote_event(self.key, self.generation, event);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::{Value, json};
    use tauri::ipc::{Channel, InvokeResponseBody};

    use super::{
        ConfiguredConnectionEvent, ConfiguredConnectionManager, ConfiguredConnectionPath,
        ConfiguredServerStatusesEvent, ConfiguredTransport, IdleExpiry, OutboundDisposition,
        PhysicalConnectionKey, PhysicalConnectionMetadata, PhysicalStartState, SharedPoolError,
    };
    use crate::{
        configuration::{ProxyId, ServerId},
        connection::{connection_id::ConnectionId, local_stdio, remote_websocket},
    };

    fn server_id() -> ServerId {
        serde_json::from_value(json!("11111111-1111-4111-8111-111111111111")).unwrap()
    }

    fn proxy_id() -> ProxyId {
        serde_json::from_value(json!("22222222-2222-4222-8222-222222222222")).unwrap()
    }

    fn connection_id(value: &str) -> ConnectionId {
        ConnectionId::parse(value.to_owned()).unwrap()
    }

    fn local_identity() -> (PhysicalConnectionKey, PhysicalConnectionMetadata) {
        let server_id = server_id();
        (
            PhysicalConnectionKey::new(server_id, 3, None),
            PhysicalConnectionMetadata {
                server_id,
                server_version: 3,
                transport: ConfiguredTransport::LocalStdio,
                connection_path: ConfiguredConnectionPath::LocalStdio,
                proxy_id: None,
                proxy_version: None,
            },
        )
    }

    fn remote_identity() -> (PhysicalConnectionKey, PhysicalConnectionMetadata) {
        let server_id = server_id();
        let proxy_id = proxy_id();
        (
            PhysicalConnectionKey::new(server_id, 5, Some((proxy_id, 7))),
            PhysicalConnectionMetadata {
                server_id,
                server_version: 5,
                transport: ConfiguredTransport::RemoteWebSocket,
                connection_path: ConfiguredConnectionPath::Socks5,
                proxy_id: Some(proxy_id),
                proxy_version: Some(7),
            },
        )
    }

    fn recording_channel() -> (Channel<ConfiguredConnectionEvent>, Arc<Mutex<Vec<Value>>>) {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&messages);
        let channel = Channel::new(move |body| {
            let InvokeResponseBody::Json(json) = body else {
                panic!("configured connection events must be JSON");
            };
            captured
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(serde_json::from_str(&json).unwrap());
            Ok(())
        });
        (channel, messages)
    }

    fn recording_status_channel() -> (
        Channel<ConfiguredServerStatusesEvent>,
        Arc<Mutex<Vec<Value>>>,
    ) {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&messages);
        let channel = Channel::new(move |body| {
            let InvokeResponseBody::Json(json) = body else {
                panic!("configured server statuses must be JSON");
            };
            captured
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(serde_json::from_str(&json).unwrap());
            Ok(())
        });
        (channel, messages)
    }

    fn clear(messages: &Arc<Mutex<Vec<Value>>>) {
        messages
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    fn protocol_messages(messages: &Arc<Mutex<Vec<Value>>>) -> Vec<Value> {
        messages
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter_map(|event| event["event"]["json"].as_str())
            .map(|json| serde_json::from_str(json).unwrap())
            .collect()
    }

    fn mark_local_connected(
        manager: &ConfiguredConnectionManager,
        key: PhysicalConnectionKey,
        generation: u64,
        physical_id: &ConnectionId,
    ) {
        manager.inner.handle_local_event(
            key,
            generation,
            local_stdio::ConnectionEvent::Status {
                connection_id: physical_id.as_str().to_owned(),
                status: local_stdio::ConnectionStatus::Connected,
                reason: None,
                exit_code: None,
                signal: None,
                stderr_bytes: 0,
                forced: false,
            },
        );
    }

    fn mark_initialized(manager: &ConfiguredConnectionManager, key: PhysicalConnectionKey) {
        manager
            .inner
            .state()
            .physical_connections
            .get_mut(&key)
            .unwrap()
            .initialization = super::SharedInitializationState::Ready {
            result: json!({"capabilities": {}}),
            initialized_forwarded: true,
        };
    }

    #[test]
    fn status_subscriber_receives_full_sanitized_physical_connection_snapshots() {
        let manager = ConfiguredConnectionManager::default();
        let (status_events, status_messages) = recording_status_channel();
        manager
            .subscribe_statuses("observer".to_owned(), status_events)
            .unwrap();
        assert_eq!(
            status_messages
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_slice(),
            &[json!({"statuses": []})]
        );

        let (key, metadata) = remote_identity();
        let (events, _) = recording_channel();
        let logical_id = connection_id("logical-status");
        let mut reservation = manager
            .reserve("main".to_owned(), logical_id.clone())
            .unwrap();
        let attachment = manager
            .attach(&mut reservation, key, metadata, events)
            .unwrap();
        reservation.commit();
        manager.inner.handle_remote_event(
            key,
            attachment.generation,
            remote_websocket::ConnectionEvent::Progress {
                connection_id: attachment.physical.connection_id.as_str().to_owned(),
                stage: remote_websocket::RemoteConnectionStage::EstablishingTunnel,
            },
        );
        manager.inner.handle_remote_event(
            key,
            attachment.generation,
            remote_websocket::ConnectionEvent::Status {
                connection_id: attachment.physical.connection_id.as_str().to_owned(),
                status: remote_websocket::ConnectionStatus::Connected,
                reason: None,
                close_code: None,
                forced: false,
            },
        );

        let messages = status_messages
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert_eq!(
            messages.last(),
            Some(&json!({
                "statuses": [{
                    "serverId": "11111111-1111-4111-8111-111111111111",
                    "phase": "ready"
                }]
            }))
        );
        assert!(messages.iter().any(|message| message
            == &json!({
                "statuses": [{
                    "serverId": "11111111-1111-4111-8111-111111111111",
                    "phase": "connecting",
                    "stage": "establishingTunnel"
                }]
            })));

        manager.unsubscribe_statuses("observer", 1);
        assert!(manager.inner.state().status_subscribers.is_empty());
    }

    #[tokio::test]
    async fn same_identity_reuses_one_physical_connection_until_idle_expiry() {
        let manager = ConfiguredConnectionManager::default();
        let (key, metadata) = local_identity();
        let (first_events, _) = recording_channel();
        let first_id = connection_id("logical-first");
        let mut first = manager
            .reserve("main".to_owned(), first_id.clone())
            .unwrap();
        let first_attachment = manager
            .attach(&mut first, key, metadata, first_events)
            .unwrap();
        assert!(first_attachment.created());
        mark_local_connected(
            &manager,
            key,
            first_attachment.generation,
            &first_attachment.physical.connection_id,
        );
        first.commit();

        let (second_events, second_messages) = recording_channel();
        let second_id = connection_id("logical-second");
        let mut second = manager
            .reserve("other".to_owned(), second_id.clone())
            .unwrap();
        let second_attachment = manager
            .attach(&mut second, key, metadata, second_events)
            .unwrap();
        assert!(!second_attachment.created());
        assert_eq!(
            second_attachment.physical.connection_id,
            first_attachment.physical.connection_id
        );
        assert_eq!(
            second_messages
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .len(),
            1
        );
        second.commit();

        manager.release("main", &first_id).unwrap();
        assert!(
            !first_attachment
                .physical
                .lifecycle
                .cancellation()
                .is_cancelled()
        );
        assert_eq!(
            manager
                .inner
                .state()
                .physical_connections
                .get(&key)
                .unwrap()
                .subscribers
                .len(),
            1
        );

        manager.release("other", &second_id).unwrap();
        let idle = {
            let state = manager.inner.state();
            let physical = state.physical_connections.get(&key).unwrap();
            assert!(physical.subscribers.is_empty());
            IdleExpiry {
                key,
                generation: physical.generation,
                token: physical.idle_token.unwrap(),
            }
        };
        assert!(
            !first_attachment
                .physical
                .lifecycle
                .cancellation()
                .is_cancelled()
        );

        manager.inner.expire_idle(idle);

        assert!(
            first_attachment
                .physical
                .lifecycle
                .cancellation()
                .is_cancelled()
        );
        assert!(manager.inner.state().physical_connections.is_empty());
    }

    #[test]
    fn remote_progress_is_broadcast_and_replayed_to_late_subscribers() {
        let manager = ConfiguredConnectionManager::default();
        let (key, metadata) = remote_identity();
        let (first_events, first_messages) = recording_channel();
        let first_id = connection_id("logical-first");
        let mut first = manager
            .reserve("main".to_owned(), first_id.clone())
            .unwrap();
        let first_attachment = manager
            .attach(&mut first, key, metadata, first_events)
            .unwrap();

        manager.inner.handle_remote_event(
            key,
            first_attachment.generation,
            remote_websocket::ConnectionEvent::Progress {
                connection_id: first_attachment.physical.connection_id.as_str().to_owned(),
                stage: remote_websocket::RemoteConnectionStage::ConnectingProxy,
            },
        );
        assert_eq!(
            first_messages.lock().unwrap()[0]["event"],
            json!({
                "kind": "progress",
                "connectionId": "logical-first",
                "stage": "connectingProxy"
            })
        );

        let (second_events, second_messages) = recording_channel();
        let second_id = connection_id("logical-second");
        let mut second = manager.reserve("other".to_owned(), second_id).unwrap();
        let second_attachment = manager
            .attach(&mut second, key, metadata, second_events)
            .unwrap();
        assert!(!second_attachment.created());
        assert_eq!(
            second_messages.lock().unwrap()[0]["event"],
            json!({
                "kind": "progress",
                "connectionId": "logical-second",
                "stage": "connectingProxy"
            })
        );
    }

    #[tokio::test]
    async fn reattach_invalidates_previous_idle_expiry() {
        let manager = ConfiguredConnectionManager::default();
        let (key, metadata) = local_identity();
        let (events, _) = recording_channel();
        let first_id = connection_id("first-idle-owner");
        let mut first = manager
            .reserve("main".to_owned(), first_id.clone())
            .unwrap();
        let first_attachment = manager.attach(&mut first, key, metadata, events).unwrap();
        mark_local_connected(
            &manager,
            key,
            first_attachment.generation,
            &first_attachment.physical.connection_id,
        );
        first.commit();
        manager.release("main", &first_id).unwrap();
        let stale_idle = {
            let state = manager.inner.state();
            let physical = state.physical_connections.get(&key).unwrap();
            IdleExpiry {
                key,
                generation: physical.generation,
                token: physical.idle_token.unwrap(),
            }
        };

        let (replacement_events, _) = recording_channel();
        let replacement_id = connection_id("replacement-owner");
        let mut replacement = manager.reserve("other".to_owned(), replacement_id).unwrap();
        let replacement_attachment = manager
            .attach(&mut replacement, key, metadata, replacement_events)
            .unwrap();
        replacement.commit();

        manager.inner.expire_idle(stale_idle);

        assert!(!replacement_attachment.created());
        assert!(
            manager
                .inner
                .state()
                .physical_connections
                .contains_key(&key)
        );
        assert!(
            !replacement_attachment
                .physical
                .lifecycle
                .cancellation()
                .is_cancelled()
        );
    }

    #[test]
    fn dropping_only_subscriber_cancels_a_connecting_physical_connection() {
        let manager = ConfiguredConnectionManager::default();
        let (key, metadata) = remote_identity();
        let (events, _) = recording_channel();
        let mut reservation = manager
            .reserve("main".to_owned(), connection_id("pending-owner"))
            .unwrap();
        let attachment = manager
            .attach(&mut reservation, key, metadata, events)
            .unwrap();

        drop(reservation);

        assert!(attachment.physical.lifecycle.cancellation().is_cancelled());
        assert!(manager.inner.state().physical_connections.is_empty());
    }

    #[test]
    fn initialization_is_forwarded_once_and_replayed_per_logical_session() {
        let manager = ConfiguredConnectionManager::default();
        let (key, metadata) = local_identity();
        let (first_events, first_messages) = recording_channel();
        let first_id = connection_id("session-one");
        let mut first = manager
            .reserve("main".to_owned(), first_id.clone())
            .unwrap();
        let first_attachment = manager
            .attach(&mut first, key, metadata, first_events)
            .unwrap();
        mark_local_connected(
            &manager,
            key,
            first_attachment.generation,
            &first_attachment.physical.connection_id,
        );
        first.commit();

        let (second_events, second_messages) = recording_channel();
        let second_id = connection_id("session-two");
        let mut second = manager
            .reserve("other".to_owned(), second_id.clone())
            .unwrap();
        manager
            .attach(&mut second, key, metadata, second_events)
            .unwrap();
        second.commit();
        clear(&first_messages);
        clear(&second_messages);

        assert!(matches!(
            manager.prepare_outbound(
                "main",
                &first_id,
                r#"{"id":"rpc:first:1:0","method":"thread/list","params":{}}"#,
            ),
            Err(SharedPoolError::InvalidMessage)
        ));

        assert!(matches!(
            manager
                .prepare_outbound(
                    "main",
                    &first_id,
                    r#"{"id":"rpc:first:1:1","method":"initialize","params":{}}"#,
                )
                .unwrap(),
            OutboundDisposition::Forward(_)
        ));
        assert!(matches!(
            manager
                .prepare_outbound(
                    "other",
                    &second_id,
                    r#"{"id":"rpc:second:1:1","method":"initialize","params":{}}"#,
                )
                .unwrap(),
            OutboundDisposition::Suppress
        ));

        manager.inner.handle_local_event(
            key,
            first_attachment.generation,
            local_stdio::ConnectionEvent::ProtocolMessage {
                connection_id: first_attachment.physical.connection_id.as_str().to_owned(),
                json: r#"{"id":"rpc:first:1:1","result":{"capabilities":{"alpha":true}}}"#
                    .to_owned(),
            },
        );

        assert_eq!(
            protocol_messages(&first_messages),
            vec![json!({
                "id": "rpc:first:1:1",
                "result": { "capabilities": { "alpha": true } }
            })]
        );
        assert_eq!(
            protocol_messages(&second_messages),
            vec![json!({
                "id": "rpc:second:1:1",
                "result": { "capabilities": { "alpha": true } }
            })]
        );
        assert!(matches!(
            manager
                .prepare_outbound("main", &first_id, r#"{"method":"initialized"}"#)
                .unwrap(),
            OutboundDisposition::Forward(_)
        ));
        assert!(matches!(
            manager
                .prepare_outbound("other", &second_id, r#"{"method":"initialized"}"#)
                .unwrap(),
            OutboundDisposition::Suppress
        ));

        let (third_events, third_messages) = recording_channel();
        let third_id = connection_id("session-three");
        let mut third = manager
            .reserve("third".to_owned(), third_id.clone())
            .unwrap();
        manager
            .attach(&mut third, key, metadata, third_events)
            .unwrap();
        third.commit();
        clear(&third_messages);
        assert!(matches!(
            manager
                .prepare_outbound(
                    "third",
                    &third_id,
                    r#"{"id":"rpc:third:1:1","method":"initialize","params":{}}"#,
                )
                .unwrap(),
            OutboundDisposition::Suppress
        ));
        assert_eq!(
            protocol_messages(&third_messages),
            vec![json!({
                "id": "rpc:third:1:1",
                "result": { "capabilities": { "alpha": true } }
            })]
        );
    }

    #[test]
    fn routes_client_responses_and_broadcasts_server_messages() {
        let manager = ConfiguredConnectionManager::default();
        let (key, metadata) = local_identity();
        let (first_events, first_messages) = recording_channel();
        let first_id = connection_id("routing-one");
        let mut first = manager
            .reserve("main".to_owned(), first_id.clone())
            .unwrap();
        let first_attachment = manager
            .attach(&mut first, key, metadata, first_events)
            .unwrap();
        mark_local_connected(
            &manager,
            key,
            first_attachment.generation,
            &first_attachment.physical.connection_id,
        );
        first.commit();
        let (second_events, second_messages) = recording_channel();
        let second_id = connection_id("routing-two");
        let mut second = manager
            .reserve("other".to_owned(), second_id.clone())
            .unwrap();
        manager
            .attach(&mut second, key, metadata, second_events)
            .unwrap();
        second.commit();
        mark_initialized(&manager, key);

        manager
            .prepare_outbound(
                "main",
                &first_id,
                r#"{"id":"rpc:first:2:1","method":"thread/list","params":{}}"#,
            )
            .unwrap();
        manager
            .prepare_outbound(
                "other",
                &second_id,
                r#"{"id":"rpc:second:2:1","method":"thread/list","params":{}}"#,
            )
            .unwrap();
        clear(&first_messages);
        clear(&second_messages);
        manager.inner.handle_local_event(
            key,
            first_attachment.generation,
            local_stdio::ConnectionEvent::ProtocolMessage {
                connection_id: first_attachment.physical.connection_id.as_str().to_owned(),
                json: r#"{"id":"rpc:second:2:1","result":{"data":[]}}"#.to_owned(),
            },
        );
        assert!(protocol_messages(&first_messages).is_empty());
        assert_eq!(
            protocol_messages(&second_messages),
            vec![json!({"id": "rpc:second:2:1", "result": {"data": []}})]
        );

        clear(&first_messages);
        clear(&second_messages);
        manager.inner.handle_local_event(
            key,
            first_attachment.generation,
            local_stdio::ConnectionEvent::ProtocolMessage {
                connection_id: first_attachment.physical.connection_id.as_str().to_owned(),
                json: r#"{"method":"thread/started","params":{"threadId":"thread-1"}}"#.to_owned(),
            },
        );
        assert_eq!(protocol_messages(&first_messages).len(), 1);
        assert_eq!(protocol_messages(&second_messages).len(), 1);

        clear(&first_messages);
        clear(&second_messages);
        manager.inner.handle_local_event(
            key,
            first_attachment.generation,
            local_stdio::ConnectionEvent::ProtocolMessage {
                connection_id: first_attachment.physical.connection_id.as_str().to_owned(),
                json: r#"{"id":"server-request-1","method":"item/commandExecution/requestApproval","params":{}}"#.to_owned(),
            },
        );
        assert_eq!(protocol_messages(&first_messages).len(), 1);
        assert_eq!(protocol_messages(&second_messages).len(), 1);
        assert!(matches!(
            manager
                .prepare_outbound(
                    "main",
                    &first_id,
                    r#"{"id":"server-request-1","result":{"decision":"decline"}}"#,
                )
                .unwrap(),
            OutboundDisposition::Forward(_)
        ));
        assert!(matches!(
            manager
                .prepare_outbound(
                    "other",
                    &second_id,
                    r#"{"id":"server-request-1","result":{"decision":"decline"}}"#,
                )
                .unwrap(),
            OutboundDisposition::Suppress
        ));
    }

    #[test]
    fn routes_thread_activity_and_server_requests_only_to_logical_subscribers() {
        let manager = ConfiguredConnectionManager::default();
        let (key, metadata) = local_identity();
        let (first_events, first_messages) = recording_channel();
        let first_id = connection_id("thread-routing-one");
        let mut first = manager
            .reserve("main".to_owned(), first_id.clone())
            .unwrap();
        let attachment = manager
            .attach(&mut first, key, metadata, first_events)
            .unwrap();
        mark_local_connected(
            &manager,
            key,
            attachment.generation,
            &attachment.physical.connection_id,
        );
        first.commit();
        let (second_events, second_messages) = recording_channel();
        let second_id = connection_id("thread-routing-two");
        let mut second = manager
            .reserve("other".to_owned(), second_id.clone())
            .unwrap();
        manager
            .attach(&mut second, key, metadata, second_events)
            .unwrap();
        second.commit();
        mark_initialized(&manager, key);

        for (window, logical_id, request_id, thread_id) in [
            ("main", &first_id, "resume-first", "thread-1"),
            ("other", &second_id, "resume-second", "thread-2"),
        ] {
            assert!(matches!(
                manager
                    .prepare_outbound(
                        window,
                        logical_id,
                        &format!(
                            r#"{{"id":"{request_id}","method":"thread/resume","params":{{"threadId":"{thread_id}"}}}}"#
                        ),
                    )
                    .unwrap(),
                OutboundDisposition::Forward(_)
            ));
            manager.inner.handle_local_event(
                key,
                attachment.generation,
                local_stdio::ConnectionEvent::ProtocolMessage {
                    connection_id: attachment.physical.connection_id.as_str().to_owned(),
                    json: format!(
                        r#"{{"id":"{request_id}","result":{{"thread":{{"id":"{thread_id}"}}}}}}"#
                    ),
                },
            );
        }
        clear(&first_messages);
        clear(&second_messages);

        manager.inner.handle_local_event(
            key,
            attachment.generation,
            local_stdio::ConnectionEvent::ProtocolMessage {
                connection_id: attachment.physical.connection_id.as_str().to_owned(),
                json: r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":"hello"}}"#.to_owned(),
            },
        );
        assert_eq!(protocol_messages(&first_messages).len(), 1);
        assert!(protocol_messages(&second_messages).is_empty());

        clear(&first_messages);
        manager.inner.handle_local_event(
            key,
            attachment.generation,
            local_stdio::ConnectionEvent::ProtocolMessage {
                connection_id: attachment.physical.connection_id.as_str().to_owned(),
                json: r#"{"method":"thread/status/changed","params":{"threadId":"thread-1","status":{"type":"active"}}}"#.to_owned(),
            },
        );
        assert_eq!(protocol_messages(&first_messages).len(), 1);
        assert_eq!(protocol_messages(&second_messages).len(), 1);

        clear(&first_messages);
        clear(&second_messages);
        manager.inner.handle_local_event(
            key,
            attachment.generation,
            local_stdio::ConnectionEvent::ProtocolMessage {
                connection_id: attachment.physical.connection_id.as_str().to_owned(),
                json: r#"{"id":"approval-1","method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1"}}"#.to_owned(),
            },
        );
        assert_eq!(protocol_messages(&first_messages).len(), 1);
        assert!(protocol_messages(&second_messages).is_empty());
        assert!(matches!(
            manager
                .prepare_outbound(
                    "other",
                    &second_id,
                    r#"{"id":"approval-1","result":{"decision":"decline"}}"#,
                )
                .unwrap(),
            OutboundDisposition::Suppress
        ));
        assert!(matches!(
            manager
                .prepare_outbound(
                    "main",
                    &first_id,
                    r#"{"id":"approval-1","result":{"decision":"decline"}}"#,
                )
                .unwrap(),
            OutboundDisposition::Forward(_)
        ));
    }

    #[test]
    fn virtualizes_thread_unsubscribe_across_logical_subscribers() {
        let manager = ConfiguredConnectionManager::default();
        let (key, metadata) = local_identity();
        let (first_events, first_messages) = recording_channel();
        let first_id = connection_id("unsubscribe-one");
        let mut first = manager
            .reserve("main".to_owned(), first_id.clone())
            .unwrap();
        let attachment = manager
            .attach(&mut first, key, metadata, first_events)
            .unwrap();
        mark_local_connected(
            &manager,
            key,
            attachment.generation,
            &attachment.physical.connection_id,
        );
        first.commit();
        let (second_events, second_messages) = recording_channel();
        let second_id = connection_id("unsubscribe-two");
        let mut second = manager
            .reserve("other".to_owned(), second_id.clone())
            .unwrap();
        manager
            .attach(&mut second, key, metadata, second_events)
            .unwrap();
        second.commit();
        mark_initialized(&manager, key);

        for (window, logical_id, request_id) in [
            ("main", &first_id, "resume-one"),
            ("other", &second_id, "resume-two"),
        ] {
            manager
                .prepare_outbound(
                    window,
                    logical_id,
                    &format!(r#"{{"id":"{request_id}","method":"thread/resume","params":{{"threadId":"thread-shared"}}}}"#),
                )
                .unwrap();
            manager.inner.handle_local_event(
                key,
                attachment.generation,
                local_stdio::ConnectionEvent::ProtocolMessage {
                    connection_id: attachment.physical.connection_id.as_str().to_owned(),
                    json: format!(
                        r#"{{"id":"{request_id}","result":{{"thread":{{"id":"thread-shared"}}}}}}"#
                    ),
                },
            );
        }
        clear(&first_messages);
        clear(&second_messages);

        assert!(matches!(
            manager
                .prepare_outbound(
                    "main",
                    &first_id,
                    r#"{"id":"unsubscribe-first","method":"thread/unsubscribe","params":{"threadId":"thread-shared"}}"#,
                )
                .unwrap(),
            OutboundDisposition::Suppress
        ));
        assert_eq!(
            protocol_messages(&first_messages),
            vec![json!({
                "id": "unsubscribe-first",
                "result": { "status": "unsubscribed" }
            })]
        );
        clear(&first_messages);

        assert!(matches!(
            manager
                .prepare_outbound(
                    "other",
                    &second_id,
                    r#"{"id":"unsubscribe-second","method":"thread/unsubscribe","params":{"threadId":"thread-shared"}}"#,
                )
                .unwrap(),
            OutboundDisposition::Forward(_)
        ));
        manager.inner.handle_local_event(
            key,
            attachment.generation,
            local_stdio::ConnectionEvent::ProtocolMessage {
                connection_id: attachment.physical.connection_id.as_str().to_owned(),
                json: r#"{"id":"unsubscribe-second","error":{"code":-32603,"message":"failed"}}"#
                    .to_owned(),
            },
        );
        clear(&second_messages);
        manager.inner.handle_local_event(
            key,
            attachment.generation,
            local_stdio::ConnectionEvent::ProtocolMessage {
                connection_id: attachment.physical.connection_id.as_str().to_owned(),
                json:
                    r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-shared"}}"#
                        .to_owned(),
            },
        );
        assert!(protocol_messages(&first_messages).is_empty());
        assert_eq!(protocol_messages(&second_messages).len(), 1);
    }

    #[tokio::test]
    async fn window_disconnect_releases_only_owned_logical_connections() {
        let manager = ConfiguredConnectionManager::default();
        let (key, metadata) = local_identity();
        let (main_events, _) = recording_channel();
        let main_id = connection_id("main-window");
        let mut main = manager.reserve("main".to_owned(), main_id.clone()).unwrap();
        let attachment = manager
            .attach(&mut main, key, metadata, main_events)
            .unwrap();
        mark_local_connected(
            &manager,
            key,
            attachment.generation,
            &attachment.physical.connection_id,
        );
        main.commit();
        let (other_events, _) = recording_channel();
        let other_id = connection_id("other-window");
        let mut other = manager
            .reserve("other".to_owned(), other_id.clone())
            .unwrap();
        manager
            .attach(&mut other, key, metadata, other_events)
            .unwrap();
        other.commit();

        assert_eq!(
            manager.release("main", &other_id),
            Err(SharedPoolError::NotOwned)
        );
        manager.disconnect_window("main");

        let state = manager.inner.state();
        assert!(!state.logical_connections.contains_key(&main_id));
        assert!(state.logical_connections.contains_key(&other_id));
        assert_eq!(
            state
                .physical_connections
                .get(&key)
                .unwrap()
                .subscribers
                .len(),
            1
        );
        assert_eq!(*attachment.start.borrow(), PhysicalStartState::Connected);
    }

    #[test]
    fn pre_cancellation_is_consumed_once() {
        let manager = ConfiguredConnectionManager::default();
        let id = connection_id("pre-cancelled");

        manager.cancel_connection("main", &id);

        assert!(matches!(
            manager.reserve("main".to_owned(), id.clone()),
            Err(SharedPoolError::Cancelled)
        ));
        assert!(manager.reserve("main".to_owned(), id).is_ok());
    }
}
