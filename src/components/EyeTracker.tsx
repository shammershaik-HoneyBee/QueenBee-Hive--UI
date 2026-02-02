import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface FaceTrackingData {
    face_detected: boolean;
    position: {
        x: number;
        y: number;
    };
    raw_position?: {
        x: number;
        y: number;
    };
    confidence?: number;
    timestamp?: string;
}

interface WifiStatus {
    connected: boolean;
    ssid: string | null;
}

interface QrCodeResponse {
    exists: boolean;
    data: string | null;
    error: string | null;
}

// Provisioning status types (matching honeybee-ble-go IPC)
type ProvisioningStatusType = 
    | 'idle'
    | 'connecting_wifi'
    | 'wifi_connected'
    | 'wifi_failed'
    | 'ble_paired'
    | 'api_requesting'
    | 'api_success'
    | 'api_failed'
    | 'api_resources_reused'
    | 'provisioning'
    | 'starting_tunnel'
    | 'tunnel_connected'
    | 'tunnel_error'
    | 'tunnel_repairing'
    | 'tunnel_recreating'
    | 'retrying'
    | 'retry_available'
    | 'provisioned'
    | 'success'
    | 'error'
    | 'health_update';

interface ProvisioningStatus {
    status: ProvisioningStatusType;
    message: string;
    progress?: number;
    hostname?: string;
    dashboard_hostname?: string;
    error_details?: string;
    retry_count?: number;
    max_retries?: number;
    // New fields for state-driven provisioning
    can_retry?: boolean;
    tunnel_healthy?: boolean;
    consecutive_failures?: number;
    recovery_action?: string;
    serial_number?: string;
    is_new_provision?: boolean;
}

// Voice agent status types (matching honeybee-voice-agent IPC)
type VoiceAgentEventType =
    | 'session_started'
    | 'session_ended'
    | 'token_refreshed'
    | 'token_error'
    | 'quota_warning'
    | 'quota_exceeded'
    | 'network_error'
    | 'error'
    | 'quota_status'
    | 'ready'
    | 'listening';

interface QuotaInfo {
    daily_limit: number;
    daily_usage: number;
    daily_remaining: number;
    monthly_limit: number;
    monthly_usage: number;
    monthly_remaining: number;
    daily_percent_used: number;
    monthly_percent_used: number;
}

interface TokenInfo {
    expires_in_seconds: number;
    is_valid: boolean;
}

interface VoiceAgentStatus {
    event: VoiceAgentEventType;
    message: string;
    timestamp?: string;
    quota?: QuotaInfo;
    token?: TokenInfo;
    error_details?: string;
    recoverable?: boolean;
}

