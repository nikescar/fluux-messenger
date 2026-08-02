pub mod storage;
pub mod api;
pub mod extraction;
pub mod window;
pub mod cleanup;
pub mod http_server;
pub mod realtime;
pub mod realtime_thread;

pub use storage::{WebxdcStorage, UpdateInput, WebxdcUpdate};
pub use extraction::{extract_webxdc, ExtractionResult, WebxdcManifest};
pub use window::open_or_focus_window;
pub use cleanup::start_cleanup_task;
pub use http_server::WebxdcHttpServer;
pub use realtime::RealtimeChannelManager;
pub use realtime_thread::ThreadRealtimeManager;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri::async_runtime::JoinHandle;
use base64::Engine;
use once_cell::sync::Lazy;
use serde::Serialize;

#[derive(serde::Deserialize, Clone)]
pub struct FileData {
    pub name: String,
    pub base64: String,
}

#[derive(serde::Serialize, Clone)]
struct SendToChatEvent {
    conversation_id: String,
    file_path: Option<String>,
    text: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ImportFilesResult {
    pub files: Vec<FileInfo>,
}

#[derive(serde::Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub mime_type: String,
    pub last_modified: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct FileContent {
    pub base64: String,
}

#[derive(serde::Serialize, Clone)]
struct ThreadJoinEvent {
    instance_id: String,
    conversation_id: String,
    thread_id: String,
}

#[derive(serde::Serialize, Clone)]
struct ThreadSendEvent {
    conversation_id: String,
    thread_id: String,
    data: String,
}

#[derive(serde::Serialize, Clone)]
struct ThreadLeaveEvent {
    instance_id: String,
}

#[derive(serde::Serialize, Clone)]
struct RealtimeMessageEvent {
    instance_id: String,
    data: String,
}

#[derive(serde::Serialize)]
pub struct SendUpdateResult {
    pub serial: i64,
    pub thread_id: String,
}

static HTTP_SERVER: Lazy<WebxdcHttpServer> = Lazy::new(|| {
    WebxdcHttpServer::start()
        .expect("Failed to start WebXDC HTTP server")
});

pub fn get_http_server() -> &'static WebxdcHttpServer {
    &HTTP_SERVER
}

pub struct WebxdcState {
    pub windows: Arc<Mutex<HashMap<String, String>>>,
    pub storage: Arc<WebxdcStorage>,
    #[allow(dead_code)]
    pub cleanup_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
    #[allow(dead_code)]
    pub realtime_manager: Arc<RealtimeChannelManager>,
    pub thread_realtime_manager: Arc<ThreadRealtimeManager>,
}

pub fn initialize_webxdc_state(app: &AppHandle) -> WebxdcState {
    let data_dir = app.path().app_data_dir()
        .expect("Failed to get app data dir");

    std::fs::create_dir_all(&data_dir).ok();

    let storage = WebxdcStorage::new(data_dir)
        .expect("Failed to initialize webxdc storage");

    let temp_dir = std::env::temp_dir().join("fluux-webxdc");
    std::fs::create_dir_all(&temp_dir).ok();

    let windows = Arc::new(Mutex::new(HashMap::new()));
    let storage = Arc::new(storage);

    let cleanup_handle = Arc::new(Mutex::new(Some(
        start_cleanup_task(temp_dir, storage.clone(), windows.clone())
    )));

    let realtime_manager = Arc::new(RealtimeChannelManager::new());
    let thread_realtime_manager = Arc::new(ThreadRealtimeManager::new());

    WebxdcState {
        windows,
        storage,
        cleanup_handle,
        realtime_manager,
        thread_realtime_manager,
    }
}

