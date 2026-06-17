const WebSocket = require('ws');

class WebSocketServer {
  constructor(port, channelManager, ffmpegAvailable = false) {
    this.port = port;
    this.channelManager = channelManager;
    this.ffmpegAvailable = ffmpegAvailable;
    this.wss = null;
    this.clients = new Map();
  }

  start() {
    this.wss = new WebSocket.Server({ port: this.port });

    this.wss.on('connection', (ws) => {
      let clientChannel = null;
      let clientUserId = null;

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);

          switch (data.action) {
            case 'join':
              clientChannel = data.channelId;
              clientUserId = data.userId || null;
              ws._channelId = clientChannel;
              ws._userId = clientUserId;
              this.sendChannelStatus(ws, clientChannel);
              break;

            case 'leave':
              clientChannel = null;
              clientUserId = null;
              ws._channelId = null;
              ws._userId = null;
              break;

            case 'control':
              this.handleControl(ws, data);
              break;

            case 'getStatus':
              this.sendChannelStatus(ws, data.channelId || clientChannel);
              break;
          }
        } catch (e) {
          console.error('WebSocket message error:', e);
        }
      });

      ws.on('close', () => {
      });
    });

    this.channelManager.on('play', (channelId, track) => {
      this.broadcastToChannel(channelId, {
        type: 'trackChange',
        channelId,
        track: { title: track.title, filename: track.filename },
        isPlaying: true
      });
    });

    this.channelManager.on('pause', (channelId) => {
      this.broadcastToChannel(channelId, {
        type: 'statusChange',
        channelId,
        isPlaying: false
      });
    });

    this.channelManager.on('resume', (channelId) => {
      this.broadcastToChannel(channelId, {
        type: 'statusChange',
        channelId,
        isPlaying: true
      });
    });

    this.channelManager.on('volume', (channelId, volume) => {
      this.broadcastToChannel(channelId, {
        type: 'volumeChange',
        channelId,
        volume
      });
    });

    this.channelManager.on('listeners', (channelId, listeners) => {
      this.broadcastToChannel(channelId, {
        type: 'listenersChange',
        channelId,
        listeners
      });
    });

    console.log(`WebSocket server running on port ${this.port}`);
  }

  handleControl(ws, data) {
    const { channelId, command, params } = data;

    switch (command) {
      case 'play':
        this.channelManager.play(channelId, params?.index);
        break;
      case 'pause':
        this.channelManager.pause(channelId);
        break;
      case 'resume':
        this.channelManager.resume(channelId);
        break;
      case 'next':
        this.channelManager.next(channelId);
        break;
      case 'prev':
        this.channelManager.prev(channelId);
        break;
      case 'volume':
        this.channelManager.setVolume(channelId, params?.volume);
        break;
    }
  }

  broadcastToChannel(channelId, message) {
    const data = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client._channelId === channelId) {
        client.send(data);
      }
    });
  }

  broadcastAll(message) {
    const data = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  sendBlacklistNotification(channelId, userId, ip, entry) {
    const message = {
      type: 'blacklisted',
      channelId: channelId,
      reason: entry.reason || '',
      expiresAt: entry.expiresAt || null,
      entryType: entry.type
    };
    const data = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (channelId && client._channelId !== channelId) return;
      const matchUserId = userId && client._userId === userId;
      const matchChannel = client._channelId === channelId;
      if (matchUserId || (matchChannel && ip && !client._userId)) {
        try {
          client.send(data);
        } catch (e) {}
      }
    });
  }

  broadcastBlacklistToChannel(channelId, entry) {
    const message = {
      type: 'blacklisted',
      channelId: channelId,
      reason: entry.reason || '',
      expiresAt: entry.expiresAt || null,
      entryType: entry.type
    };
    const data = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client._channelId === channelId) {
        try {
          client.send(data);
        } catch (e) {}
      }
    });
  }

  sendChannelStatus(ws, channelId) {
    const channel = this.channelManager.getChannel(channelId);
    if (!channel) return;

    ws.send(JSON.stringify({
      type: 'status',
      channelId,
      name: channel.name,
      isPlaying: channel.isPlaying,
      currentTrack: channel.currentTrack ? {
        title: channel.currentTrack.title,
        filename: channel.currentTrack.filename
      } : null,
      volume: channel.volume,
      listeners: channel.listeners,
      playlist: channel.playlist.map((t, i) => ({
        index: i,
        title: t.title,
        filename: t.filename
      })),
      currentIndex: channel.currentIndex,
      ffmpegAvailable: this.ffmpegAvailable
    }));
  }

  stop() {
    if (this.wss) {
      this.wss.close();
    }
  }
}

module.exports = WebSocketServer;
