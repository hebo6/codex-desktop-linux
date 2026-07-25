use std::{
    collections::HashMap,
    fs::File,
    io::Read as _,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

const MAX_CLIPBOARD_FILE_BYTES: u64 = 16 * 1024 * 1024;
const CLIPBOARD_FILE_CHUNK_BYTES: usize = 256 * 1024;
const CLIPBOARD_FILE_TOKEN_LIFETIME: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFile {
    name: String,
    size: u64,
    token: Option<Uuid>,
    error: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct PreparedClipboardFile {
    name: String,
    size: u64,
    data: Option<Vec<u8>>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFileChunk {
    data_base64: String,
    next_offset: u64,
    complete: bool,
}

#[derive(Clone, Default)]
pub struct ClipboardFileStore {
    files: Arc<Mutex<HashMap<Uuid, Vec<u8>>>>,
}

#[tauri::command]
pub async fn read_clipboard_files(
    app: tauri::AppHandle,
    store: State<'_, ClipboardFileStore>,
) -> Result<Vec<ClipboardFile>, String> {
    let store = store.inner().clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        let uris = clipboard
            .wait_for_uris()
            .into_iter()
            .map(|uri| uri.to_string())
            .collect::<Vec<_>>();
        let image_png = if uris.is_empty() {
            clipboard
                .wait_for_image()
                .and_then(|image| image.save_to_bufferv("png", &[]).ok())
        } else {
            None
        };
        let _ = sender.send((uris, image_png));
    })
    .map_err(|_| "无法访问系统剪贴板".to_owned())?;
    let (uris, image_png) = receiver
        .await
        .map_err(|_| "无法读取系统剪贴板".to_owned())?;

    let files = tokio::task::spawn_blocking(move || {
        read_clipboard_contents_with_limit(uris, image_png, MAX_CLIPBOARD_FILE_BYTES)
    })
    .await
    .map_err(|_| "无法读取剪贴板中的文件".to_owned())?;
    let (files, tokens) = store.store(files)?;
    let cleanup_store = store.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLIPBOARD_FILE_TOKEN_LIFETIME).await;
        cleanup_store.remove(&tokens);
    });
    Ok(files)
}

#[tauri::command]
pub fn read_clipboard_file_chunk(
    token: String,
    offset: u64,
    store: State<'_, ClipboardFileStore>,
) -> Result<ClipboardFileChunk, String> {
    let token = Uuid::parse_str(&token).map_err(|_| "剪贴板文件令牌无效".to_owned())?;
    store.read_chunk(token, offset)
}

fn read_clipboard_contents_with_limit(
    uris: Vec<String>,
    image_png: Option<Vec<u8>>,
    max_file_bytes: u64,
) -> Vec<PreparedClipboardFile> {
    let files = uris
        .into_iter()
        .filter_map(|uri| local_file_path(&uri))
        .filter_map(|path| read_clipboard_file(&path, max_file_bytes))
        .collect::<Vec<_>>();
    if !files.is_empty() {
        return files;
    }
    image_png
        .map(|data| clipboard_image(data, max_file_bytes))
        .into_iter()
        .collect()
}

fn local_file_path(uri: &str) -> Option<PathBuf> {
    let url = url::Url::parse(uri).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    url.to_file_path().ok()
}

fn read_clipboard_file(path: &Path, max_file_bytes: u64) -> Option<PreparedClipboardFile> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Some(clipboard_file_error(name, 0, "无法读取剪贴板中的文件")),
    };
    let metadata = match file.metadata() {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return None,
    };
    if metadata.len() > max_file_bytes {
        return Some(clipboard_file_error(
            name,
            metadata.len(),
            "图片超过 16 MiB 上限",
        ));
    }

    let mut data = Vec::with_capacity(metadata.len() as usize);
    if file
        .take(max_file_bytes.saturating_add(1))
        .read_to_end(&mut data)
        .is_err()
    {
        return Some(clipboard_file_error(
            name,
            metadata.len(),
            "无法读取剪贴板中的文件",
        ));
    }
    if data.len() as u64 > max_file_bytes {
        return Some(clipboard_file_error(
            name,
            data.len() as u64,
            "图片超过 16 MiB 上限",
        ));
    }

    Some(PreparedClipboardFile {
        name,
        size: data.len() as u64,
        data: Some(data),
        error: None,
    })
}

fn clipboard_file_error(name: String, size: u64, error: &str) -> PreparedClipboardFile {
    PreparedClipboardFile {
        name,
        size,
        data: None,
        error: Some(error.to_owned()),
    }
}

fn clipboard_image(data: Vec<u8>, max_file_bytes: u64) -> PreparedClipboardFile {
    let name = "粘贴图片.png".to_owned();
    if data.len() as u64 > max_file_bytes {
        return clipboard_file_error(name, data.len() as u64, "图片超过 16 MiB 上限");
    }
    PreparedClipboardFile {
        name,
        size: data.len() as u64,
        data: Some(data),
        error: None,
    }
}