function EyeTracker() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const eyeLeftRef = useRef<THREE.Object3D | null>(null);
    const eyeRightRef = useRef<THREE.Object3D | null>(null);
    const eyeLeftAdditionalRef = useRef<THREE.Object3D | null>(null);
    const eyeRightAdditionalRef = useRef<THREE.Object3D | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<number | null>(null);
    const modelRef = useRef<THREE.Object3D | null>(null);
    const wifiPollIntervalRef = useRef<number | null>(null);
    const successBannerTimeoutRef = useRef<number | null>(null);
    const hasShownSuccessBannerRef = useRef<boolean>(false);
    const voiceAgentErrorTimeoutRef = useRef<number | null>(null);

    const [isLoading, setIsLoading] = useState(true);
    const [showSettings, setShowSettings] = useState(false);
    const [xOffset, setXOffset] = useState(-0.890);
    const [yOffset, setYOffset] = useState(0.050);
    const [scaleMultiplier, setScaleMultiplier] = useState(1.32);
    
    // WiFi and QR code state
    const [wifiConnected, setWifiConnected] = useState(true);
    const [qrCodeImage, setQrCodeImage] = useState<string | null>(null);
    const [showSuccessBanner, setShowSuccessBanner] = useState(false);
    const [connectedSsid, setConnectedSsid] = useState<string | null>(null);
    
    // Provisioning state
    const [provisioningStatus, setProvisioningStatus] = useState<ProvisioningStatus | null>(null);
    const provisioningSuccessTimeoutRef = useRef<number | null>(null);
    
    // Voice agent state
    const [voiceAgentStatus, setVoiceAgentStatus] = useState<VoiceAgentStatus | null>(null);
    const [quotaInfo, setQuotaInfo] = useState<QuotaInfo | null>(null);
    const [voiceAgentError, setVoiceAgentError] = useState<VoiceAgentStatus | null>(null);
    const [showQuotaWarning, setShowQuotaWarning] = useState(false);

    // Check WiFi status
    const checkWifiStatus = useCallback(async () => {
        try {
            const status = await invoke<WifiStatus>('check_wifi_status');
            
            // If WiFi just connected and we haven't shown the banner yet
            if (status.connected && !hasShownSuccessBannerRef.current) {
                // Check if we were previously disconnected (qrCodeImage was shown)
                setWifiConnected(prevConnected => {
                    if (!prevConnected) {
                        // We were disconnected, now connected - show success banner
                        hasShownSuccessBannerRef.current = true;
                        setShowSuccessBanner(true);
                        setConnectedSsid(status.ssid);
                        
                        // Hide success banner after 10 seconds
                        if (successBannerTimeoutRef.current) {
                            clearTimeout(successBannerTimeoutRef.current);
                        }
                        successBannerTimeoutRef.current = window.setTimeout(() => {
                            setShowSuccessBanner(false);
                        }, 10000);
                    }
                    return status.connected;
                });
            } else {
                setWifiConnected(status.connected);
                setConnectedSsid(status.ssid);
            }
            
            // Reset the banner flag when WiFi disconnects so it can show again next time
            if (!status.connected) {
                hasShownSuccessBannerRef.current = false;
            }
        } catch (error) {
            console.error('Failed to check WiFi status:', error);
            setWifiConnected(false);
            hasShownSuccessBannerRef.current = false;
        }
    }, []);

    // Fetch QR code image
    const fetchQrCode = useCallback(async () => {
        try {
            const response = await invoke<QrCodeResponse>('get_qr_code_image');
            if (response.exists && response.data) {
                setQrCodeImage(response.data);
            } else {
                setQrCodeImage(null);
            }
        } catch (error) {
            console.error('Failed to fetch QR code:', error);
            setQrCodeImage(null);
        }
    }, []);

    // Setup WiFi polling and QR code file watcher
    useEffect(() => {
        // Initial checks
        checkWifiStatus();
        fetchQrCode();

        // Poll WiFi status every 10 seconds
        wifiPollIntervalRef.current = window.setInterval(() => {
            checkWifiStatus();
        }, 10000);

        // Listen for QR code file changes from Rust backend
        const unlistenQrPromise = listen<QrCodeResponse>('qr-code-changed', (event) => {
            console.log('QR code file changed:', event.payload);
            if (event.payload.exists && event.payload.data) {
                setQrCodeImage(event.payload.data);
            } else {
                setQrCodeImage(null);
            }
        });

        // Listen for provisioning status updates from honeybee-ble-go via IPC
        const unlistenProvisioningPromise = listen<ProvisioningStatus>('provisioning-status', (event) => {
            console.log('Provisioning status update:', event.payload);
            setProvisioningStatus(event.payload);
            
            // Clear provisioning status after success (after 15 seconds)
            if (event.payload.status === 'success') {
                if (provisioningSuccessTimeoutRef.current) {
                    clearTimeout(provisioningSuccessTimeoutRef.current);
                }
                provisioningSuccessTimeoutRef.current = window.setTimeout(() => {
                    setProvisioningStatus(null);
                }, 15000);
            }
        });

        // Listen for voice agent status updates
        const unlistenVoiceAgentPromise = listen<VoiceAgentStatus>('voice-agent-status', (event) => {
            console.log('Voice agent status update:', event.payload);
            setVoiceAgentStatus(event.payload);
            
            // Update quota info if present
            if (event.payload.quota) {
                setQuotaInfo(event.payload.quota);
            }
            
            // Show quota warning for quota_warning and quota_exceeded events
            if (event.payload.event === 'quota_warning' || event.payload.event === 'quota_exceeded') {
                setShowQuotaWarning(true);
                // Auto-hide after 30 seconds for warnings
                if (event.payload.event === 'quota_warning') {
                    setTimeout(() => setShowQuotaWarning(false), 30000);
                }
            }
        });

        // Listen for voice agent errors specifically
        const unlistenVoiceAgentErrorPromise = listen<VoiceAgentStatus>('voice-agent-error', (event) => {
            console.log('Voice agent error:', event.payload);
            setVoiceAgentError(event.payload);
            
            // Clear error after 15 seconds for recoverable errors
            if (event.payload.recoverable) {
                if (voiceAgentErrorTimeoutRef.current) {
                    clearTimeout(voiceAgentErrorTimeoutRef.current);
                }
                voiceAgentErrorTimeoutRef.current = window.setTimeout(() => {
                    setVoiceAgentError(null);
                }, 15000);
            }
        });

        // Listen for quota updates specifically
        const unlistenVoiceAgentQuotaPromise = listen<QuotaInfo>('voice-agent-quota', (event) => {
            console.log('Voice agent quota update:', event.payload);
            setQuotaInfo(event.payload);
        });

        return () => {
            if (wifiPollIntervalRef.current) {
                clearInterval(wifiPollIntervalRef.current);
            }
            if (successBannerTimeoutRef.current) {
                clearTimeout(successBannerTimeoutRef.current);
            }
            if (provisioningSuccessTimeoutRef.current) {
                clearTimeout(provisioningSuccessTimeoutRef.current);
            }
            if (voiceAgentErrorTimeoutRef.current) {
                clearTimeout(voiceAgentErrorTimeoutRef.current);
            }
            unlistenQrPromise.then(unlisten => unlisten());
            unlistenProvisioningPromise.then(unlisten => unlisten());
            unlistenVoiceAgentPromise.then(unlisten => unlisten());
            unlistenVoiceAgentErrorPromise.then(unlisten => unlisten());
            unlistenVoiceAgentQuotaPromise.then(unlisten => unlisten());
        };
    }, [checkWifiStatus, fetchQrCode]);

    // Update eye positions based on face tracking data
    const updateEyePositions = (data: FaceTrackingData) => {
        const leftEye = eyeLeftRef.current;
        const rightEye = eyeRightRef.current;
        const leftEyeAdditional = eyeLeftAdditionalRef.current;
        const rightEyeAdditional = eyeRightAdditionalRef.current;

        if (!leftEye || !rightEye || !leftEyeAdditional || !rightEyeAdditional) return;

        let xOffset = 0;
        let yOffset = 0;

        if (data.face_detected) {
            // Use smoothed position from server directly
            xOffset = data.position.x;
            yOffset = data.position.y;
        }
        // When face not detected, offsets stay at 0 (eyes look straight)

        const maxOffset = 0.02;
        const halfOffset = maxOffset / 2;

        // Update main eye meshes
        leftEye.position.x = xOffset * maxOffset;
        leftEye.position.y = yOffset * maxOffset;
        rightEye.position.x = xOffset * maxOffset;
        rightEye.position.y = yOffset * maxOffset;

        // Update additional eye meshes (iris)
        leftEyeAdditional.position.x = xOffset * halfOffset;
        leftEyeAdditional.position.y = yOffset * halfOffset;
        rightEyeAdditional.position.x = xOffset * halfOffset;
        rightEyeAdditional.position.y = yOffset * halfOffset;
    };

    // WebSocket connection with auto-reconnect
    const connectWebSocket = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) return;

        const ws = new WebSocket('ws://localhost:8765');

        ws.onopen = () => {
            console.log('WebSocket connected to face tracking server');
        };

        ws.onmessage = (event) => {
            try {
                const data: FaceTrackingData = JSON.parse(event.data);
                updateEyePositions(data);
            } catch (e) {
                console.error('Failed to parse face tracking data:', e);
            }
        };

        ws.onclose = () => {
            console.log('WebSocket disconnected, reconnecting in 2s...');
            // Reset eyes to center when disconnected
            updateEyePositions({ face_detected: false, position: { x: 0, y: 0 } });
            // Auto-reconnect
            reconnectTimeoutRef.current = window.setTimeout(connectWebSocket, 2000);
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            ws.close();
        };

        wsRef.current = ws;
    };

    // Keyboard shortcut handler for settings panel
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.key === 'h') {
                e.preventDefault();
                setShowSettings(prev => !prev);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // Apply position and scale adjustments to model
    useEffect(() => {
        if (modelRef.current) {
            const model = modelRef.current;
            const height = window.innerHeight;
            
            // Apply scale
            const baseScaleFactor = (height / 480) * 38;
            const finalScale = baseScaleFactor * scaleMultiplier;
            model.scale.set(finalScale, finalScale, finalScale);
            
            // Recenter and apply offsets
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            model.position.x = -center.x + xOffset;
            model.position.y = -center.y + yOffset;
            model.position.z = -center.z;
        }
    }, [xOffset, yOffset, scaleMultiplier]);

    useEffect(() => {
        // Create Three.js scene
        const scene = new THREE.Scene();
        sceneRef.current = scene;

        // Set solid black background (simpler than canvas texture)
        scene.background = new THREE.Color(0x000000);

        // Setup camera
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        cameraRef.current = camera;
        camera.position.z = 8;

        // Create renderer with proper color management
        const renderer = new THREE.WebGLRenderer({
            canvas: canvasRef.current!,
            antialias: true,
            alpha: false,
            powerPreference: 'default'
        });
        rendererRef.current = renderer;
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        
        // Critical: Set proper color space for correct rendering
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;

        // Lighting setup
        const ambientLight = new THREE.AmbientLight(0x404040, 0.3);
        scene.add(ambientLight);

        const keyLight = new THREE.DirectionalLight(0xffffff, 15);
        keyLight.position.set(5, 5, 5);
        keyLight.castShadow = true;
        scene.add(keyLight);

        const fillLight = new THREE.DirectionalLight(0x87ceeb, 3);
        fillLight.position.set(-3, 2, 3);
        scene.add(fillLight);

        const rimLight = new THREE.DirectionalLight(0xff6b35, 8);
        rimLight.position.set(0, -2, -5);
        scene.add(rimLight);

        const pointLight = new THREE.PointLight(0xffd700, 4, 10);
        pointLight.position.set(2, 10, 2);
        scene.add(pointLight);

        // Load 3D model
        const loader = new GLTFLoader();
        
        // Use relative path for Tauri compatibility
        const modelPath = 'Normal.glb';
        console.log('Loading model from:', modelPath);
        
        loader.load(modelPath, (gltf) => {
            console.log('Model loaded successfully');
            const model = gltf.scene;
            modelRef.current = model;
            const height = window.innerHeight;

            // Scale to fit screen height and apply user multiplier
            const baseScaleFactor = (height / 480) * 38;
            const finalScale = baseScaleFactor * scaleMultiplier;
            model.scale.set(finalScale, finalScale, finalScale);

            model.position.set(0, 0, 0);

            // Center the model and apply initial offsets from state
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            model.position.x = -center.x + xOffset;
            model.position.y = -center.y + yOffset;
            model.position.z = -center.z;

            scene.add(model);

            // Setup materials with proper color space handling
            model.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) {
                    const mesh = child as THREE.Mesh;
                    if (mesh.material) {
                        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                        materials.forEach((material, index) => {
                            if ((material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
                                const stdMaterial = material as THREE.MeshStandardMaterial;
                                
                                // Ensure textures use correct color space
                                if (stdMaterial.map) {
                                    stdMaterial.map.colorSpace = THREE.SRGBColorSpace;
                                }
                                if (stdMaterial.emissiveMap) {
                                    stdMaterial.emissiveMap.colorSpace = THREE.SRGBColorSpace;
                                }
                                
                                if (child.name?.includes('eye')) {
                                    stdMaterial.metalness = 0.9;
                                    stdMaterial.roughness = 0.1;
                                    stdMaterial.emissive = new THREE.Color(0x001122);
                                    stdMaterial.emissiveIntensity = 0.2;
                                } else if (child.name?.includes('skin') || child.name?.includes('face')) {
                                    stdMaterial.metalness = 0.1;
                                    stdMaterial.roughness = 0.7;
                                    stdMaterial.color.multiplyScalar(1.1);
                                } else {
                                    stdMaterial.metalness = 0.6 + (index * 0.1);
                                    stdMaterial.roughness = 0.3 - (index * 0.05);
                                }
                                stdMaterial.needsUpdate = true;
                            }
                        });
                    }
                }
            });

            // Setup eye mesh helper
            const setupEyeMesh = (meshName: string): THREE.Object3D | null => {
                const mesh = model.getObjectByName(meshName);
                if (mesh) {
                    mesh.visible = true;
                    mesh.position.set(0, 0, 0);
                    mesh.rotation.set(0, 0, 0);
                    if ((mesh as THREE.Mesh).material) {
                        ((mesh as THREE.Mesh).material as THREE.Material).visible = true;
                    }
                }
                return mesh || null;
            };

            // Setup eye meshes
            eyeLeftRef.current = setupEyeMesh('ballL1');
            eyeRightRef.current = setupEyeMesh('ballR1');
            eyeLeftAdditionalRef.current = setupEyeMesh('iresL1');
            eyeRightAdditionalRef.current = setupEyeMesh('IresR1');

            setIsLoading(false);

            // Connect to WebSocket after model is loaded
            connectWebSocket();
        },
            (xhr) => {
                const percent = xhr.total > 0 ? (xhr.loaded / xhr.total * 100).toFixed(0) : 'unknown';
                console.log(`Model loading: ${percent}% loaded`);
            },
            (error) => {
                console.error('Error loading model:', error);
                console.error('Failed to load GLB file. Check if Normal.glb exists in public folder.');
            }
        );

        // Animation loop
        const animate = () => {
            animationFrameRef.current = requestAnimationFrame(animate);
            renderer.render(scene, camera);
        };
        animate();

        // Handle window resize
        const handleResize = () => {
            const width = window.innerWidth;
            const height = window.innerHeight;
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height);
        };
        window.addEventListener('resize', handleResize);

        // Cleanup
        return () => {
            window.removeEventListener('resize', handleResize);
            
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
            
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
            
            if (wsRef.current) {
                wsRef.current.close();
            }
            
            renderer.dispose();
            scene.traverse((object) => {
                if ((object as THREE.Mesh).isMesh) {
                    const mesh = object as THREE.Mesh;
                    mesh.geometry.dispose();
                    if (Array.isArray(mesh.material)) {
                        mesh.material.forEach(m => m.dispose());
                    } else {
                        mesh.material.dispose();
                    }
                }
            });
        };
    }, []);

    // Determine if QR overlay should be shown (not during provisioning)
    const showQrOverlay = !wifiConnected && qrCodeImage && !provisioningStatus;
    
    // Determine if provisioning overlay should be shown
    const showProvisioningOverlay = provisioningStatus && 
        [
            'connecting_wifi', 'wifi_connected', 'wifi_failed', 'ble_paired',
            'api_requesting', 'api_success', 'api_failed', 'api_resources_reused',
            'provisioning', 'starting_tunnel', 'tunnel_connected', 'tunnel_error',
            'tunnel_repairing', 'tunnel_recreating', 'retrying', 'retry_available',
            'provisioned', 'success', 'error'
        ].includes(provisioningStatus.status);

    // Get provisioning status display info
    const getProvisioningDisplayInfo = () => {
        if (!provisioningStatus) return { icon: '', title: '', color: '' };
        
        switch (provisioningStatus.status) {
            case 'ble_paired':
                return { icon: '📲', title: 'Mobile App Connected', color: 'rgba(59, 130, 246, 0.95)' };
            case 'connecting_wifi':
                return { icon: '📶', title: 'Connecting to WiFi...', color: 'rgba(59, 130, 246, 0.95)' };
            case 'wifi_connected':
                return { icon: '✅', title: 'WiFi Connected', color: 'rgba(34, 197, 94, 0.95)' };
            case 'wifi_failed':
                return { icon: '❌', title: 'WiFi Connection Failed', color: 'rgba(239, 68, 68, 0.95)' };
            case 'api_requesting':
            case 'provisioning':
                return { icon: '🔐', title: 'Activating Device...', color: 'rgba(139, 92, 246, 0.95)' };
            case 'api_success':
                return { icon: '✅', title: 'Device Activated', color: 'rgba(34, 197, 94, 0.95)' };
            case 'api_failed':
                return { icon: '❌', title: 'Activation Failed', color: 'rgba(239, 68, 68, 0.95)' };
            case 'api_resources_reused':
                return { icon: '🔄', title: 'Configuration Retrieved', color: 'rgba(34, 197, 94, 0.95)' };
            case 'starting_tunnel':
                return { icon: '🚀', title: 'Starting Secure Tunnel...', color: 'rgba(236, 72, 153, 0.95)' };
            case 'tunnel_connected':
                return { icon: '🔒', title: 'Tunnel Connected', color: 'rgba(34, 197, 94, 0.95)' };
            case 'tunnel_error':
                return { icon: '⚠️', title: 'Tunnel Error', color: 'rgba(245, 158, 11, 0.95)' };
            case 'tunnel_repairing':
                return { icon: '🔧', title: 'Repairing Connection...', color: 'rgba(245, 158, 11, 0.95)' };
            case 'tunnel_recreating':
                return { icon: '🔨', title: 'Recreating Tunnel...', color: 'rgba(245, 158, 11, 0.95)' };
            case 'retrying':
                return { icon: '🔄', title: 'Retrying...', color: 'rgba(59, 130, 246, 0.95)' };
            case 'retry_available':
                return { icon: '🔄', title: 'Retry Available', color: 'rgba(245, 158, 11, 0.95)' };
            case 'provisioned':
            case 'success':
                return { icon: '🎉', title: 'Setup Complete!', color: 'rgba(34, 197, 94, 0.95)' };
            case 'error':
                return { icon: '❌', title: 'Setup Failed', color: 'rgba(239, 68, 68, 0.95)' };
            default:
                return { icon: '⏳', title: 'Processing...', color: 'rgba(107, 114, 128, 0.95)' };
        }
    };
    
    const provisioningDisplay = getProvisioningDisplayInfo();
    
    // Check if current status allows retry button
    const canRetry = provisioningStatus?.can_retry || 
        ['wifi_failed', 'api_failed', 'tunnel_error', 'retry_available', 'error'].includes(provisioningStatus?.status || '');
    
    // Trigger retry from kiosk UI
    const handleRetry = async () => {
        try {
            await invoke('trigger_provisioning_retry');
        } catch (error) {
            console.error('Failed to trigger retry:', error);
        }
    };

    return (
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                width: '100%',
                height: '100vh',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                overflow: 'hidden',
                backgroundColor: '#000',
            }}
        >
            {isLoading && (
                <div
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        backgroundColor: '#000',
                        color: '#fff',
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                        zIndex: 10,
                    }}
                >
                    <h1>Loading...</h1>
                </div>
            )}

            {/* Eye Tracker Canvas - blurred when QR or provisioning overlay is shown */}
            <canvas
                ref={canvasRef}
                style={{
                    width: '100%',
                    height: '100%',
                    filter: (showQrOverlay || showProvisioningOverlay) ? 'blur(20px)' : 'none',
                    transition: 'filter 0.3s ease-in-out',
                }}
            />

            {/* QR Code Overlay - shown when WiFi is not connected */}
            {showQrOverlay && (
                <div
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        alignItems: 'center',
                        zIndex: 100,
                        backgroundColor: 'rgba(0, 0, 0, 0.5)',
                    }}
                >
                    <div
                        style={{
                            backgroundColor: '#fff',
                            padding: '30px',
                            borderRadius: '20px',
                            boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            maxWidth: '90%',
                        }}
                    >
                        <h2
                            style={{
                                margin: '0 0 20px 0',
                                color: '#333',
                                fontSize: '24px',
                                textAlign: 'center',
                            }}
                        >
                            📱 Connect to WiFi
                        </h2>
                        <p
                            style={{
                                margin: '0 0 20px 0',
                                color: '#666',
                                fontSize: '16px',
                                textAlign: 'center',
                            }}
                        >
                            Scan with Honeybee mobile app
                        </p>
                        <img
                            src={qrCodeImage}
                            alt="WiFi Setup QR Code"
                            style={{
                                width: '256px',
                                height: '256px',
                                borderRadius: '10px',
                            }}
                        />
                        <p
                            style={{
                                margin: '20px 0 0 0',
                                color: '#999',
                                fontSize: '14px',
                                textAlign: 'center',
                            }}
                        >
                            No WiFi connection detected
                        </p>
                    </div>
                </div>
            )}

            {/* Success Banner - shown for 10 seconds after WiFi connects */}
            {showSuccessBanner && (
                <div
                    style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        zIndex: 200,
                        backgroundColor: 'rgba(34, 197, 94, 0.95)',
                        padding: '30px 50px',
                        borderRadius: '20px',
                        boxShadow: '0 10px 40px rgba(0, 0, 0, 0.3)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        animation: 'fadeIn 0.3s ease-in-out',
                    }}
                >
                    <div
                        style={{
                            fontSize: '60px',
                            marginBottom: '15px',
                        }}
                    >
                        ✅
                    </div>
                    <h2
                        style={{
                            margin: '0 0 10px 0',
                            color: '#fff',
                            fontSize: '28px',
                            fontWeight: 'bold',
                        }}
                    >
                        Connected!
                    </h2>
                    {connectedSsid && (
                        <p
                            style={{
                                margin: 0,
                                color: 'rgba(255, 255, 255, 0.9)',
                                fontSize: '18px',
                            }}
                        >
                            {connectedSsid}
                        </p>
                    )}
                </div>
            )}

            {/* Provisioning Status Overlay */}
            {showProvisioningOverlay && provisioningStatus && (
                <div
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        alignItems: 'center',
                        zIndex: 150,
                        backgroundColor: 'rgba(0, 0, 0, 0.6)',
                    }}
                >
                    <div
                        style={{
                            backgroundColor: provisioningDisplay.color,
                            padding: '40px 60px',
                            borderRadius: '24px',
                            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.4)',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            minWidth: '400px',
                            maxWidth: '600px',
                        }}
                    >
                        {/* Animated Icon */}
                        <div
                            style={{
                                fontSize: '80px',
                                marginBottom: '20px',
                                animation: provisioningStatus.status === 'error' ? 'none' : 'pulse 1.5s infinite',
                            }}
                        >
                            {provisioningDisplay.icon}
                        </div>
                        
                        {/* Title */}
                        <h2
                            style={{
                                margin: '0 0 15px 0',
                                color: '#fff',
                                fontSize: '32px',
                                fontWeight: 'bold',
                                textAlign: 'center',
                            }}
                        >
                            {provisioningDisplay.title}
                        </h2>
                        
                        {/* Message */}
                        <p
                            style={{
                                margin: '0 0 20px 0',
                                color: 'rgba(255, 255, 255, 0.9)',
                                fontSize: '18px',
                                textAlign: 'center',
                            }}
                        >
                            {provisioningStatus.message}
                        </p>
                        
                        {/* Progress Bar (for non-error states) */}
                        {provisioningStatus.status !== 'error' && provisioningStatus.status !== 'success' && (
                            <div
                                style={{
                                    width: '100%',
                                    height: '8px',
                                    backgroundColor: 'rgba(255, 255, 255, 0.3)',
                                    borderRadius: '4px',
                                    overflow: 'hidden',
                                    marginBottom: '15px',
                                }}
                            >
                                <div
                                    style={{
                                        height: '100%',
                                        backgroundColor: '#fff',
                                        borderRadius: '4px',
                                        width: provisioningStatus.progress ? `${provisioningStatus.progress}%` : '0%',
                                        transition: 'width 0.5s ease-out',
                                        animation: provisioningStatus.progress ? 'none' : 'indeterminate 1.5s infinite',
                                    }}
                                />
                            </div>
                        )}
                        
                        {/* Success Details */}
                        {provisioningStatus.status === 'success' && provisioningStatus.hostname && (
                            <div
                                style={{
                                    backgroundColor: 'rgba(255, 255, 255, 0.2)',
                                    padding: '15px 25px',
                                    borderRadius: '12px',
                                    marginTop: '10px',
                                }}
                            >
                                <p
                                    style={{
                                        margin: 0,
                                        color: '#fff',
                                        fontSize: '14px',
                                        textAlign: 'center',
                                    }}
                                >
                                    🏠 Home Assistant: <strong>{provisioningStatus.hostname}</strong>
                                </p>
                                {provisioningStatus.dashboard_hostname && (
                                    <p
                                        style={{
                                            margin: '10px 0 0 0',
                                            color: '#fff',
                                            fontSize: '14px',
                                            textAlign: 'center',
                                        }}
                                    >
                                        📊 Dashboard: <strong>{provisioningStatus.dashboard_hostname}</strong>
                                    </p>
                                )}
                            </div>
                        )}
                        
                        {/* Error Details */}
                        {(provisioningStatus.status === 'error' || provisioningStatus.status === 'wifi_failed' || 
                          provisioningStatus.status === 'api_failed' || provisioningStatus.status === 'tunnel_error' ||
                          provisioningStatus.status === 'retry_available') && (
                            <div
                                style={{
                                    backgroundColor: 'rgba(0, 0, 0, 0.2)',
                                    padding: '15px 25px',
                                    borderRadius: '12px',
                                    marginTop: '10px',
                                    maxWidth: '100%',
                                }}
                            >
                                {provisioningStatus.error_details && (
                                    <p
                                        style={{
                                            margin: '0 0 10px 0',
                                            color: 'rgba(255, 255, 255, 0.9)',
                                            fontSize: '14px',
                                            textAlign: 'center',
                                            wordBreak: 'break-word',
                                        }}
                                    >
                                        {provisioningStatus.error_details}
                                    </p>
                                )}
                                {provisioningStatus.retry_count !== undefined && provisioningStatus.retry_count > 0 && (
                                    <p
                                        style={{
                                            margin: 0,
                                            color: 'rgba(255, 255, 255, 0.7)',
                                            fontSize: '13px',
                                            textAlign: 'center',
                                        }}
                                    >
                                        Attempt {provisioningStatus.retry_count} of {provisioningStatus.max_retries || 3}
                                    </p>
                                )}
                                
                                {/* Retry Button */}
                                {canRetry && (
                                    <button
                                        onClick={handleRetry}
                                        style={{
                                            display: 'block',
                                            width: '100%',
                                            marginTop: '15px',
                                            padding: '12px 24px',
                                            backgroundColor: 'rgba(255, 255, 255, 0.2)',
                                            color: '#fff',
                                            border: '2px solid rgba(255, 255, 255, 0.5)',
                                            borderRadius: '8px',
                                            fontSize: '16px',
                                            fontWeight: 'bold',
                                            cursor: 'pointer',
                                            transition: 'all 0.2s ease',
                                        }}
                                        onMouseOver={(e) => {
                                            e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.3)';
                                            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.8)';
                                        }}
                                        onMouseOut={(e) => {
                                            e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
                                            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.5)';
                                        }}
                                    >
                                        🔄 Retry Provisioning
                                    </button>
                                )}
                                
                                {!canRetry && (
                                    <p
                                        style={{
                                            margin: '15px 0 0 0',
                                            color: 'rgba(255, 255, 255, 0.8)',
                                            fontSize: '14px',
                                            textAlign: 'center',
                                        }}
                                    >
                                        Please try again from the mobile app
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Voice Agent Quota Display - shown in corner when quota info available */}
            {quotaInfo && !showProvisioningOverlay && !showQrOverlay && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: '20px',
                        left: '20px',
                        backgroundColor: quotaInfo.daily_percent_used > 80 
                            ? 'rgba(239, 68, 68, 0.9)' 
                            : quotaInfo.daily_percent_used > 50 
                                ? 'rgba(245, 158, 11, 0.9)' 
                                : 'rgba(34, 197, 94, 0.85)',
                        padding: '12px 18px',
                        borderRadius: '12px',
                        boxShadow: '0 4px 15px rgba(0, 0, 0, 0.3)',
                        zIndex: 50,
                        minWidth: '180px',
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                        <span style={{ fontSize: '18px', marginRight: '8px' }}>
                            {quotaInfo.daily_percent_used > 80 ? '⚠️' : '📊'}
                        </span>
                        <span style={{ color: '#fff', fontSize: '14px', fontWeight: 'bold' }}>
                            Daily Quota
                        </span>
                    </div>
                    <div style={{ 
                        backgroundColor: 'rgba(255, 255, 255, 0.2)', 
                        borderRadius: '6px', 
                        height: '8px',
                        marginBottom: '6px',
                        overflow: 'hidden',
                    }}>
                        <div style={{
                            backgroundColor: '#fff',
                            height: '100%',
                            width: `${Math.min(100, quotaInfo.daily_percent_used)}%`,
                            borderRadius: '6px',
                            transition: 'width 0.3s ease',
                        }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#fff', fontSize: '12px' }}>
                        <span>{quotaInfo.daily_remaining} left</span>
                        <span>{quotaInfo.daily_usage} / {quotaInfo.daily_limit}</span>
                    </div>
                </div>
            )}

            {/* Voice Agent Error Notification - shown as toast in top-right */}
            {voiceAgentError && (
                <div
                    style={{
                        position: 'absolute',
                        top: '20px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        backgroundColor: voiceAgentError.event === 'quota_exceeded' 
                            ? 'rgba(239, 68, 68, 0.95)' 
                            : voiceAgentError.event === 'network_error'
                                ? 'rgba(245, 158, 11, 0.95)'
                                : 'rgba(239, 68, 68, 0.95)',
                        padding: '16px 24px',
                        borderRadius: '12px',
                        boxShadow: '0 8px 25px rgba(0, 0, 0, 0.3)',
                        zIndex: 300,
                        maxWidth: '500px',
                        animation: 'slideDown 0.3s ease-out',
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                        <span style={{ fontSize: '24px', marginRight: '12px' }}>
                            {voiceAgentError.event === 'quota_exceeded' ? '🚫' 
                                : voiceAgentError.event === 'network_error' ? '🌐' 
                                : voiceAgentError.event === 'token_error' ? '🔐'
                                : '❌'}
                        </span>
                        <span style={{ color: '#fff', fontSize: '18px', fontWeight: 'bold' }}>
                            {voiceAgentError.event === 'quota_exceeded' ? 'Quota Exceeded'
                                : voiceAgentError.event === 'network_error' ? 'Network Error'
                                : voiceAgentError.event === 'token_error' ? 'Authentication Error'
                                : 'Voice Agent Error'}
                        </span>
                    </div>
                    <p style={{ margin: 0, color: 'rgba(255, 255, 255, 0.95)', fontSize: '14px' }}>
                        {voiceAgentError.message}
                    </p>
                    {voiceAgentError.error_details && (
                        <p style={{ 
                            margin: '8px 0 0 0', 
                            color: 'rgba(255, 255, 255, 0.75)', 
                            fontSize: '12px',
                            fontStyle: 'italic',
                        }}>
                            {voiceAgentError.error_details}
                        </p>
                    )}
                    {voiceAgentError.recoverable && (
                        <p style={{ 
                            margin: '10px 0 0 0', 
                            color: 'rgba(255, 255, 255, 0.9)', 
                            fontSize: '13px',
                        }}>
                            Will retry automatically...
                        </p>
                    )}
                    <button
                        onClick={() => setVoiceAgentError(null)}
                        style={{
                            position: 'absolute',
                            top: '8px',
                            right: '8px',
                            backgroundColor: 'transparent',
                            border: 'none',
                            color: 'rgba(255, 255, 255, 0.7)',
                            fontSize: '18px',
                            cursor: 'pointer',
                            padding: '4px 8px',
                        }}
                    >
                        ✕
                    </button>
                </div>
            )}

            {/* Quota Warning Banner - shown prominently when quota is low */}
            {showQuotaWarning && quotaInfo && !showProvisioningOverlay && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: '100px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        backgroundColor: quotaInfo.daily_remaining === 0 
                            ? 'rgba(239, 68, 68, 0.95)' 
                            : 'rgba(245, 158, 11, 0.95)',
                        padding: '20px 30px',
                        borderRadius: '16px',
                        boxShadow: '0 8px 30px rgba(0, 0, 0, 0.4)',
                        zIndex: 250,
                        textAlign: 'center',
                        animation: 'pulse 2s infinite',
                    }}
                >
                    <div style={{ fontSize: '40px', marginBottom: '10px' }}>
                        {quotaInfo.daily_remaining === 0 ? '🚫' : '⚠️'}
                    </div>
                    <h3 style={{ margin: '0 0 8px 0', color: '#fff', fontSize: '20px' }}>
                        {quotaInfo.daily_remaining === 0 ? 'Daily Quota Exceeded' : 'Quota Running Low'}
                    </h3>
                    <p style={{ margin: 0, color: 'rgba(255, 255, 255, 0.9)', fontSize: '16px' }}>
                        {quotaInfo.daily_remaining === 0 
                            ? 'Voice commands unavailable until tomorrow'
                            : `Only ${quotaInfo.daily_remaining} requests remaining today`}
                    </p>
                    <button
                        onClick={() => setShowQuotaWarning(false)}
                        style={{
                            marginTop: '15px',
                            padding: '8px 20px',
                            backgroundColor: 'rgba(255, 255, 255, 0.2)',
                            color: '#fff',
                            border: '1px solid rgba(255, 255, 255, 0.5)',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            fontSize: '14px',
                        }}
                    >
                        Dismiss
                    </button>
                </div>
            )}

            {/* Voice Agent Status Indicator - small icon in bottom-right */}
            {voiceAgentStatus && !showProvisioningOverlay && !showQrOverlay && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: '20px',
                        right: '20px',
                        backgroundColor: voiceAgentStatus.event === 'listening' 
                            ? 'rgba(59, 130, 246, 0.9)' 
                            : voiceAgentStatus.event === 'session_started'
                                ? 'rgba(139, 92, 246, 0.9)'
                                : 'rgba(107, 114, 128, 0.8)',
                        padding: '10px 16px',
                        borderRadius: '20px',
                        boxShadow: '0 4px 15px rgba(0, 0, 0, 0.3)',
                        zIndex: 50,
                        display: 'flex',
                        alignItems: 'center',
                        animation: voiceAgentStatus.event === 'listening' ? 'pulse 1.5s infinite' : 'none',
                    }}
                >
                    <span style={{ fontSize: '18px', marginRight: '8px' }}>
                        {voiceAgentStatus.event === 'listening' ? '🎤' 
                            : voiceAgentStatus.event === 'session_started' ? '✨'
                            : voiceAgentStatus.event === 'ready' ? '👂'
                            : '🤖'}
                    </span>
                    <span style={{ color: '#fff', fontSize: '13px', fontWeight: '500' }}>
                        {voiceAgentStatus.event === 'listening' ? 'Listening...'
                            : voiceAgentStatus.event === 'session_started' ? 'Session Active'
                            : voiceAgentStatus.event === 'ready' ? 'Ready'
                            : voiceAgentStatus.message.slice(0, 30)}
                    </span>
                </div>
            )}

            {showSettings && (
                <div
                    style={{
                        position: 'absolute',
                        top: '20px',
                        right: '20px',
                        backgroundColor: 'rgba(0, 0, 0, 0.7)',
                        color: '#fff',
                        padding: '20px',
                        borderRadius: '8px',
                        fontFamily: 'monospace',
                        fontSize: '14px',
                        zIndex: 1000,
                        minWidth: '300px',
                    }}
                >
                    <h3 style={{ margin: '0 0 15px 0', fontSize: '16px' }}>
                        Position & Scale Adjustments
                    </h3>
                    
                    <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '5px' }}>
                            X Offset: {xOffset.toFixed(3)}
                        </label>
                        <input
                            type="range"
                            min="-1"
                            max="1"
                            step="0.01"
                            value={xOffset}
                            onChange={(e) => setXOffset(parseFloat(e.target.value))}
                            style={{ width: '100%' }}
                        />
                        <input
                            type="number"
                            min="-1"
                            max="1"
                            step="0.01"
                            value={xOffset}
                            onChange={(e) => setXOffset(parseFloat(e.target.value))}
                            style={{
                                width: '100%',
                                marginTop: '5px',
                                padding: '5px',
                                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                                color: '#fff',
                                border: '1px solid rgba(255, 255, 255, 0.3)',
                                borderRadius: '4px',
                            }}
                        />
                    </div>

                    <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '5px' }}>
                            Y Offset: {yOffset.toFixed(3)}
                        </label>
                        <input
                            type="range"
                            min="-1"
                            max="1"
                            step="0.01"
                            value={yOffset}
                            onChange={(e) => setYOffset(parseFloat(e.target.value))}
                            style={{ width: '100%' }}
                        />
                        <input
                            type="number"
                            min="-1"
                            max="1"
                            step="0.01"
                            value={yOffset}
                            onChange={(e) => setYOffset(parseFloat(e.target.value))}
                            style={{
                                width: '100%',
                                marginTop: '5px',
                                padding: '5px',
                                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                                color: '#fff',
                                border: '1px solid rgba(255, 255, 255, 0.3)',
                                borderRadius: '4px',
                            }}
                        />
                    </div>

                    <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '5px' }}>
                            Scale Multiplier: {scaleMultiplier.toFixed(2)}
                        </label>
                        <input
                            type="range"
                            min="0.5"
                            max="2.0"
                            step="0.01"
                            value={scaleMultiplier}
                            onChange={(e) => setScaleMultiplier(parseFloat(e.target.value))}
                            style={{ width: '100%' }}
                        />
                        <input
                            type="number"
                            min="0.5"
                            max="2.0"
                            step="0.01"
                            value={scaleMultiplier}
                            onChange={(e) => setScaleMultiplier(parseFloat(e.target.value))}
                            style={{
                                width: '100%',
                                marginTop: '5px',
                                padding: '5px',
                                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                                color: '#fff',
                                border: '1px solid rgba(255, 255, 255, 0.3)',
                                borderRadius: '4px',
                            }}
                        />
                    </div>

                    <div style={{ 
                        marginTop: '20px', 
                        padding: '10px', 
                        backgroundColor: 'rgba(255, 255, 255, 0.1)',
                        borderRadius: '4px',
                        fontSize: '12px',
                    }}>
                        <div style={{ marginBottom: '5px' }}>
                            <strong>Copy these values to code:</strong>
                        </div>
                        <div>xOffset: {xOffset.toFixed(3)}</div>
                        <div>yOffset: {yOffset.toFixed(3)}</div>
                        <div>scaleMultiplier: {scaleMultiplier.toFixed(2)}</div>
                    </div>

                    <div style={{ 
                        marginTop: '15px', 
                        fontSize: '12px',
                        opacity: 0.7,
                    }}>
                        Press Ctrl+H to close
                    </div>
                </div>
            )}
        </div>
    );
}

export default EyeTracker;
