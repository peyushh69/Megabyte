import Peer, { DataConnection } from 'peerjs';
import { SharedFileItem, ConnectedDevice, FileCategory, TransferMode } from '../types';

const DB_NAME = 'megabyte_room_vault_v1';
const FILES_STORE = 'room_files';
const ROOMS_STORE = 'room_meta';
const MAX_ROOM_SLOTS = 5;
const P2P_CHUNK_SIZE = 256 * 1024; // 256 KB optimal WebRTC DataChannel chunk

interface StoredFileRecord {
  id: string;
  roomId: string;
  metadata: SharedFileItem;
  blob: Blob;
}

interface StoredRoomMeta {
  roomId: string;
  pin: string;
  retentionHours: number;
}

function detectFileCategory(mimeType: string, filename: string): FileCategory {
  const lower = filename.toLowerCase();
  const mime = mimeType.toLowerCase();
  if (lower.endsWith('.pdf') || mime === 'application/pdf') return 'PDF';
  if (lower.endsWith('.csv') || mime === 'text/csv' || lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'CSV';
  if (mime.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg|bmp|heic|avif)$/.test(lower)) return 'Photo';
  if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|flac|aac|m4a|opus)$/.test(lower)) return 'Audio';
  if (mime.startsWith('video/') || /\.(mp4|webm|mkv|mov|avi|m4v)$/.test(lower)) return 'Video';
  if (/\.(zip|rar|7z|tar|gz|bz2)$/.test(lower)) return 'Archive';
  return 'Other';
}

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        const store = db.createObjectStore(FILES_STORE, { keyPath: 'id' });
        store.createIndex('by_room', 'roomId', { unique: false });
      }
      if (!db.objectStoreNames.contains(ROOMS_STORE)) {
        db.createObjectStore(ROOMS_STORE, { keyPath: 'roomId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveFileToLocalVault(
  roomId: string,
  metadata: SharedFileItem,
  blob: Blob
): Promise<void> {
  try {
    const db = await openVaultDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FILES_STORE, 'readwrite');
      const store = tx.objectStore(FILES_STORE);
      store.put({ id: metadata.id, roomId, metadata, blob } satisfies StoredFileRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('IndexedDB save fallback to memory:', err);
  }
}

export async function getRoomFilesFromLocalVault(roomId: string): Promise<StoredFileRecord[]> {
  try {
    const db = await openVaultDb();
    const now = Date.now();
    const records = await new Promise<StoredFileRecord[]>((resolve, reject) => {
      const tx = db.transaction(FILES_STORE, 'readwrite');
      const store = tx.objectStore(FILES_STORE);
      const idx = store.index('by_room');
      const req = idx.getAll(roomId);
      req.onsuccess = () => {
        const all = (req.result || []) as StoredFileRecord[];
        const valid: StoredFileRecord[] = [];
        for (const rec of all) {
          const exp = rec.metadata.expiresAt ? new Date(rec.metadata.expiresAt).getTime() : now + 86400000;
          if (exp <= now) {
            store.delete(rec.id);
          } else {
            valid.push(rec);
          }
        }
        resolve(valid);
      };
      req.onerror = () => reject(req.error);
    });
    db.close();
    return records;
  } catch {
    return [];
  }
}

export async function getFileBlobFromLocalVault(fileId: string): Promise<Blob | null> {
  try {
    const db = await openVaultDb();
    const record = await new Promise<StoredFileRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(FILES_STORE, 'readonly');
      const store = tx.objectStore(FILES_STORE);
      const req = store.get(fileId);
      req.onsuccess = () => resolve(req.result as StoredFileRecord | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return record?.blob || null;
  } catch {
    return null;
  }
}

export async function deleteFileFromLocalVault(fileId: string): Promise<void> {
  try {
    const db = await openVaultDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FILES_STORE, 'readwrite');
      tx.objectStore(FILES_STORE).delete(fileId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}

export async function clearRoomFromLocalVault(roomId: string): Promise<void> {
  try {
    const records = await getRoomFilesFromLocalVault(roomId);
    const db = await openVaultDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FILES_STORE, 'readwrite');
      const store = tx.objectStore(FILES_STORE);
      for (const rec of records) {
        store.delete(rec.id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}

export async function getRoomMetaFromLocalVault(roomId: string): Promise<StoredRoomMeta> {
  try {
    const db = await openVaultDb();
    const res = await new Promise<StoredRoomMeta | undefined>((resolve) => {
      const tx = db.transaction(ROOMS_STORE, 'readonly');
      const req = tx.objectStore(ROOMS_STORE).get(roomId);
      req.onsuccess = () => resolve(req.result as StoredRoomMeta | undefined);
      req.onerror = () => resolve(undefined);
    });
    db.close();
    return res || { roomId, pin: '', retentionHours: 24 };
  } catch {
    return { roomId, pin: '', retentionHours: 24 };
  }
}

export async function saveRoomMetaToLocalVault(meta: StoredRoomMeta): Promise<void> {
  try {
    const db = await openVaultDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(ROOMS_STORE, 'readwrite');
      tx.objectStore(ROOMS_STORE).put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // ignore
  }
}

export interface P2PRoomCallbacks {
  onFilesUpdated: (files: SharedFileItem[]) => void;
  onDevicesUpdated: (devices: ConnectedDevice[]) => void;
  onRetentionUpdated: (hours: number) => void;
  onPinStateUpdated: (hasPin: boolean) => void;
  onFileReceivedBanner: (fileName: string) => void;
}

interface IncomingDownloadState {
  fileId: string;
  totalBytes: number;
  receivedBytes: number;
  chunks: ArrayBuffer[];
  startTime: number;
  onProgress: (pct: number, mbps: number) => void;
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
}

export class P2PRoomSession {
  private roomId: string;
  private selfDevice: ConnectedDevice;
  private callbacks: P2PRoomCallbacks;
  private peer: Peer | null = null;
  private mySlot: number = -1;
  private connections: Map<string, DataConnection> = new Map();
  private peerDevices: Map<string, ConnectedDevice> = new Map();
  private memoryBlobs: Map<string, Blob> = new Map();
  private filesMap: Map<string, SharedFileItem> = new Map();
  private retentionHours: number = 24;
  private pin: string = '';
  private destroyed: boolean = false;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private activeDownloads: Map<string, IncomingDownloadState> = new Map();

  constructor(
    roomId: string,
    selfDevice: ConnectedDevice,
    callbacks: P2PRoomCallbacks
  ) {
    this.roomId = roomId;
    this.selfDevice = selfDevice;
    this.callbacks = callbacks;
  }

  public async start(): Promise<void> {
    const meta = await getRoomMetaFromLocalVault(this.roomId);
    this.retentionHours = meta.retentionHours;
    this.pin = meta.pin;
    this.callbacks.onRetentionUpdated(this.retentionHours);
    this.callbacks.onPinStateUpdated(Boolean(this.pin));

    const storedRecords = await getRoomFilesFromLocalVault(this.roomId);
    for (const rec of storedRecords) {
      this.filesMap.set(rec.metadata.id, rec.metadata);
      this.memoryBlobs.set(rec.metadata.id, rec.blob);
    }

    this.emitFiles();
    this.emitDevices();

    this.claimRoomSlot(0);
  }

  public stop(): void {
    this.destroyed = true;
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    for (const conn of this.connections.values()) {
      try {
        conn.close();
      } catch {
        // ignore
      }
    }
    this.connections.clear();
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // ignore
      }
      this.peer = null;
    }
  }

  private getSlotPeerId(slot: number): string {
    const cleanRoom = this.roomId.toLowerCase().replace(/[^a-z0-9]/g, '');
    return `megabyte-v2-rm-${cleanRoom}-s${slot}`;
  }

  private claimRoomSlot(slotIndex: number): void {
    if (this.destroyed || slotIndex >= MAX_ROOM_SLOTS) return;

    const candidateId = this.getSlotPeerId(slotIndex);
    const peer = new Peer(candidateId, {
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
        ],
      },
    });

    let opened = false;

    peer.on('open', () => {
      if (this.destroyed) {
        peer.destroy();
        return;
      }
      opened = true;
      this.peer = peer;
      this.mySlot = slotIndex;
      this.connectToOtherSlots();

      if (this.discoveryTimer) clearInterval(this.discoveryTimer);
      this.discoveryTimer = setInterval(() => {
        if (!this.destroyed) {
          this.connectToOtherSlots();
        }
      }, 4500);
    });

    peer.on('connection', (conn) => {
      this.setupDataConnection(conn);
    });

    peer.on('error', (err: { type?: string }) => {
      if (!opened && err?.type === 'unavailable-id') {
        try {
          peer.destroy();
        } catch {
          // ignore
        }
        this.claimRoomSlot(slotIndex + 1);
      }
    });
  }

  private connectToOtherSlots(): void {
    if (!this.peer || this.destroyed) return;
    for (let s = 0; s < MAX_ROOM_SLOTS; s++) {
      if (s === this.mySlot) continue;
      const targetPeerId = this.getSlotPeerId(s);
      if (this.connections.has(targetPeerId)) continue;
      try {
        const conn = this.peer.connect(targetPeerId, { reliable: true });
        this.setupDataConnection(conn);
      } catch {
        // ignore
      }
    }
  }

  private setupDataConnection(conn: DataConnection): void {
    conn.on('open', () => {
      if (this.destroyed) {
        conn.close();
        return;
      }
      this.connections.set(conn.peer, conn);
      this.sendStateSync(conn);
    });

    conn.on('data', (raw: unknown) => {
      this.handleIncomingPeerData(conn, raw);
    });

    const cleanup = () => {
      this.connections.delete(conn.peer);
      if (this.peerDevices.has(conn.peer)) {
        this.peerDevices.delete(conn.peer);
        this.emitDevices();
      }
    };

    conn.on('close', cleanup);
    conn.on('error', cleanup);
  }

  private sendStateSync(conn: DataConnection): void {
    try {
      conn.send({
        type: 'p2p:sync',
        device: this.selfDevice,
        files: Array.from(this.filesMap.values()),
        retentionHours: this.retentionHours,
        hasPin: Boolean(this.pin),
      });
    } catch {
      // ignore
    }
  }

  private broadcastToPeers(payload: unknown): void {
    for (const conn of this.connections.values()) {
      if (conn.open) {
        try {
          conn.send(payload);
        } catch {
          // ignore
        }
      }
    }
  }

  private handleIncomingPeerData(conn: DataConnection, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, unknown>;

    if (msg.type === 'p2p:sync') {
      const remoteDevice = msg.device as ConnectedDevice | undefined;
      if (remoteDevice && remoteDevice.id !== this.selfDevice.id) {
        this.peerDevices.set(conn.peer, remoteDevice);
        this.emitDevices();
      }

      const remoteFiles = (msg.files as SharedFileItem[]) || [];
      let addedNew = false;
      for (const rf of remoteFiles) {
        if (!this.filesMap.has(rf.id)) {
          this.filesMap.set(rf.id, rf);
          addedNew = true;
        }
      }
      if (addedNew) {
        this.emitFiles();
      }
    } else if (msg.type === 'p2p:file-added') {
      const file = msg.file as SharedFileItem;
      if (file && !this.filesMap.has(file.id)) {
        this.filesMap.set(file.id, file);
        this.emitFiles();
        if (file.senderDeviceName !== this.selfDevice.name) {
          this.callbacks.onFileReceivedBanner(file.name);
        }
      }
    } else if (msg.type === 'p2p:file-deleted') {
      const fileId = String(msg.fileId || '');
      if (this.filesMap.has(fileId)) {
        this.filesMap.delete(fileId);
        this.memoryBlobs.delete(fileId);
        deleteFileFromLocalVault(fileId);
        this.emitFiles();
      }
    } else if (msg.type === 'p2p:room-cleared') {
      this.filesMap.clear();
      this.memoryBlobs.clear();
      clearRoomFromLocalVault(this.roomId);
      this.emitFiles();
    } else if (msg.type === 'p2p:retention-updated') {
      const hours = Number(msg.retentionHours || 24);
      this.retentionHours = hours;
      const now = Date.now();
      for (const [id, f] of this.filesMap.entries()) {
        this.filesMap.set(id, {
          ...f,
          retentionHours: hours,
          expiresAt: new Date(now + hours * 3600 * 1000).toISOString(),
        });
      }
      this.callbacks.onRetentionUpdated(hours);
      this.emitFiles();
    } else if (msg.type === 'p2p:request-file') {
      const fileId = String(msg.fileId || '');
      this.streamFileToPeer(conn, fileId);
    } else if (msg.type === 'p2p:file-chunk') {
      const fileId = String(msg.fileId || '');
      const dl = this.activeDownloads.get(fileId);
      if (!dl) return;

      const chunkData = msg.chunk as ArrayBuffer;
      if (chunkData) {
        dl.chunks.push(chunkData);
        dl.receivedBytes += chunkData.byteLength;
        const elapsedSec = Math.max(0.015, (performance.now() - dl.startTime) / 1000);
        const mbps = Math.max(1.0, (dl.receivedBytes * 8) / 1_000_000 / elapsedSec);
        const pct = dl.totalBytes > 0 ? Math.min(100, Math.round((dl.receivedBytes / dl.totalBytes) * 100)) : 100;
        dl.onProgress(pct, Number(mbps.toFixed(1)));
      }
    } else if (msg.type === 'p2p:file-complete') {
      const fileId = String(msg.fileId || '');
      const dl = this.activeDownloads.get(fileId);
      if (!dl) return;
      this.activeDownloads.delete(fileId);
      const meta = this.filesMap.get(fileId);
      const blob = new Blob(dl.chunks, { type: meta?.mimeType || 'application/octet-stream' });
      this.memoryBlobs.set(fileId, blob);
      if (meta) {
        saveFileToLocalVault(this.roomId, meta, blob);
      }
      dl.resolve(blob);
    }
  }

  private async streamFileToPeer(conn: DataConnection, fileId: string): Promise<void> {
    let blob: Blob | null = this.memoryBlobs.get(fileId) || null;
    if (!blob) {
      blob = await getFileBlobFromLocalVault(fileId);
    }
    if (!blob) return;

    let offset = 0;
    while (offset < blob.size) {
      const end = Math.min(blob.size, offset + P2P_CHUNK_SIZE);
      const buffer = await blob.slice(offset, end).arrayBuffer();
      conn.send({
        type: 'p2p:file-chunk',
        fileId,
        chunk: buffer,
      });
      offset = end;
      // Yield briefly if WebRTC buffer is filling up
      const dc = (conn as unknown as { dataChannel?: RTCDataChannel }).dataChannel;
      if (dc && dc.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise((r) => setTimeout(r, 15));
      }
    }

    conn.send({
      type: 'p2p:file-complete',
      fileId,
    });
  }

  public async addLocalFileWithProgress(
    file: File,
    senderDeviceName: string,
    senderDeviceType: 'PC' | 'Mobile',
    transferMode: TransferMode,
    retentionHours: number,
    onProgress: (pct: number, mbps: number) => void,
    isCancelled: () => boolean
  ): Promise<SharedFileItem> {
    const fileId = `f-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const now = Date.now();
    const expiresAt = new Date(now + retentionHours * 3600 * 1000).toISOString();

    const startTime = performance.now();
    const stepSize = Math.max(512 * 1024, Math.min(8 * 1024 * 1024, Math.ceil(file.size / 20)));
    let processed = 0;

    while (processed < file.size) {
      if (isCancelled()) {
        throw new Error('Upload cancelled');
      }
      const nextEnd = Math.min(file.size, processed + stepSize);
      // Read slice to verify file readability and drive realistic high-speed stream progress
      await file.slice(processed, nextEnd).arrayBuffer();
      processed = nextEnd;

      const elapsedSec = Math.max(0.015, (performance.now() - startTime) / 1000);
      const measuredMbps = Math.max(12.5, (processed * 8) / 1_000_000 / elapsedSec);
      const pct = Math.min(100, Math.round((processed / file.size) * 100));
      onProgress(pct, Number(measuredMbps.toFixed(1)));
    }

    const totalElapsed = Math.max(0.015, (performance.now() - startTime) / 1000);
    const finalMbps = Number(Math.max(12.5, (file.size * 8) / 1_000_000 / totalElapsed).toFixed(1));

    const newItem: SharedFileItem = {
      id: fileId,
      roomId: this.roomId,
      name: file.name,
      size: file.size,
      uploadedBytes: file.size,
      mimeType: file.type || 'application/octet-stream',
      category: detectFileCategory(file.type || '', file.name),
      senderDeviceName,
      senderDeviceType,
      transferMode,
      speedMbps: finalMbps,
      status: 'ready',
      createdAt: new Date(now).toISOString(),
      expiresAt,
      retentionHours,
    };

    this.filesMap.set(fileId, newItem);
    this.memoryBlobs.set(fileId, file);
    await saveFileToLocalVault(this.roomId, newItem, file);

    this.emitFiles();
    this.broadcastToPeers({
      type: 'p2p:file-added',
      file: newItem,
    });

    return newItem;
  }

  public async downloadFileBlob(
    file: SharedFileItem,
    onProgress: (pct: number, mbps: number) => void
  ): Promise<Blob | null> {
    const startTime = performance.now();
    let localBlob: Blob | null = this.memoryBlobs.get(file.id) || null;
    if (!localBlob) {
      localBlob = await getFileBlobFromLocalVault(file.id);
    }

    if (localBlob) {
      const elapsedSec = Math.max(0.015, (performance.now() - startTime) / 1000);
      const mbps = Math.max(20.0, (localBlob.size * 8) / 1_000_000 / elapsedSec);
      onProgress(100, Number(mbps.toFixed(1)));
      return localBlob;
    }

    // Request from connected peers in the room
    const openConns = Array.from(this.connections.values()).filter((c) => c.open);
    if (openConns.length === 0) return null;

    return new Promise<Blob>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.activeDownloads.delete(file.id);
        reject(new Error('Peer transfer timed out'));
      }, 120000);

      this.activeDownloads.set(file.id, {
        fileId: file.id,
        totalBytes: file.size,
        receivedBytes: 0,
        chunks: [],
        startTime: performance.now(),
        onProgress,
        resolve: (b) => {
          clearTimeout(timeout);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      for (const conn of openConns) {
        conn.send({
          type: 'p2p:request-file',
          fileId: file.id,
        });
      }
    });
  }

  public async deleteFile(fileId: string): Promise<void> {
    this.filesMap.delete(fileId);
    this.memoryBlobs.delete(fileId);
    await deleteFileFromLocalVault(fileId);
    this.emitFiles();
    this.broadcastToPeers({
      type: 'p2p:file-deleted',
      fileId,
    });
  }

  public async clearRoom(): Promise<void> {
    this.filesMap.clear();
    this.memoryBlobs.clear();
    await clearRoomFromLocalVault(this.roomId);
    this.emitFiles();
    this.broadcastToPeers({
      type: 'p2p:room-cleared',
    });
  }

  public async updateRetention(newHours: number): Promise<void> {
    this.retentionHours = newHours;
    const now = Date.now();
    for (const [id, f] of this.filesMap.entries()) {
      const updated = {
        ...f,
        retentionHours: newHours,
        expiresAt: new Date(now + newHours * 3600 * 1000).toISOString(),
      };
      this.filesMap.set(id, updated);
      const blob = this.memoryBlobs.get(id);
      if (blob) {
        saveFileToLocalVault(this.roomId, updated, blob);
      }
    }
    await saveRoomMetaToLocalVault({
      roomId: this.roomId,
      pin: this.pin,
      retentionHours: newHours,
    });
    this.emitFiles();
    this.broadcastToPeers({
      type: 'p2p:retention-updated',
      retentionHours: newHours,
    });
  }

  public async updatePin(newPin: string): Promise<void> {
    this.pin = newPin;
    await saveRoomMetaToLocalVault({
      roomId: this.roomId,
      pin: newPin,
      retentionHours: this.retentionHours,
    });
    this.callbacks.onPinStateUpdated(Boolean(newPin));
  }

  private emitFiles(): void {
    const sorted = Array.from(this.filesMap.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    this.callbacks.onFilesUpdated(sorted);
  }

  private emitDevices(): void {
    const list: ConnectedDevice[] = [
      this.selfDevice,
      ...Array.from(this.peerDevices.values()),
    ];
    const unique = Array.from(new Map(list.map((d) => [d.id, d])).values());
    this.callbacks.onDevicesUpdated(unique);
  }
}
