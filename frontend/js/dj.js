class DJPanel {
  constructor() {
    this.currentChannel = null;
    this.ws = null;
    this.playlist = [];
    this.currentIndex = -1;
    this.isPlaying = false;
    this.blacklist = [];
    this._blacklistRefreshTimer = null;

    this.channelList = document.getElementById('channelList');
    this.djChannelName = document.getElementById('djChannelName');
    this.statusBadge = document.getElementById('statusBadge');
    this.nowPlaying = document.getElementById('nowPlaying');
    this.playPauseBtn = document.getElementById('playPauseBtn');
    this.prevBtn = document.getElementById('prevBtn');
    this.nextBtn = document.getElementById('nextBtn');
    this.channelVolume = document.getElementById('channelVolume');
    this.djListenerCount = document.getElementById('djListenerCount');
    this.playlistCount = document.getElementById('playlistCount');
    this.playlistEl = document.getElementById('playlist');

    this.blacklistEl = document.getElementById('blacklist');
    this.blacklistCount = document.getElementById('blacklistCount');
    this.addBlacklistBtn = document.getElementById('addBlacklistBtn');
    this.importBlacklistBtn = document.getElementById('importBlacklistBtn');
    this.exportBlacklistBtn = document.getElementById('exportBlacklistBtn');
    this.clearBlacklistBtn = document.getElementById('clearBlacklistBtn');
    this.importFileInput = document.getElementById('importFileInput');

    this.blacklistModal = document.getElementById('blacklistModal');
    this.blacklistType = document.getElementById('blacklistType');
    this.blacklistValue = document.getElementById('blacklistValue');
    this.blacklistReason = document.getElementById('blacklistReason');
    this.blacklistDuration = document.getElementById('blacklistDuration');
    this.customDurationGroup = document.getElementById('customDurationGroup');
    this.customDuration = document.getElementById('customDuration');
    this.valueLabel = document.getElementById('valueLabel');
    this.valueHint = document.getElementById('valueHint');
    this.closeModalBtn = document.getElementById('closeModalBtn');
    this.cancelModalBtn = document.getElementById('cancelModalBtn');
    this.confirmBlacklistBtn = document.getElementById('confirmBlacklistBtn');

    this.init();
  }

  async init() {
    await this.loadChannels();
    this.bindEvents();
  }

  async loadChannels() {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/channels`);
      const channels = await response.json();
      this.renderChannels(channels);
    } catch (err) {
      console.error('Failed to load channels:', err);
    }
  }

  renderChannels(channels) {
    this.channelList.innerHTML = channels.map(ch => `
      <div class="channel-item ${this.currentChannel === ch.id ? 'active' : ''}" data-id="${ch.id}">
        <h3><span class="channel-status ${ch.isPlaying ? 'playing' : ''}"></span>${ch.name}</h3>
        <p>${ch.description}</p>
        <div class="channel-meta">
          <span>👥 ${ch.listeners} 人在线</span>
          <span>${ch.isPlaying ? '播放中' : '已停止'}</span>
        </div>
      </div>
    `).join('');

    this.channelList.querySelectorAll('.channel-item').forEach(item => {
      item.addEventListener('click', () => {
        const channelId = item.dataset.id;
        this.selectChannel(channelId);
      });
    });
  }

  selectChannel(channelId) {
    if (this.currentChannel === channelId) return;

    if (this.ws) {
      this.ws.close();
    }

    if (this._blacklistRefreshTimer) {
      clearInterval(this._blacklistRefreshTimer);
      this._blacklistRefreshTimer = null;
    }

    this.currentChannel = channelId;
    this.connectWebSocket(channelId);
    this.loadPlaylist(channelId);
    this.loadBlacklist(channelId);
    this.loadChannels();

    this._blacklistRefreshTimer = setInterval(() => {
      this.renderBlacklist();
    }, 10000);
  }

  connectWebSocket(channelId) {
    this.ws = new WebSocket(CONFIG.WS_URL);

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({
        action: 'join',
        channelId: channelId
      }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleWebSocketMessage(data);
    };

    this.ws.onclose = () => {
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  handleWebSocketMessage(data) {
    switch (data.type) {
      case 'status':
        this.handleStatus(data);
        break;
      case 'trackChange':
        this.handleTrackChange(data);
        break;
      case 'statusChange':
        this.handleStatusChange(data);
        break;
      case 'listenersChange':
        this.handleListenersChange(data);
        break;
      case 'volumeChange':
        this.handleVolumeChange(data);
        break;
    }
  }

  handleStatus(data) {
    this.djChannelName.textContent = data.name;
    this.isPlaying = data.isPlaying;
    this.currentIndex = data.currentIndex || -1;

    if (data.currentTrack) {
      this.nowPlaying.textContent = data.currentTrack.title;
    } else {
      this.nowPlaying.textContent = '--';
    }

    this.djListenerCount.textContent = data.listeners;

    if (data.playlist) {
      this.playlist = data.playlist;
      this.playlistCount.textContent = data.playlist.length;
      this.renderPlaylist();
    }

    this.updatePlayPauseButton();
    this.updateStatusBadge();
    this.channelVolume.value = Math.round((data.volume || 1) * 100);
  }

  handleTrackChange(data) {
    if (data.track) {
      this.nowPlaying.textContent = data.track.title;
      const idx = this.playlist.findIndex(t => t.filename === data.track.filename);
      if (idx >= 0) {
        this.currentIndex = idx;
      }
    }
    this.isPlaying = data.isPlaying;
    this.updatePlayPauseButton();
    this.updateStatusBadge();
    this.renderPlaylist();
  }

  handleStatusChange(data) {
    this.isPlaying = data.isPlaying;
    this.updatePlayPauseButton();
    this.updateStatusBadge();
  }

  handleListenersChange(data) {
    this.djListenerCount.textContent = data.listeners;
    this.loadChannels();
  }

  handleVolumeChange(data) {
    this.channelVolume.value = Math.round(data.volume * 100);
  }

  updatePlayPauseButton() {
    if (this.isPlaying) {
      this.playPauseBtn.textContent = '⏸';
    } else {
      this.playPauseBtn.textContent = '▶';
    }
  }

  updateStatusBadge() {
    this.statusBadge.classList.remove('playing', 'paused', 'stopped');
    if (this.isPlaying) {
      this.statusBadge.textContent = '播放中';
      this.statusBadge.classList.add('playing');
    } else if (this.currentIndex >= 0) {
      this.statusBadge.textContent = '已暂停';
      this.statusBadge.classList.add('paused');
    } else {
      this.statusBadge.textContent = '已停止';
      this.statusBadge.classList.add('stopped');
    }
  }

  async loadPlaylist(channelId) {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/channels/${channelId}/playlist`);
      const playlist = await response.json();
      this.playlist = playlist;
      this.playlistCount.textContent = playlist.length;
      this.renderPlaylist();
    } catch (err) {
      console.error('Failed to load playlist:', err);
    }
  }

  renderPlaylist() {
    if (this.playlist.length === 0) {
      this.playlistEl.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">播放列表为空</div>';
      return;
    }

    this.playlistEl.innerHTML = this.playlist.map(track => `
      <div class="playlist-item ${track.index === this.currentIndex ? 'current' : ''}" data-index="${track.index}">
        <span class="track-index">${track.index === this.currentIndex ? '♪' : track.index + 1}</span>
        <span class="track-title">${track.title}</span>
      </div>
    `).join('');

    this.playlistEl.querySelectorAll('.playlist-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.index);
        this.playTrack(index);
      });
    });
  }

  async loadBlacklist(channelId) {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/channels/${channelId}/blacklist`);
      this.blacklist = await response.json();
      this.blacklistCount.textContent = this.blacklist.length;
      this.renderBlacklist();
    } catch (err) {
      console.error('Failed to load blacklist:', err);
      this.blacklist = [];
      this.blacklistCount.textContent = 0;
      this.renderBlacklist();
    }
  }

  getTypeLabel(type) {
    const labels = {
      'ip': 'IP 地址',
      'ip_cidr': 'IP 段 (CIDR)',
      'ip_range': 'IP 范围',
      'user': '用户标识'
    };
    return labels[type] || type;
  }

  formatDate(timestamp) {
    if (!timestamp) return '永久';
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN');
  }

  formatDuration(expiresAt, createdAt) {
    if (!expiresAt) return '永久';
    const remainMs = expiresAt - Date.now();
    if (remainMs <= 0) return '已过期';
    const seconds = Math.floor(remainMs / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}天${hours}小时`;
    if (hours > 0) return `${hours}小时${minutes}分钟`;
    return `${minutes}分钟`;
  }

  renderBlacklist() {
    if (this.blacklist.length === 0) {
      this.blacklistEl.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">黑名单为空</div>';
      return;
    }

    const now = Date.now();
    this.blacklistEl.innerHTML = this.blacklist.map(item => {
      const isExpired = item.expiresAt && item.expiresAt <= now;
      const createdByLabel = item.createdBy === 'dj' ? 'DJ操作' : item.createdBy === 'system' ? '系统' : item.createdBy || '';
      return `
        <div class="blacklist-item ${isExpired ? 'expired' : ''}" data-id="${item.id}">
          <div class="blacklist-item-header">
            <span class="blacklist-type">${this.getTypeLabel(item.type)}</span>
            <span class="blacklist-value">${item.value}</span>
            ${isExpired ? '<span class="badge expired-badge">已过期</span>' : ''}
            ${createdByLabel ? `<span class="created-by-tag">${createdByLabel}</span>` : ''}
          </div>
          <div class="blacklist-item-body">
            ${item.reason ? `<div class="blacklist-reason">原因: ${item.reason}</div>` : ''}
            <div class="blacklist-meta">
              <span>创建: ${this.formatDate(item.createdAt)}</span>
              <span>到期: ${this.formatDate(item.expiresAt)}</span>
              <span>剩余: ${this.formatDuration(item.expiresAt, item.createdAt)}</span>
            </div>
            <div class="blacklist-actions-inline" style="margin-top:8px;">
              <button class="copy-btn" data-value="${item.value}" style="padding:4px 10px;font-size:11px;background:rgba(59,130,246,0.2);color:#93c5fd;border:none;border-radius:6px;cursor:pointer;">
                📋 复制值
              </button>
            </div>
          </div>
          <button class="remove-btn" data-id="${item.id}">移除</button>
        </div>
      `;
    }).join('');

    this.blacklistEl.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const entryId = btn.dataset.id;
        this.removeBlacklistEntry(entryId);
      });
    });

    this.blacklistEl.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const value = btn.dataset.value;
        this.copyToClipboard(value);
      });
    });
  }

  copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        this.showToast('已复制: ' + text, 'success');
      }).catch(() => {
        this._copyFallback(text);
      });
    } else {
      this._copyFallback(text);
    }
  }

  _copyFallback(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      this.showToast('已复制: ' + text, 'success');
    } catch (e) {
      this.showToast('复制失败', 'error');
    }
    document.body.removeChild(textarea);
  }

  showToast(message, type = 'info', duration = 3000) {
    const existing = document.querySelector('.toast');
    if (existing) {
      existing.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  showAddModal() {
    this.blacklistType.value = 'ip';
    this.blacklistValue.value = '';
    this.blacklistReason.value = '';
    this.blacklistDuration.value = '0';
    this.customDuration.value = '';
    this.customDurationGroup.style.display = 'none';
    this.updateValueHint();
    this.blacklistModal.style.display = 'flex';
  }

  hideModal() {
    this.blacklistModal.style.display = 'none';
  }

  updateValueHint() {
    const type = this.blacklistType.value;
    const hints = {
      'ip': { label: 'IP 地址', placeholder: '例如: 192.168.1.100', hint: '输入要屏蔽的单个 IP 地址' },
      'ip_cidr': { label: 'CIDR 格式', placeholder: '例如: 192.168.1.0/24', hint: '输入要屏蔽的 IP 段，CIDR 格式' },
      'ip_range': { label: 'IP 范围', placeholder: '例如: 192.168.1.1-192.168.1.100', hint: '输入要屏蔽的 IP 起始范围，用横线分隔' },
      'user': { label: '用户标识 (UID)', placeholder: '例如: 550e8400-e29b-41d4-a716-446655440000', hint: '输入要屏蔽的用户唯一标识符' }
    };
    const info = hints[type] || hints['ip'];
    this.valueLabel.textContent = info.label;
    this.blacklistValue.placeholder = info.placeholder;
    this.valueHint.textContent = info.hint;
  }

  async addBlacklistEntry() {
    if (!this.currentChannel) {
      this.showToast('请先选择频道', 'error');
      return;
    }

    const type = this.blacklistType.value;
    const value = this.blacklistValue.value.trim();
    const reason = this.blacklistReason.value.trim();
    const durationSel = this.blacklistDuration.value;

    if (!value) {
      this.showToast('请输入要屏蔽的值', 'error');
      return;
    }

    let duration = 0;
    if (durationSel === 'custom') {
      const custom = parseInt(this.customDuration.value, 10);
      if (!custom || custom <= 0) {
        this.showToast('请输入有效的自定义有效期', 'error');
        return;
      }
      duration = custom;
    } else {
      duration = parseInt(durationSel, 10) || 0;
    }

    try {
      const body = { type, value, reason };
      if (duration > 0) {
        body.duration = duration;
      }

      const response = await fetch(`${CONFIG.API_BASE}/api/channels/${this.currentChannel}/blacklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const result = await response.json();
      if (result.success) {
        this.hideModal();
        this.loadBlacklist(this.currentChannel);
        this.showToast('已添加到黑名单', 'success');
      } else {
        this.showToast('添加失败: ' + (result.error || '未知错误'), 'error');
      }
    } catch (err) {
      console.error('Failed to add blacklist entry:', err);
      this.showToast('添加失败，请稍后重试', 'error');
    }
  }

  async removeBlacklistEntry(entryId) {
    if (!this.currentChannel) return;
    if (!confirm('确定要移除此黑名单条目吗？')) return;

    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/channels/${this.currentChannel}/blacklist/${entryId}`, {
        method: 'DELETE'
      });
      const result = await response.json();
      if (result.success) {
        this.loadBlacklist(this.currentChannel);
        this.showToast('已移除黑名单条目', 'success');
      } else {
        this.showToast('移除失败: ' + (result.error || '未知错误'), 'error');
      }
    } catch (err) {
      console.error('Failed to remove blacklist entry:', err);
      this.showToast('移除失败，请稍后重试', 'error');
    }
  }

  async clearBlacklist() {
    if (!this.currentChannel) return;
    if (!confirm('确定要清空当前频道的所有黑名单条目吗？此操作不可恢复！')) return;

    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/channels/${this.currentChannel}/blacklist`, {
        method: 'DELETE'
      });
      const result = await response.json();
      if (result.success) {
        this.loadBlacklist(this.currentChannel);
        this.showToast('已清空黑名单', 'success');
      } else {
        this.showToast('清空失败: ' + (result.error || '未知错误'), 'error');
      }
    } catch (err) {
      console.error('Failed to clear blacklist:', err);
      this.showToast('清空失败，请稍后重试', 'error');
    }
  }

  exportBlacklist() {
    if (!this.currentChannel) {
      this.showToast('请先选择频道', 'error');
      return;
    }
    this.showToast('正在导出黑名单数据...', 'info');
    window.open(`${CONFIG.API_BASE}/api/blacklist/export?channelId=${this.currentChannel}`, '_blank');
  }

  triggerImport() {
    this.importFileInput.click();
  }

  async handleImportFile(file) {
    if (!this.currentChannel) return;
    if (!file) return;

    try {
      const text = await file.text();
      const entries = JSON.parse(text);
      if (!Array.isArray(entries)) {
        alert('导入文件格式错误，应为 JSON 数组');
        return;
      }

      const response = await fetch(`${CONFIG.API_BASE}/api/channels/${this.currentChannel}/blacklist/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries })
      });

      const result = await response.json();
      let msg = `导入完成: 成功 ${result.imported} 条`;
      if (result.failed > 0) {
        msg += `，失败 ${result.failed} 条`;
        if (result.failedItems && result.failedItems.length > 0) {
          msg += '\n\n失败详情:\n';
          result.failedItems.slice(0, 5).forEach(item => {
            msg += `  - ${JSON.stringify(item.entry.value)}: ${item.error}\n`;
          });
          if (result.failedItems.length > 5) {
            msg += `  ... 还有 ${result.failedItems.length - 5} 条失败记录`;
          }
        }
        this.showToast(msg, 'error', 6000);
      } else {
        this.showToast(msg, 'success');
      }
      this.loadBlacklist(this.currentChannel);
    } catch (err) {
      console.error('Failed to import blacklist:', err);
      this.showToast('导入失败: ' + err.message, 'error');
    }
  }

  sendControl(command, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      action: 'control',
      channelId: this.currentChannel,
      command: command,
      params: params
    }));
  }

  playTrack(index) {
    this.sendControl('play', { index });
    this.currentIndex = index;
  }

  togglePlayPause() {
    if (this.isPlaying) {
      this.sendControl('pause');
    } else {
      if (this.currentIndex >= 0) {
        this.sendControl('resume');
      } else {
        this.sendControl('play');
      }
    }
  }

  nextTrack() {
    this.sendControl('next');
  }

  prevTrack() {
    this.sendControl('prev');
  }

  setVolume(value) {
    this.sendControl('volume', { volume: value / 100 });
  }

  bindEvents() {
    this.playPauseBtn.addEventListener('click', () => {
      if (!this.currentChannel) return;
      this.togglePlayPause();
    });

    this.nextBtn.addEventListener('click', () => {
      if (!this.currentChannel) return;
      this.nextTrack();
    });

    this.prevBtn.addEventListener('click', () => {
      if (!this.currentChannel) return;
      this.prevTrack();
    });

    this.channelVolume.addEventListener('input', (e) => {
      if (!this.currentChannel) return;
      this.setVolume(parseInt(e.target.value));
    });

    this.addBlacklistBtn.addEventListener('click', () => this.showAddModal());
    this.importBlacklistBtn.addEventListener('click', () => this.triggerImport());
    this.exportBlacklistBtn.addEventListener('click', () => this.exportBlacklist());
    this.clearBlacklistBtn.addEventListener('click', () => this.clearBlacklist());

    this.closeModalBtn.addEventListener('click', () => this.hideModal());
    this.cancelModalBtn.addEventListener('click', () => this.hideModal());
    this.confirmBlacklistBtn.addEventListener('click', () => this.addBlacklistEntry());

    this.blacklistType.addEventListener('change', () => this.updateValueHint());
    this.blacklistDuration.addEventListener('change', () => {
      if (this.blacklistDuration.value === 'custom') {
        this.customDurationGroup.style.display = 'block';
      } else {
        this.customDurationGroup.style.display = 'none';
      }
    });

    this.importFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        this.handleImportFile(file);
      }
      e.target.value = '';
    });

    this.blacklistModal.addEventListener('click', (e) => {
      if (e.target === this.blacklistModal) {
        this.hideModal();
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new DJPanel();
});
