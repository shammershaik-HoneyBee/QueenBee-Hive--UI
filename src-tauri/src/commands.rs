use base64::{engine::general_purpose::STANDARD, Engine};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Response for WiFi status check
#[derive(Debug, Serialize, Clone)]
pub struct WifiStatus {
    pub connected: bool,
    pub ssid: Option<String>,
}

/// Response for QR code
#[derive(Debug, Serialize, Clone)]
pub struct QrCodeResponse {
    pub exists: bool,
    pub data: Option<String>, // Base64 encoded image data
    pub error: Option<String>,
}

/// Get the QR code directory path
fn get_qr_code_dir() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".config/honeybee/qr"))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Get the QR code file path
fn get_qr_code_path() -> PathBuf {
    get_qr_code_dir().join("honeybee-qr.png")
}

/// Check WiFi connection status using nmcli
#[tauri::command]
pub fn check_wifi_status() -> WifiStatus {
    // Use nmcli to check WiFi status
    // nmcli -t -f DEVICE,STATE,CONNECTION device status
    let output = Command::new("nmcli")
        .args(["-t", "-f", "DEVICE,STATE,CONNECTION", "device", "status"])
        .output();

    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            
            // Parse output to find connected WiFi device
            for line in stdout.lines() {
                let parts: Vec<&str> = line.split(':').collect();
                if parts.len() >= 3 {
                    let device = parts[0];
                    let state = parts[1];
                    let connection = parts[2];
                    
                    // Check if it's a wireless device and is connected
                    if device.starts_with("wl") && state == "connected" {
                        return WifiStatus {
                            connected: true,
                            ssid: if connection.is_empty() {
                                None
                            } else {
                                Some(connection.to_string())
                            },
                        };
                    }
                }
            }
            
            WifiStatus {
                connected: false,
                ssid: None,
            }
        }
        Err(_) => WifiStatus {
            connected: false,
            ssid: None,
        },
    }
}

/// Get QR code image as base64
#[tauri::command]
pub fn get_qr_code_image() -> QrCodeResponse {
    let qr_path = get_qr_code_path();
    
    if !qr_path.exists() {
        return QrCodeResponse {
            exists: false,
            data: None,
            error: None,
        };
    }
    
    match fs::read(&qr_path) {
        Ok(bytes) => {
            let base64_data = STANDARD.encode(&bytes);
            QrCodeResponse {
                exists: true,
                data: Some(format!("data:image/png;base64,{}", base64_data)),
                error: None,
            }
        }
        Err(e) => QrCodeResponse {
            exists: false,
            data: None,
            error: Some(e.to_string()),
        },
    }
}

/// Start watching the QR code file for changes
/// This runs in a separate thread and emits events to the frontend
pub fn start_qr_file_watcher(app_handle: AppHandle) {
    thread::spawn(move || {
        let qr_dir = get_qr_code_dir();
        
        // Create the directory if it doesn't exist
        if let Err(e) = fs::create_dir_all(&qr_dir) {
            eprintln!("Failed to create QR directory: {}", e);
            // Continue anyway, directory might already exist
        }
        
        let (tx, rx) = channel::<notify::Result<Event>>();
        
        // Create a watcher with default config
        let mut watcher: RecommendedWatcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("Failed to create file watcher: {}", e);
                return;
            }
        };
        
        // Watch the QR directory
        if let Err(e) = watcher.watch(&qr_dir, RecursiveMode::NonRecursive) {
            eprintln!("Failed to watch QR directory {:?}: {}", qr_dir, e);
            return;
        }
        
        println!("📁 Watching QR directory: {:?}", qr_dir);
        
        // Process events
        loop {
            match rx.recv() {
                Ok(Ok(event)) => {
                    // Check if the event is for our QR file
                    let qr_path = get_qr_code_path();
                    if event.paths.iter().any(|p| p == &qr_path) {
                        println!("📄 QR file changed: {:?}", event.kind);
                        
                        // Small delay to ensure file write is complete
                        thread::sleep(Duration::from_millis(100));
                        
                        // Read the new QR code and emit event
                        let qr_response = get_qr_code_image();
                        if let Err(e) = app_handle.emit("qr-code-changed", qr_response) {
                            eprintln!("Failed to emit QR change event: {}", e);
                        }
                    }
                }
                Ok(Err(e)) => {
                    eprintln!("Watch error: {}", e);
                }
                Err(e) => {
                    eprintln!("Channel error: {}", e);
                    break;
                }
            }
        }
    });
}

/// Get the path to the honeybee-ble IPC socket
fn get_ipc_socket_path() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".config/honeybee/provisioning.sock"))
        .unwrap_or_else(|| PathBuf::from("/tmp/honeybee-provisioning.sock"))
}

/// Response for retry command
#[derive(Debug, Serialize, Clone)]
pub struct RetryResponse {
    pub success: bool,
    pub message: String,
}

/// Trigger provisioning retry via IPC
#[tauri::command]
pub fn trigger_provisioning_retry() -> RetryResponse {
    let socket_path = get_ipc_socket_path();
    
    if !socket_path.exists() {
        return RetryResponse {
            success: false,
            message: "Provisioning service not running".to_string(),
        };
    }
    
    // Connect to IPC socket and send retry command
    match UnixStream::connect(&socket_path) {
        Ok(mut stream) => {
            // Set timeout
            if let Err(e) = stream.set_read_timeout(Some(Duration::from_secs(5))) {
                eprintln!("Failed to set socket timeout: {}", e);
            }
            
            // Send retry command as JSON
            let retry_command = r#"{"command":"retry"}"#;
            if let Err(e) = stream.write_all(retry_command.as_bytes()) {
                return RetryResponse {
                    success: false,
                    message: format!("Failed to send retry command: {}", e),
                };
            }
            
            // Read response
            let mut response = String::new();
            match stream.read_to_string(&mut response) {
                Ok(_) => {
                    println!("Retry command response: {}", response);
                    RetryResponse {
                        success: true,
                        message: "Retry triggered successfully".to_string(),
                    }
                }
                Err(e) => {
                    // Even if read fails, the command might have been received
                    eprintln!("Failed to read response: {}", e);
                    RetryResponse {
                        success: true,
                        message: "Retry triggered (no confirmation)".to_string(),
                    }
                }
            }
        }
        Err(e) => RetryResponse {
            success: false,
            message: format!("Failed to connect to provisioning service: {}", e),
        },
    }
}
