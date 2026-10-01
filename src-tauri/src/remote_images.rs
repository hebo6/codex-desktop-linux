use std::{net::IpAddr, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::{Client, ClientBuilder, Response, StatusCode, header};
use serde::Serialize;
use url::{Host, Url};

const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteImage {
    data_base64: String,
    media_type: &'static str,
}

#[tauri::command]
pub(crate) async fn read_remote_image(url: String) -> Result<RemoteImage, String> {
    tokio::time::timeout(DOWNLOAD_TIMEOUT, download_image(&url))
        .await
        .map_err(|_| "图片下载超时".to_owned())?
}

async fn download_image(value: &str) -> Result<RemoteImage, String> {
    let mut url = parse_image_url(value)?;
    let client = image_client_builder()?
        .build()
        .map_err(|_| "无法初始化图片下载连接".to_owned())?;
    for redirect_count in 0..=MAX_REDIRECTS {
        let response = client
            .get(url.clone())
            .header(header::ACCEPT, "image/png,image/jpeg,image/gif,image/webp")
            .send()
            .await
            .map_err(request_error)?;

        if matches!(
            response.status(),
            StatusCode::MOVED_PERMANENTLY
                | StatusCode::FOUND
                | StatusCode::SEE_OTHER
                | StatusCode::TEMPORARY_REDIRECT
                | StatusCode::PERMANENT_REDIRECT
        ) {
            if redirect_count == MAX_REDIRECTS {
                return Err("图片地址重定向次数过多".to_owned());
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "图片地址重定向无效".to_owned())?;
            url = redirect_url(&url, location)?;
            continue;
        }

        return read_image_response(response, MAX_IMAGE_BYTES).await;
    }
    unreachable!("the final allowed redirect returns an error")
}

fn parse_image_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "图片地址无效".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err("互联网图片仅支持 HTTP 或 HTTPS 地址".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("图片地址不能包含用户名或密码".to_owned());
    }
    match url.host().ok_or_else(|| "图片地址无效".to_owned())? {
        Host::Domain(domain) => {
            let domain = domain.trim_end_matches('.');
            if domain == "localhost" || domain.ends_with(".localhost") {
                return Err("互联网图片地址不能使用 localhost".to_owned());
            }
            // Trust the system resolver and routing, including proxy Fake-IP
            // addresses. Only addresses written directly in the URL are checked.
        }
        Host::Ipv4(address) => require_public_address(address.into())?,
        Host::Ipv6(address) => require_public_address(address.into())?,
    }
    Ok(url)
}

fn redirect_url(current: &Url, location: &str) -> Result<Url, String> {
    let next = current
        .join(location)
        .map_err(|_| "图片地址重定向无效".to_owned())?;
    parse_image_url(next.as_str())
}

fn image_client_builder() -> Result<ClientBuilder, String> {
    let tls_config = crate::connection::remote_websocket::tls_config()
        .map_err(|_| "无法加载图片下载所需的系统 TLS 证书".to_owned())?;
    Ok(Client::builder()
        .tls_backend_preconfigured((*tls_config).clone())
        // Use system DNS/routing without inheriting application or HTTP proxy credentials.
        .no_proxy()
        .referer(false)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(DOWNLOAD_TIMEOUT)
        .connect_timeout(Duration::from_secs(10)))
}

fn require_public_address(address: IpAddr) -> Result<(), String> {
    let is_public = match address {
        IpAddr::V4(address) => {
            let [a, b, c, _] = address.octets();
            // Exclude special-purpose ranges, including shared address space,
            // documentation, benchmarking and transition-service addresses.
            !matches!(a, 0 | 10 | 127 | 224..=255)
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 169 && b == 254)
                && !(a == 172 && (16..=31).contains(&b))
                && !(a == 192
                    && (b == 168 || (b == 0 && matches!(c, 0 | 2)) || (b == 88 && c == 99)))
                && !(a == 198 && (matches!(b, 18 | 19) || (b == 51 && c == 100)))
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(address) => {
            let [a, b, ..] = address.segments();
            // Only global unicast, excluding IETF special-purpose, 6to4 and
            // documentation ranges. This also excludes mapped IPv4 and NAT64.
            (a & 0xe000) == 0x2000
                && !(a == 0x2001 && (b < 0x0200 || b == 0x0db8))
                && a != 0x2002
                && !(a == 0x3fff && b < 0x1000)
        }
    };
    if !is_public {
        return Err("图片地址不能直接指定本机、私网或保留 IP".to_owned());
    }
    Ok(())
}

