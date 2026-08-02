use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Clone)]
struct InstanceData {
    extract_path: PathBuf,
    server_port: u16,
}

pub struct WebxdcHttpServer {
    port: u16,
    token_registry: Arc<Mutex<HashMap<(String, String), InstanceData>>>,
}

impl WebxdcHttpServer {
    pub fn start() -> Result<Self, String> {
        let listener = (0..3)
            .find_map(|_| TcpListener::bind("127.0.0.1:0").ok())
            .ok_or_else(|| "Failed to bind to any port after 3 attempts".to_string())?;

        let port = listener.local_addr()
            .map_err(|e| format!("Failed to get local addr: {}", e))?
            .port();

        let token_registry = Arc::new(Mutex::new(HashMap::new()));
        let registry_clone = token_registry.clone();

        thread::spawn(move || {
            eprintln!("[WebXDC HTTP] Server listening on 127.0.0.1:{}", port);

            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let registry = registry_clone.clone();
                        thread::spawn(move || {
                            if let Err(e) = handle_connection(stream, registry) {
                                eprintln!("[WebXDC HTTP] Connection error: {}", e);
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("[WebXDC HTTP] Failed to accept connection: {}", e);
                    }
                }
            }
        });

        Ok(WebxdcHttpServer {
            port,
            token_registry,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn register_instance(
        &self,
        hash: String,
        token: String,
        extract_path: PathBuf,
    ) {
        let mut registry = self.token_registry.lock().unwrap();
        registry.insert(
            (hash, token),
            InstanceData {
                extract_path,
                server_port: self.port,
            },
        );
    }

    pub fn unregister_instance(&self, hash: &str, token: &str) {
        let mut registry = self.token_registry.lock().unwrap();
        registry.remove(&(hash.to_string(), token.to_string()));
    }
}

fn parse_request_line<R: BufRead>(reader: &mut R) -> Result<(String, String), String> {
    let mut line = String::new();
    reader.read_line(&mut line)
        .map_err(|e| format!("Failed to read request: {}", e))?;

    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 3 {
        return Err("Invalid HTTP request".to_string());
    }

    if parts[0] != "GET" {
        return Err(format!("Method not allowed: {}", parts[0]));
    }

    Ok((parts[0].to_string(), parts[1].to_string()))
}

fn extract_path_components(path: &str) -> Result<(String, String, String), String> {
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();

    if parts.len() < 3 {
        return Err("Invalid path structure".to_string());
    }

    Ok((
        parts[0].to_string(),
        parts[1].to_string(),
        parts[2..].join("/"),
    ))
}

fn detect_mime_type(filename: &str) -> &'static str {
    let ext = filename.rsplit('.').next().unwrap_or("");

    match ext.to_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css",
        "js" => "application/javascript",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff" | "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn handle_connection(
    mut stream: TcpStream,
    registry: Arc<Mutex<HashMap<(String, String), InstanceData>>>,
) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);

    let (method, mut path) = match parse_request_line(&mut reader) {
        Ok(result) => result,
        Err(e) => {
            eprintln!("[WebXDC HTTP] Bad request line: {}", e);
            send_response(&mut stream, 400, "Bad Request", b"")?;
            return Ok(());
        }
    };

    if method != "GET" {
        send_response(&mut stream, 405, "Method Not Allowed", b"")?;
        return Ok(());
    }

    // Read headers to find Referer for path resolution
    let mut referer_hash_token: Option<(String, String)> = None;
    let mut line = String::new();
    while reader.read_line(&mut line).is_ok() {
        if line == "\r\n" || line == "\n" {
            break; // End of headers
        }
        if line.to_lowercase().starts_with("referer:") {
            // Extract hash/token from referer URL
            if let Some(referer) = line.split_whitespace().nth(1) {
                if let Some(path_part) = referer.split("://").nth(1) {
                    if let Some(path_only) = path_part.split('/').skip(1).take(2).collect::<Vec<_>>().get(0..2) {
                        if path_only.len() == 2 {
                            referer_hash_token = Some((path_only[0].to_string(), path_only[1].to_string()));
                        }
                    }
                }
            }
        }
        line.clear();
    }

    // If path starts with / but doesn't have hash/token, try to prepend from referer
    let (hash, token, file_path) = match extract_path_components(&path) {
        Ok(result) => result,
        Err(_) => {
            // Path might be absolute like /assets/file.woff2
            // Try to use referer's hash/token
            if let Some((ref_hash, ref_token)) = referer_hash_token {
                let fixed_path = format!("/{}/{}{}", ref_hash, ref_token, path);
                eprintln!("[WebXDC HTTP] Rewriting absolute path '{}' to '{}'", path, fixed_path);
                path = fixed_path;
                extract_path_components(&path).map_err(|e| {
                    eprintln!("[WebXDC HTTP] Still bad after rewrite: {}", e);
                    e
                })?
            } else {
                eprintln!("[WebXDC HTTP] Bad path '{}' and no referer to fix it", path);
                send_response(&mut stream, 400, "Bad Request", b"")?;
                return Ok(());
            }
        }
    };

    let instance_data = {
        let registry = registry.lock().unwrap();
        registry.get(&(hash.clone(), token.clone())).cloned()
    };

    let instance_data = match instance_data {
        Some(data) => data,
        None => {
            eprintln!("[WebXDC HTTP] Invalid token: {}/{}", hash, token);
            send_response(&mut stream, 404, "Not Found", b"")?;
            return Ok(());
        }
    };

    let requested_file = instance_data.extract_path.join(&file_path);

    let canonical_file = match requested_file.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            send_response(&mut stream, 404, "Not Found", b"")?;
            return Ok(());
        }
    };

    let canonical_base = match instance_data.extract_path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            send_response(&mut stream, 500, "Internal Server Error", b"")?;
            return Ok(());
        }
    };

    if !canonical_file.starts_with(&canonical_base) {
        eprintln!("[WebXDC HTTP] Path traversal attempt: {}", requested_file.display());
        send_response(&mut stream, 403, "Forbidden", b"")?;
        return Ok(());
    }

    let mut contents = match std::fs::read(&canonical_file) {
        Ok(data) => data,
        Err(_) => {
            send_response(&mut stream, 404, "Not Found", b"")?;
            return Ok(());
        }
    };

    let mime_type = detect_mime_type(&file_path);

    // Inject <base> tag into HTML to fix absolute path resolution
    if mime_type.starts_with("text/html") {
        let html = String::from_utf8_lossy(&contents);
        let base_url = format!("http://127.0.0.1:{}/{}/{}/",
            instance_data.server_port, hash, token);

        eprintln!("[WebXDC HTTP] Injecting base tag: {}", base_url);

        // Inject base tag after <head> or at start of document
        let injected = if let Some(pos) = html.to_lowercase().find("<head>") {
            let insert_pos = pos + 6; // after "<head>"
            format!(
                "{}<base href=\"{}\">{}",
                &html[..insert_pos],
                base_url,
                &html[insert_pos..]
            )
        } else {
            format!("<base href=\"{}\">{}", base_url, html)
        };
        contents = injected.into_bytes();
    }

    send_response_with_body(&mut stream, 200, "OK", mime_type, &contents)?;

    Ok(())
}

