fn main() {
    // Expose git short hash as GIT_HASH env var for compile-time embedding
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output();
    let git_hash = output
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=GIT_HASH={}", git_hash);

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "log_to_terminal",
                "webxdc_extract",
                "webxdc_open_window",
                "webxdc_send_update",
                "webxdc_get_updates",
                "webxdc_receive_update",
                "webxdc_close_window",
                "webxdc_send_to_chat",
                "webxdc_import_files",
                "webxdc_read_imported_file",
                "webxdc_realtime_join",
                "webxdc_realtime_send",
                "webxdc_realtime_leave",
                "webxdc_realtime_receive",
                "webxdc_get_instance_by_thread",
                "webxdc_set_thread_for_instance",
                "webxdc_extract_manifest",
                "webxdc_compute_hash",
                "webxdc_create_new_instance",
            ]))
    )
    .expect("failed to run tauri-build");
}
