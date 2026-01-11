mod commands;
mod provisioning_ipc;

#[cfg(debug_assertions)]
use tauri::Manager;

use commands::{check_wifi_status, get_qr_code_image, start_qr_file_watcher};
use provisioning_ipc::{check_provisioning_socket, start_provisioning_ipc_listener};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![check_wifi_status, get_qr_code_image, check_provisioning_socket])
        .setup(|app| {
            // Open devtools only in debug builds
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // Start the QR file watcher
            let app_handle = app.handle().clone();
            start_qr_file_watcher(app_handle);

            // Start the provisioning IPC listener
            let app_handle_ipc = app.handle().clone();
            start_provisioning_ipc_listener(app_handle_ipc);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
