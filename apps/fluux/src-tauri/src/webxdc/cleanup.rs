use crate::webxdc::storage::WebxdcStorage;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tracing::{debug, error, info, warn};

pub fn start_cleanup_task(
    temp_dir: PathBuf,
    storage: Arc<WebxdcStorage>,
    windows: Arc<Mutex<HashMap<String, String>>>,
) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));

        loop {
            interval.tick().await;

            match cleanup_old_instances(&temp_dir, &storage, &windows).await {
                Ok(count) => {
                    if count > 0 {
                        info!("Cleaned up {} stale webxdc instances", count);
                    }
                }
                Err(e) => {
                    error!("Webxdc cleanup task error: {}", e);
                }
            }
        }
    })
}

async fn cleanup_old_instances(
    _temp_dir: &Path,
    storage: &WebxdcStorage,
    windows: &Arc<Mutex<HashMap<String, String>>>,
) -> Result<usize, Box<dyn std::error::Error>> {
    let stale_instances = storage.get_stale_instances(Duration::from_secs(24 * 3600))?;

    // Collect paths to delete outside the lock
    let paths_to_delete: Vec<String> = {
        let open_windows = windows.lock().unwrap();
        stale_instances
            .into_iter()
            .filter(|instance| !open_windows.contains_key(&instance.instance_id))
            .map(|instance| instance.extract_path)
            .collect()
    };

    let mut cleaned = 0;

    for path_str in paths_to_delete {
        let path = Path::new(&path_str);
        if path.exists() {
            match tokio::fs::remove_dir_all(path).await {
                Ok(_) => {
                    debug!("Deleted stale webxdc: {}", path_str);
                    cleaned += 1;
                }
                Err(e) => {
                    warn!("Failed to delete {}: {}", path_str, e);
                }
            }
        }
    }

    Ok(cleaned)
}
