use crate::webxdc::api;
use crate::webxdc::extraction::WebxdcManifest;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[derive(Clone, serde::Serialize)]
struct WindowClosedEvent {
    instance_id: String,
    closed_at: u64,
}

pub async fn open_or_focus_window(
    app: &AppHandle,
    instance_id: &str,
    extract_path: &str,
    self_addr: &str,
    self_name: &str,
    manifest: &WebxdcManifest,
    registry: Arc<Mutex<HashMap<String, String>>>,
) -> Result<String, String> {
    let mut windows = registry.lock().unwrap();

    if let Some(label) = windows.get(instance_id) {
        if let Some(window) = app.get_webview_window(label) {
            window.set_focus().map_err(|e| e.to_string())?;
            return Ok(label.clone());
        } else {
            windows.remove(instance_id);
        }
    }

    let label = format!("webxdc-{}", sanitize_label(instance_id));

    // Generate token and hash
    let token = generate_token();
    let hash = compute_instance_hash(instance_id);

    // Register with HTTP server
    let http_server = crate::webxdc::get_http_server();
    http_server.register_instance(
        hash.clone(),
        token.clone(),
        std::path::PathBuf::from(extract_path),
    );

    // Build HTTP URL
    let url = format!(
        "http://127.0.0.1:{}/{}/{}/index.html",
        http_server.port(),
        hash,
        token
    );

    eprintln!("[WebXDC] Opening window: {}", url);

    // For External URLs, we must inject Tauri IPC manually
    // This is the Tauri v2 pattern for custom protocols
    let tauri_init = r#"
        window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
        window.__TAURI__ = window.__TAURI__ || {};
        window.__TAURI__.invoke = async function(cmd, args) {
            return window.__TAURI_INTERNALS__.invoke(cmd, args);
        };
        window.__TAURI__.convertFileSrc = function(filePath, protocol) {
            return window.__TAURI_INTERNALS__.convertFileSrc(filePath, protocol);
        };
    "#;

    // Extract conversation_id from instance_id (format: "conv_id:url")
    let conversation_id = instance_id.split(':').next().unwrap_or("");
    let webxdc_bridge = api::generate_api_script(instance_id, conversation_id, self_addr, self_name);
    let init_script = format!("{}\n{}", tauri_init, webxdc_bridge);

    // Create window with External URL
    let window = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?)
    )
        .title(&manifest.name)
        .inner_size(800.0, 600.0)
        .initialization_script(&init_script)
        .build()
        .map_err(|e| e.to_string())?;

    // Cleanup on close
    let instance_id_clone = instance_id.to_string();
    let registry_clone = registry.clone();
    let hash_clone = hash.clone();
    let token_clone = token.clone();
    let app_clone = app.clone();

    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { .. } = event {
            let http_server = crate::webxdc::get_http_server();
            http_server.unregister_instance(&hash_clone, &token_clone);

            let mut windows = registry_clone.lock().unwrap();
            windows.remove(&instance_id_clone);

            // Emit close event to frontend
            let closed_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;

            let _ = app_clone.emit("fluux://webxdc-window-closed", WindowClosedEvent {
                instance_id: instance_id_clone.clone(),
                closed_at,
            });

            // Note: Realtime channel cleanup is handled by the WebxdcState
            // when webxdc_close_window command is called by frontend.
            // The close handler in mod.rs will call state.realtime_manager.leave()
            // For this window event, we just log that cleanup should happen.
            eprintln!("[WebXDC] Window closed: {}", instance_id_clone);
        }
    });

    windows.insert(instance_id.to_string(), label.clone());

    Ok(label)
}

pub fn sanitize_label(instance_id: &str) -> String {
    instance_id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .collect()
}

fn generate_token() -> String {
    format!("{:032x}", rand::random::<u128>())
}

fn compute_instance_hash(instance_id: &str) -> String {
    use sha2::{Sha256, Digest};

    // Hash the full instance_id to ensure uniqueness per app instance.
    // Different instances of the same app URL must get different hashes
    // for proper HTTP server routing isolation (matches extraction.rs logic).
    let mut hasher = Sha256::new();
    hasher.update(instance_id.as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_label() {
        assert_eq!(sanitize_label("chat@example.com:https://url"), "chat_example_com_https___url");
        assert_eq!(sanitize_label("simple-id-123"), "simple-id-123");
    }

    #[test]
    fn test_generate_token() {
        let token1 = generate_token();
        let token2 = generate_token();

        assert_eq!(token1.len(), 32);
        assert_ne!(token1, token2);
        assert!(token1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_compute_instance_hash() {
        // Same instance should produce same hash
        let hash1 = compute_instance_hash("test:https://example.com/app.xdc");
        let hash2 = compute_instance_hash("test:https://example.com/app.xdc");
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_compute_instance_hash_different_instances_same_app() {
        // Different instances of the same app should produce DIFFERENT hashes
        // This is critical - each thread/instance must get its own hash for HTTP routing
        let instance1 = "nikescar@conversations.im:https://partage.jabberfr.org/019fb66c-8407-7399-8114-6bc2b4b58afb/app.xdc";
        let instance2 = "nikescar@conversations.im:https://partage.jabberfr.org/019fb4d7-46b6-7fbe-b242-3e153a16df0b/app.xdc";

        let hash1 = compute_instance_hash(instance1);
        let hash2 = compute_instance_hash(instance2);

        assert_ne!(hash1, hash2,
            "Different instances must have different hashes for HTTP server routing isolation");
    }
}
