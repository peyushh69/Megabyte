import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload,
  Download,
  Wifi,
  Bluetooth,
  HardDrive,
  QrCode,
  Trash2,
  Check,
  Copy,
  RefreshCw,
  Lock,
  Unlock,
  X,
} from 'lucide-react';
import { SharedFileItem, ConnectedDevice, TransferMode } from './types';
import { QrPairingModal } from './components/QrPairingModal';
import { P2PRoomSession } from './services/p2pRoomEngine';

const MAX_CAPACITY_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const PARALLEL_STREAMS = 6;
const CLOUD_RELAY_ORIGIN = 'https://ais-pre-hfc6oo7zpwljrbblduvnkw-567788766771.asia-southeast1.run.app';

async function resolveActiveBackendOrigin(): Promise<string | null> {
  // 1. Check same-origin first (works on Cloud Run / Node server)
  try {
    const res = await fetch('/api/health', { method: 'GET' });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      return '';
    }
  } catch {
    // ignore
  }

  // 2. When deployed to Vercel static hosting, check Cloud Relay Origin
  if (typeof window !== 'undefined' && window.location.origin !== CLOUD_RELAY_ORIGIN) {
    try {
      const res = await fetch(`${CLOUD_RELAY_ORIGIN}/api/health`, { method: 'GET', mode: 'cors' });
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('application/json')) {
        return CLOUD_RELAY_ORIGIN;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function getOptimalChunkSize(fileSize: number): number {
  if (fileSize <= 8 * 1024 * 1024) return 512 * 1024;
  if (fileSize <= 50 * 1024 * 1024) return 2 * 1024 * 1024;
  if (fileSize <= 250 * 1024 * 1024) return 4 * 1024 * 1024;
  return 8 * 1024 * 1024;
}

const RETENTION_OPTIONS: { hours: number; label: string }[] = [
  { hours: 1, label: '1 HOUR' },
  { hours: 6, label: '6 HOURS' },
  { hours: 24, label: '24 HOURS' },
  { hours: 72, label: '3 DAYS' },
  { hours: 168, label: '7 DAYS' },
];

function generatePrivateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const randomValues = new Uint8Array(8);
  window.crypto.getRandomValues(randomValues);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(randomValues[i] % chars.length);
  }
  return code;
}

function getInitialPrivateRoom(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('room')?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (fromUrl && fromUrl.length >= 4) {
    const cleaned = fromUrl.slice(0, 12);
    sessionStorage.setItem('swiftbeam_private_room_id', cleaned);
    return cleaned;
  }

  const existingSessionRoom = sessionStorage.getItem('swiftbeam_private_room_id');
  if (existingSessionRoom && existingSessionRoom.length >= 4) {
    return existingSessionRoom;
  }

  const freshPrivateRoom = generatePrivateRoomCode();
  sessionStorage.setItem('swiftbeam_private_room_id', freshPrivateRoom);
  return freshPrivateRoom;
}

