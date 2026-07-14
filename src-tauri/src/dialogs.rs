use std::fs::OpenOptions;
use std::io;
use std::process::Stdio;

use base64::engine::general_purpose::STANDARD;
use base64::read::DecoderReader;

const MAX_SAVE_BYTES: u64 = 256 * 1024 * 1024;

#[tauri::command]
pub async fn pick_local_directory() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("选择工作目录")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "网页地址格式无效".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.host_str().is_none()
    {
        return Err("只允许打开不含认证信息的 HTTP 或 HTTPS 网页".to_owned());
    }
    std::process::Command::new("xdg-open")
        .arg(parsed.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "无法调用系统默认浏览器".to_owned())
}

#[tauri::command]
pub async fn save_remote_file(
    data_base64: String,
    suggested_name: String,
    allow_large: bool,
) -> Result<Option<String>, String> {
    let estimated_size = (data_base64.len() as u64 / 4).saturating_mul(3);
    if estimated_size > MAX_SAVE_BYTES && !allow_large {
        return Err("文件超过 256 MiB 默认保存上限".to_owned());
    }
    let file_name = sanitize_file_name(&suggested_name);
    let Some(target) = rfd::AsyncFileDialog::new()
        .set_title("另存远程文件")
        .set_file_name(&file_name)
        .save_file()
        .await
    else {
        return Ok(None);
    };

    let token = uuid::Uuid::new_v4();
    let temporary_path = crate::local_data::temporary_directory()
        .map_err(|_| "无法创建受控临时目录".to_owned())?
        .join(format!("{token}.tmp"));
    let result = write_saved_file(
        &data_base64,
        target.path(),
        &temporary_path,
        token,
        allow_large,
    );
    let _ = std::fs::remove_file(&temporary_path);
    result.map(|()| Some(target.path().to_string_lossy().into_owned()))
}

fn write_saved_file(
    data_base64: &str,
    target: &std::path::Path,
    temporary_path: &std::path::Path,
    token: uuid::Uuid,
    allow_large: bool,
) -> Result<(), String> {
    let mut temporary = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary_path)
        .map_err(|_| "无法创建受控临时文件".to_owned())?;
    let mut decoder = DecoderReader::new(data_base64.as_bytes(), &STANDARD);
    let decoded_bytes = io::copy(&mut decoder, &mut temporary)
        .map_err(|_| "远程文件内容不是有效 Base64 数据".to_owned())?;
    if decoded_bytes > MAX_SAVE_BYTES && !allow_large {
        return Err("文件超过 256 MiB 默认保存上限".to_owned());
    }
    temporary
        .sync_all()
        .map_err(|_| "无法写入受控临时文件".to_owned())?;
    drop(temporary);

    let parent = target
        .parent()
        .ok_or_else(|| "保存位置没有有效父目录".to_owned())?;
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "保存文件名无效".to_owned())?;
    let adjacent_path = parent.join(format!(".{target_name}.codex-{token}.tmp"));
    let copy_result = (|| -> io::Result<()> {
        std::fs::copy(temporary_path, &adjacent_path)?;
        OpenOptions::new()
            .read(true)
            .open(&adjacent_path)?
            .sync_all()?;
        std::fs::rename(&adjacent_path, target)?;
        Ok(())
    })();
    if copy_result.is_err() {
        let _ = std::fs::remove_file(&adjacent_path);
        return Err("无法将远程文件保存到所选位置".to_owned());
    }
    Ok(())
}

fn sanitize_file_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | '\0'..='\u{1f}' | '\u{7f}' => '_',
            _ => character,
        })
        .take(180)
        .collect();
    let sanitized = sanitized.trim().trim_matches('.');
    if sanitized.is_empty() {
        "remote-file".to_owned()
    } else {
        sanitized.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_file_name;

    #[test]
    fn sanitizes_suggested_file_names() {
        assert_eq!(sanitize_file_name("../../secret.txt"), "_.._secret.txt");
        assert_eq!(sanitize_file_name("..."), "remote-file");
        assert_eq!(sanitize_file_name("image.png"), "image.png");
    }
}
