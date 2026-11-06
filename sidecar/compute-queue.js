// GPU Compute Semaphore / Priority Queue
// Limits active inference compute to N agents at a time.

const activeComputeLocks = new Set();
const computeQueue = [];
let MAX_CONCURRENT_COMPUTE = 1; // Default to 1 for typical local GPU setup

function setMaxConcurrentCompute(n) {
  MAX_CONCURRENT_COMPUTE = n;
}

function releaseNext() {
  if (computeQueue.length > 0 && activeComputeLocks.size < MAX_CONCURRENT_COMPUTE) {
    const next = computeQueue.shift();
    activeComputeLocks.add(next.id);
    next.resolve();
  }
}

async function acquireCompute(id) {
  if (activeComputeLocks.size < MAX_CONCURRENT_COMPUTE) {
    activeComputeLocks.add(id);
    return;
  }
  return new Promise(resolve => {
    computeQueue.push({ id, resolve });
  });
}

function releaseCompute(id) {
  activeComputeLocks.delete(id);
  releaseNext();
}

module.exports = {
  setMaxConcurrentCompute,
  acquireCompute,
  releaseCompute
};
