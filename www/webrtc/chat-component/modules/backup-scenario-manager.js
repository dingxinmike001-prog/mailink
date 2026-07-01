/**
 * Backup Scenario Manager
 * Pre-generate multiple Answer variants to accelerate Offer-Answer exchange
 * 
 * Core features:
 * 1. Pre-generate 3-4 Answer variants during the Discover phase
 * 2. Quickly apply the best matching Scenario after receiving an Offer
 * 3. Manage lifecycle and resource cleanup of pre-generated scenarios
 */

export class BackupScenarioManager {
  constructor(logger, config) {
    this.logger = logger;
    
    // Defensive check: ensure config is always a valid object
    if (!config) {
      this.logger.warn('⚠️ [BackupScenario] config Missing parameter, usedefaultvalue');
      config = { config: { iceServers: [] } };
    }
    
    // Check if config.config exists
    if (!config.config) {
      this.logger.warn('⚠️ [BackupScenario] config.config not definition, usedefault RTCPeerConnection configuration');
      config.config = { iceServers: [] };
    }
    
    this.config = config;
    
    // 🎯 Optimized ICE server config (passed from outside)
    this.optimizedIceConfig = null;
    
    // Store pre-generated scenarios: Map<targetEmail, ScenarioSet>
    this.scenarios = new Map();
    
    // TTL config (ms): pre-generated scenarios live up to 5 minutes
    this.SCENARIO_TTL = 5 * 60 * 1000;
    
    // Max concurrent pre-generation count (to avoid excessive resource use)
    this.MAX_CONCURRENT_SCENARIOS = 8;
    
    // Track targets currently being pre-generated
    this.generatingTargets = new Set();
    
    this.log('✅ BackupScenarioManager initializecompleted');
  }

  /**
   * 🎯 Set optimized ICE config
   * @param {Object} optimizedConfig - Optimized RTCPeerConnection config
   */
  setOptimizedIceConfig(optimizedConfig) {
    if (optimizedConfig && optimizedConfig.iceServers) {
      this.optimizedIceConfig = optimizedConfig;
      this.log(`[BackupScenario] set optimized ICE config (${optimizedConfig.iceServers.length}  servers)`);
    }
  }

  /**
   * 🎯 Get current ICE config
   * @returns {Object} - RTCPeerConnection config
   */
  _getIceConfig() {
    // Prefer optimized config
    if (this.optimizedIceConfig) {
      return this.optimizedIceConfig;
    }
    // Fall back to original config
    return this.config.config;
  }

