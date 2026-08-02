use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use zip::ZipArchive;

const MAX_EXTRACTED_SIZE: u64 = 50 * 1024 * 1024;
const MAX_FILE_COUNT: usize = 1000;
const MAX_ICON_SIZE: u64 = 512 * 1024; // 512 KB — webxdc icons are small; anything larger is treated as absent.

#[derive(Debug, Error)]
pub enum ExtractionError {
    #[error("Download failed: {0}")]
    Download(String),

    #[error("Decryption failed: {0}")]
    Decryption(String),

    #[error("Invalid ZIP structure: {0}")]
    InvalidZip(String),

    #[error("Missing required file: index.html")]
    MissingIndexHtml,

    #[error("Unsafe filename detected: {0}")]
    UnsafeFilename(String),

    #[error("Extraction size limit exceeded")]
    SizeLimit,

    #[error("File count limit exceeded")]
    FileCountLimit,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WebxdcManifest {
    pub name: String,
    pub icon: Option<String>,
    pub min_api: Option<u32>,
    pub source_code_url: Option<String>,
}

fn sanitize_filename(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("Empty filename".to_string());
    }

    let normalized: String = path.nfc().collect();

    if normalized.contains('\0') {
        return Err("Null byte in filename".to_string());
    }

    if normalized.starts_with('/')
        || normalized.starts_with('\\')
        || (normalized.len() >= 2 && normalized.chars().nth(1) == Some(':'))
    {
        return Err("Absolute path".to_string());
    }

    for component in Path::new(&normalized).components() {
        match component {
            Component::ParentDir => return Err("Path traversal (..)".to_string()),
            Component::CurDir => return Err("Current dir (.)".to_string()),
            _ => {}
        }
    }

    Ok(PathBuf::from(normalized))
}

fn parse_manifest(toml_content: &str, fallback_name: &str) -> WebxdcManifest {
    match toml::from_str::<WebxdcManifest>(toml_content) {
        Ok(mut manifest) => {
            if manifest.name.is_empty() {
                manifest.name = fallback_name.to_string();
            }
            manifest
        }
        Err(_) => WebxdcManifest {
            name: fallback_name.to_string(),
            icon: None,
            min_api: None,
            source_code_url: None,
        },
    }
}

fn icon_mime_type(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// Read the icon file referenced by `icon_path` out of `archive` and return it
/// as a base64 `data:` URI. Returns `None` (never an error) on any failure —
/// missing file, oversized, or unreadable — so a broken icon never blocks
/// manifest extraction.
fn extract_icon_data_uri<R: std::io::Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    icon_path: &str,
) -> Option<String> {
    let mut file = archive.by_name(icon_path).ok()?;

    if file.size() > MAX_ICON_SIZE {
        return None;
    }

    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut bytes).ok()?;

    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", icon_mime_type(icon_path), encoded))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExtractionResult {
    pub extract_path: String,
    pub manifest: WebxdcManifest,
}