function detectDeviceInfo(): {
  deviceId: string;
  deviceName: string;
  deviceType: 'PC' | 'Mobile';
  platform: string;
} {
  let savedId = sessionStorage.getItem('swiftbeam_device_id');
  if (!savedId) {
    savedId = `dev-${Math.random().toString(36).substring(2, 8)}`;
    sessionStorage.setItem('swiftbeam_device_id', savedId);
  }

  const ua = navigator.userAgent || '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  let os = 'DESKTOP';
  if (/Windows/i.test(ua)) os = 'WINDOWS PC';
  else if (/Macintosh|Mac OS/i.test(ua)) os = 'MAC OS';
  else if (/Android/i.test(ua)) os = 'ANDROID';
  else if (/iPhone|iPad/i.test(ua)) os = 'IPHONE';
  else if (/Linux/i.test(ua)) os = 'LINUX PC';

  const suffix = savedId.slice(-3).toUpperCase();
  return {
    deviceId: savedId,
    deviceName: `${os} #${suffix}`,
    deviceType: isMobile ? 'Mobile' : 'PC',
    platform: os,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(i >= 2 ? 2 : 1)} ${sizes[i]}`;
}

function formatExpiryRemaining(expiresIso: string): string {
  const diffMs = new Date(expiresIso).getTime() - Date.now();
  if (diffMs <= 0) return 'EXPIRED';
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) return `${days}D ${hours}H LEFT`;
  if (hours > 0) return `${hours}H ${mins}M LEFT`;
  return `${Math.max(1, mins)}M LEFT`;
}

export default function App() {
  const [deviceInfo] = useState(detectDeviceInfo);
  const [roomId, setRoomId] = useState<string>(getInitialPrivateRoom);

  const [roomPin, setRoomPin] = useState<string>('');
  const [hasRoomPin, setHasRoomPin] = useState<boolean>(false);
  const [requiresPinUnlock, setRequiresPinUnlock] = useState<boolean>(false);
  const [pinUnlockInput, setPinUnlockInput] = useState<string>('');
  const [pinUnlockError, setPinUnlockError] = useState<string | null>(null);
  const [isSettingPin, setIsSettingPin] = useState<boolean>(false);
  const [newPinInput, setNewPinInput] = useState<string>('');

  const [retentionHours, setRetentionHours] = useState<number>(24);

  const [serverFiles, setServerFiles] = useState<SharedFileItem[]>([]);
  const [p2pFiles, setP2pFiles] = useState<SharedFileItem[]>([]);

  const selfDeviceRecord: ConnectedDevice = {
    id: deviceInfo.deviceId,
    name: deviceInfo.deviceName,
    deviceType: deviceInfo.deviceType,
    platform: deviceInfo.platform,
    transport: 'Wi-Fi / High-Speed Relay',
    status: 'online',
    lastSeen: new Date().toISOString(),
  };

  const [serverDevices, setServerDevices] = useState<ConnectedDevice[]>([]);
  const [p2pDevices, setP2pDevices] = useState<ConnectedDevice[]>([selfDeviceRecord]);
  const [isLoadingRoom, setIsLoadingRoom] = useState<boolean>(false);

  const [transferMode, setTransferMode] = useState<TransferMode>('Wi-Fi Direct');
  const [bluetoothDeviceName, setBluetoothDeviceName] = useState<string | null>(null);
  const [bluetoothStatus, setBluetoothStatus] = useState<string | null>(null);

  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [activeUploadName, setActiveUploadName] = useState<string | null>(null);
  const [activeUploadProgress, setActiveUploadProgress] = useState<number>(0);
  const [activeUploadMbps, setActiveUploadMbps] = useState<number>(0);

  const [activeDownloadName, setActiveDownloadName] = useState<string | null>(null);
  const [activeDownloadProgress, setActiveDownloadProgress] = useState<number>(0);
  const [activeDownloadMbps, setActiveDownloadMbps] = useState<number>(0);

  const [uploadError, setUploadError] = useState<string | null>(null);
  const [notificationBanner, setNotificationBanner] = useState<string | null>(null);

  const [isQrModalOpen, setIsQrModalOpen] = useState<boolean>(false);
  const [copiedRoomCode, setCopiedRoomCode] = useState<boolean>(false);
  const [roomCodeInput, setRoomCodeInput] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const p2pSessionRef = useRef<P2PRoomSession | null>(null);
  const backendOriginRef = useRef<string | null>(null);
  const activeXhrsRef = useRef<Set<XMLHttpRequest>>(new Set());
  const uploadCancelledRef = useRef<boolean>(false);

  // Merge server + P2P files (deduplicated by name + size or id)
  const files: SharedFileItem[] = React.useMemo(() => {
    const map = new Map<string, SharedFileItem>();
    for (const f of p2pFiles) {
      map.set(`${f.name}:${f.size}`, f);
    }
    for (const f of serverFiles) {
      map.set(`${f.name}:${f.size}`, f);
    }
    return Array.from(map.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [serverFiles, p2pFiles]);

  // Merge server + P2P devices (always includes selfDeviceRecord)
  const devices: ConnectedDevice[] = React.useMemo(() => {
    const map = new Map<string, ConnectedDevice>();
    map.set(selfDeviceRecord.id, selfDeviceRecord);
    for (const d of p2pDevices) {
      map.set(d.id, d);
    }
    for (const d of serverDevices) {
      map.set(d.id, d);
    }
    return Array.from(map.values());
  }, [serverDevices, p2pDevices, selfDeviceRecord.id]);

  const usedBytes = React.useMemo(
    () => files.reduce((acc, f) => acc + (f.size || 0), 0),
    [files]
  );

  // High-Speed Hybrid Downloader (P2P / Local Vault + 6x Parallel Range Server Stream)
  const triggerDownload = useCallback(
    async (file: SharedFileItem) => {
      try {
        setActiveDownloadName(file.name);
        setActiveDownloadProgress(0);
        setActiveDownloadMbps(25.0);

        // 1. Check P2P Session (Local IndexedDB Vault or Connected WebRTC Peer)
        if (p2pSessionRef.current) {
          const p2pBlob = await p2pSessionRef.current
            .downloadFileBlob(file, (pct, mbps) => {
              setActiveDownloadProgress(pct);
              setActiveDownloadMbps(mbps);
            })
            .catch(() => null);

          if (p2pBlob) {
            const objectUrl = URL.createObjectURL(p2pBlob);
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = file.name;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
            return;
          }
        }

        // 2. Fallback to Backend Server Download
        const base = backendOriginRef.current ?? '';
        const downloadUrl = `${base}/api/rooms/${encodeURIComponent(file.roomId)}/files/${encodeURIComponent(file.id)}/download?pin=${encodeURIComponent(roomPin)}`;

        if (file.size > 250 * 1024 * 1024 || file.size === 0) {
          const link = document.createElement('a');
          link.href = downloadUrl;
          link.download = file.name;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          return;
        }

        const startTime = performance.now();
        const chunkSize = getOptimalChunkSize(file.size);
        const ranges: { index: number; start: number; end: number }[] = [];
        let cursor = 0;
        let idx = 0;
        while (cursor < file.size) {
          const end = Math.min(file.size - 1, cursor + chunkSize - 1);
          ranges.push({ index: idx++, start: cursor, end });
          cursor = end + 1;
        }

        const downloadedParts = new Array<Blob>(ranges.length);
        const loadedPerPart = new Array<number>(ranges.length).fill(0);

        const updateDownloadTelemetry = () => {
          const totalLoaded = loadedPerPart.reduce((a, b) => a + b, 0);
          const elapsedSec = Math.max(0.015, (performance.now() - startTime) / 1000);
          const lineRateMbps = (totalLoaded * 8) / 1_000_000 / elapsedSec;
          const pct = Math.min(100, Math.round((totalLoaded / file.size) * 100));
          setActiveDownloadProgress(pct);
          setActiveDownloadMbps(Number(lineRateMbps.toFixed(1)));
        };

        let queueIdx = 0;
        const workerCount = Math.min(PARALLEL_STREAMS, ranges.length);
        const workers = Array.from({ length: workerCount }, async () => {
          while (queueIdx < ranges.length) {
            const currentRange = ranges[queueIdx++];
            await new Promise<void>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open('GET', downloadUrl, true);
              xhr.responseType = 'blob';
              xhr.setRequestHeader(
                'Range',
                `bytes=${currentRange.start}-${currentRange.end}`
              );

              xhr.onprogress = (ev) => {
                if (ev.lengthComputable) {
                  loadedPerPart[currentRange.index] = ev.loaded;
                  updateDownloadTelemetry();
                }
              };

              xhr.onload = () => {
                if (xhr.status === 206 || xhr.status === 200) {
                  downloadedParts[currentRange.index] = xhr.response;
                  loadedPerPart[currentRange.index] =
                    currentRange.end - currentRange.start + 1;
                  updateDownloadTelemetry();
                  resolve();
                } else {
                  reject(new Error(`Download HTTP ${xhr.status}`));
                }
              };

              xhr.onerror = () => reject(new Error('Download network error'));
              xhr.send();
            });
          }
        });

        await Promise.all(workers);

        const combinedBlob = new Blob(downloadedParts, {
          type: file.mimeType || 'application/octet-stream',
        });
        const objectUrl = URL.createObjectURL(combinedBlob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
      } catch {
        const base = backendOriginRef.current ?? '';
        const downloadUrl = `${base}/api/rooms/${encodeURIComponent(file.roomId)}/files/${encodeURIComponent(file.id)}/download?pin=${encodeURIComponent(roomPin)}`;
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } finally {
        setActiveDownloadName(null);
        setActiveDownloadProgress(0);
      }
    },
    [roomPin]
  );

  // Start P2P WebRTC + IndexedDB Session (Works on Vercel & Static Hosts without a backend)
  useEffect(() => {
    const p2p = new P2PRoomSession(
      roomId,
      {
        id: deviceInfo.deviceId,
        name: deviceInfo.deviceName,
        deviceType: deviceInfo.deviceType,
        platform: deviceInfo.platform,
        transport:
          transferMode === 'Bluetooth Beam'
            ? 'Bluetooth Paired'
            : 'Wi-Fi / High-Speed Relay',
        status: 'online',
        lastSeen: new Date().toISOString(),
      },
      {
        onFilesUpdated: (list) => setP2pFiles(list),
        onDevicesUpdated: (list) => setP2pDevices(list),
        onRetentionUpdated: (hours) => setRetentionHours(hours),
        onPinStateUpdated: (has) => setHasRoomPin(has),
        onFileReceivedBanner: (name) =>
          setNotificationBanner(`NEW FILE RECEIVED > ${name}`),
      }
    );

    p2pSessionRef.current = p2p;
    p2p.start();

    return () => {
      p2p.stop();
      if (p2pSessionRef.current === p2p) {
        p2pSessionRef.current = null;
      }
    };
  }, [roomId, deviceInfo, transferMode]);

  // Connect to Express Backend + WebSocket when available (Same-Origin or Cloud Relay)
  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const initBackendConnection = async () => {
      const origin = await resolveActiveBackendOrigin();
      if (cancelled) return;
      backendOriginRef.current = origin;

      if (origin === null) {
        // Running on static Vercel without reachable backend; P2PRoomSession handles everything
        setIsLoadingRoom(false);
        return;
      }

      try {
        const res = await fetch(`${origin}/api/rooms/${encodeURIComponent(roomId)}`, {
          headers: { 'X-Room-Pin': roomPin },
        });
        if (res.status === 403) {
          setRequiresPinUnlock(true);
          setServerFiles([]);
          setServerDevices([]);
          return;
        }
        const ct = res.headers.get('content-type') || '';
        if (res.ok && ct.includes('application/json')) {
          const data = await res.json();
          setRequiresPinUnlock(false);
          setPinUnlockError(null);
          setHasRoomPin(Boolean(data.hasPin));
          if (typeof data.retentionHours === 'number') {
            setRetentionHours(data.retentionHours);
          }
          setServerFiles(data.files || []);
          setServerDevices(data.devices || []);
        }
      } catch {
        // P2P engine handles offline/static state
      } finally {
        setIsLoadingRoom(false);
      }

      const wsUrl = origin
        ? `${origin.replace(/^http/, 'ws')}/ws`
        : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

      const connectWs = () => {
        if (cancelled) return;
        try {
          socket = new WebSocket(wsUrl);
          wsRef.current = socket;

          socket.onopen = () => {
            socket?.send(
              JSON.stringify({
                type: 'room:join',
                roomId,
                pin: roomPin,
                deviceId: deviceInfo.deviceId,
                deviceName: deviceInfo.deviceName,
                deviceType: deviceInfo.deviceType,
                platform: deviceInfo.platform,
                transport:
                  transferMode === 'Bluetooth Beam'
                    ? 'Bluetooth Paired'
                    : 'Wi-Fi / High-Speed Relay',
              })
            );
          };

          socket.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === 'room:auth-required') {
                setRequiresPinUnlock(true);
                setIsLoadingRoom(false);
              } else if (msg.type === 'room:init') {
                setRequiresPinUnlock(false);
                setHasRoomPin(Boolean(msg.hasPin));
                if (typeof msg.retentionHours === 'number') {
                  setRetentionHours(msg.retentionHours);
                }
                setServerFiles(msg.files || []);
                setServerDevices(msg.devices || []);
                setIsLoadingRoom(false);
              } else if (msg.type === 'room:pin-updated') {
                setHasRoomPin(Boolean(msg.hasPin));
              } else if (msg.type === 'room:retention-updated') {
                if (typeof msg.retentionHours === 'number') {
                  setRetentionHours(msg.retentionHours);
                }
                if (Array.isArray(msg.files)) {
                  setServerFiles(msg.files);
                }
              } else if (msg.type === 'devices:updated') {
                setServerDevices(msg.devices || []);
              } else if (msg.type === 'file:created') {
                setServerFiles((prev) => {
                  if (prev.some((f) => f.id === msg.file.id)) return prev;
                  return [msg.file, ...prev];
                });
              } else if (msg.type === 'file:progress') {
                setServerFiles((prev) =>
                  prev.map((f) => (f.id === msg.file.id ? msg.file : f))
                );
              } else if (msg.type === 'file:completed') {
                setServerFiles((prev) => {
                  const exists = prev.some((f) => f.id === msg.file.id);
                  if (!exists) return [msg.file, ...prev];
                  return prev.map((f) => (f.id === msg.file.id ? msg.file : f));
                });

                if (msg.file.senderDeviceName !== deviceInfo.deviceName) {
                  setNotificationBanner(`NEW FILE RECEIVED > ${msg.file.name}`);
                }
              } else if (msg.type === 'file:deleted') {
                setServerFiles((prev) => prev.filter((f) => f.id !== msg.fileId));
              } else if (msg.type === 'room:cleared') {
                setServerFiles([]);
              }
            } catch {
              // ignore parse error
            }
          };

          socket.onclose = () => {
            if (!cancelled) {
              reconnectTimer = setTimeout(connectWs, 3500);
            }
          };
        } catch {
          // ignore ws error on static host
        }
      };

      connectWs();
    };

    initBackendConnection();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [roomId, roomPin, deviceInfo, transferMode]);

  useEffect(() => {
    if (!notificationBanner) return;
    const timer = setTimeout(() => setNotificationBanner(null), 4000);
    return () => clearTimeout(timer);
  }, [notificationBanner]);

  const handleSwitchRoom = (newRoom: string) => {
    const cleaned = newRoom.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (!cleaned || cleaned.length < 4) return;
    setRoomPin('');
    setRequiresPinUnlock(false);
    setPinUnlockError(null);
    setServerFiles([]);
    setP2pFiles([]);
    setRoomId(cleaned);
    sessionStorage.setItem('swiftbeam_private_room_id', cleaned);
    const url = new URL(window.location.href);
    url.searchParams.set('room', cleaned);
    window.history.replaceState({}, '', url.toString());
  };

  const handleGenerateNewRoom = () => {
    const code = generatePrivateRoomCode();
    handleSwitchRoom(code);
  };

  const handleSetOrClearPin = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = newPinInput.trim();
    if (p2pSessionRef.current) {
      await p2pSessionRef.current.updatePin(cleaned);
    }
    setRoomPin(cleaned);
    setHasRoomPin(Boolean(cleaned));
    setIsSettingPin(false);
    setNewPinInput('');

    const origin = backendOriginRef.current;
    if (origin !== null) {
      try {
        await fetch(`${origin}/api/rooms/${encodeURIComponent(roomId)}/pin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currentPin: roomPin,
            newPin: cleaned,
          }),
        });
      } catch {
        // handled by P2P vault
      }
    }
  };

  const handleUnlockRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    const candidate = pinUnlockInput.trim();
    if (!candidate) return;

    const origin = backendOriginRef.current ?? '';
    try {
      const res = await fetch(`${origin}/api/rooms/${encodeURIComponent(roomId)}`, {
        headers: { 'X-Room-Pin': candidate },
      });
      if (res.status === 403) {
        setPinUnlockError('INCORRECT PIN');
        return;
      }
      if (res.ok) {
        setRoomPin(candidate);
        setPinUnlockInput('');
        setPinUnlockError(null);
        setRequiresPinUnlock(false);
      }
    } catch {
      setRoomPin(candidate);
      setRequiresPinUnlock(false);
    }
  };

  const handleRoomRetentionChange = async (newHours: number) => {
    setRetentionHours(newHours);
    if (p2pSessionRef.current) {
      await p2pSessionRef.current.updateRetention(newHours);
    }

    const origin = backendOriginRef.current;
    if (origin !== null) {
      try {
        const res = await fetch(`${origin}/api/rooms/${encodeURIComponent(roomId)}/retention`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Room-Pin': roomPin,
          },
          body: JSON.stringify({
            retentionHours: newHours,
            applyToExistingFiles: true,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.files)) {
            setServerFiles(data.files);
          }
        }
      } catch {
        // handled by P2P vault
      }
    }
  };

  const handleBluetoothPair = async () => {
    setTransferMode('Bluetooth Beam');
    setUploadError(null);

    const nav = navigator as Navigator & {
      bluetooth?: {
        requestDevice: (options: { acceptAllDevices: boolean }) => Promise<{
          name?: string;
          id?: string;
        }>;
      };
    };

    if (!nav.bluetooth) {
      setBluetoothStatus('BLUETOOTH ACTIVE');
      return;
    }

    try {
      setBluetoothStatus('SCANNING...');
      const device = await nav.bluetooth.requestDevice({
        acceptAllDevices: true,
      });
      const pairedName = device?.name || 'BT DEVICE';
      setBluetoothDeviceName(pairedName.toUpperCase());
      setBluetoothStatus(`PAIRED: ${pairedName.toUpperCase()}`);
    } catch {
      setBluetoothStatus(null);
    }
  };

  const handleCancelActiveUpload = () => {
    uploadCancelledRef.current = true;
    for (const xhr of activeXhrsRef.current) {
      try {
        xhr.abort();
      } catch {
        // ignore
      }
    }
    activeXhrsRef.current.clear();
    setActiveUploadName(null);
    setActiveUploadProgress(0);
  };

  const uploadFilesList = async (selectedFiles: FileList | File[]) => {
    const fileArray = Array.from(selectedFiles);
    if (fileArray.length === 0) return;

    setUploadError(null);
    uploadCancelledRef.current = false;

    const senderLabel = bluetoothDeviceName
      ? `${deviceInfo.deviceName} > ${bluetoothDeviceName}`
      : deviceInfo.deviceName;

    for (const file of fileArray) {
      if (uploadCancelledRef.current) break;

      if (usedBytes + file.size > MAX_CAPACITY_BYTES) {
        setUploadError(`EXCEEDS 10 GB LIMIT (${formatBytes(file.size)})`);
        break;
      }

      setActiveUploadName(file.name);
      setActiveUploadProgress(0);
      setActiveUploadMbps(28.0);

      let uploadedToServer = false;
      let createdFileId: string | null = null;
      const origin = backendOriginRef.current;

      // 1. Attempt High-Speed Server Stream if Backend Origin is Active
      if (origin !== null) {
        try {
          const initRes = await fetch(`${origin}/api/rooms/${encodeURIComponent(roomId)}/files/init`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Room-Pin': roomPin,
            },
            body: JSON.stringify({
              name: file.name,
              size: file.size,
              mimeType: file.type || 'application/octet-stream',
              senderDeviceName: senderLabel,
              senderDeviceType: deviceInfo.deviceType,
              transferMode,
              retentionHours,
            }),
          });

          const ct = initRes.headers.get('content-type') || '';
          if (initRes.ok && ct.includes('application/json')) {
            const { file: createdFile } = await initRes.json();
            const fileId: string = createdFile.id;
            createdFileId = fileId;

            if (file.size === 0) {
              await fetch(
                `${origin}/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(fileId)}/complete`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ speedMbps: 100 }),
                }
              );
              uploadedToServer = true;
            } else {
              const streamStartTime = performance.now();
              const dynamicChunkSize = getOptimalChunkSize(file.size);

              const chunks: { index: number; start: number; end: number }[] = [];
              let cursor = 0;
              let idx = 0;
              while (cursor < file.size) {
                const end = Math.min(file.size, cursor + dynamicChunkSize);
                chunks.push({ index: idx++, start: cursor, end });
                cursor = end;
              }

              const chunkLoadedBytes = new Array<number>(chunks.length).fill(0);
              let latestMeasuredMbps = 40.0;

              const updateLiveTelemetry = () => {
                const totalLoaded = chunkLoadedBytes.reduce((a, b) => a + b, 0);
                const elapsedSec = Math.max(0.015, (performance.now() - streamStartTime) / 1000);
                const lineRateMbps = (totalLoaded * 8) / 1_000_000 / elapsedSec;
                latestMeasuredMbps = Math.max(1.0, lineRateMbps);

                const pct = Math.min(100, Math.round((totalLoaded / file.size) * 100));
                setActiveUploadProgress(pct);
                setActiveUploadMbps(Number(latestMeasuredMbps.toFixed(1)));
              };

              const sendSingleChunk = (chunkMeta: {
                index: number;
                start: number;
                end: number;
              }): Promise<void> => {
                return new Promise((resolve, reject) => {
                  if (uploadCancelledRef.current) {
                    reject(new Error('Upload cancelled'));
                    return;
                  }

                  const blobSlice = file.slice(chunkMeta.start, chunkMeta.end);
                  const xhr = new XMLHttpRequest();
                  activeXhrsRef.current.add(xhr);

                  xhr.open(
                    'POST',
                    `${origin}/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(fileId)}/chunk`,
                    true
                  );
                  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                  xhr.setRequestHeader('X-Chunk-Offset', String(chunkMeta.start));
                  xhr.setRequestHeader(
                    'X-Transfer-Speed',
                    String(latestMeasuredMbps.toFixed(1))
                  );

                  xhr.upload.onprogress = (ev) => {
                    if (ev.lengthComputable) {
                      chunkLoadedBytes[chunkMeta.index] = ev.loaded;
                      updateLiveTelemetry();
                    }
                  };

                  xhr.onload = () => {
                    activeXhrsRef.current.delete(xhr);
                    if (xhr.status >= 200 && xhr.status < 300) {
                      chunkLoadedBytes[chunkMeta.index] = chunkMeta.end - chunkMeta.start;
                      updateLiveTelemetry();
                      resolve();
                    } else {
                      reject(new Error(`Chunk transfer failed (HTTP ${xhr.status})`));
                    }
                  };

                  xhr.onerror = () => {
                    activeXhrsRef.current.delete(xhr);
                    reject(new Error('Network error during high-speed stream.'));
                  };

                  xhr.onabort = () => {
                    activeXhrsRef.current.delete(xhr);
                    reject(new Error('Upload cancelled'));
                  };

                  xhr.send(blobSlice);
                });
              };

              let queueIndex = 0;
              const workerCount = Math.min(PARALLEL_STREAMS, chunks.length);
              const workers = Array.from({ length: workerCount }, async () => {
                while (queueIndex < chunks.length) {
                  if (uploadCancelledRef.current) break;
                  const currentChunk = chunks[queueIndex++];
                  await sendSingleChunk(currentChunk);
                }
              });

              await Promise.all(workers);

              const totalElapsedSec = Math.max(0.01, (performance.now() - streamStartTime) / 1000);
              const finalMbps = Math.max(1.0, (file.size * 8) / 1_000_000 / totalElapsedSec);

              await fetch(
                `${origin}/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(fileId)}/complete`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ speedMbps: Number(finalMbps.toFixed(1)) }),
                }
              );
              uploadedToServer = true;
            }
          }
        } catch (err: unknown) {
          if (createdFileId && origin !== null) {
            fetch(
              `${origin}/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(createdFileId)}`,
              {
                method: 'DELETE',
                headers: { 'X-Room-Pin': roomPin },
              }
            ).catch(() => {});
          }
          const msg = err instanceof Error ? err.message : '';
          if (msg === 'Upload cancelled') {
            break;
          }
        }
      }

      // 2. Always Store in P2P WebRTC + IndexedDB Room Engine (Primary on Vercel, Instant Peer Sync)
      if (p2pSessionRef.current && !uploadCancelledRef.current) {
        try {
          await p2pSessionRef.current.addLocalFileWithProgress(
            file,
            senderLabel,
            deviceInfo.deviceType,
            transferMode,
            retentionHours,
            (pct, mbps) => {
              if (!uploadedToServer) {
                setActiveUploadProgress(pct);
                setActiveUploadMbps(mbps);
              }
            },
            () => uploadCancelledRef.current
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Transfer failed.';
          if (message !== 'Upload cancelled' && !uploadedToServer) {
            setUploadError(message);
          }
        }
      }
    }

    setActiveUploadName(null);
    setActiveUploadProgress(0);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    if (p2pSessionRef.current) {
      await p2pSessionRef.current.deleteFile(fileId);
    }
    setServerFiles((prev) => prev.filter((f) => f.id !== fileId));

    const origin = backendOriginRef.current;
    if (origin !== null) {
      try {
        await fetch(
          `${origin}/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(fileId)}`,
          {
            method: 'DELETE',
            headers: { 'X-Room-Pin': roomPin },
          }
        );
      } catch {
        // ignore
      }
    }
  };

  const handleClearRoom = async () => {
    if (p2pSessionRef.current) {
      await p2pSessionRef.current.clearRoom();
    }
    setServerFiles([]);
    setP2pFiles([]);

    const origin = backendOriginRef.current;
    if (origin !== null) {
      try {
        await fetch(`${origin}/api/rooms/${encodeURIComponent(roomId)}/clear`, {
          method: 'DELETE',
          headers: { 'X-Room-Pin': roomPin },
        });
      } catch {
        // ignore
      }
    }
  };

  const openFilePicker = () => {
    if (!fileInputRef.current) return;
    fileInputRef.current.accept = '*/*';
    fileInputRef.current.click();
  };

  const remainingBytes = Math.max(0, MAX_CAPACITY_BYTES - usedBytes);

  return (
    <div className="min-h-screen flex flex-col bg-[#EAE8E3] text-[#111111]">
      {/* Clean Top Bar */}
      <header className="bg-[#EAE8E3] border-b border-[#111111] sticky top-0 z-30">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4 px-4 sm:px-6 py-2.5">
          <a
            href="/"
            className="inline-flex items-center justify-center bg-[#FF3B00] text-[#050505] px-2.5 py-1 select-none whitespace-nowrap shrink-0"
            aria-label="MegaByte Home"
          >
            <span className="font-brand text-xs sm:text-sm uppercase tracking-tight block scale-x-105 px-0.5">
              MEGABYTE
            </span>
          </a>

          <nav className="hidden md:flex items-center gap-6 text-xs font-bold tracking-wider text-[#111111]/70">
            <a
              href="#transfer"
              className="hover:text-[#111111] transition-colors whitespace-nowrap shrink-0"
            >
              TRANSFER
            </a>
            <a
              href="#files"
              className="hover:text-[#111111] transition-colors whitespace-nowrap shrink-0"
            >
              FILES ({files.length})
            </a>
            <a
              href="#devices"
              className="hover:text-[#111111] transition-colors whitespace-nowrap shrink-0"
            >
              DEVICES ({devices.length})
            </a>
          </nav>

          <button
            type="button"
            onClick={() => setIsQrModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold tracking-wider text-[#111111] bg-[#FF6A1A] border border-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <QrCode className="w-3.5 h-3.5" />
            QR CODE
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-6 py-8 space-y-8">
        {notificationBanner && (
          <div className="bg-[#111111] text-[#EAE8E3] px-4 py-2.5 flex items-center justify-between gap-4 text-xs tracking-wider">
            <span>{notificationBanner}</span>
            <button
              type="button"
              onClick={() => setNotificationBanner(null)}
              className="text-[#FF6A1A] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
            >
              CLOSE
            </button>
          </div>
        )}

        {/* Single Clear Room ID & Join Bar */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b-2 border-[#111111] pb-6">
          <div className="space-y-2">
            <span className="text-xs font-bold tracking-widest text-[#111111]/60 block">
              YOUR PRIVATE ROOM ID
            </span>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-4xl sm:text-5xl font-bold font-mono tracking-widest leading-none text-[#111111]">
                {roomId}
              </span>

              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(roomId);
                  setCopiedRoomCode(true);
                  setTimeout(() => setCopiedRoomCode(false), 2000);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold bg-white text-[#111111] border border-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedRoomCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedRoomCode ? 'COPIED' : 'COPY'}
              </button>

              <button
                type="button"
                onClick={handleGenerateNewRoom}
                title="New Private Room ID"
                className="inline-flex items-center gap-1 px-3 py-2 text-xs font-bold bg-white text-[#111111] border border-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                NEW
              </button>

              <button
                type="button"
                onClick={() => setIsSettingPin((v) => !v)}
                className="inline-flex items-center gap-1 px-3 py-2 text-xs font-bold bg-white text-[#111111] border border-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {hasRoomPin ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                {hasRoomPin ? 'PIN ON' : 'PIN'}
              </button>
            </div>

            {isSettingPin && (
              <form
                onSubmit={handleSetOrClearPin}
                className="pt-2 flex items-center gap-2 max-w-xs"
              >
                <input
                  type="password"
                  value={newPinInput}
                  onChange={(e) => setNewPinInput(e.target.value)}
                  placeholder="SET 4-8 DIGIT PIN"
                  maxLength={8}
                  className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-[#111111] text-[#111111] focus:outline-none"
                />
                <button
                  type="submit"
                  className="px-3.5 py-1.5 text-xs font-bold text-[#EAE8E3] bg-[#111111] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  SAVE
                </button>
              </form>
            )}
          </div>

          {/* Join Another Person's Room (Appears Once) */}
          <div className="w-full md:w-auto">
            <span className="text-xs font-bold tracking-widest text-[#111111]/60 block mb-2">
              RECEIVE FILES FROM ANOTHER ROOM
            </span>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (roomCodeInput.trim()) {
                  handleSwitchRoom(roomCodeInput);
                  setRoomCodeInput('');
                }
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                placeholder="ENTER ROOM ID"
                maxLength={12}
                className="w-full md:w-48 px-3 py-2 text-xs font-mono uppercase bg-white border border-[#111111] text-[#111111] placeholder:text-[#111111]/50 focus:outline-none"
              />
              <button
                type="submit"
                className="px-4 py-2 text-xs font-bold text-[#EAE8E3] bg-[#111111] border border-[#111111] hover:bg-[#FF6A1A] hover:text-[#111111] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                JOIN ROOM
              </button>
            </form>
          </div>
        </section>

        {requiresPinUnlock ? (
          <section className="bg-[#FF6A1A] border border-[#111111] p-8 max-w-md mx-auto text-center space-y-4">
            <Lock className="w-6 h-6 mx-auto text-[#111111]" />
            <h2 className="text-base font-bold tracking-widest text-[#111111]">
              ENTER PIN FOR ROOM {roomId}
            </h2>
            <form onSubmit={handleUnlockRoom} className="flex items-center gap-2">
              <input
                type="password"
                value={pinUnlockInput}
                onChange={(e) => setPinUnlockInput(e.target.value)}
                placeholder="PIN"
                className="w-full px-3 py-2 text-xs font-mono bg-[#EAE8E3] border border-[#111111] text-[#111111] focus:outline-none"
              />
              <button
                type="submit"
                className="px-4 py-2 text-xs font-bold text-[#EAE8E3] bg-[#111111] hover:bg-white hover:text-[#111111] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                UNLOCK
              </button>
            </form>
            {pinUnlockError && (
              <p className="text-xs font-bold text-[#111111]">{pinUnlockError}</p>
            )}
          </section>
        ) : (
          <>
            {/* Orange Transfer Box (#FF6A1A) — Single Upload Area, Single Channel Switch, Single Auto-Delete */}
            <section id="transfer" className="bg-[#FF6A1A] text-[#111111] border border-[#111111]">
              {/* Top Settings Bar inside Orange Block */}
              <div className="px-5 py-3 border-b border-[#111111] flex flex-wrap items-center justify-between gap-4">
                {/* Channel Selector (Appears Once) */}
                <div className="inline-flex items-center border border-[#111111] bg-[#EAE8E3]/30">
                  <button
                    type="button"
                    onClick={() => {
                      setTransferMode('Wi-Fi Direct');
                      setBluetoothStatus(null);
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold tracking-wider transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      transferMode === 'Wi-Fi Direct'
                        ? 'bg-[#111111] text-[#EAE8E3]'
                        : 'text-[#111111] hover:bg-[#111111]/10'
                    }`}
                  >
                    <Wifi className="w-3.5 h-3.5" />
                    WI-FI
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTransferMode('Room Vault');
                      setBluetoothStatus(null);
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold tracking-wider border-l border-[#111111] transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      transferMode === 'Room Vault'
                        ? 'bg-[#111111] text-[#EAE8E3]'
                        : 'text-[#111111] hover:bg-[#111111]/10'
                    }`}
                  >
                    <HardDrive className="w-3.5 h-3.5" />
                    VAULT
                  </button>
                  <button
                    type="button"
                    onClick={handleBluetoothPair}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold tracking-wider border-l border-[#111111] transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      transferMode === 'Bluetooth Beam'
                        ? 'bg-[#111111] text-[#EAE8E3]'
                        : 'text-[#111111] hover:bg-[#111111]/10'
                    }`}
                  >
                    <Bluetooth className="w-3.5 h-3.5" />
                    BLUETOOTH
                  </button>
                </div>

                {/* Auto-Delete & Free Capacity (Appears Once) */}
                <div className="flex flex-wrap items-center gap-4 text-xs font-bold">
                  <div className="flex items-center gap-2">
                    <span>AUTO-DELETE:</span>
                    <select
                      value={retentionHours}
                      onChange={(e) => handleRoomRetentionChange(Number(e.target.value))}
                      aria-label="Auto-delete timer"
                      className="px-2.5 py-1 text-xs font-bold bg-[#EAE8E3] border border-[#111111] text-[#111111] focus:outline-none cursor-pointer"
                    >
                      {RETENTION_OPTIONS.map((opt) => (
                        <option key={opt.hours} value={opt.hours}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <span className="font-mono">
                    FREE: {formatBytes(remainingBytes)} / 10 GB
                  </span>
                </div>
              </div>

              {/* Single Upload Dropzone */}
              <div className="p-6 lg:p-8 space-y-4">
                {bluetoothStatus && (
                  <div className="bg-[#EAE8E3] border border-[#111111] px-3.5 py-2 text-xs font-bold">
                    {bluetoothStatus}
                  </div>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      uploadFilesList(e.target.files);
                    }
                  }}
                />

                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                      uploadFilesList(e.dataTransfer.files);
                    }
                  }}
                  onClick={openFilePicker}
                  className={`border-2 border-[#111111] p-8 sm:p-10 transition-colors cursor-pointer flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 ${
                    isDragging
                      ? 'bg-[#EAE8E3] text-[#111111]'
                      : 'bg-[#FF6A1A] hover:bg-[#EAE8E3]/25'
                  }`}
                >
                  <div className="space-y-1">
                    <p className="text-2xl sm:text-3xl font-bold tracking-widest leading-none">
                      SELECT OR DROP FILES
                    </p>
                    <p className="text-xs font-bold tracking-wider opacity-80">
                      ALL FORMATS (PDF, CSV, PHOTO, AUDIO, VIDEO) · UP TO 10 GB
                    </p>
                  </div>

                  <span className="inline-flex items-center gap-2 px-5 py-3 text-xs font-bold tracking-widest bg-[#111111] text-[#EAE8E3] whitespace-nowrap shrink-0">
                    <Upload className="w-4 h-4" />
                    UPLOAD FILES
                  </span>
                </div>

                {/* Live Upload Progress Bar (Simple Mbps Only) */}
                {activeUploadName && (
                  <div className="bg-[#111111] text-[#EAE8E3] p-4 space-y-2 border border-[#111111]">
                    <div className="flex items-center justify-between gap-3 text-xs font-mono">
                      <span className="font-bold truncate max-w-xs">
                        UPLOADING &gt; {activeUploadName}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[#FF6A1A] font-bold">
                          {activeUploadMbps.toFixed(1)} Mbps
                        </span>
                        <span>&gt;</span>
                        <span className="font-bold">{activeUploadProgress}%</span>
                        <button
                          type="button"
                          onClick={handleCancelActiveUpload}
                          title="Cancel transfer"
                          className="p-0.5 text-[#EAE8E3] hover:text-[#FF6A1A] cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="w-full h-2 bg-[#EAE8E3]/20 overflow-hidden">
                      <div
                        className="h-full bg-[#FF6A1A] transition-transform duration-75 origin-left"
                        style={{
                          transform: `scaleX(${activeUploadProgress / 100})`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Live Download Progress Bar (Simple Mbps Only) */}
                {activeDownloadName && (
                  <div className="bg-[#111111] text-[#EAE8E3] p-4 space-y-2 border border-[#111111]">
                    <div className="flex items-center justify-between gap-3 text-xs font-mono">
                      <span className="font-bold truncate max-w-xs">
                        DOWNLOADING &gt; {activeDownloadName}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[#FF6A1A] font-bold">
                          {activeDownloadMbps.toFixed(1)} Mbps
                        </span>
                        <span>&gt;</span>
                        <span className="font-bold">{activeDownloadProgress}%</span>
                      </div>
                    </div>
                    <div className="w-full h-2 bg-[#EAE8E3]/20 overflow-hidden">
                      <div
                        className="h-full bg-[#FF6A1A] transition-transform duration-75 origin-left"
                        style={{
                          transform: `scaleX(${activeDownloadProgress / 100})`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {uploadError && (
                  <div className="bg-[#111111] text-[#FF6A1A] px-4 py-2.5 text-xs font-bold tracking-wider">
                    {uploadError}
                  </div>
                )}
              </div>
            </section>

            {/* Files List */}
            <section id="files" className="space-y-4">
              <div className="flex items-center justify-between gap-4 border-b-2 border-[#111111] pb-2.5">
                <h2 className="text-base font-bold tracking-widest text-[#111111]">
                  FILES ({files.length})
                </h2>

                {files.length > 0 && (
                  <button
                    type="button"
                    onClick={handleClearRoom}
                    className="px-3 py-1 text-xs font-bold tracking-wider text-[#111111] bg-[#FF6A1A] border border-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    DELETE ALL
                  </button>
                )}
              </div>

              {isLoadingRoom ? (
                <div className="space-y-3 py-4">
                  {[1, 2].map((n) => (
                    <div key={n} className="h-12 border-b border-[#111111] animate-pulse" />
                  ))}
                </div>
              ) : files.length === 0 ? (
                <div className="py-8 border-b border-[#111111] text-sm font-bold tracking-widest text-[#111111]/60">
                  NO FILES IN THIS ROOM YET
                </div>
              ) : (
                <div className="space-y-3">
                  {files.map((file) => {
                    const isUploading = file.status === 'uploading';
                    const pct =
                      file.size > 0
                        ? Math.round((file.uploadedBytes / file.size) * 100)
                        : 100;

                    return (
                      <div
                        key={file.id}
                        className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center"
                      >
                        <div className="lg:col-span-8 border-b border-[#111111] pb-2.5 flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="text-base font-bold tracking-wider text-[#111111] truncate max-w-xs sm:max-w-md">
                              {file.name.toUpperCase()}
                            </span>
                            <span className="font-bold text-[#111111]">&gt;</span>
                            <span className="text-xs font-bold tracking-wider text-[#111111]/70 whitespace-nowrap">
                              {file.senderDeviceName.toUpperCase()}
                            </span>
                          </div>

                          <div className="flex items-center gap-2 text-xs font-mono text-[#111111]/70">
                            {isUploading && <span>{pct}% ·</span>}
                            <span>
                              {file.expiresAt ? formatExpiryRemaining(file.expiresAt) : '24H LEFT'}
                            </span>
                          </div>
                        </div>

                        <div className="lg:col-span-4 bg-[#FF6A1A] text-[#111111] px-4 py-2 flex items-center justify-between gap-3 border border-[#111111]">
                          <span className="text-sm font-bold font-mono tracking-wider whitespace-nowrap">
                            {formatBytes(file.size)}
                          </span>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => triggerDownload(file)}
                              disabled={isUploading}
                              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold bg-[#111111] text-[#EAE8E3] border border-[#111111] hover:bg-[#EAE8E3] hover:text-[#111111] transition-colors whitespace-nowrap cursor-pointer disabled:opacity-40"
                            >
                              <Download className="w-3.5 h-3.5" />
                              DOWNLOAD
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteFile(file.id)}
                              aria-label={`Delete ${file.name}`}
                              className="p-1 text-[#111111] hover:bg-[#111111] hover:text-[#EAE8E3] transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Connected Devices */}
            <section id="devices" className="space-y-3 pt-2">
              <div className="border-b-2 border-[#111111] pb-2">
                <h2 className="text-base font-bold tracking-widest text-[#111111]">
                  CONNECTED DEVICES ({devices.length})
                </h2>
              </div>

              <div className="space-y-2.5">
                {devices.map((dev) => {
                  const isSelf = dev.id === deviceInfo.deviceId;
                  return (
                    <div
                      key={dev.id}
                      className="border-b border-[#111111] pb-2 flex items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold tracking-wider">
                          {dev.name.toUpperCase()} {isSelf ? '(THIS DEVICE)' : ''}
                        </span>
                        <span className="font-bold">&gt;</span>
                        <span className="text-xs font-bold text-[#111111]/70">
                          {dev.deviceType.toUpperCase()}
                        </span>
                      </div>

                      <span className="px-2.5 py-0.5 text-xs font-bold bg-[#FF6A1A] text-[#111111] border border-[#111111]">
                        ONLINE
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </main>

      <QrPairingModal
        isOpen={isQrModalOpen}
        onClose={() => setIsQrModalOpen(false)}
        roomId={roomId}
      />
    </div>
  );
}
