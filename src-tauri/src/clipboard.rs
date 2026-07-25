use std::{
    fs::File,
    io::Read as _,
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;

const MAX_CLIPBOARD_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFile {
    name: String,
    size: u64,
    data_base64: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn read_clipboard_files(app: tauri::AppHandle) -> Result<Vec<ClipboardFile>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        let uris = clipboard
            .wait_for_uris()
            .into_iter()
            .map(|uri| uri.to_string())
            .collect();
        let _ = sender.send(uris);
    })
    .map_err(|_| "无法访问系统剪贴板".to_owned())?;
    let uris = receiver
        .await
        .map_err(|_| "无法读取系统剪贴板".to_owned())?;

    tokio::task::spawn_blocking(move || {
        read_clipboard_files_with_limit(uris, MAX_CLIPBOARD_FILE_BYTES)
    })
    .await
    .map_err(|_| "无法读取剪贴板中的文件".to_owned())
}

fn read_clipboard_files_with_limit(uris: Vec<String>, max_file_bytes: u64) -> Vec<ClipboardFile> {
    uris.into_iter()
        .filter_map(|uri| local_file_path(&uri))
        .filter_map(|path| read_clipboard_file(&path, max_file_bytes))
        .collect()
}

fn local_file_path(uri: &str) -> Option<PathBuf> {
    let url = url::Url::parse(uri).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    url.to_file_path().ok()
}

fn read_clipboard_file(path: &Path, max_file_bytes: u64) -> Option<ClipboardFile> {
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

    Some(ClipboardFile {
        name,
        size: data.len() as u64,
        data_base64: Some(STANDARD.encode(data)),
        error: None,
    })
}

fn clipboard_file_error(name: String, size: u64, error: &str) -> ClipboardFile {
    ClipboardFile {
        name,
        size,
        data_base64: None,
        error: Some(error.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use uuid::Uuid;

    use super::read_clipboard_files_with_limit;

    #[test]
    fn reads_local_file_uris_and_ignores_other_uri_schemes() {
        let directory = std::env::temp_dir().join(format!("codex-clipboard-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let image_path = directory.join("screen shot.png");
        fs::write(&image_path, b"image").unwrap();
        let file_uri = url::Url::from_file_path(&image_path).unwrap().to_string();

        let files = read_clipboard_files_with_limit(
            vec![file_uri, "https://example.com/image.png".to_owned()],
            16,
        );

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "screen shot.png");
        assert_eq!(files[0].size, 5);
        assert_eq!(
            STANDARD
                .decode(files[0].data_base64.as_ref().unwrap())
                .unwrap(),
            b"image",
        );
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

        let files = read_clipboard_files_with_limit(vec![file_uri], 4);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "large.png");
        assert_eq!(files[0].size, 5);
        assert_eq!(files[0].data_base64, None);
        assert_eq!(files[0].error.as_deref(), Some("图片超过 16 MiB 上限"));

        fs::remove_file(image_path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