pub async fn extract_webxdc(
    url: &str,
    instance_id: &str,
    conversation_id: &str,
    filename: &str,
    decrypt: Option<([u8; 32], [u8; 12])>,
) -> Result<ExtractionResult, ExtractionError> {
    // Step 1: Generate extraction path (moved before download for cache check)
    // Hash the full instance_id to ensure uniqueness per app instance
    let hash = {
        let mut hasher = Sha256::new();
        hasher.update(instance_id.as_bytes());
        format!("{:x}", hasher.finalize())[..16].to_string()
    };
    let extract_path = std::env::temp_dir()
        .join("fluux-webxdc")
        .join(conversation_id)
        .join(hash);

    // Step 2: Check if already extracted (cache hit)
    let index_path = extract_path.join("index.html");
    if index_path.exists() {
        // Already extracted, read cached manifest
        let manifest_path = extract_path.join("manifest.toml");
        let manifest_content = if manifest_path.exists() {
            std::fs::read_to_string(&manifest_path).unwrap_or_default()
        } else {
            String::new()
        };
        let manifest = parse_manifest(&manifest_content, filename);

        return Ok(ExtractionResult {
            extract_path: extract_path.to_string_lossy().to_string(),
            manifest,
        });
    }

    // Step 3: Cache miss - download file
    let bytes = download_file(url, decrypt).await?;

    // Step 4: Unzip in memory
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|e| ExtractionError::InvalidZip(e.to_string()))?;

    // Step 5: Validate index.html exists
    let has_index = (0..archive.len()).any(|i| {
        archive.by_index(i).ok()
            .map(|f| f.name() == "index.html")
            .unwrap_or(false)
    });

    if !has_index {
        return Err(ExtractionError::MissingIndexHtml);
    }

    // Step 6: Extract files
    std::fs::create_dir_all(&extract_path)
        .map_err(|e| ExtractionError::InvalidZip(format!("Failed to create dir: {}", e)))?;

    let mut manifest_content = String::new();
    let mut total_size: u64 = 0;

    if archive.len() > MAX_FILE_COUNT {
        return Err(ExtractionError::FileCountLimit);
    }

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| ExtractionError::InvalidZip(e.to_string()))?;

        if file.is_dir() {
            continue;
        }

        let sanitized = sanitize_filename(file.name())
            .map_err(|e| ExtractionError::UnsafeFilename(format!("{}: {}", file.name(), e)))?;

        total_size += file.size();
        if total_size > MAX_EXTRACTED_SIZE {
            return Err(ExtractionError::SizeLimit);
        }

        let target_path = extract_path.join(&sanitized);

        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ExtractionError::InvalidZip(format!("Failed to create parent dir: {}", e)))?;
        }

        let mut contents = Vec::new();
        file.read_to_end(&mut contents)
            .map_err(|e| ExtractionError::InvalidZip(e.to_string()))?;

        // Rewrite absolute paths in HTML/CSS/JS files to be relative
        if sanitized.to_str() == Some("index.html")
            || sanitized.extension().and_then(|s| s.to_str()) == Some("html")
            || sanitized.extension().and_then(|s| s.to_str()) == Some("css")
            || sanitized.extension().and_then(|s| s.to_str()) == Some("js") {
            let content_str = String::from_utf8_lossy(&contents);
            // Replace common absolute path patterns
            let modified = content_str
                .replace("src=\"/", "src=\"./")
                .replace("href=\"/", "href=\"./")
                .replace("from \"/", "from \"./")
                .replace("from'/", "from'./")
                .replace("import \"/", "import \"./")
                .replace("import'/", "import'./");
            contents = modified.into_bytes();
        }

        std::fs::write(&target_path, &contents)
            .map_err(|e| ExtractionError::InvalidZip(format!("Failed to write file: {}", e)))?;

        if sanitized.to_str() == Some("manifest.toml") {
            manifest_content = String::from_utf8_lossy(&contents).to_string();
        }
    }

    // Step 7: Parse manifest
    let manifest = parse_manifest(&manifest_content, filename);

    // Step 8: Create webxdc.js placeholder
    // Some webxdc apps reference webxdc.js as a file even though it's injected
    // Create an empty file to prevent 404 errors (the real API is injected via initialization_script)
    let webxdc_js_path = extract_path.join("webxdc.js");
    std::fs::write(&webxdc_js_path, "// webxdc API injected by Tauri\n")
        .map_err(|e| ExtractionError::InvalidZip(format!("Failed to create webxdc.js: {}", e)))?;

    Ok(ExtractionResult {
        extract_path: extract_path.to_string_lossy().to_string(),
        manifest,
    })
}