  /**
   * Pre-generate Answer scenarios for a specific contact
   * @param {string} targetEmail - Target email
   * @returns {Promise<ScenarioSet>} Pre-generated scenarios
   */
  async generateBackupScenariosFor(targetEmail) {
    // Check if scenario already exists or is being generated
    if (this.scenarios.has(targetEmail)) {
      this.log(`ℹ️ [BackupScenario] ${targetEmail} pre-generated scenarios already exist, skip`);
      return this.scenarios.get(targetEmail);
    }

    if (this.generatingTargets.has(targetEmail)) {
      this.log(`⏳ [BackupScenario] ${targetEmail} pre-generating, wait...`);
      
      // Wait for pre-generation to complete (max 10 seconds)
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.scenarios.has(targetEmail)) {
            clearInterval(checkInterval);
            resolve(this.scenarios.get(targetEmail));
          }
        }, 100);
        
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve(null);  // Return null on timeout
        }, 10000);
      });
    }

    // Check concurrent count
    if (this.generatingTargets.size >= this.MAX_CONCURRENT_SCENARIOS) {
      this.log(`⚠️ [BackupScenario] concurrent pre-generation limit reached(${this.MAX_CONCURRENT_SCENARIOS}), wait...`);
      
      // Wait for an available slot
      return new Promise((resolve) => {
        const checkInterval = setInterval(async () => {
          if (this.generatingTargets.size < this.MAX_CONCURRENT_SCENARIOS) {
            clearInterval(checkInterval);
            const result = await this.generateBackupScenariosFor(targetEmail);
            resolve(result);
          }
        }, 500);
      });
    }

    // Start pre-generation
    this.generatingTargets.add(targetEmail);
    this.log(`🔨 [BackupScenario] start generating for ${targetEmail} pre-generate scenarios...`);

    try {
      const startTime = Date.now();
      
      // Pre-generate 4 scenarios
      const scenarioSet = new ScenarioSet(targetEmail, this.logger);
      
      // Generate all scenarios in parallel (saves time)
      const results = await Promise.allSettled([
        this._generatePrimaryScenario(scenarioSet),
        this._generateLowNetworkScenario(scenarioSet),
        this._generateRelayScenario(scenarioSet),
        this._generateIPv6Scenario(scenarioSet)
      ]);
      
      // Check pre-generation results
      let successCount = 0;
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          successCount++;
          this.log(`  ✓ Scenario ${index + 1} pre-generatesucceeded`);
        } else {
          this.log(`  ✗ Scenario ${index + 1} pre-generation failed: ${result.reason?.message || 'not knowerror'}`);
        }
      });

      const duration = Date.now() - startTime;
      
      if (successCount === 0) {
        this.log(`❌ [BackupScenario] ${targetEmail} all pre-generation failed, time taken${duration}ms`);
        this.generatingTargets.delete(targetEmail);
        return null;
      }

      // Save to Map
      this.scenarios.set(targetEmail, scenarioSet);
      
      // Set TTL auto cleanup
      this._setScenarioTTL(targetEmail);
      
      this.log(`✅ [BackupScenario] ${targetEmail} pre-generation completed (succeeded${successCount}/4, time taken${duration}ms)`);
      
      return scenarioSet;
    } catch (error) {
      this.log(`❌ [BackupScenario] pre-generate ${targetEmail} error: ${error.message}`);
      return null;
    } finally {
      this.generatingTargets.delete(targetEmail);
    }
  }

  /**
   * Pre-generate primary scenario (standard config)
   * Optimization: no longer pre-collect ICE candidates; collect in real time after receiving the real Offer
   */
  async _generatePrimaryScenario(scenarioSet) {
    const config = { ...this._getIceConfig(), iceCandidatePoolSize: 10 };
    const pc = new RTCPeerConnection(config);
    
    // Create DataChannel
    pc.createDataChannel('data');
    
    // Pre-generate Answer template
    // Note: we don't set remote description yet; set it when Offer is received
    // This ensures Answer SDP matches the Offer
    
    // Optimization: no longer create dummyOffer or pre-gather ICE candidates
    // ICE candidates will be collected in real time after receiving the real Offer for better quality
    
    scenarioSet.setPrimary({
      pc,
      candidates: [],  // empty array, usetimereal-timecollect
      metadata: {
        generatedAt: Date.now(),
        configuration: config,
        type: 'primary'
      }
    });
  }

  /**
   * Pre-generate low network quality scenario
   * Optimization: no longer pre-collect ICE candidates; collect in real time after receiving the real Offer
   */
  async _generateLowNetworkScenario(scenarioSet) {
    const config = {
      ...this._getIceConfig(),
      bundlePolicy: 'max-bundle',  // usesingle networkconnection
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 5       // Reduce candidate count
    };
    
    const pc = new RTCPeerConnection(config);
    pc.createDataChannel('data');
    
    // Optimization: no longer create dummyOffer or pre-gather ICE candidates
    
    scenarioSet.setLowNetwork({
      pc,
      candidates: [],  // empty array, usetimereal-timecollect
      metadata: {
        generatedAt: Date.now(),
        configuration: config,
        type: 'low-network',
        optimization: 'prefer_host_over_srflx'
      }
    });
  }

  /**
   * Pre-generate Relay-required scenario
   * Optimization: no longer pre-collect ICE candidates; collect in real time after receiving the real Offer
   */
  async _generateRelayScenario(scenarioSet) {
    const config = {
      ...this._getIceConfig(),
      iceTransportPolicy: 'relay',   // forceuseRelay
      bundlePolicy: 'balanced',
      iceCandidatePoolSize: 15
    };
    
    const pc = new RTCPeerConnection(config);
    pc.createDataChannel('data');
    
    // Optimization: no longer create dummyOffer or pre-gather ICE candidates
    
    scenarioSet.setRelay({
      pc,
      candidates: [],  // empty array, usetimereal-timecollect
      metadata: {
        generatedAt: Date.now(),
        configuration: config,
        type: 'relay',
        optimization: 'include_relay'
      }
    });
  }

  /**
   * Pre-generate IPv6 scenario
   * 
   * Config notes:
   * 1. Inherit base IPv4 STUN servers
   * 2. Add IPv6-specific STUN servers (from config.ipv6StunServers)
   * 3. Prefer IPv6 by collecting IPv4/IPv6 candidates in parallel
   * 
   * Optimization: no longer pre-collect ICE candidates; collect in real time after receiving the real Offer
   */
  async _generateIPv6Scenario(scenarioSet) {
    // Merge IPv4 and IPv6 STUN servers
    const ipv6StunServers = this.config.ipv6StunServers || [
      { urls: 'stun:[2001:4860:4860::8888]:3478' }  // Fallback config
    ];
    
    const baseConfig = this._getIceConfig();
    const config = {
      ...baseConfig,
      iceServers: [
        ...(baseConfig.iceServers || []),
        ...ipv6StunServers  // Read IPv6 config from config
      ],
      iceCandidatePoolSize: 10
    };
    
    const pc = new RTCPeerConnection(config);
    pc.createDataChannel('data');
    
    // Optimization: no longer create dummyOffer or pre-gather ICE candidates
    
    scenarioSet.setIPv6({
      pc,
      candidates: [],  // empty array, usetimereal-timecollect
      metadata: {
        generatedAt: Date.now(),
        configuration: config,
        type: 'ipv6',
        optimization: 'ipv6_first'
      }
    });
  }

  /**
   * Collect ICE candidates
   * @param {RTCPeerConnection} pc
   * @param {number} timeoutMs - Collection timeout (ms)
   * @returns {Promise<RTCIceCandidate[]>}
   */
  async _collectICECandidates(pc, timeoutMs) {
    return new Promise((resolve) => {
      const candidates = [];
      
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          candidates.push(event.candidate);
        }
      };
      
      // Set timeout
      const timeoutId = setTimeout(() => {
        this.log(`  ℹ️ ICE gatheringin ${timeoutMs}msaftertimeout, collect${candidates.length} candidates`);
        resolve(candidates);
      }, timeoutMs);
      
      // Listen for ICE collection completion
      const handleIceComplete = () => {
        clearTimeout(timeoutId);
        pc.removeEventListener('icegatheringstatechange', handleIceComplete);
        resolve(candidates);
      };
      
      pc.addEventListener('icegatheringstatechange', handleIceComplete);
    });
  }

  /**
   * Select the best pre-generated Scenario based on Offer
   * @param {RTCSessionDescription} offer - Received Offer
   * @param {string} targetEmail - Peer email
   * @returns {Scenario|null} Best matching Scenario, or null (generate in real time)
   */
  selectBestScenario(offer, targetEmail) {
    const scenarioSet = this.scenarios.get(targetEmail);
    
    if (!scenarioSet) {
      this.log(`⚠️ [BackupScenario] Not found ${targetEmail} pre-generate scenarios`);
      return null;
    }

    // Simple selection strategy: prefer primary
    const scenario = scenarioSet.primary || scenarioSet.lowNetwork || scenarioSet.relay;
    
    if (scenario) {
      this.log(`✓ [BackupScenario]  as  ${targetEmail} select in progress ${scenario.metadata.type} scenario`);
      return scenario;
    }

    this.log(`❌ [BackupScenario] ${targetEmail} no availablescenario`);
    return null;
  }

  /**
   * Set Scenario TTL for auto cleanup
   */
  _setScenarioTTL(targetEmail) {
    setTimeout(() => {
      if (this.scenarios.has(targetEmail)) {
        this.log(`🗑️ [BackupScenario] ${targetEmail} Expired(TTL=${this.SCENARIO_TTL}ms), proceedclean`);
        this.cleanupScenariosFor(targetEmail);
      }
    }, this.SCENARIO_TTL);
  }

  /**
   * Clean up scenarios for a specific contact
   * @param {string} targetEmail - Target email
   */
  cleanupScenariosFor(targetEmail) {
    const scenarioSet = this.scenarios.get(targetEmail);
    
    if (!scenarioSet) {
      return;
    }

    this.log(`🧹 [BackupScenario] clean ${targetEmail} scenarios...`);
    
    // Close all PC connections
    [scenarioSet.primary, scenarioSet.lowNetwork, scenarioSet.relay, scenarioSet.ipv6]
      .filter(s => s && s.pc)
      .forEach(scenario => {
        try {
          scenario.pc.close();
        } catch (e) {
          this.log(`  ⚠️ closePCfailed: ${e.message}`);
        }
      });
    
    // Remove from Map
    this.scenarios.delete(targetEmail);
    this.log(`✅ [BackupScenario] ${targetEmail} scenariosclean`);
  }

  /**
   * Clean up all scenarios (called on app unload or background)
   */
  cleanupAllScenarios() {
    this.log(`🧹 [BackupScenario] cleanallscenarios...`);
    
    for (const targetEmail of this.scenarios.keys()) {
      this.cleanupScenariosFor(targetEmail);
    }
    
    this.generatingTargets.clear();
    this.log(`✅ [BackupScenario] allscenariosclean`);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      totalScenarioSets: this.scenarios.size,
      generatingCount: this.generatingTargets.size,
      scenarios: Array.from(this.scenarios.entries()).map(([email, set]) => ({
        email,
        hasBackups: {
          primary: !!set.primary,
          lowNetwork: !!set.lowNetwork,
          relay: !!set.relay,
          ipv6: !!set.ipv6
        },
        createdAt: set.createdAt
      }))
    };
  }

  log(message) {
    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info(message);
    } else {
      console.log(message);
    }
  }
}

