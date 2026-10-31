import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

const PORT = 3000;
const MAX_ROOM_CAPACITY_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const DEFAULT_RETENTION_HOURS = 24; // 24 Hours Default
const MAX_RETENTION_HOURS = 168; // 7 Days Maximum (7 * 24)
const STREAM_HIGH_WATER_MARK = 4 * 1024 * 1024; // 4 MB ultra-fast I/O buffer
const STORAGE_DIR = path.join(os.tmpdir(), 'swiftbeam-storage');

if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

export interface SharedFileRecord {
  id: string;
  roomId: string;
  name: string;
  size: number;
  uploadedBytes: number;
  mimeType: string;
  category: 'photo' | 'audio' | 'pdf' | 'csv' | 'video' | 'archive' | 'other';
  senderDeviceName: string;
  senderDeviceType: 'PC' | 'Mobile';
  transferMode: 'Wi-Fi Direct' | 'Room Vault' | 'Bluetooth Beam';
  speedMbps: number; // Stored in Megabits per second (Mbps) matching ISP speed units
  status: 'uploading' | 'completed' | 'error';
  createdAt: string;
  retentionHours: number;
  expiresAt: string;
  filePath: string;
}

export interface ConnectedDevice {
  id: string;
  roomId: string;
  name: string;
  deviceType: 'PC' | 'Mobile';
  platform: string;
  transport: 'Wi-Fi / High-Speed Relay' | 'WebRTC P2P' | 'Bluetooth Paired';
  joinedAt: string;
}

const roomsFiles = new Map<string, SharedFileRecord[]>();
const roomsPins = new Map<string, string>();
const roomsDefaultRetention = new Map<string, number>();
const roomsDevices = new Map<string, Map<string, { device: ConnectedDevice; ws: WebSocket }>>();
const lastProgressBroadcastMs = new Map<string, number>();

// Persistent FileHandle pool so parallel chunk uploads never waste time opening/closing descriptors
const openFileHandles = new Map<string, fs.promises.FileHandle>();

async function closeFileHandleSafely(fileId: string) {
  const handle = openFileHandles.get(fileId);
  if (handle) {
    openFileHandles.delete(fileId);
    try {
      await handle.close();
    } catch {
      // ignore already closed
    }
  }
}

function normalizeRoomId(raw: string): string {
  return (raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function clampRetentionHours(hours: unknown): number {
  const num = Number(hours);
  if (Number.isNaN(num) || num <= 0) return DEFAULT_RETENTION_HOURS;
  return Math.min(MAX_RETENTION_HOURS, Math.max(1, Math.round(num)));
}

function categorizeFile(name: string, mimeType: string): SharedFileRecord['category'] {
  const lower = name.toLowerCase();
  if (mimeType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg|bmp|heic)$/.test(lower)) {
    return 'photo';
  }
  if (mimeType.startsWith('audio/') || /\.(mp3|wav|ogg|flac|aac|m4a)$/.test(lower)) {
    return 'audio';
  }
  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) {
    return 'pdf';
  }
  if (
    mimeType === 'text/csv' ||
    /\.(csv|tsv|xlsx|xls|json)$/.test(lower)
  ) {
    return 'csv';
  }
  if (mimeType.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi)$/.test(lower)) {
    return 'video';
  }
  if (/\.(zip|rar|7z|tar|gz)$/.test(lower)) {
    return 'archive';
  }
  return 'other';
}

function getRoomFiles(roomId: string): SharedFileRecord[] {
  const normalized = normalizeRoomId(roomId);
  if (!roomsFiles.has(normalized)) {
    roomsFiles.set(normalized, []);
  }
  return roomsFiles.get(normalized)!;
}

function getRoomUsedBytes(roomId: string): number {
  const files = getRoomFiles(roomId);
  return files.reduce((acc, f) => acc + f.size, 0);
}

function sanitizeFileRecord(record: SharedFileRecord) {
  const { filePath, ...rest } = record;
  return rest;
}

