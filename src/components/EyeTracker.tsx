import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

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

    const [isLoading, setIsLoading] = useState(true);
    const [showSettings, setShowSettings] = useState(false);
    const [xOffset, setXOffset] = useState(-0.890);
    const [yOffset, setYOffset] = useState(0.050);
    const [scaleMultiplier, setScaleMultiplier] = useState(1.32);

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

            <canvas
                ref={canvasRef}
                style={{
                    width: '100%',
                    height: '100%',
                }}
            />

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
