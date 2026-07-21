use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, str,
};

use serde::{
    Deserialize, Deserializer,
    de::{Error as _, MapAccess, Visitor},
};
use zeroize::Zeroizing;

use crate::{
    authentication_policy::is_valid_bearer_token,
    credentials::{CredentialDescriptor, ProxyCredentialKind, ServerCredentialKind},
};

use super::model::{ProxyId, ServerId};

const MAX_ENVIRONMENT_COUNT: usize = 64;
const MAX_ENVIRONMENT_NAME_BYTES: usize = 128;
const MAX_ENVIRONMENT_VALUE_BYTES: usize = 8 * 1024;
const MAX_HTTP_BASIC_PASSWORD_BYTES: usize = 5_882;
const MAX_BEARER_TOKEN_BYTES: usize = 8_185;
const MAX_SOCKS5_PASSWORD_BYTES: usize = u8::MAX as usize;
const MAX_SSH_SECRET_BYTES: usize = 8 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SetServerCredentialRequest {
    server_id: ServerId,
    expected_version: u64,
    credential: ServerCredentialInput,
    #[serde(default)]
    plaintext_fallback_confirmed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClearServerCredentialRequest {
    server_id: ServerId,
    expected_version: u64,
    credential_type: ServerCredentialType,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ServerConnectionTestCredentialSource {
    None {},
    Provided {
        credential: ServerCredentialInput,
    },
    Stored {
        server_id: ServerId,
        expected_version: u64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ProxyConnectionTestCredentialSource {
    None {},
    Provided {
        credential: ProxyCredentialInput,
    },
    Stored {
        proxy_id: ProxyId,
        expected_version: u64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SetProxyCredentialRequest {
    proxy_id: ProxyId,
    expected_version: u64,
    credential: ProxyCredentialInput,
    #[serde(default)]
    plaintext_fallback_confirmed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClearProxyCredentialRequest {
    proxy_id: ProxyId,
    expected_version: u64,
    credential_type: ProxyCredentialType,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ServerCredentialInput {
    SensitiveEnvironment {
        values: BTreeMap<String, SecretString>,
    },
    BearerToken {
        value: SecretString,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ServerCredentialType {
    SensitiveEnvironment,
    BearerToken,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ProxyCredentialInput {
    HttpBasicPassword { value: SecretString },
    HttpBearerToken { value: SecretString },
    Socks5Password { value: SecretString },
    SshPrivateKeyPassphrase { value: SecretString },
    SshPassword { value: SecretString },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ProxyCredentialType {
    HttpBasicPassword,
    HttpBearerToken,
    Socks5Password,
    SshPrivateKeyPassphrase,
    SshPassword,
}

pub(super) struct ValidatedCredentialWrite {
    pub(super) descriptor: CredentialDescriptor,
    pub(super) expected_version: u64,
    pub(super) plaintext_fallback_confirmed: bool,
    secret: CredentialSecret,
}

impl fmt::Debug for ValidatedCredentialWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ValidatedCredentialWrite")
            .field("descriptor", &self.descriptor)
            .field("expected_version", &self.expected_version)
            .field(
                "plaintext_fallback_confirmed",
                &self.plaintext_fallback_confirmed,
            )
            .field("secret", &"[redacted]")
            .finish()
    }
}

enum CredentialSecret {
    Text(SecretString),
    SensitiveEnvironment(BTreeMap<String, SecretString>),
}

impl ServerCredentialInput {
    pub(crate) const fn kind(&self) -> ServerCredentialKind {
        match self {
            Self::SensitiveEnvironment { .. } => ServerCredentialKind::SensitiveEnvironment,
            Self::BearerToken { .. } => ServerCredentialKind::BearerToken,
        }
    }

    pub(crate) fn resolve(self) -> Result<ResolvedCredential, CredentialValidationError> {
        match self {
            Self::SensitiveEnvironment { values } => {
                validate_sensitive_environment(&values)?;
                let values = values
                    .into_iter()
                    .map(|(name, value)| (SecretText::from_string(name), value.0))
                    .collect();
                Ok(ResolvedCredential::SensitiveEnvironment(
                    SensitiveEnvironment(values),
                ))
            }
            Self::BearerToken { value } => {
                validate_bearer_token(&value)?;
                Ok(ResolvedCredential::BearerToken(value.0))
            }
        }
    }
}

impl ProxyCredentialInput {
    pub(crate) const fn kind(&self) -> ProxyCredentialKind {
        match self {
            Self::HttpBasicPassword { .. } => ProxyCredentialKind::HttpBasicPassword,
            Self::HttpBearerToken { .. } => ProxyCredentialKind::HttpBearerToken,
            Self::Socks5Password { .. } => ProxyCredentialKind::Socks5Password,
            Self::SshPrivateKeyPassphrase { .. } => ProxyCredentialKind::SshPrivateKeyPassphrase,
            Self::SshPassword { .. } => ProxyCredentialKind::SshPassword,
        }
    }

    pub(crate) fn resolve(self) -> Result<ResolvedCredential, CredentialValidationError> {
        match self {
            Self::HttpBasicPassword { value } => {
                validate_text_secret(&value, MAX_HTTP_BASIC_PASSWORD_BYTES)?;
                Ok(ResolvedCredential::HttpBasicPassword(value.0))
            }
            Self::HttpBearerToken { value } => {
                validate_bearer_token(&value)?;
                Ok(ResolvedCredential::HttpBearerToken(value.0))
            }
            Self::Socks5Password { value } => {
                validate_text_secret(&value, MAX_SOCKS5_PASSWORD_BYTES)?;
                Ok(ResolvedCredential::Socks5Password(value.0))
            }
            Self::SshPrivateKeyPassphrase { value } => {
                validate_text_secret(&value, MAX_SSH_SECRET_BYTES)?;
                Ok(ResolvedCredential::SshPrivateKeyPassphrase(value.0))
            }
            Self::SshPassword { value } => {
                validate_text_secret(&value, MAX_SSH_SECRET_BYTES)?;
                Ok(ResolvedCredential::SshPassword(value.0))
            }
        }
    }
}

impl ValidatedCredentialWrite {
    pub(super) fn text_bytes(&self) -> Option<&[u8]> {
        self.secret.text_bytes()
    }

    pub(super) fn encoded_environment(
        &self,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, CredentialValidationError> {
        self.secret.encoded_environment()
    }

    pub(super) fn environment_names(&self) -> Option<BTreeSet<String>> {
        self.secret.environment_names()
    }
}

impl CredentialSecret {
    pub(super) fn text_bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Text(value) => Some(value.as_bytes()),
            Self::SensitiveEnvironment(_) => None,
        }
    }

    pub(super) fn encoded_environment(
        &self,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, CredentialValidationError> {
        let Self::SensitiveEnvironment(values) = self else {
            return Ok(None);
        };
        let borrowed = values
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect::<BTreeMap<_, _>>();
        serde_json::to_vec(&borrowed)
            .map(Zeroizing::new)
            .map(Some)
            .map_err(|_| CredentialValidationError::invalid_sensitive_environment())
    }

    pub(super) fn environment_names(&self) -> Option<BTreeSet<String>> {
        match self {
            Self::SensitiveEnvironment(values) => Some(values.keys().cloned().collect()),
            Self::Text(_) => None,
        }
    }
}

pub(crate) struct SecretString(SecretText);

impl SecretString {
    fn as_str(&self) -> &str {
        self.0.as_str()
    }

    fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString([redacted])")
    }
}

impl<'de> Deserialize<'de> for SecretString {
    fn deserialize<DeserializerType>(
        deserializer: DeserializerType,
    ) -> Result<Self, DeserializerType::Error>
    where
        DeserializerType: Deserializer<'de>,
    {
        SecretText::deserialize(deserializer).map(Self)
    }
}

pub(crate) struct SecretText(Zeroizing<Vec<u8>>);

impl SecretText {
    pub(crate) fn from_string(value: String) -> Self {
        Self(Zeroizing::new(value.into_bytes()))
    }

    pub(crate) fn from_bytes(value: Zeroizing<Vec<u8>>) -> Result<Self, StoredCredentialError> {
        str::from_utf8(&value).map_err(|_| StoredCredentialError)?;
        Ok(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        str::from_utf8(&self.0).expect("SecretText must contain validated UTF-8")
    }

    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for SecretText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretText([redacted])")
    }
}

impl<'de> Deserialize<'de> for SecretText {
    fn deserialize<DeserializerType>(
        deserializer: DeserializerType,
    ) -> Result<Self, DeserializerType::Error>
    where
        DeserializerType: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self::from_string)
    }
}

pub(crate) struct SensitiveEnvironment(Vec<(SecretText, SecretText)>);

impl SensitiveEnvironment {
    pub(crate) fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }
}

impl fmt::Debug for SensitiveEnvironment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SensitiveEnvironment([redacted])")
    }
}

impl<'de> Deserialize<'de> for SensitiveEnvironment {
    fn deserialize<DeserializerType>(
        deserializer: DeserializerType,
    ) -> Result<Self, DeserializerType::Error>
    where
        DeserializerType: Deserializer<'de>,
    {
        struct SensitiveEnvironmentVisitor;

        impl<'de> Visitor<'de> for SensitiveEnvironmentVisitor {
            type Value = SensitiveEnvironment;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a sensitive environment object")
            }

            fn visit_map<Map>(self, mut map: Map) -> Result<Self::Value, Map::Error>
            where
                Map: MapAccess<'de>,
            {
                let mut values: Vec<(SecretText, SecretText)> = Vec::new();
                while let Some((name, value)) = map.next_entry::<SecretText, SecretText>()? {
                    if values.len() >= MAX_ENVIRONMENT_COUNT
                        || values
                            .iter()
                            .any(|(existing, _)| existing.as_str() == name.as_str())
                    {
                        return Err(Map::Error::custom("invalid sensitive environment"));
                    }
                    values.push((name, value));
                }
                Ok(SensitiveEnvironment(values))
            }
        }

        deserializer.deserialize_map(SensitiveEnvironmentVisitor)
    }
}

pub(crate) enum ResolvedCredential {
    SensitiveEnvironment(SensitiveEnvironment),
    BearerToken(SecretText),
    HttpBasicPassword(SecretText),
    HttpBearerToken(SecretText),
    Socks5Password(SecretText),
    SshPrivateKeyPassphrase(SecretText),
    SshPassword(SecretText),
}

impl fmt::Debug for ResolvedCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            Self::SensitiveEnvironment(_) => "SensitiveEnvironment",
            Self::BearerToken(_) => "BearerToken",
            Self::HttpBasicPassword(_) => "HttpBasicPassword",
            Self::HttpBearerToken(_) => "HttpBearerToken",
            Self::Socks5Password(_) => "Socks5Password",
            Self::SshPrivateKeyPassphrase(_) => "SshPrivateKeyPassphrase",
            Self::SshPassword(_) => "SshPassword",
        };
        formatter
            .debug_tuple("ResolvedCredential")
            .field(&kind)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StoredCredentialError;

pub(crate) fn decode_stored_credential(
    descriptor: CredentialDescriptor,
    value: Zeroizing<Vec<u8>>,
) -> Result<ResolvedCredential, StoredCredentialError> {
    match descriptor {
        CredentialDescriptor::Server {
            kind: ServerCredentialKind::SensitiveEnvironment,
            ..
        } => {
            let environment = serde_json::from_slice::<SensitiveEnvironment>(&value)
                .map_err(|_| StoredCredentialError)?;
            validate_resolved_sensitive_environment(&environment)?;
            Ok(ResolvedCredential::SensitiveEnvironment(environment))
        }
        CredentialDescriptor::Server {
            kind: ServerCredentialKind::BearerToken,
            ..
        } => {
            let value = SecretText::from_bytes(value)?;
            validate_bearer_text(&value)?;
            Ok(ResolvedCredential::BearerToken(value))
        }
        CredentialDescriptor::Proxy {
            kind: ProxyCredentialKind::HttpBasicPassword,
            ..
        } => decode_text_credential(value, MAX_HTTP_BASIC_PASSWORD_BYTES)
            .map(ResolvedCredential::HttpBasicPassword),
        CredentialDescriptor::Proxy {
            kind: ProxyCredentialKind::HttpBearerToken,
            ..
        } => {
            let value = SecretText::from_bytes(value)?;
            validate_bearer_text(&value)?;
            Ok(ResolvedCredential::HttpBearerToken(value))
        }
        CredentialDescriptor::Proxy {
            kind: ProxyCredentialKind::Socks5Password,
            ..
        } => decode_text_credential(value, MAX_SOCKS5_PASSWORD_BYTES)
            .map(ResolvedCredential::Socks5Password),
        CredentialDescriptor::Proxy {
            kind: ProxyCredentialKind::SshPrivateKeyPassphrase,
            ..
        } => decode_text_credential(value, MAX_SSH_SECRET_BYTES)
            .map(ResolvedCredential::SshPrivateKeyPassphrase),
        CredentialDescriptor::Proxy {
            kind: ProxyCredentialKind::SshPassword,
            ..
        } => {
            decode_text_credential(value, MAX_SSH_SECRET_BYTES).map(ResolvedCredential::SshPassword)
        }
    }
}

fn decode_text_credential(
    value: Zeroizing<Vec<u8>>,
    max_bytes: usize,
) -> Result<SecretText, StoredCredentialError> {
    let value = SecretText::from_bytes(value)?;
    validate_text(&value, max_bytes)?;
    Ok(value)
}

fn validate_resolved_sensitive_environment(
    values: &SensitiveEnvironment,
) -> Result<(), StoredCredentialError> {
    if values.0.is_empty() || values.0.len() > MAX_ENVIRONMENT_COUNT {
        return Err(StoredCredentialError);
    }
    for (name, value) in &values.0 {
        if !valid_environment_entry(name.as_str(), value.as_bytes(), value.as_str()) {
            return Err(StoredCredentialError);
        }
    }
    Ok(())
}

fn validate_bearer_text(value: &SecretText) -> Result<(), StoredCredentialError> {
    if value.as_bytes().len() > MAX_BEARER_TOKEN_BYTES || !is_valid_bearer_token(value.as_str()) {
        Err(StoredCredentialError)
    } else {
        Ok(())
    }
}

fn validate_text(value: &SecretText, max_bytes: usize) -> Result<(), StoredCredentialError> {
    if value.as_bytes().is_empty()
        || value.as_bytes().len() > max_bytes
        || value.as_str().contains('\0')
    {
        Err(StoredCredentialError)
    } else {
        Ok(())
    }
}

impl SetServerCredentialRequest {
    pub(super) fn validate(self) -> Result<ValidatedCredentialWrite, CredentialValidationError> {
        validate_version(self.expected_version)?;
        let (kind, secret) = match self.credential {
            ServerCredentialInput::SensitiveEnvironment { values } => {
                validate_sensitive_environment(&values)?;
                (
                    ServerCredentialKind::SensitiveEnvironment,
                    CredentialSecret::SensitiveEnvironment(values),
                )
            }
            ServerCredentialInput::BearerToken { value } => {
                validate_bearer_token(&value)?;
                (
                    ServerCredentialKind::BearerToken,
                    CredentialSecret::Text(value),
                )
            }
        };
        Ok(ValidatedCredentialWrite {
            descriptor: CredentialDescriptor::Server {
                server_id: self.server_id.0,
                kind,
            },
            expected_version: self.expected_version,
            plaintext_fallback_confirmed: self.plaintext_fallback_confirmed,
            secret,
        })
    }
}

impl ClearServerCredentialRequest {
    pub(super) fn validate(self) -> Result<(CredentialDescriptor, u64), CredentialValidationError> {
        validate_version(self.expected_version)?;
        let kind = match self.credential_type {
            ServerCredentialType::SensitiveEnvironment => {
                ServerCredentialKind::SensitiveEnvironment
            }
            ServerCredentialType::BearerToken => ServerCredentialKind::BearerToken,
        };
        Ok((
            CredentialDescriptor::Server {
                server_id: self.server_id.0,
                kind,
            },
            self.expected_version,
        ))
    }
}

impl SetProxyCredentialRequest {
    pub(super) fn validate(self) -> Result<ValidatedCredentialWrite, CredentialValidationError> {
        validate_version(self.expected_version)?;
        let (kind, value) = match self.credential {
            ProxyCredentialInput::HttpBasicPassword { value } => {
                validate_text_secret(&value, MAX_HTTP_BASIC_PASSWORD_BYTES)?;
                (ProxyCredentialKind::HttpBasicPassword, value)
            }
            ProxyCredentialInput::HttpBearerToken { value } => {
                validate_bearer_token(&value)?;
                (ProxyCredentialKind::HttpBearerToken, value)
            }
            ProxyCredentialInput::Socks5Password { value } => {
                validate_text_secret(&value, MAX_SOCKS5_PASSWORD_BYTES)?;
                (ProxyCredentialKind::Socks5Password, value)
            }
            ProxyCredentialInput::SshPrivateKeyPassphrase { value } => {
                validate_text_secret(&value, MAX_SSH_SECRET_BYTES)?;
                (ProxyCredentialKind::SshPrivateKeyPassphrase, value)
            }
            ProxyCredentialInput::SshPassword { value } => {
                validate_text_secret(&value, MAX_SSH_SECRET_BYTES)?;
                (ProxyCredentialKind::SshPassword, value)
            }
        };
        Ok(ValidatedCredentialWrite {
            descriptor: CredentialDescriptor::Proxy {
                proxy_id: self.proxy_id.0,
                kind,
            },
            expected_version: self.expected_version,
            plaintext_fallback_confirmed: self.plaintext_fallback_confirmed,
            secret: CredentialSecret::Text(value),
        })
    }
}

impl ClearProxyCredentialRequest {
    pub(super) fn validate(self) -> Result<(CredentialDescriptor, u64), CredentialValidationError> {
        validate_version(self.expected_version)?;
        let kind = match self.credential_type {
            ProxyCredentialType::HttpBasicPassword => ProxyCredentialKind::HttpBasicPassword,
            ProxyCredentialType::HttpBearerToken => ProxyCredentialKind::HttpBearerToken,
            ProxyCredentialType::Socks5Password => ProxyCredentialKind::Socks5Password,
            ProxyCredentialType::SshPrivateKeyPassphrase => {
                ProxyCredentialKind::SshPrivateKeyPassphrase
            }
            ProxyCredentialType::SshPassword => ProxyCredentialKind::SshPassword,
        };
        Ok((
            CredentialDescriptor::Proxy {
                proxy_id: self.proxy_id.0,
                kind,
            },
            self.expected_version,
        ))
    }
}

fn validate_version(value: u64) -> Result<(), CredentialValidationError> {
    if value == 0 || value > 9_007_199_254_740_991 {
        Err(CredentialValidationError::invalid_version())
    } else {
        Ok(())
    }
}

fn validate_sensitive_environment(
    values: &BTreeMap<String, SecretString>,
) -> Result<(), CredentialValidationError> {
    if values.is_empty() || values.len() > MAX_ENVIRONMENT_COUNT {
        return Err(CredentialValidationError::invalid_sensitive_environment());
    }
    for (name, value) in values {
        if !valid_environment_entry(name, value.as_bytes(), value.as_str()) {
            return Err(CredentialValidationError::invalid_sensitive_environment());
        }
    }
    Ok(())
}

fn valid_environment_entry(name: &str, value_bytes: &[u8], value: &str) -> bool {
    let mut characters = name.chars();
    let valid_first = characters
        .next()
        .is_some_and(|character| character == '_' || character.is_ascii_alphabetic());
    valid_first
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
        && name.len() <= MAX_ENVIRONMENT_NAME_BYTES
        && value_bytes.len() <= MAX_ENVIRONMENT_VALUE_BYTES
        && !value.contains('\0')
}

fn validate_bearer_token(value: &SecretString) -> Result<(), CredentialValidationError> {
    validate_bearer_text(&value.0).map_err(|_| CredentialValidationError::invalid_value())
}

fn validate_text_secret(
    value: &SecretString,
    max_bytes: usize,
) -> Result<(), CredentialValidationError> {
    validate_text(&value.0, max_bytes).map_err(|_| CredentialValidationError::invalid_value())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CredentialValidationError {
    pub(super) code: &'static str,
    pub(super) message: &'static str,
}

impl CredentialValidationError {
    pub(super) const fn invalid_payload() -> Self {
        Self::invalid_value()
    }

    const fn invalid_version() -> Self {
        Self {
            code: "invalidConfigurationVersion",
            message: "The configuration version is invalid",
        }
    }

    const fn invalid_value() -> Self {
        Self {
            code: "invalidCredentialValue",
            message: "The credential value is invalid",
        }
    }

    const fn invalid_sensitive_environment() -> Self {
        Self {
            code: "invalidSensitiveEnvironment",
            message: "The sensitive environment is invalid",
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::{
        ClearProxyCredentialRequest, ClearServerCredentialRequest, MAX_BEARER_TOKEN_BYTES,
        MAX_ENVIRONMENT_COUNT, MAX_ENVIRONMENT_VALUE_BYTES, MAX_HTTP_BASIC_PASSWORD_BYTES,
        MAX_SOCKS5_PASSWORD_BYTES, MAX_SSH_SECRET_BYTES, ResolvedCredential,
        ServerConnectionTestCredentialSource, SetProxyCredentialRequest,
        SetServerCredentialRequest, decode_stored_credential,
    };
    use crate::credentials::{CredentialDescriptor, ProxyCredentialKind, ServerCredentialKind};
    use zeroize::Zeroizing;

    const SERVER_ID: &str = "11111111-1111-4111-8111-111111111111";
    const PROXY_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    fn request<Value: serde::de::DeserializeOwned>(value: serde_json::Value) -> Value {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn validates_server_secret_shapes_without_exposing_values() {
        let write = request::<SetServerCredentialRequest>(json!({
            "serverId": SERVER_ID,
            "expectedVersion": 1,
            "credential": {
                "type": "sensitiveEnvironment",
                "values": { "OPENAI_API_KEY": "server-secret-sentinel" }
            },
            "plaintextFallbackConfirmed": true
        }))
        .validate()
        .unwrap();
        assert!(matches!(
            write.descriptor,
            CredentialDescriptor::Server {
                kind: ServerCredentialKind::SensitiveEnvironment,
                ..
            }
        ));
        assert_eq!(
            write.secret.environment_names().unwrap(),
            ["OPENAI_API_KEY".to_owned()].into_iter().collect()
        );
        assert!(write.plaintext_fallback_confirmed);
        let encoded = write.secret.encoded_environment().unwrap().unwrap();
        assert!(encoded.windows(6).any(|window| window == b"secret"));

        let debug = format!("{write:?}");
        assert!(!debug.contains("server-secret-sentinel"));
    }

    #[test]
    fn validates_connection_test_credential_sources_without_exposing_provided_values() {
        let source = request::<ServerConnectionTestCredentialSource>(json!({
            "type": "provided",
            "credential": {
                "type": "bearerToken",
                "value": "SECRET_TEST_TOKEN"
            }
        }));
        assert!(!format!("{source:?}").contains("SECRET_TEST_TOKEN"));
        let ServerConnectionTestCredentialSource::Provided { credential } = source else {
            panic!("provided source should be retained");
        };
        assert!(matches!(
            credential.resolve().unwrap(),
            ResolvedCredential::BearerToken(_)
        ));

        assert!(
            serde_json::from_value::<ServerConnectionTestCredentialSource>(json!({
                "type": "stored",
                "serverId": SERVER_ID
            }))
            .is_err()
        );
    }

    #[test]
    fn validates_all_scalar_credential_kinds_and_clear_types() {
        for (credential_type, expected_kind) in [
            ("httpBasicPassword", ProxyCredentialKind::HttpBasicPassword),
            ("httpBearerToken", ProxyCredentialKind::HttpBearerToken),
            ("socks5Password", ProxyCredentialKind::Socks5Password),
            (
                "sshPrivateKeyPassphrase",
                ProxyCredentialKind::SshPrivateKeyPassphrase,
            ),
            ("sshPassword", ProxyCredentialKind::SshPassword),
        ] {
            let value = if credential_type == "httpBearerToken" {
                "valid-token"
            } else {
                "valid secret"
            };
            let write = request::<SetProxyCredentialRequest>(json!({
                "proxyId": PROXY_ID,
                "expectedVersion": 1,
                "credential": { "type": credential_type, "value": value }
            }))
            .validate()
            .unwrap();
            assert_eq!(
                write.descriptor,
                CredentialDescriptor::Proxy {
                    proxy_id: uuid::Uuid::parse_str(PROXY_ID).unwrap(),
                    kind: expected_kind,
                }
            );
            assert!(write.secret.text_bytes().is_some());

            let (descriptor, version) = request::<ClearProxyCredentialRequest>(json!({
                "proxyId": PROXY_ID,
                "expectedVersion": 2,
                "credentialType": credential_type
            }))
            .validate()
            .unwrap();
            assert_eq!(descriptor, write.descriptor);
            assert_eq!(version, 2);
        }

        let (descriptor, _) = request::<ClearServerCredentialRequest>(json!({
            "serverId": SERVER_ID,
            "expectedVersion": 1,
            "credentialType": "bearerToken"
        }))
        .validate()
        .unwrap();
        assert!(matches!(
            descriptor,
            CredentialDescriptor::Server {
                kind: ServerCredentialKind::BearerToken,
                ..
            }
        ));
    }

    #[test]
    fn rejects_empty_oversized_unknown_and_malformed_credentials_safely() {
        let cases = [
            json!({
                "proxyId": PROXY_ID,
                "expectedVersion": 1,
                "credential": { "type": "socks5Password", "value": "" }
            }),
            json!({
                "proxyId": PROXY_ID,
                "expectedVersion": 1,
                "credential": { "type": "httpBearerToken", "value": "bad token" }
            }),
            json!({
                "proxyId": PROXY_ID,
                "expectedVersion": 1,
                "credential": {
                    "type": "httpBasicPassword",
                    "value": "x".repeat(MAX_HTTP_BASIC_PASSWORD_BYTES + 1)
                }
            }),
            json!({
                "proxyId": PROXY_ID,
                "expectedVersion": 1,
                "credential": {
                    "type": "httpBearerToken",
                    "value": "x".repeat(MAX_BEARER_TOKEN_BYTES + 1)
                }
            }),
            json!({
                "proxyId": PROXY_ID,
                "expectedVersion": 1,
                "credential": {
                    "type": "socks5Password",
                    "value": "x".repeat(MAX_SOCKS5_PASSWORD_BYTES + 1)
                }
            }),
            json!({
                "proxyId": PROXY_ID,
                "expectedVersion": 1,
                "credential": {
                    "type": "sshPassword",
                    "value": "x".repeat(MAX_SSH_SECRET_BYTES + 1)
                }
            }),
            json!({
                "proxyId": PROXY_ID,
                "expectedVersion": 1,
                "credential": {
                    "type": "httpBasicPassword",
                    "value": "secret",
                    "unknown": true
                }
            }),
        ];
        for payload in cases {
            let parsed = serde_json::from_value::<SetProxyCredentialRequest>(payload);
            match parsed {
                Ok(request) => assert!(request.validate().is_err()),
                Err(error) => assert!(!error.to_string().contains("secret")),
            }
        }

        let invalid_request = request::<SetServerCredentialRequest>(json!({
            "serverId": SERVER_ID,
            "expectedVersion": 1,
            "credential": {
                "type": "sensitiveEnvironment",
                "values": { "INVALID-NAME": "environment-secret-sentinel" }
            }
        }));
        let error = invalid_request.validate().unwrap_err();
        assert_eq!(error.code, "invalidSensitiveEnvironment");
        assert!(!format!("{error:?}").contains("environment-secret-sentinel"));

        for payload in [
            json!({
                "serverId": SERVER_ID,
                "expectedVersion": 0,
                "credential": { "type": "bearerToken", "value": "valid-token" }
            }),
            json!({
                "serverId": SERVER_ID,
                "expectedVersion": 9_007_199_254_740_992_u64,
                "credential": { "type": "bearerToken", "value": "valid-token" }
            }),
            json!({
                "serverId": SERVER_ID,
                "expectedVersion": 1,
                "credential": {
                    "type": "sensitiveEnvironment",
                    "values": { "ACCESS_TOKEN": "x".repeat(MAX_ENVIRONMENT_VALUE_BYTES + 1) }
                }
            }),
            json!({
                "serverId": SERVER_ID,
                "expectedVersion": 1,
                "credential": {
                    "type": "sensitiveEnvironment",
                    "values": (0..=MAX_ENVIRONMENT_COUNT)
                        .map(|index| (format!("SECRET_{index}"), "value"))
                        .collect::<BTreeMap<_, _>>()
                }
            }),
        ] {
            let error = request::<SetServerCredentialRequest>(payload)
                .validate()
                .unwrap_err();
            assert!(matches!(
                error.code,
                "invalidConfigurationVersion" | "invalidSensitiveEnvironment"
            ));
        }
    }

    #[test]
    fn strictly_decodes_stored_credentials_without_exposing_values() {
        let server_id = uuid::Uuid::parse_str(SERVER_ID).unwrap();
        let environment = decode_stored_credential(
            CredentialDescriptor::Server {
                server_id,
                kind: ServerCredentialKind::SensitiveEnvironment,
            },
            Zeroizing::new(br#"{"ACCESS_TOKEN":"environment-secret-sentinel"}"#.to_vec()),
        )
        .unwrap();
        let ResolvedCredential::SensitiveEnvironment(environment) = environment else {
            panic!("expected a sensitive environment");
        };
        assert_eq!(
            environment.iter().collect::<Vec<_>>(),
            vec![("ACCESS_TOKEN", "environment-secret-sentinel")]
        );
        assert!(!format!("{environment:?}").contains("environment-secret-sentinel"));

        let bearer = decode_stored_credential(
            CredentialDescriptor::Server {
                server_id,
                kind: ServerCredentialKind::BearerToken,
            },
            Zeroizing::new(b"valid-token".to_vec()),
        )
        .unwrap();
        let ResolvedCredential::BearerToken(bearer) = bearer else {
            panic!("expected a bearer token");
        };
        assert_eq!(bearer.as_str(), "valid-token");
        assert!(!format!("{bearer:?}").contains("valid-token"));
    }

    #[test]
    fn rejects_corrupt_stored_credential_payloads() {
        let server_id = uuid::Uuid::parse_str(SERVER_ID).unwrap();
        let environment_descriptor = CredentialDescriptor::Server {
            server_id,
            kind: ServerCredentialKind::SensitiveEnvironment,
        };
        for value in [
            br#"[]"#.as_slice(),
            br#"{}"#.as_slice(),
            br#"{"A":"one","A":"two"}"#.as_slice(),
            br#"{"INVALID-NAME":"value"}"#.as_slice(),
            br#"{"ACCESS_TOKEN":"bad\u0000value"}"#.as_slice(),
        ] {
            assert!(
                decode_stored_credential(environment_descriptor, Zeroizing::new(value.to_vec()))
                    .is_err()
            );
        }

        let password_descriptor = CredentialDescriptor::Proxy {
            proxy_id: uuid::Uuid::parse_str(PROXY_ID).unwrap(),
            kind: ProxyCredentialKind::Socks5Password,
        };
        for value in [Vec::new(), vec![0xff], b"bad\0value".to_vec()] {
            assert!(decode_stored_credential(password_descriptor, Zeroizing::new(value)).is_err());
        }
    }
}
