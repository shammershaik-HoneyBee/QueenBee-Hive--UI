// System control types for brightness and volume

export interface BrightnessInfo {
  current: number;  // Current brightness percentage (0-100)
  max: number;      // Maximum brightness value
}

export interface VolumeInfo {
  level: number;    // Volume level percentage (0-100)
  muted: boolean;   // Whether audio is muted
}

export interface SystemControlsState {
  brightness: number;
  volume: number;
  isLoading: boolean;
  error: string | null;
}
