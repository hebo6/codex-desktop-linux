pub(crate) fn looks_sensitive_identifier(name: &str) -> bool {
    let has_sensitive_part = name
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .any(|part| {
            matches!(
                part.to_ascii_lowercase().as_str(),
                "auth"
                    | "authorization"
                    | "cookie"
                    | "credential"
                    | "credentials"
                    | "jwt"
                    | "key"
                    | "pat"
                    | "password"
                    | "passwd"
                    | "secret"
                    | "session"
                    | "token"
            )
        });
    if has_sensitive_part {
        return true;
    }

    let compact_name = name
        .bytes()
        .filter(u8::is_ascii_alphanumeric)
        .map(|byte| byte.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let compact_name = String::from_utf8(compact_name)
        .expect("an ASCII-only identifier must always be valid UTF-8");
    [
        "authorization",
        "bearer",
        "cookie",
        "credential",
        "password",
        "passwd",
        "secret",
        "session",
        "token",
    ]
    .iter()
    .any(|marker| compact_name.contains(marker))
        || [
            "apikey",
            "accesskey",
            "privatekey",
            "secretkey",
            "signingkey",
        ]
        .iter()
        .any(|marker| compact_name.contains(marker))
}

pub(crate) fn looks_sensitive_environment_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("SSH_AUTH_SOCK") || looks_sensitive_identifier(name)
}

#[cfg(test)]
mod tests {
    use super::{looks_sensitive_environment_name, looks_sensitive_identifier};

    #[test]
    fn detects_segmented_and_compact_sensitive_identifiers() {
        for name in [
            "X-Auth",
            "Proxy-Authorization",
            "session_cookie",
            "OPENAI_API_KEY",
            "accessKey",
            "GITHUB_PAT",
            "jwt",
        ] {
            assert!(looks_sensitive_identifier(name), "{name}");
        }
        for name in ["Accept-Language", "CODEX_HOME", "MONKEY", "X-Trace-Mode"] {
            assert!(!looks_sensitive_identifier(name), "{name}");
        }
    }

    #[test]
    fn treats_ssh_agent_and_sensitive_identifiers_as_sensitive_environment() {
        assert!(looks_sensitive_environment_name("SSH_AUTH_SOCK"));
        assert!(looks_sensitive_environment_name("SERVICE_PASSWD"));
        assert!(!looks_sensitive_environment_name("RUST_LOG"));
    }
}
