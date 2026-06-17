const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const config = require('../config.json');
const ChannelManager = require('./channel-manager');
const AudioStreamer = require('./audio-streamer');
const WebSocketServer = require('./ws-server');
const BlacklistManager = require('./blacklist-manager');

let ffmpegAvailable = false;
try {
  execSync('ffmpeg -version 2>nul', { stdio: 'ignore' });
  ffmpegAvailable = true;
} catch (e) {}

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});

const app = express();
app.use(cors());

app.use((req, res, next) => {
  let userId = null;
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)listener_uid=([^;]+)/);
    if (match) {
      userId = match[1];
    }
  }
  if (!userId) {
    userId = crypto.randomUUID();
    res.cookie('listener_uid', userId, {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: 'lax'
    });
  }
  req.listenerUid = userId;
  next();
});

const rawBodyBuffer = (req, res, buf, encoding) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
};

app.use(express.json({ verify: rawBodyBuffer }));

const frontendPath = path.join(__dirname, '../../frontend');
app.use(express.static(frontendPath));

const channelManager = new ChannelManager(config);
channelManager.init();

const audioStreamer = new AudioStreamer(channelManager);

const dataDir = path.join(__dirname, '../data');
const blacklistManager = new BlacklistManager(dataDir);

const wsServer = new WebSocketServer(config.wsPort, channelManager, ffmpegAvailable);
wsServer.start();

audioStreamer.setWebSocketServer(wsServer);

blacklistManager.on('entryAdded', (channelId, entry) => {
  const removed = audioStreamer.removeStreamsByBlacklistCheck(channelId, blacklistManager, (userId, ip, removedEntry) => {
    wsServer.sendBlacklistNotification(channelId, userId, ip, removedEntry);
  });
  if (removed > 0) {
    console.log(`[Blacklist] Disconnected ${removed} listener(s) from channel ${channelId} due to new blacklist entry`);
  }
});

app.get('/api/channels', (req, res) => {
  const channels = channelManager.getAllChannels();
  res.json(channels);
});

app.get('/api/channels/:channelId', (req, res) => {
  const channel = channelManager.getChannel(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  res.json({
    id: channel.id,
    name: channel.name,
    description: channel.description,
    isPlaying: channel.isPlaying,
    currentTrack: channel.currentTrack ? {
      title: channel.currentTrack.title,
      filename: channel.currentTrack.filename
    } : null,
    listeners: channel.listeners,
    volume: channel.volume,
    currentIndex: channel.currentIndex
  });
});

app.get('/api/channels/:channelId/playlist', (req, res) => {
  const channel = channelManager.getChannel(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  const playlist = channelManager.getPlaylist(req.params.channelId);
  res.json(playlist.map((t, i) => ({
    index: i,
    title: t.title,
    filename: t.filename
  })));
});

app.post('/api/channels/:channelId/play', (req, res) => {
  const { index } = req.body || {};
  const track = channelManager.play(req.params.channelId, index);
  if (track === null) {
    return res.status(404).json({ error: 'No tracks available' });
  }
  res.json({ success: true, track });
});

app.post('/api/channels/:channelId/pause', (req, res) => {
  const result = channelManager.pause(req.params.channelId);
  res.json({ success: result });
});

app.post('/api/channels/:channelId/resume', (req, res) => {
  const result = channelManager.resume(req.params.channelId);
  res.json({ success: result });
});

app.post('/api/channels/:channelId/next', (req, res) => {
  const track = channelManager.next(req.params.channelId);
  res.json({ success: true, track });
});

app.post('/api/channels/:channelId/prev', (req, res) => {
  const track = channelManager.prev(req.params.channelId);
  res.json({ success: true, track });
});

app.post('/api/channels/:channelId/volume', (req, res) => {
  const { volume } = req.body;
  if (volume === undefined) {
    return res.status(400).json({ error: 'Volume is required' });
  }
  const result = channelManager.setVolume(req.params.channelId, volume);
  res.json({ success: result, volume: channelManager.getChannel(req.params.channelId)?.volume });
});

app.get('/stream/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  const channel = channelManager.getChannel(channelId);
  const userId = req.listenerUid;
  const clientIp = req.ip || req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    (req.connection.socket ? req.connection.socket.remoteAddress : null);

  if (!channel) {
    return res.status(404).send('Channel not found');
  }

  const blacklistCheck = blacklistManager.isBlacklisted(channelId, clientIp, userId);
  if (blacklistCheck.blacklisted) {
    const entry = blacklistCheck.entry;
    let reasonMsg = '您已被禁止访问此频道';
    if (entry.reason) {
      reasonMsg = `您已被禁止访问此频道：${entry.reason}`;
    }
    if (entry.expiresAt) {
      const expireDate = new Date(entry.expiresAt);
      reasonMsg += `（解禁时间：${expireDate.toLocaleString()}）`;
    }
    res.status(403).type('text/plain; charset=utf-8').send(reasonMsg);
    return;
  }

  let contentType = 'audio/mpeg';
  if (!ffmpegAvailable) {
    const currentTrack = channelManager.getCurrentTrack(channelId);
    if (currentTrack) {
      const ext = currentTrack.filename.split('.').pop().toLowerCase();
      if (ext === 'wav') contentType = 'audio/wav';
      else if (ext === 'ogg') contentType = 'audio/ogg';
      else if (ext === 'flac') contentType = 'audio/flac';
      else if (ext === 'm4a' || ext === 'aac') contentType = 'audio/aac';
    }
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'none');
  res.status(200);

  const result = audioStreamer.createClientStream(channelId, userId, true, clientIp);
  if (!result) {
    res.end();
    return;
  }

  const { stream: clientStream, connectionId } = result;
  res.setHeader('X-Connection-Id', connectionId);

  clientStream.pipe(res);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      clientStream.unpipe(res);
    } catch (e) {}
    try {
      clientStream.destroy();
    } catch (e) {}
  };

  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
  res.on('finish', cleanup);
  clientStream.on('error', cleanup);
});

