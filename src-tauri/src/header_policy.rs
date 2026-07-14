pub(crate) fn is_reserved_websocket_header(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "connection" | "content-length" | "host" | "transfer-encoding" | "upgrade"
    ) || normalized.starts_with("sec-websocket-")
        || normalized.starts_with("proxy-")
}

pub(crate) fn is_reserved_http_connect_header(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "authorization"
            | "connection"
            | "content-length"
            | "host"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    ) || normalized.starts_with("sec-websocket-")
}

#[cfg(test)]
mod tests {
    use super::{is_reserved_http_connect_header, is_reserved_websocket_header};

    #[test]
    fn websocket_policy_rejects_managed_header_families() {
        for name in [
            "Host",
            "Sec-WebSocket-Foo",
            "Proxy-Foo",
            "Transfer-Encoding",
        ] {
            assert!(is_reserved_websocket_header(name), "{name}");
        }
        assert!(!is_reserved_websocket_header("X-Trace-Mode"));
    }

    #[test]
    fn http_connect_policy_rejects_managed_headers() {
        for name in [
            "Host",
            "Proxy-Authenticate",
            "Proxy-Authorization",
            "Sec-WebSocket-Foo",
            "TE",
            "Trailer",
        ] {
            assert!(is_reserved_http_connect_header(name), "{name}");
        }
        assert!(!is_reserved_http_connect_header("Proxy-Foo"));
        assert!(!is_reserved_http_connect_header("X-Trace-Mode"));
    }
}
