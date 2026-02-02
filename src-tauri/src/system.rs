// System controls: brightness and volume management
// 
// Brightness: Uses KDE's DBus interface (for development)
// In production (GNOME), this will be swapped to the appropriate interface
//
// Volume: Uses PipeWire (wpctl) -> PulseAudio (pactl) -> ALSA (amixer) fallback chain
// Only controls speaker OUTPUT volume, never touches microphone/input

use std::process::Command;

/// Audio backend detection
#[derive(Debug, Clone, Copy)]
enum AudioBackend {
    PipeWire,
    PulseAudio,
    Alsa,
}

fn detect_audio_backend() -> AudioBackend {
    // Check for PipeWire first (modern systems)
    if Command::new("wpctl")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return AudioBackend::PipeWire;
    }

    // Check for PulseAudio
    if Command::new("pactl")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return AudioBackend::PulseAudio;
    }

    // Fallback to ALSA
    AudioBackend::Alsa
}

// ============================================================================
// BRIGHTNESS CONTROL (KDE DBus)
// ============================================================================

/// Get maximum brightness value from KDE
fn get_brightness_max_kde() -> Result<i32, String> {
    let output = Command::new("busctl")
        .args([
            "--user",
            "call",
            "org.kde.Solid.PowerManagement",
            "/org/kde/Solid/PowerManagement/Actions/BrightnessControl",
            "org.kde.Solid.PowerManagement.Actions.BrightnessControl",
            "brightnessMax",
        ])
        .output()
        .map_err(|e| format!("Failed to call brightnessMax: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "brightnessMax failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Output format: "i 19200" (type indicator followed by value)
    let value_str = stdout
        .split_whitespace()
        .nth(1)
        .ok_or("Invalid brightnessMax response")?;

    value_str
        .parse::<i32>()
        .map_err(|_| "Failed to parse brightness max value".to_string())
}

/// Get current brightness value from KDE
fn get_brightness_current_kde() -> Result<i32, String> {
    let output = Command::new("busctl")
        .args([
            "--user",
            "call",
            "org.kde.Solid.PowerManagement",
            "/org/kde/Solid/PowerManagement/Actions/BrightnessControl",
            "org.kde.Solid.PowerManagement.Actions.BrightnessControl",
            "brightness",
        ])
        .output()
        .map_err(|e| format!("Failed to call brightness: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "brightness failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Output format: "i 9600" (type indicator followed by value)
    let value_str = stdout
        .split_whitespace()
        .nth(1)
        .ok_or("Invalid brightness response")?;

    value_str
        .parse::<i32>()
        .map_err(|_| "Failed to parse brightness value".to_string())
}

/// Get current display brightness as percentage (0-100)
#[tauri::command]
pub fn get_brightness() -> Result<u8, String> {
    let max = get_brightness_max_kde()?;
    let current = get_brightness_current_kde()?;

    if max <= 0 {
        return Err("Invalid max brightness value".to_string());
    }

    let percentage = ((current as f64 / max as f64) * 100.0).round() as u8;
    Ok(percentage.clamp(0, 100))
}

/// Set display brightness (percentage 0-100)
#[tauri::command]
pub fn set_brightness(level: u8) -> Result<(), String> {
    // Clamp to safe range (never fully black, minimum 5%)
    let safe_level = level.clamp(5, 100);

    let max = get_brightness_max_kde()?;
    let target_value = ((safe_level as f64 / 100.0) * max as f64).round() as i32;

    let output = Command::new("busctl")
        .args([
            "--user",
            "call",
            "org.kde.Solid.PowerManagement",
            "/org/kde/Solid/PowerManagement/Actions/BrightnessControl",
            "org.kde.Solid.PowerManagement.Actions.BrightnessControl",
            "setBrightness",
            "i",
            &target_value.to_string(),
        ])
        .output()
        .map_err(|e| format!("Failed to set brightness: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "setBrightness failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

// ============================================================================
// VOLUME CONTROL (PipeWire / PulseAudio / ALSA)
// ============================================================================

/// Get current speaker volume as percentage (0-100)
#[tauri::command]
pub fn get_volume() -> Result<u8, String> {
    match detect_audio_backend() {
        AudioBackend::PipeWire => get_volume_pipewire(),
        AudioBackend::PulseAudio => get_volume_pulseaudio(),
        AudioBackend::Alsa => get_volume_alsa(),
    }
}

fn get_volume_pipewire() -> Result<u8, String> {
    let output = Command::new("wpctl")
        .args(["get-volume", "@DEFAULT_AUDIO_SINK@"])
        .output()
        .map_err(|e| format!("wpctl error: {}", e))?;

    if !output.status.success() {
        return Err("wpctl get-volume failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Output format: "Volume: 0.50" or "Volume: 0.50 [MUTED]"
    // 0.50 = 50%
    for word in stdout.split_whitespace() {
        if let Ok(vol) = word.parse::<f64>() {
            return Ok((vol * 100.0).round() as u8);
        }
    }

    Err("Failed to parse wpctl volume".to_string())
}

fn get_volume_pulseaudio() -> Result<u8, String> {
    let output = Command::new("pactl")
        .args(["get-sink-volume", "@DEFAULT_SINK@"])
        .output()
        .map_err(|e| format!("pactl error: {}", e))?;

    if !output.status.success() {
        return Err("pactl get-sink-volume failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Output contains percentage like "50%"
    for word in stdout.split_whitespace() {
        if word.ends_with('%') {
            if let Ok(vol) = word.trim_end_matches('%').parse::<u8>() {
                return Ok(vol.min(100));
            }
        }
    }

    Err("Failed to parse pactl volume".to_string())
}

fn get_volume_alsa() -> Result<u8, String> {
    let output = Command::new("amixer")
        .args(["get", "Master"])
        .output()
        .map_err(|e| format!("amixer error: {}", e))?;

    if !output.status.success() {
        return Err("amixer get Master failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Output contains "[50%]"
    for line in stdout.lines() {
        if let Some(start) = line.find('[') {
            if let Some(end) = line[start..].find('%') {
                if let Ok(vol) = line[start + 1..start + end].parse::<u8>() {
                    return Ok(vol.min(100));
                }
            }
        }
    }

    Err("Failed to parse amixer volume".to_string())
}

/// Set speaker volume (percentage 0-100)
/// NOTE: This only affects OUTPUT volume, never touches microphone/input
#[tauri::command]
pub fn set_volume(level: u8) -> Result<(), String> {
    let safe_level = level.clamp(0, 100);

    match detect_audio_backend() {
        AudioBackend::PipeWire => set_volume_pipewire(safe_level),
        AudioBackend::PulseAudio => set_volume_pulseaudio(safe_level),
        AudioBackend::Alsa => set_volume_alsa(safe_level),
    }
}

fn set_volume_pipewire(level: u8) -> Result<(), String> {
    // Convert percentage to decimal (50% = 0.5)
    let decimal = level as f64 / 100.0;

    let output = Command::new("wpctl")
        .args([
            "set-volume",
            "@DEFAULT_AUDIO_SINK@", // SINK = output only, never touches SOURCE/input
            &format!("{:.2}", decimal),
        ])
        .output()
        .map_err(|e| format!("wpctl error: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "wpctl set-volume failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

fn set_volume_pulseaudio(level: u8) -> Result<(), String> {
    let output = Command::new("pactl")
        .args([
            "set-sink-volume", // SINK = output only
            "@DEFAULT_SINK@",
            &format!("{}%", level),
        ])
        .output()
        .map_err(|e| format!("pactl error: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "pactl set-sink-volume failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

fn set_volume_alsa(level: u8) -> Result<(), String> {
    let output = Command::new("amixer")
        .args(["set", "Master", &format!("{}%", level)])
        .output()
        .map_err(|e| format!("amixer error: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "amixer set Master failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}
