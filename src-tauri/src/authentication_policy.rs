pub(crate) fn is_valid_bearer_token(token: &str) -> bool {
    let padding_start = token.find('=').unwrap_or(token.len());
    padding_start > 0
        && token[..padding_start].bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'+' | b'/')
        })
        && token[padding_start..].bytes().all(|byte| byte == b'=')
}

#[cfg(test)]
mod tests {
    use super::is_valid_bearer_token;

    #[test]
    fn accepts_rfc6750_b64token_and_rejects_unsafe_values() {
        for value in ["abc", "abc.def_ghi-~+/", "abc=="] {
            assert!(is_valid_bearer_token(value), "{value}");
        }
        for value in ["", "=", "abc=def", "abc def", "abc\r\nInjected"] {
            assert!(!is_valid_bearer_token(value), "{value:?}");
        }
    }
}
