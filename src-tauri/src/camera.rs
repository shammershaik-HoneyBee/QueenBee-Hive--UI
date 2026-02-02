use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Local;
use image::{ImageBuffer, Rgb};
use nokhwa::{
    pixel_format::RgbFormat,
    utils::{CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType, Resolution},
    Camera,
};
use parking_lot::RwLock;
use std::{
    io::Cursor,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter};

// Global camera state
static CAMERA_RUNNING: AtomicBool = AtomicBool::new(false);
static STOP_SIGNAL: AtomicBool = AtomicBool::new(false);

// Shared frame buffer for capture (stores JPEG bytes ready to save)
lazy_static::lazy_static! {
    static ref LATEST_FRAME: Arc<RwLock<Option<Vec<u8>>>> = Arc::new(RwLock::new(None));
}

// Single resolution for everything
const CAMERA_WIDTH: u32 = 640;
const CAMERA_HEIGHT: u32 = 480;

// JPEG quality
const JPEG_QUALITY: u8 = 85;

// Target FPS for streaming
const TARGET_FPS: u64 = 25;

/// Camera frame event payload
#[derive(Clone, serde::Serialize)]
pub struct CameraFrame {
    pub data: String, // base64 encoded JPEG
    pub width: u32,
    pub height: u32,
}

/// Camera error event payload
#[derive(Clone, serde::Serialize)]
pub struct CameraError {
    pub message: String,
}

