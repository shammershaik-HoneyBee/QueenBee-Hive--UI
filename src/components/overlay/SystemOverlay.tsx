import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sun, Volume2, VolumeX, Volume1, Settings, X, GripHorizontal, Home } from 'lucide-react';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MiniAppsPage } from '@/components/miniapps/MiniAppsPage';

interface SystemOverlayProps {
  children?: React.ReactNode;
}

export function SystemOverlay({ children }: SystemOverlayProps) {
  const [brightness, setBrightness] = useState(50);
  const [volume, setVolume] = useState(50);
  const [_isInitialized, setIsInitialized] = useState(false);
  const [showMiniApps, setShowMiniApps] = useState(false);
  const autoDismissRef = useRef<number | null>(null);
  const lastInteractionRef = useRef<number>(Date.now());

  const { isActive, progress, isDragging, dismiss, show } = useSwipeGesture({
    edgeThreshold: 40,
    activationDistance: 60,
    maxOverlayHeight: 200,
    onActivate: () => {
      loadCurrentValues();
      resetAutoDismiss();
    },
    onDeactivate: () => {
      clearAutoDismiss();
    },
  });

  // Debug toggle for non-touch displays
  const handleDebugToggle = () => {
    if (isActive) {
      dismiss();
    } else {
      show();
    }
  };

  const clearAutoDismiss = useCallback(() => {
    if (autoDismissRef.current) {
      clearTimeout(autoDismissRef.current);
      autoDismissRef.current = null;
    }
  }, []);

  const resetAutoDismiss = useCallback(() => {
    clearAutoDismiss();
    lastInteractionRef.current = Date.now();
    autoDismissRef.current = window.setTimeout(() => {
      dismiss();
    }, 5000);
  }, [clearAutoDismiss, dismiss]);

  // Auto-dismiss after 5 seconds of inactivity
  useEffect(() => {
    if (!isActive) {
      clearAutoDismiss();
      return;
    }
    resetAutoDismiss();
    return () => clearAutoDismiss();
  }, [isActive, clearAutoDismiss, resetAutoDismiss]);

  const loadCurrentValues = async () => {
    try {
      const [currentBrightness, currentVolume] = await Promise.all([
        invoke<number>('get_brightness').catch(() => 50),
        invoke<number>('get_volume').catch(() => 50),
      ]);
      setBrightness(currentBrightness);
      setVolume(currentVolume);
      setIsInitialized(true);
    } catch (error) {
      console.error('Failed to load system values:', error);
      setIsInitialized(true);
    }
  };

  const handleBrightnessChange = useCallback(async (value: number[]) => {
    const newValue = value[0];
    setBrightness(newValue);
    resetAutoDismiss();
    try {
      await invoke('set_brightness', { level: newValue });
    } catch (error) {
      console.error('Failed to set brightness:', error);
    }
  }, [resetAutoDismiss]);

  const handleVolumeChange = useCallback(async (value: number[]) => {
    const newValue = value[0];
    setVolume(newValue);
    resetAutoDismiss();
    try {
      await invoke('set_volume', { level: newValue });
    } catch (error) {
      console.error('Failed to set volume:', error);
    }
  }, [resetAutoDismiss]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      dismiss();
    }
  };

  const handleSliderInteraction = () => {
    resetAutoDismiss();
  };

  // Get volume icon based on level
  const VolumeIcon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  // Calculate transform based on drag state
  const getTransform = () => {
    if (isDragging) {
      return `translateY(${(progress * 100) - 100}%)`;
    }
    return isActive ? 'translateY(0)' : 'translateY(-100%)';
  };

  // Handle home button click
  const handleHomeClick = () => {
    dismiss();
    setShowMiniApps(true);
  };

  // Handle closing mini apps page
  const handleCloseMiniApps = () => {
    setShowMiniApps(false);
  };

  // If mini apps page is showing, render it instead
  if (showMiniApps) {
    return (
      <>
        {children}
        <MiniAppsPage onClose={handleCloseMiniApps} />
      </>
    );
  }

  return (
    <>
      {children}

      {/* Swipe hint indicator at top */}
      {!isActive && (
        <div className="fixed top-0 left-1/2 -translate-x-1/2 z-[998] p-2 pointer-events-none">
          <div className="w-12 h-1 bg-white/20 rounded-full" />
        </div>
      )}

      {/* Debug toggle button - REMOVE IN PRODUCTION */}
      <Button
        variant="ghost"
        size="icon"
        onClick={handleDebugToggle}
        title="Toggle System Overlay (Debug)"
        className={cn(
          "fixed top-3 right-3 z-[1001]",
          "w-11 h-11 rounded-full",
          "bg-black/60 hover:bg-black/80 backdrop-blur-sm",
          "border border-white/10 hover:border-white/20",
          "text-white/80 hover:text-white",
          "shadow-lg"
        )}
      >
        {isActive ? <X className="h-5 w-5" /> : <Settings className="h-5 w-5" />}
      </Button>

      {/* Overlay Backdrop */}
      {isActive && (
        <div
          className="fixed inset-0 z-[999] bg-black/50 backdrop-blur-md"
          onClick={handleBackdropClick}
          style={{
            opacity: isDragging ? progress : 1,
          }}
        />
      )}

      {/* Overlay Panel */}
      <div
        className={cn(
          "fixed top-0 left-0 right-0 z-[1000]",
          "bg-gradient-to-b from-neutral-900/98 to-neutral-950/95",
          "backdrop-blur-xl",
          "border-b border-white/5",
          "rounded-b-3xl",
          "shadow-2xl shadow-black/50",
          "px-6 pt-4 pb-3",
          "will-change-transform"
        )}
        style={{
          transform: getTransform(),
          transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div className="max-w-lg mx-auto space-y-5">
          {/* Brightness Control */}
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-amber-500/15 text-amber-400">
              <Sun className="h-5 w-5" />
            </div>
            
            <div className="flex-1 relative">
              <Slider
                value={[brightness]}
                onValueChange={handleBrightnessChange}
                onPointerDown={handleSliderInteraction}
                min={5}
                max={100}
                step={1}
                className="py-2"
                trackClassName="h-3 bg-white/10"
                rangeClassName="bg-gradient-to-r from-amber-500 to-amber-400"
                thumbClassName="border-amber-400 shadow-amber-500/30"
              />
            </div>
            
            <span className="w-12 text-right text-sm font-medium text-white/70 tabular-nums">
              {brightness}%
            </span>
          </div>

          {/* Volume Control */}
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-blue-500/15 text-blue-400">
              <VolumeIcon className="h-5 w-5" />
            </div>
            
            <div className="flex-1 relative">
              <Slider
                value={[volume]}
                onValueChange={handleVolumeChange}
                onPointerDown={handleSliderInteraction}
                min={0}
                max={100}
                step={1}
                className="py-2"
                trackClassName="h-3 bg-white/10"
                rangeClassName="bg-gradient-to-r from-blue-500 to-blue-400"
                thumbClassName="border-blue-400 shadow-blue-500/30"
              />
            </div>
            
            <span className="w-12 text-right text-sm font-medium text-white/70 tabular-nums">
              {volume}%
            </span>
          </div>

          {/* Action Buttons Row */}
          <div className="flex items-center justify-center gap-4 pt-2">
            {/* Home Button - Opens Mini Apps */}
            <Button
              variant="ghost"
              onClick={handleHomeClick}
              className={cn(
                "flex items-center gap-2 px-5 py-2.5 h-auto",
                "rounded-xl",
                "bg-amber-500/15 hover:bg-amber-500/25",
                "border border-amber-500/20 hover:border-amber-500/40",
                "text-amber-400 hover:text-amber-300",
                "transition-all duration-200"
              )}
            >
              <Home className="h-5 w-5" />
              <span className="text-sm font-medium">Apps</span>
            </Button>
          </div>

          {/* Drag Handle */}
          <div className="flex justify-center pt-1 pb-1">
            <div className="flex items-center justify-center w-12 h-5 rounded-full hover:bg-white/5 transition-colors cursor-grab active:cursor-grabbing">
              <GripHorizontal className="h-4 w-4 text-white/30" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
