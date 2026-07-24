use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Runtime, State, WebviewWindow, ipc::Channel};

use crate::windows::PROTOCOL_DEBUG_WINDOW_LABEL;

const MAX_RETAINED_ENTRIES: usize = 5_000;
const MAX_RETAINED_BYTES: usize = 32 * 1024 * 1024;
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
const DELIVERY_DELAY: Duration = Duration::from_millis(40);
const REDACTED_VALUE: &str = "[已脱敏]";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProtocolTraceDirection {
    Inbound,
    Outbound,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProtocolTraceScope {
    Configured,
    ConnectionTest,
}

#[derive(Clone, Debug)]
pub(crate) struct ProtocolTraceContext {
    scope: ProtocolTraceScope,
    server_id: Option<String>,
    connection_id: String,
    transport: &'static str,
    connection_path: &'static str,
    window_label: Option<String>,
}

impl ProtocolTraceContext {
    pub(crate) fn configured(
        server_id: String,
        connection_id: String,
        transport: &'static str,
        connection_path: &'static str,
    ) -> Self {
        Self {
            scope: ProtocolTraceScope::Configured,
            server_id: Some(server_id),
            connection_id,
            transport,
            connection_path,
            window_label: None,
        }
    }

    pub(crate) fn connection_test(
        connection_id: String,
        transport: &'static str,
        connection_path: &'static str,
        window_label: String,
    ) -> Self {
        Self {
            scope: ProtocolTraceScope::ConnectionTest,
            server_id: None,
            connection_id,
            transport,
            connection_path,
            window_label: Some(window_label),
        }
    }

    pub(crate) fn with_window_label(&self, window_label: &str) -> Self {
        let mut context = self.clone();
        context.window_label = Some(window_label.to_owned());
        context
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProtocolTraceEntry {
    sequence: u64,
    timestamp_ms: u64,
    direction: ProtocolTraceDirection,
    scope: ProtocolTraceScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_id: Option<String>,
    connection_id: String,
    transport: &'static str,
    connection_path: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    window_label: Option<String>,
    kind: ProtocolMessageKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<f64>,
    payload: String,
    original_bytes: usize,
    truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ProtocolMessageKind {
    Request,
    Response,
    Notification,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProtocolTraceBatch {
    reset: bool,
    entries: Vec<ProtocolTraceEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    oldest_sequence: Option<u64>,
    retained_count: usize,
    retained_bytes: usize,
    evicted_count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UnsubscribeProtocolTraceRequest {
    subscription_id: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProtocolDebugAvailability {
    available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProtocolTraceCommandError {
    code: &'static str,
    message: &'static str,
}

impl ProtocolTraceCommandError {
    const fn unavailable() -> Self {
        Self {
            code: "protocolDebugUnavailable",
            message: "The protocol debugger is only available in debug builds",
        }
    }

    const fn invalid_window() -> Self {
        Self {
            code: "invalidProtocolDebugWindow",
            message: "The command caller is not the protocol debugger window",
        }
    }

    const fn delivery_failed() -> Self {
        Self {
            code: "protocolTraceDeliveryFailed",
            message: "The protocol trace event channel is unavailable",
        }
    }
}

#[derive(Clone)]
struct TraceSubscriber {
    window_label: String,
    generation: u64,
    events: Channel<ProtocolTraceBatch>,
}

struct PendingRequest {
    method: String,
    started_at: Instant,
    window_label: Option<String>,
    sequence: u64,
}

#[derive(Hash, PartialEq, Eq)]
struct PendingRequestKey {
    connection_id: String,
    request_id: String,
    response_direction: TraceDirectionKey,
}

#[derive(Clone, Copy, Hash, PartialEq, Eq)]
enum TraceDirectionKey {
    Inbound,
    Outbound,
}

impl From<ProtocolTraceDirection> for TraceDirectionKey {
    fn from(value: ProtocolTraceDirection) -> Self {
        match value {
            ProtocolTraceDirection::Inbound => Self::Inbound,
            ProtocolTraceDirection::Outbound => Self::Outbound,
        }
    }
}

impl TraceDirectionKey {
    const fn opposite(self) -> Self {
        match self {
            Self::Inbound => Self::Outbound,
            Self::Outbound => Self::Inbound,
        }
    }
}

#[derive(Default)]
struct ProtocolTraceState {
    entries: VecDeque<ProtocolTraceEntry>,
    retained_bytes: usize,
    evicted_count: u64,
    pending_requests: HashMap<PendingRequestKey, PendingRequest>,
    pending_delivery_start: Option<u64>,
    subscriber: Option<TraceSubscriber>,
}

struct ProtocolTraceInner {
    enabled: AtomicBool,
    delivery_scheduled: AtomicBool,
    next_sequence: AtomicU64,
    next_subscription_generation: AtomicU64,
    delivery: Mutex<()>,
    state: Mutex<ProtocolTraceState>,
}

#[derive(Clone)]
pub(crate) struct ProtocolTraceHub {
    inner: Arc<ProtocolTraceInner>,
}

impl Default for ProtocolTraceHub {
    fn default() -> Self {
        Self {
            inner: Arc::new(ProtocolTraceInner {
                enabled: AtomicBool::new(false),
                delivery_scheduled: AtomicBool::new(false),
                next_sequence: AtomicU64::new(1),
                next_subscription_generation: AtomicU64::new(1),
                delivery: Mutex::new(()),
                state: Mutex::new(ProtocolTraceState::default()),
            }),
        }
    }
}

impl ProtocolTraceHub {
    pub(crate) fn is_enabled(&self) -> bool {
        self.inner.enabled.load(Ordering::Acquire)
    }

    pub(crate) fn record(
        &self,
        context: &ProtocolTraceContext,
        direction: ProtocolTraceDirection,
        json: &str,
    ) {
        if !self.is_enabled() {
            return;
        }

        let Some((payload, inspected)) = prepare_payload(json) else {
            return;
        };
        let mut state = self.state();
        if state.subscriber.is_none() {
            return;
        }
        let sequence = self.inner.next_sequence.fetch_add(1, Ordering::Relaxed);
        let timestamp_ms = unix_timestamp_ms();

        let correlation = correlate_message(
            &mut state.pending_requests,
            context,
            direction,
            &inspected,
            sequence,
        );
        let entry = ProtocolTraceEntry {
            sequence,
            timestamp_ms,
            direction,
            scope: context.scope,
            server_id: context.server_id.clone(),
            connection_id: context.connection_id.clone(),
            transport: context.transport,
            connection_path: context.connection_path,
            window_label: correlation
                .window_label
                .or_else(|| context.window_label.clone()),
            kind: inspected.kind,
            method: correlation.method.or(inspected.method),
            request_id: inspected.request_id,
            duration_ms: correlation.duration_ms,
            payload: payload.text,
            original_bytes: json.len(),
            truncated: payload.truncated,
        };
        state.retained_bytes = state.retained_bytes.saturating_add(entry.payload.len());
        state.entries.push_back(entry);
        state.pending_delivery_start.get_or_insert(sequence);
        evict_overflow(&mut state);
        drop(state);
        self.schedule_delivery();
    }

    fn subscribe(
        &self,
        window_label: String,
        events: Channel<ProtocolTraceBatch>,
    ) -> Result<u64, ProtocolTraceCommandError> {
        let generation = self
            .inner
            .next_subscription_generation
            .fetch_add(1, Ordering::Relaxed);
        let initial = ProtocolTraceBatch {
            reset: true,
            entries: Vec::new(),
            oldest_sequence: None,
            retained_count: 0,
            retained_bytes: 0,
            evicted_count: 0,
        };

        let _delivery = self.delivery();
        {
            let mut state = self.state();
            clear_state(&mut state);
            state.subscriber = Some(TraceSubscriber {
                window_label: window_label.clone(),
                generation,
                events: events.clone(),
            });
            self.inner.enabled.store(true, Ordering::Release);
        }
        if events.send(initial).is_err() {
            self.unsubscribe(&window_label, generation);
            return Err(ProtocolTraceCommandError::delivery_failed());
        }
        Ok(generation)
    }

    fn unsubscribe(&self, window_label: &str, generation: u64) {
        let mut state = self.state();
        if state.subscriber.as_ref().is_some_and(|subscriber| {
            subscriber.window_label == window_label && subscriber.generation == generation
        }) {
            state.subscriber = None;
            clear_state(&mut state);
            self.inner.enabled.store(false, Ordering::Release);
        }
    }

    pub(crate) fn disconnect_window(&self, window_label: &str) {
        let mut state = self.state();
        if state
            .subscriber
            .as_ref()
            .is_some_and(|subscriber| subscriber.window_label == window_label)
        {
            state.subscriber = None;
            clear_state(&mut state);
            self.inner.enabled.store(false, Ordering::Release);
        }
    }

    fn clear(&self, window_label: &str) -> Result<(), ProtocolTraceCommandError> {
        let _delivery = self.delivery();
        let (subscriber, batch) = {
            let mut state = self.state();
            let subscriber = state
                .subscriber
                .as_ref()
                .filter(|subscriber| subscriber.window_label == window_label)
                .cloned()
                .ok_or_else(ProtocolTraceCommandError::invalid_window)?;
            clear_state(&mut state);
            let batch = snapshot_batch(&state, true, Vec::new());
            (subscriber, batch)
        };
        if subscriber.events.send(batch).is_err() {
            self.disconnect_window(window_label);
            return Err(ProtocolTraceCommandError::delivery_failed());
        }
        Ok(())
    }

    fn schedule_delivery(&self) {
        if self
            .inner
            .delivery_scheduled
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let hub = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(DELIVERY_DELAY).await;
            hub.flush_delivery();
        });
    }

    fn flush_delivery(&self) {
        let _delivery = self.delivery();
        let delivery = {
            let mut state = self.state();
            self.inner
                .delivery_scheduled
                .store(false, Ordering::Release);
            let subscriber = state.subscriber.clone();
            let pending_start = state.pending_delivery_start.take();
            subscriber
                .zip(pending_start)
                .map(|(subscriber, pending_start)| {
                    let entries = state
                        .entries
                        .iter()
                        .filter(|entry| entry.sequence >= pending_start)
                        .cloned()
                        .collect();
                    let batch = snapshot_batch(&state, false, entries);
                    (subscriber, batch)
                })
        };
        let Some((subscriber, batch)) = delivery else {
            return;
        };
        if batch.entries.is_empty() {
            return;
        }
        if subscriber.events.send(batch).is_err() {
            self.unsubscribe(&subscriber.window_label, subscriber.generation);
        }
    }

    fn state(&self) -> MutexGuard<'_, ProtocolTraceState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn delivery(&self) -> MutexGuard<'_, ()> {
        self.inner
            .delivery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

struct SanitizedPayload {
    text: String,
    truncated: bool,
}

struct InspectedMessage {
    kind: ProtocolMessageKind,
    method: Option<String>,
    request_id: Option<String>,
}

#[derive(Default)]
struct Correlation {
    method: Option<String>,
    duration_ms: Option<f64>,
    window_label: Option<String>,
}

#[cfg(test)]
fn sanitize_payload(json: &str) -> Option<SanitizedPayload> {
    prepare_payload(json).map(|(payload, _)| payload)
}

fn prepare_payload(json: &str) -> Option<(SanitizedPayload, InspectedMessage)> {
    let mut value = serde_json::from_str::<Value>(json).ok()?;
    let inspected = inspect_value(&value);
    redact_sensitive_fields(&mut value);
    let serialized = serde_json::to_string(&value).ok()?;
    if serialized.len() <= MAX_PAYLOAD_BYTES {
        return Some((
            SanitizedPayload {
                text: serialized,
                truncated: false,
            },
            inspected,
        ));
    }
    let mut boundary = MAX_PAYLOAD_BYTES;
    while !serialized.is_char_boundary(boundary) {
        boundary -= 1;
    }
    let mut text = serialized[..boundary].to_owned();
    text.push_str("\n…[内容已截断]");
    Some((
        SanitizedPayload {
            text,
            truncated: true,
        },
        inspected,
    ))
}

fn redact_sensitive_fields(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                redact_sensitive_fields(value);
            }
        }
        Value::Object(fields) => {
            for (name, value) in fields {
                if sensitive_field_name(name) {
                    *value = Value::String(REDACTED_VALUE.to_owned());
                } else {
                    redact_sensitive_fields(value);
                }
            }
        }
        _ => {}
    }
}

fn sensitive_field_name(name: &str) -> bool {
    let normalized = name
        .bytes()
        .filter(u8::is_ascii_alphanumeric)
        .map(|byte| byte.to_ascii_lowercase())
        .collect::<Vec<_>>();
    matches!(
        normalized.as_slice(),
        b"accesstoken"
            | b"refreshtoken"
            | b"idtoken"
            | b"apikey"
            | b"openaiapikey"
            | b"authorization"
            | b"proxyauthorization"
            | b"cookie"
            | b"password"
            | b"secret"
            | b"clientsecret"
            | b"privatekey"
            | b"secretkey"
            | b"signingkey"
            | b"accesskey"
            | b"bearertoken"
            | b"wstoken"
            | b"credential"
            | b"credentials"
            | b"jwt"
            | b"pat"
            | b"token"
    ) || normalized.ends_with(b"token")
        || normalized.ends_with(b"password")
        || normalized.ends_with(b"passwd")
        || normalized.ends_with(b"secret")
        || normalized.ends_with(b"authorization")
        || normalized.ends_with(b"cookie")
        || normalized.ends_with(b"credential")
}

#[cfg(test)]
fn inspect_message(json: &str) -> InspectedMessage {
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return InspectedMessage {
            kind: ProtocolMessageKind::Unknown,
            method: None,
            request_id: None,
        };
    };
    inspect_value(&value)
}

fn inspect_value(value: &Value) -> InspectedMessage {
    let Some(object) = value.as_object() else {
        return InspectedMessage {
            kind: ProtocolMessageKind::Unknown,
            method: None,
            request_id: None,
        };
    };
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let request_id = object.get("id").and_then(rpc_id);
    let kind = if method.is_some() {
        if request_id.is_some() {
            ProtocolMessageKind::Request
        } else {
            ProtocolMessageKind::Notification
        }
    } else if request_id.is_some()
        && (object.contains_key("result") || object.contains_key("error"))
    {
        ProtocolMessageKind::Response
    } else {
        ProtocolMessageKind::Unknown
    };
    InspectedMessage {
        kind,
        method,
        request_id,
    }
}

fn rpc_id(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn correlate_message(
    pending: &mut HashMap<PendingRequestKey, PendingRequest>,
    context: &ProtocolTraceContext,
    direction: ProtocolTraceDirection,
    message: &InspectedMessage,
    sequence: u64,
) -> Correlation {
    let Some(request_id) = &message.request_id else {
        return Correlation::default();
    };
    let direction_key = TraceDirectionKey::from(direction);
    match message.kind {
        ProtocolMessageKind::Request => {
            let Some(method) = &message.method else {
                return Correlation::default();
            };
            pending.insert(
                PendingRequestKey {
                    connection_id: context.connection_id.clone(),
                    request_id: request_id.clone(),
                    response_direction: direction_key.opposite(),
                },
                PendingRequest {
                    method: method.clone(),
                    started_at: Instant::now(),
                    window_label: context.window_label.clone(),
                    sequence,
                },
            );
            Correlation::default()
        }
        ProtocolMessageKind::Response => {
            let key = PendingRequestKey {
                connection_id: context.connection_id.clone(),
                request_id: request_id.clone(),
                response_direction: direction_key,
            };
            let Some(request) = pending.remove(&key) else {
                return Correlation::default();
            };
            Correlation {
                method: Some(request.method),
                duration_ms: Some(request.started_at.elapsed().as_secs_f64() * 1000.0),
                window_label: request.window_label,
            }
        }
        ProtocolMessageKind::Notification | ProtocolMessageKind::Unknown => Correlation::default(),
    }
}

fn evict_overflow(state: &mut ProtocolTraceState) {
    while state.entries.len() > MAX_RETAINED_ENTRIES || state.retained_bytes > MAX_RETAINED_BYTES {
        let Some(entry) = state.entries.pop_front() else {
            break;
        };
        if entry.kind == ProtocolMessageKind::Request {
            if let Some(request_id) = entry.request_id.as_ref() {
                let key = PendingRequestKey {
                    connection_id: entry.connection_id.clone(),
                    request_id: request_id.clone(),
                    response_direction: TraceDirectionKey::from(entry.direction).opposite(),
                };
                if state
                    .pending_requests
                    .get(&key)
                    .is_some_and(|request| request.sequence == entry.sequence)
                {
                    state.pending_requests.remove(&key);
                }
            }
        }
        state.retained_bytes = state.retained_bytes.saturating_sub(entry.payload.len());
        state.evicted_count = state.evicted_count.saturating_add(1);
    }
}

fn clear_state(state: &mut ProtocolTraceState) {
    state.entries.clear();
    state.pending_requests.clear();
    state.pending_delivery_start = None;
    state.retained_bytes = 0;
    state.evicted_count = 0;
}

fn snapshot_batch(
    state: &ProtocolTraceState,
    reset: bool,
    entries: Vec<ProtocolTraceEntry>,
) -> ProtocolTraceBatch {
    ProtocolTraceBatch {
        reset,
        entries,
        oldest_sequence: state.entries.front().map(|entry| entry.sequence),
        retained_count: state.entries.len(),
        retained_bytes: state.retained_bytes,
        evicted_count: state.evicted_count,
    }
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn require_debug_window<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), ProtocolTraceCommandError> {
    if !cfg!(debug_assertions) {
        return Err(ProtocolTraceCommandError::unavailable());
    }
    if window.label() != PROTOCOL_DEBUG_WINDOW_LABEL || window.as_ref().url().is_err() {
        return Err(ProtocolTraceCommandError::invalid_window());
    }
    Ok(())
}

#[tauri::command]
pub(crate) const fn protocol_debug_availability() -> ProtocolDebugAvailability {
    ProtocolDebugAvailability {
        available: cfg!(debug_assertions),
    }
}

#[tauri::command]
pub(crate) fn subscribe_protocol_trace<R: Runtime>(
    window: WebviewWindow<R>,
    hub: State<'_, ProtocolTraceHub>,
    events: Channel<ProtocolTraceBatch>,
) -> Result<u64, ProtocolTraceCommandError> {
    require_debug_window(&window)?;
    hub.subscribe(window.label().to_owned(), events)
}

#[tauri::command]
pub(crate) fn unsubscribe_protocol_trace<R: Runtime>(
    window: WebviewWindow<R>,
    hub: State<'_, ProtocolTraceHub>,
    request: UnsubscribeProtocolTraceRequest,
) -> Result<(), ProtocolTraceCommandError> {
    require_debug_window(&window)?;
    hub.unsubscribe(window.label(), request.subscription_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn clear_protocol_trace<R: Runtime>(
    window: WebviewWindow<R>,
    hub: State<'_, ProtocolTraceHub>,
) -> Result<(), ProtocolTraceCommandError> {
    require_debug_window(&window)?;
    hub.clear(window.label())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::{Value, json};

    use super::{
        MAX_PAYLOAD_BYTES, MAX_RETAINED_ENTRIES, ProtocolMessageKind, ProtocolTraceContext,
        ProtocolTraceDirection, ProtocolTraceEntry, ProtocolTraceScope, ProtocolTraceState,
        REDACTED_VALUE, correlate_message, evict_overflow, inspect_message, sanitize_payload,
    };

    #[test]
    fn redacts_authentication_fields_without_hiding_usage_metrics() {
        let payload = sanitize_payload(
            &json!({
                "accessToken": "access",
                "nested": {
                    "Authorization": "Bearer secret",
                    "client_secret": "client-secret",
                    "Proxy-Authorization": "Basic secret",
                    "token": "capability",
                    "tokenUsage": { "totalTokens": 42 }
                }
            })
            .to_string(),
        )
        .unwrap();
        let value = serde_json::from_str::<Value>(&payload.text).unwrap();

        assert_eq!(value["accessToken"], REDACTED_VALUE);
        assert_eq!(value["nested"]["Authorization"], REDACTED_VALUE);
        assert_eq!(value["nested"]["client_secret"], REDACTED_VALUE);
        assert_eq!(value["nested"]["Proxy-Authorization"], REDACTED_VALUE);
        assert_eq!(value["nested"]["token"], REDACTED_VALUE);
        assert_eq!(value["nested"]["tokenUsage"]["totalTokens"], 42);
        assert!(!payload.truncated);
    }

    #[test]
    fn classifies_all_json_rpc_envelope_shapes() {
        assert_eq!(
            inspect_message(r#"{"id":"1","method":"thread/list","params":{}}"#).kind,
            ProtocolMessageKind::Request
        );
        assert_eq!(
            inspect_message(r#"{"method":"thread/started","params":{}}"#).kind,
            ProtocolMessageKind::Notification
        );
        assert_eq!(
            inspect_message(r#"{"id":"1","result":{}}"#).kind,
            ProtocolMessageKind::Response
        );
    }

    #[test]
    fn truncates_large_payloads_on_a_character_boundary() {
        let payload =
            sanitize_payload(&json!({ "value": "测".repeat(MAX_PAYLOAD_BYTES) }).to_string())
                .unwrap();

        assert!(payload.truncated);
        assert!(payload.text.ends_with("…[内容已截断]"));
        assert!(payload.text.is_char_boundary(payload.text.len()));
    }

    #[test]
    fn evicts_oldest_entries_at_the_retention_limit() {
        let mut state = ProtocolTraceState::default();
        for sequence in 1..=(MAX_RETAINED_ENTRIES as u64 + 1) {
            let entry = ProtocolTraceEntry {
                sequence,
                timestamp_ms: sequence,
                direction: ProtocolTraceDirection::Inbound,
                scope: ProtocolTraceScope::Configured,
                server_id: None,
                connection_id: "connection".to_owned(),
                transport: "localStdio",
                connection_path: "localStdio",
                window_label: None,
                kind: ProtocolMessageKind::Notification,
                method: Some("thread/started".to_owned()),
                request_id: None,
                duration_ms: None,
                payload: "{}".to_owned(),
                original_bytes: 2,
                truncated: false,
            };
            state.retained_bytes += entry.payload.len();
            state.entries.push_back(entry);
        }

        evict_overflow(&mut state);

        assert_eq!(state.entries.len(), MAX_RETAINED_ENTRIES);
        assert_eq!(state.entries.front().map(|entry| entry.sequence), Some(2));
        assert_eq!(state.evicted_count, 1);
    }

    #[test]
    fn correlates_responses_with_request_method_and_origin_window() {
        let context = ProtocolTraceContext::configured(
            "11111111-1111-4111-8111-111111111111".to_owned(),
            "pool-connection".to_owned(),
            "localStdio",
            "localStdio",
        )
        .with_window_label("main");
        let mut pending = HashMap::new();
        let request = inspect_message(r#"{"id":"request-1","method":"thread/list","params":{}}"#);
        correlate_message(
            &mut pending,
            &context,
            ProtocolTraceDirection::Outbound,
            &request,
            1,
        );

        let response = inspect_message(r#"{"id":"request-1","result":{"data":[]}}"#);
        let correlation = correlate_message(
            &mut pending,
            &context,
            ProtocolTraceDirection::Inbound,
            &response,
            2,
        );

        assert_eq!(correlation.method.as_deref(), Some("thread/list"));
        assert_eq!(correlation.window_label.as_deref(), Some("main"));
        assert!(
            correlation
                .duration_ms
                .is_some_and(|duration| duration >= 0.0)
        );
        assert!(pending.is_empty());
    }
}