async fn download_file(
    url: &str,
    decrypt: Option<([u8; 32], [u8; 12])>,
) -> Result<Vec<u8>, ExtractionError> {
    // Use reqwest to download the file
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| ExtractionError::Download(format!("Failed to build HTTP client: {}", e)))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| ExtractionError::Download(format!("GET request failed: {}", e)))?;

    if !response.status().is_success() {
        return Err(ExtractionError::Download(format!(
            "HTTP {}",
            response.status().as_u16()
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| ExtractionError::Download(format!("Failed to read response body: {}", e)))?
        .to_vec();

    // Decrypt if needed
    if let Some((key, iv)) = decrypt {
        use aes_gcm::aead::Aead;
        use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};

        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(key));
        let nonce = Nonce::try_from(iv.as_slice())
            .map_err(|_| ExtractionError::Decryption("Invalid nonce size".to_string()))?;
        cipher
            .decrypt(&nonce, bytes.as_ref())
            .map_err(|_| ExtractionError::Decryption(
                "AES-GCM decryption failed (wrong key/IV or corrupt payload)".to_string()
            ))
    } else {
        Ok(bytes)
    }
}

/// Extract only the manifest from a .xdc file without full extraction.
/// Returns manifest data or falls back to filename if extraction fails.
pub async fn extract_manifest_only(
    url: &str,
    filename: &str,
    decrypt: Option<([u8; 32], [u8; 12])>,
) -> Result<WebxdcManifest, ExtractionError> {
    // Download file
    let bytes = download_file(url, decrypt).await?;

    // Unzip in memory
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|e| ExtractionError::InvalidZip(e.to_string()))?;

    // Look for manifest.toml
    let mut manifest_content = String::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| ExtractionError::InvalidZip(e.to_string()))?;

        if file.name() == "manifest.toml" {
            file.read_to_string(&mut manifest_content)
                .map_err(|e| ExtractionError::InvalidZip(e.to_string()))?;
            break;
        }
    }

    // Parse manifest (fallback to filename if missing/invalid)
    let mut manifest = parse_manifest(&manifest_content, filename);

    // manifest.icon (if present) is a path *inside the zip* per the webxdc spec —
    // resolve it to actual image bytes so the frontend can render <img src=...>
    // directly instead of just knowing a filename.
    if let Some(icon_path) = manifest.icon.clone() {
        manifest.icon = extract_icon_data_uri(&mut archive, &icon_path);
    } else {
        // Fallback: if manifest doesn't specify an icon but icon.png exists, use it.
        // Many webxdc apps have icon.png in the root but forget to add it to manifest.toml.
        manifest.icon = extract_icon_data_uri(&mut archive, "icon.png");
    }

    Ok(manifest)
}

