use std::fs;

#[test]
fn test_http_server_full_flow() {
    let server = fluux::webxdc::get_http_server();
    let port = server.port();

    let temp_dir = std::env::temp_dir().join(format!("webxdc-test-{}", rand::random::<u32>()));
    fs::create_dir_all(&temp_dir).unwrap();
    fs::write(temp_dir.join("index.html"), "<html><head></head><body>Test</body></html>").unwrap();

    let token = format!("{:032x}", rand::random::<u128>());
    let hash = "testhash";

    server.register_instance(
        hash.to_string(),
        token.clone(),
        temp_dir.clone(),
    );

    let url = format!("http://127.0.0.1:{}/{}/{}/index.html", port, hash, token);
    let response = reqwest::blocking::get(&url).unwrap();

    assert_eq!(response.status(), 200);
    let body = response.text().unwrap();
    assert!(body.contains("Test"));

    // Invalid token = 404
    let bad_url = format!("http://127.0.0.1:{}/{}/wrongtoken/index.html", port, hash);
    let bad_response = reqwest::blocking::get(&bad_url).unwrap();
    assert_eq!(bad_response.status(), 404);

    // Cleanup
    server.unregister_instance(hash, &token);
    fs::remove_dir_all(&temp_dir).unwrap();
}

#[test]
fn test_path_traversal_protection() {
    let server = fluux::webxdc::get_http_server();
    let port = server.port();

    let temp_dir = std::env::temp_dir().join(format!("webxdc-sec-{}", rand::random::<u32>()));
    fs::create_dir_all(&temp_dir).unwrap();
    fs::write(temp_dir.join("safe.html"), "<html>Safe</html>").unwrap();

    let token = format!("{:032x}", rand::random::<u128>());
    let hash = "security";

    server.register_instance(hash.to_string(), token.clone(), temp_dir.clone());

    let traversal_url = format!("http://127.0.0.1:{}/{}/{}/safe.html/../../etc/passwd", port, hash, token);
    let response = reqwest::blocking::get(&traversal_url).unwrap();

    // Should be 403 or 404 (path traversal protection or file not found after normalization)
    assert!(response.status() == 403 || response.status() == 404);

    server.unregister_instance(hash, &token);
    fs::remove_dir_all(&temp_dir).unwrap();
}