#[tauri::command]
pub async fn webxdc_extract(
    url: String,
    instance_id: String,
    conversation_id: String,
    filename: String,
    decrypt_key: Option<String>,
    decrypt_iv: Option<String>,
    _state: State<'_, WebxdcState>,
) -> Result<ExtractionResult, String> {
    let decrypt = if let (Some(key_b64), Some(iv_b64)) = (decrypt_key, decrypt_iv) {
        let key_bytes = base64::engine::general_purpose::STANDARD.decode(key_b64)
            .map_err(|e| format!("Invalid decrypt key: {}", e))?;
        let iv_bytes = base64::engine::general_purpose::STANDARD.decode(iv_b64)
            .map_err(|e| format!("Invalid decrypt IV: {}", e))?;

        if key_bytes.len() != 32 {
            return Err("Decrypt key must be 32 bytes".to_string());
        }
        if iv_bytes.len() != 12 {
            return Err("Decrypt IV must be 12 bytes".to_string());
        }

        let mut key = [0u8; 32];
        let mut iv = [0u8; 12];
        key.copy_from_slice(&key_bytes);
        iv.copy_from_slice(&iv_bytes);

        Some((key, iv))
    } else {
        None
    };

    extract_webxdc(&url, &instance_id, &conversation_id, &filename, decrypt)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn webxdc_open_window(
    instance_id: String,
    extract_path: String,
    self_addr: String,
    self_name: String,
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<String, String> {
    let manifest = WebxdcManifest {
        name: instance_id.split(':').next().unwrap_or("Webxdc App").to_string(),
        icon: None,
        min_api: None,
        source_code_url: None,
    };

    open_or_focus_window(
        &app_handle,
        &instance_id,
        &extract_path,
        &self_addr,
        &self_name,
        &manifest,
        state.windows.clone(),
    ).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn webxdc_send_update(
    instance_id: String,
    payload: serde_json::Value,
    info: Option<String>,
    document: Option<String>,
    summary: Option<String>,
    sender_id: String,
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<SendUpdateResult, String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let update = UpdateInput {
        payload: payload.clone(),
        info: info.clone(),
        document: document.clone(),
        summary: summary.clone(),
        sender: sender_id.clone(),
        timestamp,
    };

    let saved = state.storage.save_update(&instance_id, update)
        .map_err(|e| e.to_string())?;

    let thread_id = state.storage.get_or_create_thread_id(&instance_id)
        .map_err(|e| e.to_string())?;

    // Emit event to frontend for XMPP transmission
    #[derive(serde::Serialize, Clone)]
    struct OutgoingUpdateEvent {
        instance_id: String,
        serial: i64,
        payload: serde_json::Value,
        info: Option<String>,
        document: Option<String>,
        summary: Option<String>,
        sender: String,
        thread_id: String,
    }

    let event = OutgoingUpdateEvent {
        instance_id: instance_id.clone(),
        serial: saved.serial,
        payload,
        info,
        document,
        summary,
        sender: sender_id,
        thread_id: thread_id.clone(),
    };

    app_handle.emit("fluux://webxdc-outgoing-update", event)
        .map_err(|e| format!("Failed to emit outgoing update event: {}", e))?;

    // Also notify open webxdc windows for local echo
    #[derive(serde::Serialize, Clone)]
    struct WindowUpdateEvent {
        #[serde(rename = "instanceId")]
        instance_id: String,
        update: WebxdcUpdate,
    }

    let window_event = WindowUpdateEvent {
        instance_id: instance_id.clone(),
        update: WebxdcUpdate {
            serial: saved.serial,
            max_serial: saved.max_serial,
            payload: saved.payload,
            info: saved.info,
            document: saved.document,
            summary: saved.summary,
            sender: saved.sender.clone(),
            timestamp: saved.timestamp,
        },
    };

    let _ = app_handle.emit("webxdc_update", window_event);

    Ok(SendUpdateResult { serial: saved.serial, thread_id })
}

#[tauri::command]
pub async fn webxdc_get_updates(
    instance_id: String,
    from_serial: Option<i64>,
    state: State<'_, WebxdcState>,
) -> Result<Vec<WebxdcUpdate>, String> {
    state.storage.get_updates(&instance_id, from_serial)
        .map_err(|e| e.to_string())
}

/// Receive an update from XMPP and notify open windows.
/// This is called by the frontend when an XMPP message with webxdc update arrives.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn webxdc_receive_update(
    instance_id: String,
    payload: serde_json::Value,
    info: Option<String>,
    document: Option<String>,
    summary: Option<String>,
    sender_id: String,
    timestamp: i64,
    thread_id: Option<String>,
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<(), String> {
    let update = UpdateInput {
        payload: payload.clone(),
        info: info.clone(),
        document: document.clone(),
        summary: summary.clone(),
        sender: sender_id.clone(),
        timestamp,
    };

    let saved = state.storage.save_update(&instance_id, update)
        .map_err(|e| e.to_string())?;

    if let Some(tid) = thread_id.as_deref() {
        state.storage.set_thread_id_if_absent(&instance_id, tid)
            .map_err(|e| e.to_string())?;
    }

    // Notify open webxdc windows
    #[derive(serde::Serialize, Clone)]
    struct WindowUpdateEvent {
        #[serde(rename = "instanceId")]
        instance_id: String,
        update: WebxdcUpdate,
    }

    let window_event = WindowUpdateEvent {
        instance_id: instance_id.clone(),
        update: WebxdcUpdate {
            serial: saved.serial,
            max_serial: saved.max_serial,
            payload: saved.payload,
            info: saved.info,
            document: saved.document,
            summary: saved.summary,
            sender: saved.sender.clone(),
            timestamp: saved.timestamp,
        },
    };

    app_handle.emit("webxdc_update", window_event)
        .map_err(|e| format!("Failed to emit window update event: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn webxdc_close_window(
    instance_id: String,
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<(), String> {
    let mut windows = state.windows.lock().unwrap();
    windows.remove(&instance_id);

    // Leave realtime channel if joined
    if state.thread_realtime_manager.leave(&instance_id).is_some() {
        let _ = app_handle.emit("fluux://webxdc-realtime-leave", ThreadLeaveEvent {
            instance_id: instance_id.clone(),
        });
    }

    // Update last_opened timestamp for cleanup
    // This would ideally update metadata, but we're keeping it simple for now

    Ok(())
}

#[tauri::command]
pub async fn webxdc_realtime_join(
    instance_id: String,
    conversation_id: String,
    _self_addr: String,
    _self_name: String,
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<(), String> {
    let thread_id = state.storage.get_or_create_thread_id(&instance_id)
        .map_err(|e| e.to_string())?;

    state.thread_realtime_manager.join(instance_id.clone(), conversation_id.clone(), thread_id.clone());

    app_handle.emit("fluux://webxdc-realtime-join", ThreadJoinEvent {
        instance_id,
        conversation_id,
        thread_id,
    }).map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn webxdc_realtime_send(
    instance_id: String,
    data: String, // base64-encoded
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<(), String> {
    let (conversation_id, thread_id) = state.thread_realtime_manager
        .get(&instance_id)
        .ok_or_else(|| "Not joined to any channel".to_string())?;

    app_handle.emit("fluux://webxdc-realtime-send", ThreadSendEvent {
        conversation_id,
        thread_id,
        data,
    }).map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn webxdc_realtime_leave(
    instance_id: String,
    app_handle: AppHandle,
    state: State<'_, WebxdcState>,
) -> Result<(), String> {
    if state.thread_realtime_manager.leave(&instance_id).is_some() {
        app_handle.emit("fluux://webxdc-realtime-leave", ThreadLeaveEvent {
            instance_id,
        }).map_err(|e| format!("Failed to emit event: {}", e))?;
    }

    Ok(())
}

/// Called by frontend when XMPP room message arrives
#[tauri::command]
pub async fn webxdc_realtime_receive(
    instance_id: String,
    data: String, // base64
    app_handle: AppHandle,
) -> Result<(), String> {
    // Emit to WebXDC window
    app_handle.emit("webxdc_realtime_message", RealtimeMessageEvent {
        instance_id,
        data,
    }).map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn webxdc_import_files(
    instance_id: String,
    extensions: Option<Vec<String>>,
    _mime_types: Option<Vec<String>>,
    multiple: bool,
    app_handle: AppHandle,
) -> Result<ImportFilesResult, String> {
    use tauri_plugin_dialog::DialogExt;

    // Build file dialog
    let mut dialog = app_handle.dialog().file();

    if let Some(exts) = extensions {
        // Convert extensions like [".jpg", ".png"] to filter
        let extensions_clean: Vec<String> = exts.iter()
            .map(|e| e.trim_start_matches('.').to_string())
            .collect();

        if !extensions_clean.is_empty() {
            let ext_refs: Vec<&str> = extensions_clean.iter().map(|s| s.as_str()).collect();
            dialog = dialog.add_filter("Allowed files", &ext_refs);
        }
    }

    // Show file picker using blocking mode
    let file_paths = if multiple {
        dialog.blocking_pick_files()
            .ok_or_else(|| "No files selected".to_string())?
    } else {
        dialog.blocking_pick_file()
            .map(|p| vec![p])
            .ok_or_else(|| "No files selected".to_string())?
    };

    // Copy files to WebXDC temp directory for sandboxed access
    let temp_dir = std::env::temp_dir()
        .join("fluux-webxdc-imports")
        .join(&instance_id);
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let mut file_infos = Vec::new();

    for original_path in file_paths {
        // Convert FilePath to PathBuf
        let path_buf = original_path.into_path()
            .map_err(|e| format!("Invalid file path: {}", e))?;

        let file_name = path_buf.file_name()
            .ok_or_else(|| "Invalid file name".to_string())?
            .to_string_lossy()
            .to_string();

        let dest_path = temp_dir.join(&file_name);

        std::fs::copy(&path_buf, &dest_path)
            .map_err(|e| format!("Failed to copy file: {}", e))?;

        let metadata = std::fs::metadata(&dest_path)
            .map_err(|e| format!("Failed to read metadata: {}", e))?;

        let mime_type = mime_guess::from_path(&dest_path)
            .first_or_octet_stream()
            .to_string();

        file_infos.push(FileInfo {
            path: dest_path.to_string_lossy().to_string(),
            name: file_name,
            mime_type,
            last_modified: metadata.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        });
    }

    Ok(ImportFilesResult { files: file_infos })
}

#[tauri::command]
pub async fn webxdc_read_imported_file(
    file_path: String,
) -> Result<FileContent, String> {
    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(FileContent { base64 })
}

#[tauri::command]
pub async fn webxdc_send_to_chat(
    instance_id: String,
    conversation_id: String,
    file_data: Option<FileData>,
    text: Option<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    // 1. If file provided, save it to temp directory
    let file_path = if let Some(file) = file_data {
        let temp_dir = std::env::temp_dir()
            .join("fluux-webxdc-export")
            .join(&instance_id);
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to create temp dir: {}", e))?;

        let file_path = temp_dir.join(&file.name);

        // Decode base64 and write
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&file.base64)
            .map_err(|e| format!("Invalid base64: {}", e))?;

        std::fs::write(&file_path, bytes)
            .map_err(|e| format!("Failed to write file: {}", e))?;

        Some(file_path.to_string_lossy().to_string())
    } else {
        None
    };

    // 2. Emit event to frontend to handle message creation
    app_handle.emit("fluux://webxdc-send-to-chat", SendToChatEvent {
        conversation_id,
        file_path,
        text,
    }).map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod send_to_chat_tests {
    use super::*;

    #[test]
    fn test_file_data_base64_encode() {
        let content = "test content";
        let base64_encoded = base64::engine::general_purpose::STANDARD.encode(content);

        let file_data = FileData {
            name: "test.txt".to_string(),
            base64: base64_encoded.clone(),
        };

        assert_eq!(file_data.name, "test.txt");
        assert_eq!(file_data.base64, base64_encoded);
    }

    #[test]
    fn test_send_to_chat_event_serialization() {
        let event = SendToChatEvent {
            conversation_id: "conv@example.com".to_string(),
            file_path: Some("/tmp/test.txt".to_string()),
            text: Some("Hello!".to_string()),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("conv@example.com"));
        assert!(json.contains("/tmp/test.txt"));
        assert!(json.contains("Hello!"));
    }

    #[test]
    fn test_file_data_invalid_base64() {
        let file_data = FileData {
            name: "test.txt".to_string(),
            base64: "invalid!!!base64".to_string(),
        };

        let result = base64::engine::general_purpose::STANDARD.decode(&file_data.base64);
        assert!(result.is_err());
    }
}

#[cfg(test)]
mod import_files_tests {
    use super::*;

    #[tokio::test]
    async fn test_read_imported_file() {
        // Create temp test file
        let temp_dir = tempfile::tempdir().unwrap();
        let test_file = temp_dir.path().join("test.txt");
        std::fs::write(&test_file, b"test content").unwrap();

        let result = webxdc_read_imported_file(
            test_file.to_string_lossy().to_string()
        ).await;

        assert!(result.is_ok());
        let content = result.unwrap();

        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&content.base64)
            .unwrap();
        assert_eq!(decoded, b"test content");
    }

    #[tokio::test]
    async fn test_read_nonexistent_file() {
        let result = webxdc_read_imported_file(
            "/nonexistent/path/file.txt".to_string()
        ).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to read file"));
    }
}

/// Reverse lookup: find instance_id by thread_id (for incoming Cheogram updates).
#[tauri::command]
pub async fn webxdc_get_instance_by_thread(
    thread_id: String,
    state: State<'_, WebxdcState>,
) -> Result<serde_json::Value, String> {
    let instance_id = state.storage.get_instance_by_thread(&thread_id)
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "instance_id": instance_id }))
}

/// Save thread→instance mapping when opening a webxdc attachment that carries
/// a `<thread>` (Cheogram interop). First-write-wins, so if we already have a
/// thread for this instance, this is a no-op.
#[tauri::command]
pub async fn webxdc_set_thread_for_instance(
    instance_id: String,
    thread_id: String,
    state: State<'_, WebxdcState>,
) -> Result<(), String> {
    state.storage.set_thread_id_if_absent(&instance_id, &thread_id)
        .map_err(|e| e.to_string())
}

// Helper struct for manifest response
#[derive(Serialize)]
pub struct ManifestData {
    pub name: String,
    pub icon: Option<String>,
}

// Helper struct for hash response
#[derive(Serialize)]
pub struct HashData {
    pub sha256: String,
}

// Helper struct for new instance response
#[derive(Serialize)]
pub struct NewInstanceData {
    pub instance_id: String,
}

// Helper to decode base64 key
fn decode_base64_key(key_str: &str) -> Result<[u8; 32], String> {
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(key_str)
        .map_err(|_| "Invalid base64 key")?;

    let key: [u8; 32] = decoded.as_slice().try_into()
        .map_err(|_| "Key must be 32 bytes")?;

    Ok(key)
}

// Helper to decode base64 IV
fn decode_base64_iv(iv_str: &str) -> Result<[u8; 12], String> {
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(iv_str)
        .map_err(|_| "Invalid base64 IV")?;

    let iv: [u8; 12] = decoded.as_slice().try_into()
        .map_err(|_| "IV must be 12 bytes")?;

    Ok(iv)
}

#[tauri::command]
pub async fn webxdc_extract_manifest(
    url: String,
    filename: String,
    decrypt_key: Option<String>,
    decrypt_iv: Option<String>,
) -> Result<ManifestData, String> {
    let decrypt = match (decrypt_key, decrypt_iv) {
        (Some(key_str), Some(iv_str)) => {
            let key = decode_base64_key(&key_str)?;
            let iv = decode_base64_iv(&iv_str)?;
            Some((key, iv))
        }
        _ => None,
    };

    let manifest = extraction::extract_manifest_only(&url, &filename, decrypt)
        .await
        .map_err(|e| e.to_string())?;

    Ok(ManifestData {
        name: manifest.name,
        icon: manifest.icon,
    })
}

#[tauri::command]
pub async fn webxdc_compute_hash(
    url: String,
    decrypt_key: Option<String>,
    decrypt_iv: Option<String>,
) -> Result<HashData, String> {
    let decrypt = match (decrypt_key, decrypt_iv) {
        (Some(key_str), Some(iv_str)) => {
            let key = decode_base64_key(&key_str)?;
            let iv = decode_base64_iv(&iv_str)?;
            Some((key, iv))
        }
        _ => None,
    };

    let sha256 = extraction::compute_file_hash(&url, decrypt)
        .await
        .map_err(|e| e.to_string())?;

    Ok(HashData { sha256 })
}

#[tauri::command]
pub async fn webxdc_create_new_instance(
    base_instance_id: String,
    state: State<'_, WebxdcState>,
) -> Result<NewInstanceData, String> {
    // Generate new instance ID with same conversation prefix but new UUID suffix
    let parts: Vec<&str> = base_instance_id.split(':').collect();
    if parts.len() != 2 {
        return Err("Invalid instance ID format".to_string());
    }

    let conversation_id = parts[0];
    let new_uuid = uuid::Uuid::new_v4().to_string();
    let new_instance_id = format!("{}:{}", conversation_id, new_uuid);

    // Copy update database from base instance
    let storage = &state.storage;
    storage.clone_instance(&base_instance_id, &new_instance_id)
        .map_err(|e| format!("Failed to clone instance: {}", e))?;

    Ok(NewInstanceData {
        instance_id: new_instance_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_http_server_singleton() {
        let server1 = get_http_server();
        let server2 = get_http_server();

        assert_eq!(server1.port(), server2.port());
    }
}