impl ClipboardFileStore {
    fn store(
        &self,
        files: Vec<PreparedClipboardFile>,
    ) -> Result<(Vec<ClipboardFile>, Vec<Uuid>), String> {
        let mut stored = self
            .files
            .lock()
            .map_err(|_| "无法保存剪贴板文件".to_owned())?;
        let mut tokens = Vec::new();
        let files = files
            .into_iter()
            .map(|file| {
                let token = file.data.map(|data| {
                    let token = Uuid::new_v4();
                    stored.insert(token, data);
                    tokens.push(token);
                    token
                });
                ClipboardFile {
                    name: file.name,
                    size: file.size,
                    token,
                    error: file.error,
                }
            })
            .collect();
        Ok((files, tokens))
    }

    fn read_chunk(&self, token: Uuid, offset: u64) -> Result<ClipboardFileChunk, String> {
        let offset = usize::try_from(offset).map_err(|_| "剪贴板文件读取位置无效".to_owned())?;
        let mut stored = self
            .files
            .lock()
            .map_err(|_| "无法读取剪贴板文件".to_owned())?;
        let data = stored
            .get(&token)
            .ok_or_else(|| "剪贴板文件已过期".to_owned())?;
        if offset > data.len() {
            return Err("剪贴板文件读取位置无效".to_owned());
        }
        let next_offset = offset
            .saturating_add(CLIPBOARD_FILE_CHUNK_BYTES)
            .min(data.len());
        let data_base64 = STANDARD.encode(&data[offset..next_offset]);
        let complete = next_offset == data.len();
        if complete {
            stored.remove(&token);
        }
        Ok(ClipboardFileChunk {
            data_base64,
            next_offset: next_offset as u64,
            complete,
        })
    }

    fn remove(&self, tokens: &[Uuid]) {
        if let Ok(mut stored) = self.files.lock() {
            for token in tokens {
                stored.remove(token);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use uuid::Uuid;

    use super::{
        CLIPBOARD_FILE_CHUNK_BYTES, ClipboardFileStore, read_clipboard_contents_with_limit,
    };

    #[test]
    fn reads_local_file_uris_and_ignores_other_uri_schemes() {
        let directory = std::env::temp_dir().join(format!("codex-clipboard-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let image_path = directory.join("screen shot.png");
        fs::write(&image_path, b"image").unwrap();
        let file_uri = url::Url::from_file_path(&image_path).unwrap().to_string();

        let files = read_clipboard_contents_with_limit(
            vec![file_uri, "https://example.com/image.png".to_owned()],
            None,
            16,
        );

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "screen shot.png");
        assert_eq!(files[0].size, 5);
        assert_eq!(files[0].data.as_deref(), Some(b"image".as_slice()));
        assert_eq!(files[0].error, None);

        fs::remove_file(image_path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn reports_oversized_files_without_reading_their_contents() {
        let directory = std::env::temp_dir().join(format!("codex-clipboard-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let image_path = directory.join("large.png");
        fs::write(&image_path, b"large").unwrap();
        let file_uri = url::Url::from_file_path(&image_path).unwrap().to_string();

        let files = read_clipboard_contents_with_limit(vec![file_uri], None, 4);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "large.png");
        assert_eq!(files[0].size, 5);
        assert_eq!(files[0].data, None);
        assert_eq!(files[0].error.as_deref(), Some("图片超过 16 MiB 上限"));

        fs::remove_file(image_path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn uses_raw_clipboard_image_when_no_local_files_are_available() {
        let png = b"\x89PNG\r\n\x1a\n".to_vec();

        let files = read_clipboard_contents_with_limit(Vec::new(), Some(png.clone()), 16);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "粘贴图片.png");
        assert_eq!(files[0].size, png.len() as u64);
        assert_eq!(files[0].data.as_ref(), Some(&png));
        assert_eq!(files[0].error, None);
    }

    #[test]
    fn streams_large_clipboard_files_in_bounded_chunks_and_consumes_the_token() {
        let data = vec![7; CLIPBOARD_FILE_CHUNK_BYTES + 1];
        let store = ClipboardFileStore::default();
        let (files, tokens) = store
            .store(vec![super::PreparedClipboardFile {
                name: "large.jpg".to_owned(),
                size: data.len() as u64,
                data: Some(data.clone()),
                error: None,
            }])
            .unwrap();
        let token = files[0].token.unwrap();

        let first = store.read_chunk(token, 0).unwrap();
        assert!(!first.complete);
        assert_eq!(first.next_offset, CLIPBOARD_FILE_CHUNK_BYTES as u64);
        assert_eq!(
            STANDARD.decode(first.data_base64).unwrap(),
            data[..CLIPBOARD_FILE_CHUNK_BYTES],
        );

        let second = store.read_chunk(token, first.next_offset).unwrap();
        assert!(second.complete);
        assert_eq!(second.next_offset, data.len() as u64);
        assert_eq!(STANDARD.decode(second.data_base64).unwrap(), [7]);
        assert!(store.read_chunk(token, 0).is_err());
        assert_eq!(tokens, vec![token]);
    }
}