app.post('/api/listeners/leave', (req, res) => {
  let body = req.body;
  if ((!body || Object.keys(body).length === 0) && req.rawBody) {
    try {
      body = JSON.parse(req.rawBody);
    } catch (e) {}
  }
  const userId = req.listenerUid;
  if (!userId) {
    return res.json({ success: false });
  }
  const affected = audioStreamer.removeAllStreamsForUser(userId);
  res.json({ success: true, affectedChannels: affected, userId });
});

app.post('/api/listeners/heartbeat', (req, res) => {
  const { connectionId, channelId } = req.body || {};
  let success = false;
  if (connectionId) {
    success = audioStreamer.listenerManager.touch(connectionId, channelId);
  }
  res.json({ success });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/config', (req, res) => {
  res.json({
    ffmpegAvailable: ffmpegAvailable,
    port: config.port,
    wsPort: config.wsPort
  });
});

app.get('/api/channels/:channelId/blacklist', (req, res) => {
  const channel = channelManager.getChannel(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  const entries = blacklistManager.getEntries(req.params.channelId);
  res.json(entries);
});

app.post('/api/channels/:channelId/blacklist', (req, res) => {
  const channel = channelManager.getChannel(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  const { type, value, reason, expiresAt, duration } = req.body || {};

  if (!type || !value) {
    return res.status(400).json({ error: 'Type and value are required' });
  }

  let finalExpiresAt = null;
  if (duration && typeof duration === 'number' && duration > 0) {
    finalExpiresAt = Date.now() + duration * 1000;
  } else if (expiresAt) {
    finalExpiresAt = new Date(expiresAt).getTime();
    if (isNaN(finalExpiresAt)) {
      return res.status(400).json({ error: 'Invalid expiresAt date' });
    }
  }

  const result = blacklistManager.addEntry(req.params.channelId, {
    type,
    value,
    reason: reason || '',
    expiresAt: finalExpiresAt,
    createdBy: 'dj'
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  res.json({ success: true, entry: result.entry });
});

app.delete('/api/channels/:channelId/blacklist/:entryId', (req, res) => {
  const channel = channelManager.getChannel(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  const result = blacklistManager.removeEntry(req.params.channelId, req.params.entryId);
  if (!result.success) {
    return res.status(404).json({ error: result.error });
  }

  res.json({ success: true, entry: result.entry });
});

app.delete('/api/channels/:channelId/blacklist', (req, res) => {
  const channel = channelManager.getChannel(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  blacklistManager.clearChannel(req.params.channelId);
  res.json({ success: true });
});

app.get('/api/blacklist/export', (req, res) => {
  const { channelId } = req.query;
  if (channelId) {
    const channel = channelManager.getChannel(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }
  }
  const entries = blacklistManager.exportEntries(channelId || null);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="blacklist-${channelId || 'all'}-${Date.now()}.json"`);
  res.json(entries);
});

app.post('/api/channels/:channelId/blacklist/import', (req, res) => {
  const channel = channelManager.getChannel(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  const { entries } = req.body || {};
  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: 'Entries must be an array' });
  }

  const result = blacklistManager.importEntries(req.params.channelId, entries);

  if (result.imported > 0) {
    const removed = audioStreamer.removeStreamsByBlacklistCheck(req.params.channelId, blacklistManager, (userId, ip, entry) => {
      wsServer.sendBlacklistNotification(req.params.channelId, userId, ip, entry);
    });
    if (removed > 0) {
      console.log(`[Blacklist] Disconnected ${removed} listener(s) from channel ${req.params.channelId} due to import`);
    }
  }

  res.json(result);
});

app.get('/api/blacklist/check', (req, res) => {
  const { channelId, ip, userId } = req.query;
  if (!channelId) {
    return res.status(400).json({ error: 'channelId is required' });
  }
  const channel = channelManager.getChannel(channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  const result = blacklistManager.isBlacklisted(channelId, ip || null, userId || null);
  res.json(result);
});

app.listen(config.port, () => {
  console.log(`\n=== 内网音频广播服务已启动 ===`);
  console.log(`HTTP 服务端口: ${config.port}`);
  console.log(`WebSocket 端口: ${config.wsPort}`);
  console.log(`音乐目录: ${path.resolve(config.musicBaseDir)}`);
  console.log(`\n频道列表:`);
  for (const ch of config.channels) {
    console.log(`  [${ch.name}] - /stream/${ch.id}`);
    console.log(`    目录: ${path.join(config.musicBaseDir, ch.dir)}`);
  }
  console.log(`\n前端页面: http://localhost:${config.port}/`);
  console.log(`DJ 控制台: http://localhost:${config.port}/dj.html`);
  console.log(`\n提示: 请确保系统已安装 ffmpeg`);
});

process.on('SIGINT', () => {
  console.log('\n正在关闭服务...');
  audioStreamer.shutdown();
  blacklistManager.shutdown();
  wsServer.stop();
  process.exit(0);
});
