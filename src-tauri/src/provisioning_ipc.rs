use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::UnixStream;

const SOCKET_PATH: &str = "/tmp/honeybee-provisioning.sock";

/// Provisioning status received from honeybee-ble-go via Unix socket
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvisioningStatus {
    pub status: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dashboard_hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_count: Option<i32>,
}

/// Start listening for provisioning status updates from honeybee-ble-go
/// This runs in a separate async task and emits events to the frontend
pub fn start_provisioning_ipc_listener(app_handle: AppHandle) {
    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();

    // Spawn the tokio runtime in a separate thread
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
        rt.block_on(async move {
            run_ipc_listener(app_handle, running_clone).await;
        });
    });
}

async fn run_ipc_listener(app_handle: AppHandle, running: Arc<AtomicBool>) {
    // Remove existing socket file if it exists (from previous run)
    if Path::new(SOCKET_PATH).exists() {
        // We don't own the socket, just try to connect and if we can't, wait
        // The honeybee-ble-go service creates the socket
        println!("🔌 Socket path exists, will connect when available");
    }

    // Keep trying to connect to the socket
    loop {
        if !running.load(Ordering::Relaxed) {
            break;
        }

        // Wait for the socket to be created by honeybee-ble-go
        if !Path::new(SOCKET_PATH).exists() {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            continue;
        }

        // Try to create a listener (we're the client, so this approach won't work)
        // Instead, we need to connect as a client to the Unix socket
        match connect_and_listen(&app_handle).await {
            Ok(_) => {
                println!("🔌 IPC connection ended, will reconnect...");
            }
            Err(e) => {
                eprintln!("❌ IPC connection error: {}", e);
            }
        }

        // Wait before reconnecting
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    }
}

async fn connect_and_listen(app_handle: &AppHandle) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("🔌 Connecting to provisioning IPC socket at {}", SOCKET_PATH);
    
    let stream = UnixStream::connect(SOCKET_PATH).await?;
    println!("✅ Connected to provisioning IPC socket");

    let reader = BufReader::new(stream);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        // Parse the JSON message
        match serde_json::from_str::<ProvisioningStatus>(&line) {
            Ok(status) => {
                println!("📨 Received provisioning status: {:?}", status);
                
                // Emit event to frontend
                if let Err(e) = app_handle.emit("provisioning-status", status.clone()) {
                    eprintln!("Failed to emit provisioning status: {}", e);
                }
            }
            Err(e) => {
                eprintln!("Failed to parse provisioning status: {} - line: {}", e, line);
            }
        }
    }

    Ok(())
}

/// Check if the provisioning socket exists
#[tauri::command]
pub fn check_provisioning_socket() -> bool {
    Path::new(SOCKET_PATH).exists()
}