async fn read_image_response(
    mut response: Response,
    max_bytes: usize,
) -> Result<RemoteImage, String> {
    if !response.status().is_success() {
        return Err(format!(
            "图片服务器返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err("图片超过 16 MiB 大小限制".to_owned());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if chunk.len() > max_bytes - bytes.len() {
            return Err("图片超过 16 MiB 大小限制".to_owned());
        }
        bytes.extend_from_slice(&chunk);
    }
    let media_type = image_media_type(&bytes)
        .ok_or_else(|| "互联网图片仅支持 PNG、JPEG、GIF 或 WebP 格式".to_owned())?;
    Ok(RemoteImage {
        data_base64: STANDARD.encode(bytes),
        media_type,
    })
}

fn image_media_type(bytes: &[u8]) -> Option<&'static str> {
    // The response Content-Type and URL extension are untrusted. Return a type
    // derived from the image bytes so SVG/HTML cannot become active content.
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "图片下载超时".to_owned()
    } else {
        "图片下载失败，请检查网络连接".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    #[test]
    fn accepts_only_http_urls_without_credentials() {
        for value in [
            "http://images.example/a.png",
            "https://images.example/a.png",
            "https://localhost.example/a.png",
            "https://1.1.1.1/a.png",
        ] {
            assert!(parse_image_url(value).is_ok(), "{value}");
        }
        for value in [
            "file:///tmp/a.png",
            "data:image/png;base64,AA==",
            "javascript:alert(1)",
            "https://user:secret@images.example/a.png",
            "https://user@images.example/a.png",
            "https://:secret@images.example/a.png",
            "https://localhost/a.png",
            "https://localhost./a.png",
            "https://LOCALHOST/a.png",
            "https://images.localhost/a.png",
            "https://images.localhost./a.png",
            "http://127.0.0.1/a.png",
            "http://127.1/a.png",
            "http://2130706433/a.png",
            "http://0x7f000001/a.png",
            "http://192.168.1.1/a.png",
            "http://[::1]/a.png",
        ] {
            assert!(parse_image_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn rejects_private_and_special_purpose_addresses() {
        for value in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "192.88.99.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "64:ff9b::7f00:1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "2001::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "3fff::1",
        ] {
            assert!(
                require_public_address(value.parse().unwrap()).is_err(),
                "{value}"
            );
        }
        for value in ["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"] {
            assert!(
                require_public_address(value.parse().unwrap()).is_ok(),
                "{value}"
            );
        }
    }

    #[tokio::test]
    async fn validates_redirects_and_blocks_private_targets_before_connecting() {
        let current = Url::parse("https://images.example/a/start").unwrap();
        assert_eq!(
            redirect_url(&current, "../image.png").unwrap().as_str(),
            "https://images.example/image.png"
        );
        assert!(redirect_url(&current, "file:///tmp/image.png").is_err());
        assert!(redirect_url(&current, "https://secret@images.example/image.png").is_err());
        for location in [
            "http://127.0.0.1/image.png",
            "http://[::1]/image.png",
            "http://localhost/image.png",
            "http://images.localhost./image.png",
        ] {
            assert!(redirect_url(&current, location).is_err(), "{location}");
        }
        assert!(
            read_remote_image("http://127.0.0.1/image.png".to_owned())
                .await
                .is_err()
        );
    }

    #[test]
    fn identifies_raster_images_by_bytes() {
        assert_eq!(image_media_type(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(image_media_type(b"\xff\xd8\xff\xe0"), Some("image/jpeg"));
        assert_eq!(image_media_type(b"GIF87a"), Some("image/gif"));
        assert_eq!(image_media_type(b"GIF89a"), Some("image/gif"));
        assert_eq!(
            image_media_type(b"RIFF\x00\x00\x00\x00WEBP"),
            Some("image/webp")
        );
        for bytes in [
            b"<svg xmlns='http://www.w3.org/2000/svg'/>".as_slice(),
            b"<html/>",
            b"RIFF",
            b"",
        ] {
            assert_eq!(image_media_type(bytes), None);
        }
    }

    async fn response_from_server(response_bytes: &[u8]) -> Response {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let response_bytes = response_bytes.to_vec();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).await.unwrap();
            stream.write_all(&response_bytes).await.unwrap();
        });
        image_client_builder()
            .unwrap()
            .build()
            .unwrap()
            .get(format!("http://{address}/image"))
            .send()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn reads_image_bytes_without_trusting_content_type() {
        let response = response_from_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nContent-Type: text/plain\r\n\r\n\x89PNG\r\n\x1a\n",
        ).await;
        let image = read_image_response(response, 8).await.unwrap();
        assert_eq!(image.media_type, "image/png");
        assert_eq!(
            STANDARD.decode(image.data_base64).unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
    }

    #[tokio::test]
    async fn rejects_oversize_fixed_and_chunked_bodies() {
        for response_bytes in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n\x89PNG\r\n\x1a\nX".as_slice(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n\x89PNG\r\n\x1a\n\r\n1\r\nX\r\n0\r\n\r\n",
        ] {
            let response = response_from_server(response_bytes).await;
            assert!(read_image_response(response, 8).await.unwrap_err().contains("16 MiB"));
        }
    }

    #[tokio::test]
    async fn rejects_unsuccessful_responses_and_disguised_svg() {
        let response =
            response_from_server(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
        assert!(
            read_image_response(response, 16)
                .await
                .unwrap_err()
                .contains("404")
        );
        let response = response_from_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 6\r\n\r\n<svg/>",
        )
        .await;
        assert!(read_image_response(response, 16).await.is_err());
    }
}