/// Photo saved event payload
#[derive(Clone, serde::Serialize)]
pub struct PhotoSaved {
    pub path: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Start camera streaming
#[tauri::command]
pub async fn start_camera_stream(app: AppHandle) -> Result<String, String> {
    // Check if already running
    if CAMERA_RUNNING.load(Ordering::SeqCst) {
        return Ok("Camera already running".to_string());
    }

    // Reset stop signal
    STOP_SIGNAL.store(false, Ordering::SeqCst);

    // Spawn camera thread
    let app_handle = app.clone();
    thread::spawn(move || {
        run_camera_stream(app_handle);
    });

    Ok("Camera stream started".to_string())
}

/// Stop camera streaming
#[tauri::command]
pub async fn stop_camera_stream() -> Result<String, String> {
    if !CAMERA_RUNNING.load(Ordering::SeqCst) {
        return Ok("Camera not running".to_string());
    }

    // Signal stop
    STOP_SIGNAL.store(true, Ordering::SeqCst);

    // Wait for camera to stop (with timeout)
    let mut attempts = 0;
    while CAMERA_RUNNING.load(Ordering::SeqCst) && attempts < 50 {
        thread::sleep(Duration::from_millis(50));
        attempts += 1;
    }

    if CAMERA_RUNNING.load(Ordering::SeqCst) {
        return Err("Camera failed to stop in time".to_string());
    }

    Ok("Camera stream stopped".to_string())
}

/// Capture and save a photo from the current stream
#[tauri::command]
pub async fn capture_photo(app: AppHandle) -> Result<PhotoSaved, String> {
    // Get the latest JPEG frame from the shared buffer
    let jpeg_data = {
        let guard = LATEST_FRAME.read();
        guard.clone()
    };

    let data = match jpeg_data {
        Some(d) => d,
        None => {
            let result = PhotoSaved {
                path: String::new(),
                success: false,
                error: Some("No frame available. Is the camera streaming?".to_string()),
            };
            let _ = app.emit("photo-saved", result.clone());
            return Ok(result);
        }
    };

    // Get Pictures directory
    let pictures_dir = dirs::picture_dir().ok_or("Failed to get Pictures directory")?;
    let camera_dir = pictures_dir.join("honeybee-camera");

    // Create directory if needed
    if !camera_dir.exists() {
        std::fs::create_dir_all(&camera_dir)
            .map_err(|e| format!("Failed to create camera directory: {}", e))?;
    }

    // Generate filename
    let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let filename = format!("IMG_{}.jpg", timestamp);
    let filepath = camera_dir.join(&filename);

    // Write JPEG directly to file
    if let Err(e) = std::fs::write(&filepath, data) {
        let result = PhotoSaved {
            path: String::new(),
            success: false,
            error: Some(format!("Failed to save photo: {}", e)),
        };
        let _ = app.emit("photo-saved", result.clone());
        return Ok(result);
    }

    let path_str = filepath.to_string_lossy().to_string();
    let result = PhotoSaved {
        path: path_str.clone(),
        success: true,
        error: None,
    };

    let _ = app.emit("photo-saved", result.clone());
    Ok(result)
}

/// Internal function to run camera stream
fn run_camera_stream(app: AppHandle) {
    CAMERA_RUNNING.store(true, Ordering::SeqCst);

    // Create camera at 640x480
    let requested = RequestedFormat::new::<RgbFormat>(RequestedFormatType::Closest(
        CameraFormat::new(
            Resolution::new(CAMERA_WIDTH, CAMERA_HEIGHT),
            FrameFormat::MJPEG,
            TARGET_FPS as u32,
        ),
    ));

    let mut camera = match Camera::new(CameraIndex::Index(0), requested) {
        Ok(cam) => cam,
        Err(e) => {
            let _ = app.emit(
                "camera-error",
                CameraError {
                    message: format!("Failed to open camera: {}", e),
                },
            );
            CAMERA_RUNNING.store(false, Ordering::SeqCst);
            return;
        }
    };

    // Open stream
    if let Err(e) = camera.open_stream() {
        let _ = app.emit(
            "camera-error",
            CameraError {
                message: format!("Failed to start camera stream: {}", e),
            },
        );
        CAMERA_RUNNING.store(false, Ordering::SeqCst);
        return;
    }

    let frame_interval = Duration::from_millis(1000 / TARGET_FPS);

    // Main capture loop
    loop {
        // Check stop signal
        if STOP_SIGNAL.load(Ordering::SeqCst) {
            break;
        }

        let frame_start = std::time::Instant::now();

        // Capture frame
        match camera.frame() {
            Ok(frame) => {
                // Decode to RGB
                if let Ok(decoded) = frame.decode_image::<RgbFormat>() {
                    // Create image buffer
                    if let Some(img) = ImageBuffer::<Rgb<u8>, Vec<u8>>::from_raw(
                        decoded.width(),
                        decoded.height(),
                        decoded.into_raw(),
                    ) {
                        // Encode to JPEG once - used for both streaming and capture
                        let mut jpeg_buffer = Cursor::new(Vec::new());
                        if image::codecs::jpeg::JpegEncoder::new_with_quality(
                            &mut jpeg_buffer,
                            JPEG_QUALITY,
                        )
                        .encode_image(&img)
                        .is_ok()
                        {
                            let jpeg_bytes = jpeg_buffer.into_inner();

                            // Store JPEG for capture
                            {
                                let mut guard = LATEST_FRAME.write();
                                *guard = Some(jpeg_bytes.clone());
                            }

                            // Convert to base64 and emit
                            let base64_data = STANDARD.encode(&jpeg_bytes);
                            let _ = app.emit(
                                "camera-frame",
                                CameraFrame {
                                    data: format!("data:image/jpeg;base64,{}", base64_data),
                                    width: img.width(),
                                    height: img.height(),
                                },
                            );
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("Camera frame error: {}", e);
            }
        }

        // Maintain target FPS
        let elapsed = frame_start.elapsed();
        if elapsed < frame_interval {
            thread::sleep(frame_interval - elapsed);
        }
    }

    // Cleanup
    let _ = camera.stop_stream();
    
    // Clear the frame buffer
    {
        let mut guard = LATEST_FRAME.write();
        *guard = None;
    }
    
    CAMERA_RUNNING.store(false, Ordering::SeqCst);
    STOP_SIGNAL.store(false, Ordering::SeqCst);

    println!("Camera stream stopped");
}
