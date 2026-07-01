export class NatDetector {
  constructor(logger) {
    this.logger = logger;
    this.reset();
  }

  reset() {
    this.collectedCandidates = [];
    this.natInfo = {
      type: 'unknown',
      typeName: this._t('chat.unknownNat'),
      description: 'Detecting NAT type...',
      hasHost: false,
      hasSrflx: false,
      hasRelay: false,
      hasPrflx: false,
      srflxCount: 0,
      relayCount: 0,
      hostCount: 0,
      srflxAddresses: new Set(),
      hostAddresses: new Set()
    };
  }

  _t(key, fallback) {
    try {
      if (window.i18n && typeof window.i18n.t === 'function') {
        const translated = window.i18n.t(key);
        return translated !== key ? translated : (fallback || key);
      }
    } catch (e) {}
    return fallback || key;
  }

  addCandidate(candidate) {
    if (!candidate || !candidate.candidate) return;
    
    this.collectedCandidates.push(candidate);
    
    const candidateStr = candidate.candidate;
    const type = this.parseCandidateType(candidateStr);
    const address = this.parseCandidateAddress(candidateStr);
    
    switch (type) {
      case 'host':
        this.natInfo.hasHost = true;
        this.natInfo.hostCount++;
        if (address) this.natInfo.hostAddresses.add(address);
        break;
      case 'srflx':
        this.natInfo.hasSrflx = true;
        this.natInfo.srflxCount++;
        if (address) this.natInfo.srflxAddresses.add(address);
        break;
      case 'relay':
        this.natInfo.hasRelay = true;
        this.natInfo.relayCount++;
        break;
      case 'prflx':
        this.natInfo.hasPrflx = true;
        break;
    }
  }

  parseCandidateType(candidateStr) {
    if (candidateStr.includes('typ host')) return 'host';
    if (candidateStr.includes('typ srflx')) return 'srflx';
    if (candidateStr.includes('typ relay')) return 'relay';
    if (candidateStr.includes('typ prflx')) return 'prflx';
    return 'unknown';
  }

  parseCandidateAddress(candidateStr) {
    const match = candidateStr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    return match ? match[1] : null;
  }

  detect() {
    const info = this.natInfo;
    const uniqueSrflxAddresses = this.natInfo.srflxAddresses.size;
    
    if (info.hasRelay && !info.hasHost && !info.hasSrflx) {
      info.type = 'blocked';
      info.typeName = this._t('chat.restrictedNetwork', 'Restricted network');
      info.description = 'UDP blocked, using TURN relay';
      this.logger?.info(`🔍 NAT detection: ${info.typeName}(relay candidates only)`);
      return info;
    }
    
    if (info.hasHost && !info.hasSrflx && !info.hasRelay) {
      const hostAddrs = Array.from(this.natInfo.hostAddresses);
      const isPrivateIp = hostAddrs.some(addr => 
        addr.startsWith('192.168.') || 
        addr.startsWith('10.') || 
        addr.startsWith('172.')
      );
      
      if (isPrivateIp) {
        info.type = 'unknown';
        info.typeName = this._t('chat.detectionLimited', 'Detection restricted');
        info.description = 'Local addresses only, STUN no response';
        this.logger?.info(`🔍 NAT detection: ${info.typeName}(host candidates only, private IP)`);
      } else {
        info.type = 'public';
        info.typeName = this._t('chat.publicNetwork', 'Public direct connection');
        info.description = 'No NAT, directly connected to public network';
        this.logger?.info(`🔍 NAT detection: ${info.typeName}(host candidates only, public IP)`);
      }
      return info;
    }
    
    if (info.hasSrflx) {
      if (uniqueSrflxAddresses >= 2) {
        info.type = 'symmetric';
        info.typeName = this._t('chat.symmetricNat', 'Symmetric NAT');
        info.description = 'Strict NAT, different mapping per destination';
        this.logger?.info(`🔍 NAT detection: ${info.typeName}(${uniqueSrflxAddresses} different srflx addresses)`);
      } else {
        info.type = 'cone';
        info.typeName = this._t('chat.coneNat', 'Cone NAT');
        info.description = 'Open NAT, direct penetration possible';
        this.logger?.info(`🔍 NAT detection: ${info.typeName}(single srflx address)`);
      }
      return info;
    }
    
    if (info.hasPrflx) {
      info.type = 'symmetric';
      info.typeName = this._t('chat.symmetricNat', 'Symmetric NAT');
      info.description = 'Strict NAT, ICE negotiation required';
      this.logger?.info(`🔍 NAT detection: ${info.typeName}(has prflx candidate)`);
      return info;
    }
    
    info.type = 'unknown';
    info.typeName = this._t('chat.unknownNat', 'Unknown');
    info.description = 'Unable to determine NAT type';
    this.logger?.info(`🔍 NAT detection: ${info.typeName}`);
    return info;
  }

  getSummary() {
    const info = this.natInfo;
    if (info.type === 'unknown') return '';
    
    if (info.hasRelay && !info.hasSrflx) {
      return `${info.typeName}${this._t('chat.relayNetwork', '(continuing)')}`;
    }
    return info.typeName;
  }

  getDetailedInfo() {
    const info = this.natInfo;
    return {
      type: info.type,
      typeName: info.typeName,
      description: info.description,
      statistics: {
        hostCount: info.hostCount,
        srflxCount: info.srflxCount,
        relayCount: info.relayCount,
        uniqueSrflxAddresses: this.natInfo.srflxAddresses.size,
        uniqueHostAddresses: this.natInfo.hostAddresses.size
      },
      hasHost: info.hasHost,
      hasSrflx: info.hasSrflx,
      hasRelay: info.hasRelay,
      hasPrflx: info.hasPrflx
    };
  }
}
