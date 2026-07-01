/**
 * Hash Worker
 * Responsibility: Handle file hash calculation in a background thread
 * - Small files (≤6MB): full hash
 * - Large files (>6MB): sampled hash (3MB from head and tail)
 */

// Import SparkMD5 library
importScripts('../spark-md5.min.js');

const SAMPLE_SIZE = 3 * 1024 * 1024; // 3MB sample size
const FULL_HASH_THRESHOLD = 6 * 1024 * 1024; // 6MB threshold
const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunked reading

/**
 * Calculate full hash (for small files)
 * @param {File} file - File object
 * @returns {Promise<string>} File hash value
 */
async function calculateFullHash(file) {
  return new Promise((resolve, reject) => {
    const spark = new SparkMD5.ArrayBuffer();
    let currentChunk = 0;
    const chunks = Math.ceil(file.size / CHUNK_SIZE);

    const reader = new FileReader();

    reader.onload = (e) => {
      spark.append(e.target.result);
      currentChunk++;

      if (currentChunk < chunks) {
        loadNext();
      } else {
        const hash = spark.end();
        resolve(hash);
      }
    };

    reader.onerror = (error) => {
      reject(error);
    };

    const loadNext = () => {
      const start = currentChunk * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const slice = file.slice(start, end);
      reader.readAsArrayBuffer(slice);
    };

    loadNext();
  });
}

/**
 * Calculate sampled hash (for large files, sample specified size from head and tail)
 * @param {File} file - File object
 * @returns {Promise<string>} File hash value
 */
async function calculateSampleHash(file) {
  return new Promise((resolve, reject) => {
    const spark = new SparkMD5.ArrayBuffer();
    const reader = new FileReader();

    // Define sampling regions: head and tail
    const regions = [
      { start: 0, end: Math.min(SAMPLE_SIZE, file.size) }, // Header
      { start: Math.max(file.size - SAMPLE_SIZE, SAMPLE_SIZE), end: file.size } // Tail
    ].filter(r => r.start < r.end); // Ensure region is valid

    let currentRegionIndex = 0;
    let currentChunkInRegion = 0;

    const loadNext = () => {
      // Current region finished, switch to next region
      if (currentRegionIndex >= regions.length) {
        const hash = spark.end();
        resolve(hash);
        return;
      }

      const region = regions[currentRegionIndex];
      const regionSize = region.end - region.start;
      const chunksInRegion = Math.ceil(regionSize / CHUNK_SIZE);

      // All chunks in current region processed
      if (currentChunkInRegion >= chunksInRegion) {
        currentRegionIndex++;
        currentChunkInRegion = 0;
        loadNext();
        return;
      }

      // Calculate actual position of current chunk
      const start = region.start + currentChunkInRegion * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, region.end);
      const slice = file.slice(start, end);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = (e) => {
      spark.append(e.target.result);
      currentChunkInRegion++;
      loadNext();
    };

    reader.onerror = (error) => {
      reject(error);
    };

    loadNext();
  });
}

/**
 * Calculate file hash
 * @param {File} file - File to calculate hash for
 * @returns {Promise<string|null>} File hash value, or null on failure
 */
async function calculateFileHash(file) {
  // Small file: use full hash
  if (file.size <= FULL_HASH_THRESHOLD) {
    return await calculateFullHash(file);
  }

  // Large file: use sampled hash (3MB from head and tail)
  return await calculateSampleHash(file);
}

// Task queue management
const taskQueue = new Map();
let taskIdCounter = 0;

// Message processing
self.onmessage = async function(e) {
  const { type, taskId, params } = e.data;

  try {
    let result;

    switch (type) {
      case 'calculateFileHash':
        result = await calculateFileHash(params.file);
        break;
      default:
        throw new Error(`Unknown operation type: ${type}`);
    }

    // Return result
    self.postMessage({
      type: 'result',
      taskId: taskId,
      success: true,
      result: result
    });
  } catch (error) {
    // Return error
    self.postMessage({
      type: 'result',
      taskId: taskId,
      success: false,
      error: error.message
    });
  }
};

// Worker initialization log
console.log('[Hash Worker] Initialized and ready');
