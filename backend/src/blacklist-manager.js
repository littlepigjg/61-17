const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

class BlacklistManager extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.dataFile = path.join(dataDir, 'blacklist.json');
    this.blacklist = new Map();
    this._cleanupTimer = null;
    this._ensureDataDir();
    this._load();
    this._startCleanup();
  }

  _ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  _load() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
        for (const item of data) {
          if (!this.blacklist.has(item.channelId)) {
            this.blacklist.set(item.channelId, new Map());
          }
          this.blacklist.get(item.channelId).set(item.id, item);
        }
      }
    } catch (err) {
      console.error('[Blacklist] Failed to load blacklist data:', err.message);
    }
  }

  _save() {
    try {
      const data = [];
      for (const channelMap of this.blacklist.values()) {
        for (const item of channelMap.values()) {
          data.push(item);
        }
      }
      fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[Blacklist] Failed to save blacklist data:', err.message);
    }
  }

  _startCleanup() {
    this._cleanupTimer = setInterval(() => {
      this._cleanupExpired();
    }, 60 * 1000);
    if (this._cleanupTimer.unref) {
      this._cleanupTimer.unref();
    }
  }

  _cleanupExpired() {
    const now = Date.now();
    let changed = false;
    for (const [channelId, channelMap] of this.blacklist.entries()) {
      const toRemove = [];
      for (const [id, item] of channelMap.entries()) {
        if (item.expiresAt && item.expiresAt <= now) {
          toRemove.push(id);
        }
      }
      for (const id of toRemove) {
        channelMap.delete(id);
        changed = true;
      }
      if (channelMap.size === 0) {
        this.blacklist.delete(channelId);
      }
    }
    if (changed) {
      this._save();
    }
  }

  _generateId() {
    return crypto.randomUUID();
  }

  _ipToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let result = 0;
    for (let i = 0; i < 4; i++) {
      const part = parseInt(parts[i], 10);
      if (isNaN(part) || part < 0 || part > 255) return null;
      result = (result << 8) + part;
    }
    return result >>> 0;
  }

  _parseCidr(cidr) {
    const parts = cidr.split('/');
    if (parts.length !== 2) return null;
    const ipInt = this._ipToInt(parts[0]);
    const prefix = parseInt(parts[1], 10);
    if (ipInt === null || isNaN(prefix) || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return {
      network: (ipInt & mask) >>> 0,
      broadcast: prefix === 32 ? ipInt : (ipInt | (~mask >>> 0)) >>> 0,
      prefix
    };
  }

  _isIpInRange(ip, range) {
    const ipInt = this._ipToInt(ip);
    if (ipInt === null) return false;
    if (range.type === 'cidr') {
      const parsed = this._parseCidr(range.value);
      if (!parsed) return false;
      return ipInt >= parsed.network && ipInt <= parsed.broadcast;
    }
    if (range.type === 'exact') {
      return ip === range.value;
    }
    if (range.type === 'range') {
      const startInt = this._ipToInt(range.start);
      const endInt = this._ipToInt(range.end);
      if (startInt === null || endInt === null) return false;
      return ipInt >= startInt && ipInt <= endInt;
    }
    return false;
  }

  addEntry(channelId, entry) {
    const { type, value, reason = '', expiresAt = null, createdBy = 'system' } = entry;

    if (!['ip', 'user', 'ip_range', 'ip_cidr'].includes(type)) {
      return { success: false, error: 'Invalid type. Must be one of: ip, user, ip_range, ip_cidr' };
    }

    if (!value) {
      return { success: false, error: 'Value is required' };
    }

    if (type === 'ip') {
      if (!this._ipToInt(value)) {
        return { success: false, error: 'Invalid IP address format' };
      }
    }

    if (type === 'ip_cidr') {
      if (!this._parseCidr(value)) {
        return { success: false, error: 'Invalid CIDR format (e.g., 192.168.1.0/24)' };
      }
    }

    if (type === 'ip_range') {
      const [start, end] = String(value).split('-').map(s => s.trim());
      if (!this._ipToInt(start) || !this._ipToInt(end)) {
        return { success: false, error: 'Invalid IP range format (e.g., 192.168.1.1-192.168.1.100)' };
      }
    }

    const id = this._generateId();
    const item = {
      id,
      channelId,
      type,
      value,
      reason,
      expiresAt,
      createdAt: Date.now(),
      createdBy
    };

    if (!this.blacklist.has(channelId)) {
      this.blacklist.set(channelId, new Map());
    }
    this.blacklist.get(channelId).set(id, item);
    this._save();

    this.emit('entryAdded', channelId, item);

    return { success: true, entry: item };
  }

  removeEntry(channelId, entryId) {
    const channelMap = this.blacklist.get(channelId);
    if (!channelMap) {
      return { success: false, error: 'Channel not found' };
    }
    if (!channelMap.has(entryId)) {
      return { success: false, error: 'Entry not found' };
    }
    const removed = channelMap.get(entryId);
    channelMap.delete(entryId);
    if (channelMap.size === 0) {
      this.blacklist.delete(channelId);
    }
    this._save();

    this.emit('entryRemoved', channelId, removed);

    return { success: true, entry: removed };
  }

  getEntries(channelId) {
    const channelMap = this.blacklist.get(channelId);
    if (!channelMap) return [];
    return Array.from(channelMap.values());
  }

  getAllEntries() {
    const result = [];
    for (const channelMap of this.blacklist.values()) {
      for (const item of channelMap.values()) {
        result.push(item);
      }
    }
    return result;
  }

  isBlacklisted(channelId, ip, userId = null) {
    this._cleanupExpired();
    const channelMap = this.blacklist.get(channelId);
    if (!channelMap) return { blacklisted: false };

    const now = Date.now();

    for (const item of channelMap.values()) {
      if (item.expiresAt && item.expiresAt <= now) continue;

      if (item.type === 'ip') {
        if (ip && ip === item.value) {
          return { blacklisted: true, entry: item };
        }
      }

      if (item.type === 'ip_cidr') {
        if (ip && this._isIpInRange(ip, { type: 'cidr', value: item.value })) {
          return { blacklisted: true, entry: item };
        }
      }

      if (item.type === 'ip_range') {
        if (ip) {
          const [start, end] = String(item.value).split('-').map(s => s.trim());
          if (this._isIpInRange(ip, { type: 'range', start, end })) {
            return { blacklisted: true, entry: item };
          }
        }
      }

      if (item.type === 'user') {
        if (userId && userId === item.value) {
          return { blacklisted: true, entry: item };
        }
      }
    }

    return { blacklisted: false };
  }

  clearChannel(channelId) {
    if (this.blacklist.has(channelId)) {
      this.blacklist.delete(channelId);
      this._save();
      this.emit('channelCleared', channelId);
      return true;
    }
    return false;
  }

  clearAll() {
    this.blacklist.clear();
    this._save();
    this.emit('allCleared');
  }

  importEntries(channelId, entries) {
    if (!Array.isArray(entries)) {
      return { success: false, error: 'Entries must be an array' };
    }

    const imported = [];
    const failed = [];

    for (const entry of entries) {
      const result = this.addEntry(channelId, entry);
      if (result.success) {
        imported.push(result.entry);
      } else {
        failed.push({ entry, error: result.error });
      }
    }

    return { success: true, imported: imported.length, failed: failed.length, failedItems: failed };
  }

  exportEntries(channelId = null) {
    if (channelId) {
      return this.getEntries(channelId);
    }
    return this.getAllEntries();
  }

  shutdown() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._save();
  }
}

module.exports = BlacklistManager;
