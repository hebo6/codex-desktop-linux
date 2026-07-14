const MAX_CONNECTION_ID_LEN: usize = 64;

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub(crate) struct ConnectionId(String);

impl ConnectionId {
    pub(crate) fn parse(value: String) -> Result<Self, InvalidConnectionId> {
        if value.is_empty() || value.len() > MAX_CONNECTION_ID_LEN {
            return Err(InvalidConnectionId);
        }

        let bytes = value.as_bytes();
        let is_alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        let has_valid_boundaries = bytes.first().is_some_and(|byte| is_alphanumeric(*byte))
            && bytes.last().is_some_and(|byte| is_alphanumeric(*byte));
        let contains_only_allowed_characters = bytes
            .iter()
            .all(|byte| is_alphanumeric(*byte) || *byte == b'-');

        if !has_valid_boundaries || !contains_only_allowed_characters {
            return Err(InvalidConnectionId);
        }

        Ok(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn into_string(self) -> String {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct InvalidConnectionId;

#[cfg(test)]
mod tests {
    use super::ConnectionId;

    #[test]
    fn accepts_slug_and_uuid_connection_ids() {
        for value in [
            "local",
            "server-01",
            "550e8400-e29b-41d4-a716-446655440000",
            "a234567890123456789012345678901234567890123456789012345678901234",
        ] {
            let connection_id =
                ConnectionId::parse(value.to_owned()).expect("connection ID should be valid");
            assert_eq!(connection_id.as_str(), value);
        }
    }

    #[test]
    fn rejects_unsafe_connection_ids() {
        for value in [
            "",
            "UPPER",
            "-leading",
            "trailing-",
            "contains space",
            "contains/slash",
            "a2345678901234567890123456789012345678901234567890123456789012345",
        ] {
            assert!(ConnectionId::parse(value.to_owned()).is_err());
        }
    }
}