/**
 * Scenario Set - Store multiple Answer variants for a single contact
 */
class ScenarioSet {
  constructor(targetEmail, logger) {
    this.targetEmail = targetEmail;
    this.logger = logger;
    this.createdAt = Date.now();
    
    this.primary = null;
    this.lowNetwork = null;
    this.relay = null;
    this.ipv6 = null;
  }

  setPrimary(scenario) { this.primary = scenario; }
  setLowNetwork(scenario) { this.lowNetwork = scenario; }
  setRelay(scenario) { this.relay = scenario; }
  setIPv6(scenario) { this.ipv6 = scenario; }

  /**
   * Get all available scenarios
   */
  getAllScenarios() {
    return [this.primary, this.lowNetwork, this.relay, this.ipv6]
      .filter(s => s !== null);
  }

  /**
   * Check whether all pre-generation is complete
   */
  isComplete() {
    return this.primary && this.lowNetwork && this.relay && this.ipv6;
  }

  /**
   * Get available scenario count
   */
  getAvailableCount() {
    return this.getAllScenarios().length;
  }
}

/**
 * Answer Generator Helper - For quickly generating Answers
 */
export class AnswerGenerator {
  constructor(scenario, logger) {
    this.scenario = scenario;
    this.logger = logger;
  }

  /**
   * Generate Answer using pre-generated scenario
   * Optimization: no longer use pre-collected candidates; collect ICE candidates in real time after setting localDescription
   */
  async generateQuickAnswer(offer) {
    if (!this.scenario || !this.scenario.pc) {
      this.logger?.info('❌ [AnswerGenerator] no availablescenario');
      return null;
    }

    try {
      const pc = this.scenario.pc;
      
      // Set remote Offer
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: 'offer',
        sdp: offer.sdp
      }));

      // Generate Answer
      const answer = await pc.createAnswer();
      
      // Set local Answer
      await pc.setLocalDescription(answer);

      // Optimization: collect ICE candidates in real time (wait up to 1.5s)
      const candidates = await this._collectICECandidates(pc, 1500);
      
      this.logger?.info(`[AnswerGenerator] real-timecollectto  ${candidates.length} ICE candidate`);

      // Return Answer and real-time collected candidates
      return {
        sdp: answer.sdp,
        candidates: candidates,  // real-timecollectcandidate
        isQuick: true,
        scenario: this.scenario.metadata
      };
    } catch (error) {
      this.logger?.info(`❌ [AnswerGenerator] generateAnswerfailed: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Collect ICE candidates in real time
   * @param {RTCPeerConnection} pc
   * @param {number} timeoutMs - Collection timeout
   * @returns {Promise<RTCIceCandidate[]>}
   */
  async _collectICECandidates(pc, timeoutMs) {
    return new Promise((resolve) => {
      const candidates = [];
      
      const originalHandler = pc.onicecandidate;
      pc.onicecandidate = (event) => {
        if (originalHandler) originalHandler(event);
        if (event.candidate) {
          candidates.push(event.candidate);
        }
      };
      
      // Set timeout
      const timeoutId = setTimeout(() => {
        pc.onicecandidate = originalHandler;  // Restore original handler
        resolve(candidates);
      }, timeoutMs);
      
      // Listen for ICE collection completion
      const handleIceComplete = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timeoutId);
          pc.removeEventListener('icegatheringstatechange', handleIceComplete);
          pc.onicecandidate = originalHandler;  // Restore original handler
          resolve(candidates);
        }
      };
      
      pc.addEventListener('icegatheringstatechange', handleIceComplete);
      
      // Return immediately if already complete
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeoutId);
        pc.removeEventListener('icegatheringstatechange', handleIceComplete);
        pc.onicecandidate = originalHandler;
        resolve(candidates);
      }
    });
  }
}