/// Compute SHA256 hash of a .xdc file
pub async fn compute_file_hash(
    url: &str,
    decrypt: Option<([u8; 32], [u8; 12])>,
) -> Result<String, ExtractionError> {
    let bytes = download_file(url, decrypt).await?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_rejects_traversal() {
        assert!(sanitize_filename("../etc/passwd").is_err());
        assert!(sanitize_filename("../../secret").is_err());
    }

    #[test]
    fn test_sanitize_rejects_absolute_paths() {
        assert!(sanitize_filename("/etc/passwd").is_err());
        assert!(sanitize_filename("C:\\Windows\\System32").is_err());
    }

    #[test]
    fn test_sanitize_rejects_null_bytes() {
        assert!(sanitize_filename("file\0.txt").is_err());
    }

    #[test]
    fn test_sanitize_allows_subdirs() {
        assert!(sanitize_filename("css/style.css").is_ok());
        assert!(sanitize_filename("images/icon.png").is_ok());
    }

    #[test]
    fn test_parse_manifest_graceful_fallback() {
        let manifest = parse_manifest("invalid toml", "app.xdc");
        assert_eq!(manifest.name, "app.xdc");
    }

    fn build_test_xdc(manifest_toml: &str, icon: Option<(&str, &[u8])>) -> Vec<u8> {
        use std::io::Write;
        use zip::write::FileOptions;

        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = FileOptions::default();

        zip.start_file("manifest.toml", options).unwrap();
        zip.write_all(manifest_toml.as_bytes()).unwrap();

        if let Some((name, bytes)) = icon {
            zip.start_file(name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }

        zip.finish().unwrap().into_inner()
    }

    fn manifest_from_bytes(zip_bytes: Vec<u8>, filename: &str) -> WebxdcManifest {
        let cursor = std::io::Cursor::new(zip_bytes);
        let mut archive = ZipArchive::new(cursor).unwrap();

        let mut manifest_content = String::new();
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).unwrap();
            if file.name() == "manifest.toml" {
                file.read_to_string(&mut manifest_content).unwrap();
                break;
            }
        }

        let mut manifest = parse_manifest(&manifest_content, filename);
        if let Some(icon_path) = manifest.icon.clone() {
            manifest.icon = extract_icon_data_uri(&mut archive, &icon_path);
        } else {
            // Fallback: if manifest doesn't specify an icon but icon.png exists, use it
            manifest.icon = extract_icon_data_uri(&mut archive, "icon.png");
        }
        manifest
    }

    #[test]
    fn test_icon_extracted_as_data_uri() {
        let png_bytes: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]; // PNG magic bytes
        let zip_bytes = build_test_xdc(
            "name = \"Tic Tac Toe\"\nicon = \"icon.png\"\n",
            Some(("icon.png", png_bytes)),
        );

        let manifest = manifest_from_bytes(zip_bytes, "app.xdc");

        assert_eq!(manifest.name, "Tic Tac Toe");
        let icon = manifest.icon.expect("icon should be extracted");
        assert!(icon.starts_with("data:image/png;base64,"));
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(icon.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        assert_eq!(decoded, png_bytes);
    }

    #[test]
    fn test_icon_none_when_manifest_has_no_icon_field() {
        let zip_bytes = build_test_xdc("name = \"No Icon App\"\n", None);
        let manifest = manifest_from_bytes(zip_bytes, "app.xdc");

        assert_eq!(manifest.name, "No Icon App");
        assert!(manifest.icon.is_none());
    }

    #[test]
    fn test_icon_none_when_path_missing_from_zip() {
        let zip_bytes = build_test_xdc(
            "name = \"Broken Icon\"\nicon = \"missing.png\"\n",
            None, // manifest references icon.png but it's never added to the zip
        );
        let manifest = manifest_from_bytes(zip_bytes, "app.xdc");

        assert_eq!(manifest.name, "Broken Icon");
        assert!(manifest.icon.is_none());
    }

    #[test]
    fn test_icon_none_when_file_exceeds_size_limit() {
        let oversized = vec![0u8; (MAX_ICON_SIZE + 1) as usize];
        let zip_bytes = build_test_xdc(
            "name = \"Huge Icon\"\nicon = \"icon.png\"\n",
            Some(("icon.png", &oversized)),
        );
        let manifest = manifest_from_bytes(zip_bytes, "app.xdc");

        assert!(manifest.icon.is_none());
    }

    #[test]
    fn test_icon_fallback_when_manifest_omits_icon_field() {
        // Many webxdc apps have icon.png but forget to add icon = "icon.png" to manifest.toml
        let png_bytes: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        let zip_bytes = build_test_xdc(
            "name = \"Calc\"\n", // No icon field
            Some(("icon.png", png_bytes)),
        );

        let manifest = manifest_from_bytes(zip_bytes, "app.xdc");

        assert_eq!(manifest.name, "Calc");
        let icon = manifest.icon.expect("icon.png should be extracted as fallback");
        assert!(icon.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn test_icon_mime_type_by_extension() {
        assert_eq!(icon_mime_type("icon.png"), "image/png");
        assert_eq!(icon_mime_type("icon.jpg"), "image/jpeg");
        assert_eq!(icon_mime_type("icon.jpeg"), "image/jpeg");
        assert_eq!(icon_mime_type("icon.svg"), "image/svg+xml");
        assert_eq!(icon_mime_type("icon.weird"), "application/octet-stream");
    }

    #[tokio::test]
    async fn test_download_error_message_is_not_doubled_on_http_error() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let response = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            stream.write_all(response.as_bytes()).unwrap();
        });

        let url = format!("http://127.0.0.1:{}/missing.xdc", port);
        let result = download_file(&url, None).await;
        handle.join().unwrap();

        let message = result.unwrap_err().to_string();
        assert_eq!(message, "Download failed: HTTP 404");
        assert!(
            !message.contains("Download failed: Download failed"),
            "error message should not double-wrap: {message}"
        );
    }
}
