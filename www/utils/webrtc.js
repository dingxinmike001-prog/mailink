import { getUtilsRoot } from './root.js';
import {
  resolveRole as commonResolveRole,
  isPolite as commonIsPolite
} from './common.js';

function getWebrtcRoot() {
  return getUtilsRoot()?.webrtc;
}

export function getOptimalIceCandidatePoolSize(...args) {
  const api = getWebrtcRoot();
  const impl = api?.getOptimalIceCandidatePoolSize;
  if (typeof impl === 'function') return impl.call(api, ...args);
  return 10;
}

export function getIceCandidatePriority(candidate) {
  const api = getWebrtcRoot();
  const impl = api?.getIceCandidatePriority;
  if (typeof impl === 'function') return impl.call(api, candidate);

  let priority = 0;
  const candidateStr = candidate?.candidate;
  if (typeof candidateStr === 'string') {
    if (candidateStr.includes('typ host')) {
      priority = 100;
    } else if (candidateStr.includes('typ srflx')) {
      priority = 200;
    } else if (candidateStr.includes('typ relay')) {
      priority = 50;
    } else if (candidateStr.includes('typ prflx')) {
      priority = 25;
    }

    if (candidateStr.includes('udp')) {
      priority += 10;
    }

    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (connection && connection.effectiveType) {
      const type = connection.effectiveType;
      if (type === '5g' || type === '4g') priority += 5;
      if (type === '2g') priority -= 5;
    }
  }
  return priority;
}

export function deduplicateIceCandidates(candidates) {
  const api = getWebrtcRoot();
  const impl = api?.deduplicateIceCandidates;
  if (typeof impl === 'function') return impl.call(api, candidates);

  const seen = new Set();
  const uniqueCandidates = [];
  for (const candidate of candidates || []) {
    const candidateStr = candidate?.candidate;
    if (typeof candidateStr !== 'string') continue;
    if (seen.has(candidateStr)) continue;
    seen.add(candidateStr);
    uniqueCandidates.push(candidate);
  }
  return uniqueCandidates;
}

export async function filterHighPriorityIceCandidates(candidates) {
  const api = getWebrtcRoot();
  const impl = api?.filterHighPriorityIceCandidates;
  if (typeof impl === 'function') return impl.call(api, candidates);

  const priorityImpl = api?.getIceCandidatePriority;
  const getPriority = typeof priorityImpl === 'function' 
    ? (c) => priorityImpl.call(api, c)
    : getIceCandidatePriority;

  if (!candidates || candidates.length === 0) return [];
  const uniqueCandidates = deduplicateIceCandidates(candidates);
  const sortedCandidates = uniqueCandidates.sort((a, b) => getPriority(b) - getPriority(a));

  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  let maxCandidates = 15;
  if (connection) {
    if (connection.effectiveType === '2g' || connection.downlink < 1) {
      maxCandidates = 8;
    } else if (connection.effectiveType === '3g' || connection.downlink < 5) {
      maxCandidates = 12;
    }
  }
  return sortedCandidates.slice(0, maxCandidates);
}

export function resolveRole(myEmail, targetEmail) {
  const api = getWebrtcRoot();
  const impl = api?.resolveRole;
  if (typeof impl === 'function') return impl.call(api, myEmail, targetEmail);
  // Use unified implementation from common.js
  return commonResolveRole(myEmail, targetEmail);
}

export function isPolite(myEmail, targetEmail) {
  const api = getWebrtcRoot();
  const impl = api?.isPolite;
  if (typeof impl === 'function') return impl.call(api, myEmail, targetEmail);
  // Use unified implementation from common.js
  return commonIsPolite(myEmail, targetEmail);
}

export async function addIceCandidates(pc, candidates) {
  const api = getWebrtcRoot();
  const impl = api?.addIceCandidates;
  if (typeof impl === 'function') return impl.call(api, pc, candidates);

  if (!candidates || !Array.isArray(candidates) || candidates.length === 0) return;
  const filteredCandidates = await filterHighPriorityIceCandidates(candidates);
  await Promise.allSettled(filteredCandidates.map(candidate => pc.addIceCandidate(new RTCIceCandidate(candidate))));
}