function verifyRoomAccess(roomId: string, providedPin?: string): boolean {
  const normalized = normalizeRoomId(roomId);
  const requiredPin = roomsPins.get(normalized);
  if (!requiredPin) return true;
  return (providedPin || '').trim() === requiredPin;
}

function broadcastToRoom(roomId: string, payload: unknown, excludeClientId?: string) {
  const normalized = normalizeRoomId(roomId);
  const deviceMap = roomsDevices.get(normalized);
  if (!deviceMap) return;
  const message = JSON.stringify(payload);
  for (const [clientId, entry] of deviceMap.entries()) {
    if (excludeClientId && clientId === excludeClientId) continue;
    if (entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(message);
    }
  }
}

function purgeExpiredFiles() {
  const nowMs = Date.now();
  for (const [roomId, files] of roomsFiles.entries()) {
    let removedAny = false;
    for (let i = files.length - 1; i >= 0; i--) {
      const f = files[i];
      const expiresMs = new Date(f.expiresAt).getTime();
      if (expiresMs <= nowMs) {
        files.splice(i, 1);
        removedAny = true;
        lastProgressBroadcastMs.delete(f.id);
        closeFileHandleSafely(f.id).finally(() => {
          if (fs.existsSync(f.filePath)) {
            fs.promises.unlink(f.filePath).catch(() => {});
          }
        });
        broadcastToRoom(roomId, {
          type: 'file:deleted',
          fileId: f.id,
          usedBytes: getRoomUsedBytes(roomId),
        });
      }
    }
    if (removedAny && files.length === 0) {
      roomsFiles.delete(roomId);
    }
  }
}

setInterval(purgeExpiredFiles, 30 * 1000);

