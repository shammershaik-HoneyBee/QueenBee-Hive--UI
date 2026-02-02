import { useState, useRef, useCallback, useEffect } from 'react';

interface SwipeGestureOptions {
  edgeThreshold?: number;      // Distance from top edge to trigger (default: 40px)
  activationDistance?: number; // Min swipe distance to activate (default: 60px)
  maxOverlayHeight?: number;   // Height of overlay when fully visible (default: 180px)
  onActivate?: () => void;
  onDeactivate?: () => void;
}

interface SwipeGestureState {
  isActive: boolean;
  progress: number;  // 0-1 representing overlay visibility
  isDragging: boolean;
}

export function useSwipeGesture(options: SwipeGestureOptions = {}) {
  const {
    edgeThreshold = 40,
    activationDistance = 60,
    maxOverlayHeight = 180,
    onActivate,
    onDeactivate,
  } = options;

  const [state, setState] = useState<SwipeGestureState>({
    isActive: false,
    progress: 0,
    isDragging: false,
  });

  const touchStartY = useRef<number>(0);
  const touchStartedInEdge = useRef<boolean>(false);
  const wasActive = useRef<boolean>(false);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    
    // Only trigger if touch starts near the top edge
    if (touch.clientY <= edgeThreshold) {
      touchStartY.current = touch.clientY;
      touchStartedInEdge.current = true;
      wasActive.current = state.isActive;
      setState(prev => ({ ...prev, isDragging: true }));
    } else if (state.isActive) {
      // Allow dragging on the overlay itself to dismiss
      touchStartY.current = touch.clientY;
      touchStartedInEdge.current = true;
      wasActive.current = true;
      setState(prev => ({ ...prev, isDragging: true }));
    }
  }, [edgeThreshold, state.isActive]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!touchStartedInEdge.current) return;

    const touch = e.touches[0];
    const deltaY = touch.clientY - touchStartY.current;

    if (wasActive.current) {
      // If already active, allow dragging up to dismiss
      if (deltaY < 0) {
        const dismissProgress = Math.max(1 + (deltaY / maxOverlayHeight), 0);
        setState(prev => ({ ...prev, progress: dismissProgress }));
      }
    } else {
      // Opening gesture - swipe down
      if (deltaY > 0) {
        const progress = Math.min(deltaY / maxOverlayHeight, 1);
        setState(prev => ({ ...prev, progress }));

        if (deltaY >= activationDistance && !state.isActive) {
          setState(prev => ({ ...prev, isActive: true }));
          onActivate?.();
        }
      }
    }
  }, [activationDistance, maxOverlayHeight, state.isActive, onActivate]);

  const handleTouchEnd = useCallback(() => {
    if (!touchStartedInEdge.current) return;

    touchStartedInEdge.current = false;

    setState(prev => {
      // If we've opened past the threshold, stay open
      if (prev.progress > 0.5 && !wasActive.current) {
        return { isActive: true, progress: 1, isDragging: false };
      }
      // If we've closed past the threshold, close
      if (prev.progress < 0.5 && wasActive.current) {
        onDeactivate?.();
        return { isActive: false, progress: 0, isDragging: false };
      }
      // Otherwise snap back to previous state
      if (prev.isActive) {
        return { ...prev, progress: 1, isDragging: false };
      }
      return { ...prev, progress: 0, isDragging: false };
    });

    wasActive.current = false;
  }, [onDeactivate]);

  const dismiss = useCallback(() => {
    setState({ isActive: false, progress: 0, isDragging: false });
    onDeactivate?.();
  }, [onDeactivate]);

  const show = useCallback(() => {
    setState({ isActive: true, progress: 1, isDragging: false });
    onActivate?.();
  }, [onActivate]);

  useEffect(() => {
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  return { ...state, dismiss, show };
}