fn send_response(
    stream: &mut TcpStream,
    status: u16,
    status_text: &str,
    body: &[u8],
) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\n\r\n",
        status, status_text, body.len()
    );

    stream.write_all(response.as_bytes())
        .map_err(|e| format!("Write error: {}", e))?;

    if !body.is_empty() {
        stream.write_all(body)
            .map_err(|e| format!("Write error: {}", e))?;
    }

    Ok(())
}

fn send_response_with_body(
    stream: &mut TcpStream,
    status: u16,
    status_text: &str,
    mime_type: &str,
    body: &[u8],
) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-cache\r\n\
         \r\n",
        status, status_text, mime_type, body.len()
    );

    stream.write_all(response.as_bytes())
        .map_err(|e| format!("Write error: {}", e))?;

    stream.write_all(body)
        .map_err(|e| format!("Write error: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_server_starts_and_allocates_port() {
        let server = WebxdcHttpServer::start().expect("Server should start");
        let port = server.port();

        assert!(port > 0);
    }

    #[test]
    fn test_register_and_unregister() {
        let server = WebxdcHttpServer::start().unwrap();

        server.register_instance(
            "hash1".to_string(),
            "token1".to_string(),
            PathBuf::from("/tmp/test"),
        );

        let registry = server.token_registry.lock().unwrap();
        assert!(registry.contains_key(&("hash1".to_string(), "token1".to_string())));
        drop(registry);

        server.unregister_instance("hash1", "token1");

        let registry = server.token_registry.lock().unwrap();
        assert!(!registry.contains_key(&("hash1".to_string(), "token1".to_string())));
    }

    #[test]
    fn test_parse_request_line() {
        let request = b"GET /hash/token/index.html HTTP/1.1\r\n\r\n";
        let cursor = Cursor::new(request);
        let mut reader = BufReader::new(cursor);

        let (method, path) = parse_request_line(&mut reader).unwrap();
        assert_eq!(method, "GET");
        assert_eq!(path, "/hash/token/index.html");
    }

    #[test]
    fn test_extract_path_components() {
        let (hash, token, file) = extract_path_components("/hash123/token456/assets/app.js")
            .unwrap();
        assert_eq!(hash, "hash123");
        assert_eq!(token, "token456");
        assert_eq!(file, "assets/app.js");
    }

    #[test]
    fn test_detect_mime_type() {
        assert_eq!(detect_mime_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(detect_mime_type("style.css"), "text/css");
        assert_eq!(detect_mime_type("app.js"), "application/javascript");
        assert_eq!(detect_mime_type("icon.png"), "image/png");
    }
}
