mod camera;
mod commands;
mod provisioning_ipc;
mod system;
mod voice_agent_ipc;

#[cfg(debug_assertions)]
use tauri::Manager;

use camera::{capture_photo, start_camera_stream, stop_camera_stream};
use commands::{check_wifi_status, get_qr_code_image, start_qr_file_watcher, trigger_provisioning_retry};
use provisioning_ipc::{check_provisioning_socket, start_provisioning_ipc_listener};
use system::{get_brightness, set_brightness, get_volume, set_volume};
use voice_agent_ipc::{check_voice_agent_socket, start_voice_agent_ipc_listener};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            // WiFi & QR commands
            check_wifi_status, 
            get_qr_code_image, 
            // Provisioning & Voice Agent IPC
            check_provisioning_socket,
            trigger_provisioning_retry,
            check_voice_agent_socket,
            // System controls (brightness & volume)
            get_brightness,
            set_brightness,
            get_volume,
            set_volume,
            // Camera commands
            start_camera_stream,
            stop_camera_stream,
            capture_photo
        ])
        .setup(|app| {
            // Open devtools only in debug builds
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // Setup permission handler for Linux (WebKitGTK)
            #[cfg(target_os = "linux")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.with_webview(|webview| {
                        use webkit2gtk::{PermissionRequestExt, WebViewExt};
                        
                        let wv = webview.inner();
                        wv.connect_permission_request(|_webview, request| {
                            // Auto-allow all permission requests (camera, microphone, etc.)
                            request.allow();
                            true // Return true to indicate we handled the request
                        });
                    }).ok();
                }
            }

            // Start the QR file watcher
            let app_handle = app.handle().clone();
            start_qr_file_watcher(app_handle);

            // Start the provisioning IPC listener
            let app_handle_ipc = app.handle().clone();
            start_provisioning_ipc_listener(app_handle_ipc);

            // Start the voice agent IPC listener
            let app_handle_voice = app.handle().clone();
            start_voice_agent_ipc_listener(app_handle_voice);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
