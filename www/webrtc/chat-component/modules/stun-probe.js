// STUN parallel probing module - probe all STUN servers before creating the RTCPeerConnection
// Select the server with the lowest latency to optimize connection success rate

export class StunProbe {
  constructor(logger) {
    this.logger = logger;
    this.probeTimeout = 3000; // Per-server probe timeout
    this.maxProbes = 3; // Number of probes per server (taking the average)
  }

  /**
   * Probe all STUN servers in parallel
   * @param {Array} stunServers - STUN server configuration array
   * @returns {Promise<Object>} - Returns the best server and probe results
   */
  async probeAllServers(stunServers) {
    if (!stunServers || stunServers.length === 0) {
      this.logger?.warn('[StunProbe] no STUN servers configured');
      return { bestServer: null, results: [] };
    }

    this.logger?.info(`[StunProbe] start parallel probing ${stunServers.length}  STUN servers...`);
    const startTime = Date.now();

    // Probe all servers in parallel
    const probePromises = stunServers.map(server => this.probeServer(server));
    const results = await Promise.all(probePromises);

    // Filter out servers that failed probing
    const successfulResults = results.filter(r => r.success && r.latency !== null);
    
    // Sort by latency
    successfulResults.sort((a, b) => a.latency - b.latency);

    const bestServer = successfulResults.length > 0 ? successfulResults[0] : null;
    const totalTime = Date.now() - startTime;

    this.logger?.info(`[StunProbe] probe completed, time taken ${totalTime}ms`);
    this.logger?.info(`[StunProbe] succeeded: ${successfulResults.length}/${stunServers.length}  servers`);
    
    if (bestServer) {
      this.logger?.info(`[StunProbe] best server: ${bestServer.name} (${bestServer.url}, latency: ${bestServer.latency}ms)`);
    }

    // Log all results
    successfulResults.forEach(r => {
      this.logger?.debug(`[StunProbe] ${r.name}: ${r.latency}ms (${r.success ? 'succeeded' : 'failed'})`);
    });

    return {
      bestServer,
      results: successfulResults,
      allResults: results
    };
  }

  /**
   * Probe a single STUN server
   * @param {Object} serverConfig - Server configuration { urls: 'stun:host:port' }
   * @returns {Promise<Object>} - Probe result
   */
  async probeServer(serverConfig) {
    const url = serverConfig.urls || serverConfig.url;
    if (!url) {
      return { success: false, latency: null, error: 'invalid URL' };
    }

    // Parse the URL
    const parsed = this.parseStunUrl(url);
    if (!parsed) {
      return { success: false, latency: null, error: 'URL parsing failed', url };
    }

    const { host, port, name } = parsed;
    
    // Perform multiple probes and take the average
    const latencies = [];
    let errors = 0;

    for (let i = 0; i < this.maxProbes; i++) {
      try {
        const latency = await this.sendStunRequest(host, port);
        if (latency !== null) {
          latencies.push(latency);
        } else {
          errors++;
        }
      } catch (e) {
        errors++;
      }
    }

    if (latencies.length === 0) {
      return {
        success: false,
        latency: null,
        url,
        host,
        port,
        name,
        error: 'all probes failed'
      };
    }

    // Calculate average latency
    const avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    const minLatency = Math.min(...latencies);

    return {
      success: true,
      latency: avgLatency,
      minLatency,
      url,
      host,
      port,
      name,
      probeCount: latencies.length,
      errorCount: errors
    };
  }

  /**
   * Parse a STUN URL
   * @param {string} url - STUN URL
   * @returns {Object|null} - Parse result
   */
  parseStunUrl(url) {
    try {
      // Supported formats: stun:host:port, stuns:host:port
      const match = url.match(/^stuns?:([^:]+):(\d+)$/);
      if (!match) {
        return null;
      }

      const host = match[1];
      const port = parseInt(match[2], 10);
      
      // Identify the server name based on the host
      const name = this.getServerName(host);

      return { host, port, name };
    } catch (e) {
      return null;
    }
  }

  /**
   * Get a friendly server name
   * @param {string} host - Hostname
   * @returns {string} - Server name
   */
  getServerName(host) {
    const nameMap = {
      'stun.miwifi.com': 'Xiaomi',
      'global.stun.twilio.com': 'Twilio',
      'stun.l.google.com': 'Google',
      'stun1.l.google.com': 'Google-1',
      'stun2.l.google.com': 'Google-2',
      'stun3.l.google.com': 'Google-3',
      'stun4.l.google.com': 'Google-4',
      'stun.relay.metered.ca': 'Metered',
      'stun.cloudflare.com': 'Cloudflare',
      'stun.voipstunt.com': 'VoIPStunt'
    };

    return nameMap[host] || host;
  }

  /**
   * Send a STUN Binding Request
   * @param {string} host - STUN server host
   * @param {number} port - STUN server port
   * @returns {Promise<number|null>} - Latency in ms or null
   */
  sendStunRequest(host, port) {
    return new Promise((resolve) => {
      // Probe using WebRTC's RTCPeerConnection
      // Create a temporary PC to collect candidates
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: `stun:${host}:${port}` }],
        iceCandidatePoolSize: 1
      });

      const startTime = Date.now();
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          pc.close();
          resolve(null);
        }
      }, this.probeTimeout);

      pc.onicecandidate = (event) => {
        if (event.candidate && !resolved) {
          const latency = Date.now() - startTime;
          clearTimeout(timeout);
          resolved = true;
          pc.close();
          resolve(latency);
        }
      };

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete' && !resolved) {
          clearTimeout(timeout);
          resolved = true;
          pc.close();
          resolve(null);
        }
      };

      // Trigger ICE collection
      pc.createDataChannel('probe');
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
      }).catch(() => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          pc.close();
          resolve(null);
        }
      });
    });
  }

  /**
   * Get optimized ICE server configuration
   * @param {Array} originalServers - Original server list
   * @param {number} topN - Select the top N best servers
   * @returns {Promise<Array>} - Optimized configuration
   */
  async getOptimizedIceServers(originalServers, topN = 3) {
    const { results } = await this.probeAllServers(originalServers);
    
    if (results.length === 0) {
      this.logger?.warn('[StunProbe] no available STUN servers, use original config');
      return originalServers;
    }

    // Select the top N best servers
    const topServers = results.slice(0, topN);
    
    // Convert to RTCPeerConnection configuration format
    const optimizedServers = topServers.map(r => ({
      urls: r.url
    }));

    this.logger?.info(`[StunProbe] optimized ICE server config (${optimizedServers.length} ):`);
    topServers.forEach((r, i) => {
      this.logger?.info(`  ${i + 1}. ${r.name} - ${r.latency}ms`);
    });

    return optimizedServers;
  }

  /**
   * Quick probe - probe only once for a quick network status check
   * @param {Array} stunServers - STUN server list
   * @returns {Promise<Object>} - The fastest available server
   */
  async quickProbe(stunServers) {
    const originalMaxProbes = this.maxProbes;
    this.maxProbes = 1; // Probe only once
    
    const result = await this.probeAllServers(stunServers);
    
    this.maxProbes = originalMaxProbes;
    return result;
  }
}

export default StunProbe;
