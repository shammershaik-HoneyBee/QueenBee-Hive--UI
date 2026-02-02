import { useState, useCallback, useEffect, useRef } from "react";
import {
  Camera,
  X,
  Circle,
  Image as ImageIcon,
  AlertCircle,
  StopCircle,
  Play,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface CameraAppProps {
  onClose: () => void;
}

interface CameraFrame {
  data: string; // base64 data URL
  width: number;
  height: number;
}

interface CameraError {
  message: string;
}

interface PhotoSaved {
  path: string;
  success: boolean;
  error: string | null;
}

export function CameraApp({ onClose }: CameraAppProps) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentFrame, setCurrentFrame] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const unlistenFrameRef = useRef<UnlistenFn | null>(null);
  const unlistenErrorRef = useRef<UnlistenFn | null>(null);
  const unlistenPhotoRef = useRef<UnlistenFn | null>(null);

  // Setup event listeners
  useEffect(() => {
    const setupListeners = async () => {
      // Listen for camera frames
      unlistenFrameRef.current = await listen<CameraFrame>(
        "camera-frame",
        (event) => {
          setCurrentFrame(event.payload.data);
        }
      );

      // Listen for camera errors
      unlistenErrorRef.current = await listen<CameraError>(
        "camera-error",
        (event) => {
          console.error("Camera error:", event.payload.message);
          setError(event.payload.message);
          setIsStreaming(false);
          setIsLoading(false);
        }
      );

      // Listen for photo saved events
      unlistenPhotoRef.current = await listen<PhotoSaved>(
        "photo-saved",
        (event) => {
          setIsCapturing(false);
          if (event.payload.success) {
            setLastSavedPath(event.payload.path);
            setSaveSuccess(true);
            setTimeout(() => setSaveSuccess(false), 3000);
          } else {
            setError(event.payload.error || "Failed to save photo");
          }
        }
      );
    };

    setupListeners();

    // Cleanup listeners and stop camera on unmount
    return () => {
      if (unlistenFrameRef.current) unlistenFrameRef.current();
      if (unlistenErrorRef.current) unlistenErrorRef.current();
      if (unlistenPhotoRef.current) unlistenPhotoRef.current();

      // Stop camera if running
      invoke("stop_camera_stream").catch(console.error);
    };
  }, []);

  // Start camera stream
  const startCamera = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      await invoke("start_camera_stream");
      setIsStreaming(true);
    } catch (err) {
      console.error("Failed to start camera:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Stop camera stream
  const stopCamera = useCallback(async () => {
    try {
      await invoke("stop_camera_stream");
      setIsStreaming(false);
      setCurrentFrame(null);
    } catch (err) {
      console.error("Failed to stop camera:", err);
    }
  }, []);

  // Capture photo
  const capturePhoto = useCallback(async () => {
    setIsCapturing(true);
    setError(null);

    try {
      await invoke("capture_photo");
      // Result will come through the photo-saved event
    } catch (err) {
      console.error("Failed to capture photo:", err);
      setError(err instanceof Error ? err.message : String(err));
      setIsCapturing(false);
    }
  }, []);

  // Handle close - stop camera first
  const handleClose = useCallback(async () => {
    if (isStreaming) {
      await stopCamera();
    }
    onClose();
  }, [isStreaming, stopCamera, onClose]);

  // Auto-start camera on mount
  useEffect(() => {
    startCamera();
  }, [startCamera]);

  // Render error state when not streaming
  if (error && !isStreaming) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-black">
        <Header onClose={handleClose} />
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <AlertCircle className="h-16 w-16 text-red-500 mb-4" />
          <h2 className="text-xl font-semibold text-white mb-2">
            Camera Error
          </h2>
          <p className="text-zinc-400 mb-6 max-w-md">{error}</p>
          <Button onClick={startCamera} variant="outline">
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <Header onClose={handleClose} />

      {/* Camera View */}
      <div className="relative flex-1 flex items-center justify-center overflow-hidden">
        {/* Loading overlay */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
            <div className="flex flex-col items-center gap-3">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-amber-500 border-t-transparent" />
              <p className="text-zinc-400">Starting camera...</p>
            </div>
          </div>
        )}

        {/* Camera frame display */}
        {currentFrame ? (
          <img
            src={currentFrame}
            alt="Camera feed"
            className="h-full w-full object-cover"
          />
        ) : (
          !isLoading && (
            <div className="flex flex-col items-center gap-4 text-zinc-500">
              <Camera className="h-20 w-20" />
              <p>Camera not started</p>
            </div>
          )
        )}

        {/* Viewfinder grid overlay */}
        {isStreaming && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute inset-8 border border-white/20 rounded-lg" />
            <div className="absolute top-1/3 left-0 right-0 h-px bg-white/10" />
            <div className="absolute top-2/3 left-0 right-0 h-px bg-white/10" />
            <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/10" />
            <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/10" />
          </div>
        )}

        {/* Status indicator */}
        {isStreaming && (
          <div className="absolute top-20 left-6 flex items-center gap-2 bg-black/60 px-3 py-1.5 rounded-full">
            <div className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs text-white">LIVE</span>
          </div>
        )}

        {/* Success message */}
        {saveSuccess && lastSavedPath && (
          <div className="absolute top-20 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-emerald-500/90 text-white px-4 py-2 rounded-full text-sm shadow-lg">
            <ImageIcon className="h-4 w-4" />
            Photo saved!
          </div>
        )}

        {/* Error toast */}
        {error && isStreaming && (
          <div className="absolute top-20 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-red-500/90 text-white px-4 py-2 rounded-full text-sm shadow-lg">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="bg-gradient-to-t from-black via-black/90 to-transparent px-6 py-8">
        <div className="flex items-center justify-center gap-8">
          {/* Start/Stop button */}
          <button
            onClick={isStreaming ? stopCamera : startCamera}
            disabled={isLoading}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400 transition-all hover:bg-zinc-700 disabled:opacity-50"
          >
            {isStreaming ? (
              <StopCircle className="h-6 w-6 text-red-400" />
            ) : (
              <Play className="h-6 w-6 text-emerald-400" />
            )}
          </button>

          {/* Capture button */}
          <button
            onClick={capturePhoto}
            disabled={!isStreaming || isCapturing}
            className={cn(
              "flex h-20 w-20 items-center justify-center rounded-full",
              "bg-white transition-all",
              "hover:scale-105 active:scale-95",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "ring-4 ring-white/30 ring-offset-4 ring-offset-black"
            )}
          >
            {isCapturing ? (
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-amber-500 border-t-transparent" />
            ) : (
              <Circle className="h-16 w-16 fill-white text-zinc-200" />
            )}
          </button>

          {/* Placeholder for symmetry */}
          <div className="w-12 h-12" />
        </div>

        {/* Last saved path */}
        {lastSavedPath && (
          <p className="text-center text-zinc-500 text-xs mt-4 truncate">
            Last: {lastSavedPath}
          </p>
        )}
      </div>
    </div>
  );
}

// Header component
function Header({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 bg-gradient-to-b from-black/80 to-transparent">
      <div className="flex items-center gap-2">
        <Camera className="h-6 w-6 text-amber-500" />
        <h1 className="text-lg font-semibold text-white">Camera</h1>
      </div>
      <button
        onClick={onClose}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-zinc-400 transition-all hover:bg-black/70 hover:text-white active:scale-95"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}

export default CameraApp;
