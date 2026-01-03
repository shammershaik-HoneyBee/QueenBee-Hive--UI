mod commands;

#[cfg(debug_assertions)]
use tauri::Manager;

use commands::{check_wifi_status, get_qr_code_image, start_qr_file_watcher};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![check_wifi_status, get_qr_code_image])
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
