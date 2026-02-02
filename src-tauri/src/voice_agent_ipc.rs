//! Voice Agent IPC Module
//! 
//! Listens for status updates from honeybee-voice-agent via Unix socket.
//! Emits events to the frontend for:
//! - Token refresh status
//! - Quota warnings
//! - Errors (token, network, quota exceeded)
//! - Usage statistics

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::UnixStream;

const VOICE_AGENT_SOCKET_PATH: &str = "/tmp/honeybee-voice-agent.sock";

/// Voice agent status types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum VoiceAgentEventType {
    /// Session started (wakeword detected)
    SessionStarted,
    /// Session ended normally
    SessionEnded,
    /// Token was refreshed
    TokenRefreshed,
    /// Token refresh failed
    TokenError,
    /// Quota warning (running low)
    QuotaWarning,
    /// Quota exceeded
    QuotaExceeded,
    /// Network error during session
    NetworkError,
    /// Generic error
    Error,
    /// Quota status update (periodic)
    QuotaStatus,
    /// Agent ready (listening for wakeword)
    Ready,
    /// Agent listening (active session)
    Listening,
}

/// Quota information
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QuotaInfo {
    /// Daily request limit
    pub daily_limit: i32,
    /// Daily requests used
    pub daily_usage: i32,
    /// Daily requests remaining
    pub daily_remaining: i32,
    /// Monthly request limit
    pub monthly_limit: i32,
    /// Monthly requests used
    pub monthly_usage: i32,
    /// Monthly requests remaining
    pub monthly_remaining: i32,
    /// Percentage of daily quota used (0-100)
    pub daily_percent_used: f32,
    /// Percentage of monthly quota used (0-100)
    pub monthly_percent_used: f32,
}

/// Token information
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenInfo {
    /// Seconds until token expires
    pub expires_in_seconds: i32,
    /// Whether token is valid
    pub is_valid: bool,
}

/// Voice agent status message received via IPC
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceAgentStatus {
    /// Event type
    pub event: VoiceAgentEventType,
    /// Human-readable message
    pub message: String,
    /// Timestamp (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// Quota information (if available)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota: Option<QuotaInfo>,
    /// Token information (if available)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<TokenInfo>,
    /// Error details (if error event)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_details: Option<String>,
    /// Whether error is recoverable
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recoverable: Option<bool>,
}

/// Start listening for voice agent status updates
/// This runs in a separate async task and emits events to the frontend
pub fn start_voice_agent_ipc_listener(app_handle: AppHandle) {
    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();

    // Spawn the tokio runtime in a separate thread
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
        rt.block_on(async move {
            run_voice_agent_ipc_listener(app_handle, running_clone).await;
        });
    });
}

async fn run_voice_agent_ipc_listener(app_handle: AppHandle, running: Arc<AtomicBool>) {
    println!("🎤 Voice agent IPC listener starting...");

    // Keep trying to connect to the socket
    loop {
        if !running.load(Ordering::Relaxed) {
            break;
        }

        // Wait for the socket to be created by honeybee-voice-agent
        if !Path::new(VOICE_AGENT_SOCKET_PATH).exists() {
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            continue;
        }

        // Try to connect
        match connect_and_listen_voice_agent(&app_handle).await {
            Ok(_) => {
                println!("🎤 Voice agent IPC connection ended, will reconnect...");
            }
            Err(e) => {
                eprintln!("❌ Voice agent IPC connection error: {}", e);
            }
        }

        // Wait before reconnecting
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
    }
}

async fn connect_and_listen_voice_agent(
    app_handle: &AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!(
        "🎤 Connecting to voice agent IPC socket at {}",
        VOICE_AGENT_SOCKET_PATH
    );

    let stream = UnixStream::connect(VOICE_AGENT_SOCKET_PATH).await?;
    println!("✅ Connected to voice agent IPC socket");

    let reader = BufReader::new(stream);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        // Parse the JSON message
        match serde_json::from_str::<VoiceAgentStatus>(&line) {
            Ok(status) => {
                println!("🎤 Received voice agent status: {:?}", status.event);

                // Emit event to frontend
                if let Err(e) = app_handle.emit("voice-agent-status", status.clone()) {
                    eprintln!("Failed to emit voice agent status: {}", e);
                }

                // Also emit specific events for different status types
                match status.event {
                    VoiceAgentEventType::QuotaWarning | VoiceAgentEventType::QuotaExceeded => {
                        if let Some(quota) = &status.quota {
                            if let Err(e) = app_handle.emit("voice-agent-quota", quota.clone()) {
                                eprintln!("Failed to emit quota status: {}", e);
                            }
                        }
                    }
                    VoiceAgentEventType::Error
                    | VoiceAgentEventType::TokenError
                    | VoiceAgentEventType::NetworkError => {
                        if let Err(e) = app_handle.emit("voice-agent-error", status.clone()) {
                            eprintln!("Failed to emit error status: {}", e);
                        }
                    }
                    _ => {}
                }
            }
            Err(e) => {
                eprintln!(
                    "Failed to parse voice agent status: {} - line: {}",
                    e, line
                );
            }
        }
    }

    Ok(())
}

/// Check if the voice agent socket exists
#[tauri::command]
pub fn check_voice_agent_socket() -> bool {
    Path::new(VOICE_AGENT_SOCKET_PATH).exists()
}