async function startServer() {
  const app = express();
  const server = http.createServer(app);

  // Tune TCP Socket Options for Maximum Line-Rate Bandwidth (Wi-Fi, Fiber & 4G/5G Mobile Data)
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15000);
  });

  app.use(express.json({ limit: '10mb' }));

  app.post('/api/rooms/generate', (_req, res) => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(8);
    let roomId = '';
    for (let i = 0; i < 8; i++) {
      roomId += chars[bytes[i] % chars.length];
    }
    res.json({ roomId });
  });

  app.post('/api/rooms/:roomId/pin', (req, res) => {
    const roomId = normalizeRoomId(req.params.roomId);
    if (!roomId || roomId.length < 4) {
      res.status(400).json({ error: 'Invalid Room ID.' });
      return;
    }
    const { currentPin, newPin } = req.body || {};
    if (!verifyRoomAccess(roomId, currentPin)) {
      res.status(403).json({ error: 'Incorrect current room PIN.' });
      return;
    }

    const cleanedNewPin = (newPin || '').trim();
    if (cleanedNewPin) {
      roomsPins.set(roomId, cleanedNewPin);
    } else {
      roomsPins.delete(roomId);
    }

    broadcastToRoom(roomId, {
      type: 'room:pin-updated',
      hasPin: Boolean(cleanedNewPin),
    });

    res.json({ ok: true, hasPin: Boolean(cleanedNewPin) });
  });

  app.post('/api/rooms/:roomId/retention', (req, res) => {
    const roomId = normalizeRoomId(req.params.roomId);
    const pin = (req.headers['x-room-pin'] as string) || '';
    if (!verifyRoomAccess(roomId, pin)) {
      res.status(403).json({ error: 'Invalid room PIN.' });
      return;
    }

    const hours = clampRetentionHours(req.body?.retentionHours);
    roomsDefaultRetention.set(roomId, hours);

    if (req.body?.applyToExistingFiles) {
      const files = getRoomFiles(roomId);
      for (const f of files) {
        f.retentionHours = hours;
        const createdMs = new Date(f.createdAt).getTime();
        f.expiresAt = new Date(createdMs + hours * 3600 * 1000).toISOString();
      }
    }

    broadcastToRoom(roomId, {
      type: 'room:retention-updated',
      retentionHours: hours,
      files: getRoomFiles(roomId).map(sanitizeFileRecord),
    });

    res.json({
      ok: true,
      retentionHours: hours,
      files: getRoomFiles(roomId).map(sanitizeFileRecord),
    });
  });

  app.patch('/api/rooms/:roomId/files/:fileId/retention', (req, res) => {
    const roomId = normalizeRoomId(req.params.roomId);
    const { fileId } = req.params;
    const pin = (req.headers['x-room-pin'] as string) || '';
    if (!verifyRoomAccess(roomId, pin)) {
      res.status(403).json({ error: 'Invalid room PIN.' });
      return;
    }

    const files = getRoomFiles(roomId);
    const record = files.find((f) => f.id === fileId && f.roomId === roomId);
    if (!record) {
      res.status(404).json({ error: 'File not found.' });
      return;
    }

    const hours = clampRetentionHours(req.body?.retentionHours);
    record.retentionHours = hours;
    const baseMs = Math.max(new Date(record.createdAt).getTime(), Date.now());
    record.expiresAt = new Date(baseMs + hours * 3600 * 1000).toISOString();

    const sanitized = sanitizeFileRecord(record);
    broadcastToRoom(roomId, {
      type: 'file:progress',
      file: sanitized,
      usedBytes: getRoomUsedBytes(roomId),
    });

    res.json({ file: sanitized });
  });

  app.get('/api/rooms/:roomId', (req, res) => {
    const roomId = normalizeRoomId(req.params.roomId);
    if (!roomId || roomId.length < 4) {
      res.status(400).json({ error: 'Valid private Room ID required.' });
      return;
    }

    const pin = (req.headers['x-room-pin'] as string) || (req.query.pin as string) || '';
    const hasPin = roomsPins.has(roomId);

    if (!verifyRoomAccess(roomId, pin)) {
      res.status(403).json({
        error: 'PIN required to access this private room.',
        requiresPin: true,
        roomId,
      });
      return;
    }

    const files = getRoomFiles(roomId).map(sanitizeFileRecord);
    const usedBytes = getRoomUsedBytes(roomId);
    const deviceMap = roomsDevices.get(roomId);
    const devices = deviceMap ? Array.from(deviceMap.values()).map((d) => d.device) : [];
    const retentionHours = roomsDefaultRetention.get(roomId) || DEFAULT_RETENTION_HOURS;

    res.json({
      roomId,
      hasPin,
      retentionHours,
      maxCapacityBytes: MAX_ROOM_CAPACITY_BYTES,
      usedBytes,
      remainingBytes: Math.max(0, MAX_ROOM_CAPACITY_BYTES - usedBytes),
      files,
      devices,
    });
  });

  // Initialize a file and keep a persistent FileHandle open for zero-overhead parallel writes
  app.post('/api/rooms/:roomId/files/init', async (req, res) => {
    const roomId = normalizeRoomId(req.params.roomId);
    if (!roomId || roomId.length < 4) {
      res.status(400).json({ error: 'Valid private Room ID required.' });
      return;
    }

    const pin = (req.headers['x-room-pin'] as string) || '';
    if (!verifyRoomAccess(roomId, pin)) {
      res.status(403).json({ error: 'Invalid room PIN.' });
      return;
    }

    const {
      name,
      size,
      mimeType,
      senderDeviceName,
      senderDeviceType,
      transferMode,
      retentionHours: requestedRetention,
    } = req.body;

    if (!name || typeof size !== 'number' || size < 0) {
      res.status(400).json({ error: 'Invalid file metadata provided.' });
      return;
    }

    const currentUsed = getRoomUsedBytes(roomId);
    if (currentUsed + size > MAX_ROOM_CAPACITY_BYTES) {
      res.status(413).json({
        error: 'File exceeds remaining 10 GB room capacity.',
      });
      return;
    }

    const retentionHours = clampRetentionHours(
      requestedRetention ?? roomsDefaultRetention.get(roomId) ?? DEFAULT_RETENTION_HOURS
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + retentionHours * 3600 * 1000).toISOString();

    const fileId = `file-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const safeExt = path.extname(name).replace(/[^a-zA-Z0-9.]/g, '');
    const filePath = path.join(STORAGE_DIR, `${fileId}${safeExt}`);

    // Open persistent FileHandle ('w+') so all parallel chunks write directly to OS page cache
    const fh = await fs.promises.open(filePath, 'w+');
    openFileHandles.set(fileId, fh);

    const record: SharedFileRecord = {
      id: fileId,
      roomId,
      name,
      size,
      uploadedBytes: 0,
      mimeType: mimeType || 'application/octet-stream',
      category: categorizeFile(name, mimeType || ''),
      senderDeviceName: senderDeviceName || 'Connected Device',
      senderDeviceType: senderDeviceType === 'Mobile' ? 'Mobile' : 'PC',
      transferMode: transferMode || 'Wi-Fi Direct',
      speedMbps: 0,
      status: size === 0 ? 'completed' : 'uploading',
      createdAt: now.toISOString(),
      retentionHours,
      expiresAt,
      filePath,
    };

    const files = getRoomFiles(roomId);
    files.unshift(record);

    const sanitized = sanitizeFileRecord(record);
    broadcastToRoom(roomId, {
      type: 'file:created',
      file: sanitized,
      usedBytes: getRoomUsedBytes(roomId),
    });

    res.json({ file: sanitized });
  });

  // Ultra-Fast Persistent-FileHandle Offset Write (Zero File-Open Overhead per Chunk)
  app.post('/api/rooms/:roomId/files/:fileId/chunk', async (req, res) => {
    const roomId = normalizeRoomId(req.params.roomId);
    const { fileId } = req.params;
    const speedHeader = parseFloat(req.headers['x-transfer-speed'] as string) || 0;
    const offsetHeader = parseInt(req.headers['x-chunk-offset'] as string, 10);

    const files = getRoomFiles(roomId);
    const record = files.find((f) => f.id === fileId && f.roomId === roomId);
    if (!record) {
      res.status(404).json({ error: 'File transfer record not found in this room.' });
      return;
    }

    let fh = openFileHandles.get(fileId);
    if (!fh) {
      fh = await fs.promises.open(record.filePath, 'r+');
      openFileHandles.set(fileId, fh);
    }

    let writePosition = !Number.isNaN(offsetHeader) && offsetHeader >= 0
      ? offsetHeader
      : record.uploadedBytes;
    let bytesWrittenThisChunk = 0;

    try {
      for await (const dataChunk of req) {
        const buf = Buffer.isBuffer(dataChunk) ? dataChunk : Buffer.from(dataChunk);
        await fh.write(buf, 0, buf.length, writePosition);
        writePosition += buf.length;
        bytesWrittenThisChunk += buf.length;
      }

      record.uploadedBytes = Math.min(
        record.size,
        record.uploadedBytes + bytesWrittenThisChunk
      );
      if (speedHeader > 0) {
        record.speedMbps = Number(speedHeader.toFixed(1));
      }
      if (record.uploadedBytes >= record.size) {
        record.status = 'completed';
      }

      const nowMs = Date.now();
      const lastMs = lastProgressBroadcastMs.get(record.id) || 0;
      if (record.status === 'completed' || nowMs - lastMs >= 150) {
        lastProgressBroadcastMs.set(record.id, nowMs);
        broadcastToRoom(roomId, {
          type: 'file:progress',
          file: sanitizeFileRecord(record),
          usedBytes: getRoomUsedBytes(roomId),
        });
      }

      res.json({
        uploadedBytes: record.uploadedBytes,
        status: record.status,
      });
    } catch (err) {
      console.error('Direct FileHandle write error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Disk write error during stream.' });
      }
    }
  });

  // Finalize file upload and close persistent FileHandle
  app.post('/api/rooms/:roomId/files/:fileId/complete', async (req, res) => {
    const roomId = normalizeRoomId(req.params.roomId);
    const { fileId } = req.params;
    const { speedMbps } = req.body || {};

    await closeFileHandleSafely(fileId);

    const files = getRoomFiles(roomId);
    const record = files.find((f) => f.id === fileId && f.roomId === roomId);
    if (!record) {
      res.status(404).json({ error: 'File not found in this room.' });
      return;
    }

    record.status = 'completed';
    record.uploadedBytes = record.size;
    if (typeof speedMbps === 'number' && speedMbps > 0) {
      record.speedMbps = Number(speedMbps.toFixed(1));
    }
    lastProgressBroadcastMs.delete(record.id);

    const sanitized = sanitizeFileRecord(record);
    broadcastToRoom(roomId, {
      type: 'file:completed',
      file: sanitized,
      usedBytes: getRoomUsedBytes(roomId),
    });

    res.json({ file: sanitized });
  });

  // High-Throughput 4MB-Buffered Range-Enabled File Download
  app.get('/api/rooms/:roomId/files/:fileId/download', (req, res) => {
    const roomId = normalizeRoomId(req.params.roomId);
    const { fileId } = req.params;
    const pin = (req.query.pin as string) || '';
    const inline = req.query.inline === '1';

    if (!verifyRoomAccess(roomId, pin)) {
      res.status(403).send('Access denied: Private room PIN required.');
      return;
    }

    const files = getRoomFiles(roomId);
    const found = files.find((f) => f.id === fileId && f.roomId === roomId);

    if (!found || !fs.existsSync(found.filePath)) {
      res.status(404).send('File not found or expired.');
      return;
    }

    const stat = fs.statSync(found.filePath);
    const disposition = inline ? 'inline' : 'attachment';
    const encodedName = encodeURIComponent(found.name);

    res.setHeader('Content-Type', found.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${found.name.replace(/"/g, '')}"; filename*=UTF-8''${encodedName}`
    );
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      if (start >= stat.size || end >= stat.size) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
        return;
      }
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', chunkSize);
      const stream = fs.createReadStream(found.filePath, {
        start,
        end,
        highWaterMark: STREAM_HIGH_WATER_MARK,
      });
      stream.pipe(res);
      req.on('close', () => stream.destroy());
    } else {
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(found.filePath, {
        highWaterMark: STREAM_HIGH_WATER_MARK,
      });
      stream.pipe(res);
      req.on('close', () => stream.destroy());
    }
  });

  app.delete('/api/rooms/:roomId/files/:fileId', async (req, res) => {
    const roomId = normalizeRoomId(req.params.roomId);
    const { fileId } = req.params;
    const pin = (req.headers['x-room-pin'] as string) || '';
    if (!verifyRoomAccess(roomId, pin)) {
      res.status(403).json({ error: 'Invalid room PIN.' });
      return;
    }

    await closeFileHandleSafely(fileId);

    const files = getRoomFiles(roomId);
    const idx = files.findIndex((f) => f.id === fileId && f.roomId === roomId);

    if (idx !== -1) {
      const [removed] = files.splice(idx, 1);
      lastProgressBroadcastMs.delete(fileId);
      if (removed && fs.existsSync(removed.filePath)) {
        fs.promises.unlink(removed.filePath).catch(() => {});
      }
      broadcastToRoom(roomId, {
        type: 'file:deleted',
        fileId,
        usedBytes: getRoomUsedBytes(roomId),
      });
    }

    res.json({ ok: true, usedBytes: getRoomUsedBytes(roomId) });
  });

  app.delete('/api/rooms/:roomId/clear', async (req, res) => {
    const roomId = normalizeRoomId(req.params.roomId);
    const pin = (req.headers['x-room-pin'] as string) || '';
    if (!verifyRoomAccess(roomId, pin)) {
      res.status(403).json({ error: 'Invalid room PIN.' });
      return;
    }

    const files = getRoomFiles(roomId);
    for (const f of files) {
      lastProgressBroadcastMs.delete(f.id);
      await closeFileHandleSafely(f.id);
      if (fs.existsSync(f.filePath)) {
        fs.promises.unlink(f.filePath).catch(() => {});
      }
    }
    roomsFiles.set(roomId, []);
    broadcastToRoom(roomId, {
      type: 'room:cleared',
      usedBytes: 0,
    });
    res.json({ ok: true, usedBytes: 0 });
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let currentRoomId = '';
    let currentDeviceId = `dev-${crypto.randomBytes(4).toString('hex')}`;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'room:join') {
          const requestedRoom = normalizeRoomId(msg.roomId);
          if (!requestedRoom || requestedRoom.length < 4) return;

          if (!verifyRoomAccess(requestedRoom, msg.pin)) {
            ws.send(
              JSON.stringify({
                type: 'room:auth-required',
                roomId: requestedRoom,
              })
            );
            return;
          }

          if (currentRoomId) {
            const prevMap = roomsDevices.get(currentRoomId);
            if (prevMap && prevMap.has(currentDeviceId)) {
              prevMap.delete(currentDeviceId);
              broadcastToRoom(currentRoomId, {
                type: 'devices:updated',
                devices: Array.from(prevMap.values()).map((d) => d.device),
              });
            }
          }

          currentRoomId = requestedRoom;
          currentDeviceId = msg.deviceId || currentDeviceId;

          if (!roomsDevices.has(currentRoomId)) {
            roomsDevices.set(currentRoomId, new Map());
          }

          const device: ConnectedDevice = {
            id: currentDeviceId,
            roomId: currentRoomId,
            name: msg.deviceName || 'Device',
            deviceType: msg.deviceType === 'Mobile' ? 'Mobile' : 'PC',
            platform: msg.platform || 'Web',
            transport: msg.transport || 'Wi-Fi / High-Speed Relay',
            joinedAt: new Date().toISOString(),
          };

          const roomMap = roomsDevices.get(currentRoomId)!;
          roomMap.set(currentDeviceId, { device, ws });

          ws.send(
            JSON.stringify({
              type: 'room:init',
              roomId: currentRoomId,
              hasPin: roomsPins.has(currentRoomId),
              retentionHours:
                roomsDefaultRetention.get(currentRoomId) || DEFAULT_RETENTION_HOURS,
              maxCapacityBytes: MAX_ROOM_CAPACITY_BYTES,
              usedBytes: getRoomUsedBytes(currentRoomId),
              files: getRoomFiles(currentRoomId).map(sanitizeFileRecord),
              devices: Array.from(roomMap.values()).map((d) => d.device),
            })
          );

          broadcastToRoom(currentRoomId, {
            type: 'devices:updated',
            devices: Array.from(roomMap.values()).map((d) => d.device),
          });
        } else if (msg.type === 'device:beam-notify' && currentRoomId) {
          broadcastToRoom(
            currentRoomId,
            {
              type: 'device:beam-alert',
              fileId: msg.fileId,
              fileName: msg.fileName,
              fromDeviceName: msg.fromDeviceName,
              targetDeviceId: msg.targetDeviceId,
              autoDownload: Boolean(msg.autoDownload),
            },
            currentDeviceId
          );
        }
      } catch (err) {
        console.error('WebSocket message error:', err);
      }
    });

    ws.on('close', () => {
      if (!currentRoomId) return;
      const roomMap = roomsDevices.get(currentRoomId);
      if (roomMap && roomMap.has(currentDeviceId)) {
        roomMap.delete(currentDeviceId);
        broadcastToRoom(currentRoomId, {
          type: 'devices:updated',
          devices: Array.from(roomMap.values()).map((d) => d.device),
        });
      }
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SwiftBeam High-Throughput 10GB Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
