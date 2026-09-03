// Shared disk-space preflight check used by every model installer
// (whisper_installer.js, mt_installer.js) before downloading a multi-hundred-
// MB file — gives a clear error up front instead of the download running to
// near-completion and failing with a bare ENOSPC.
'use strict';

const fs = require('fs');

// `dir` must already exist. 1.15x margin covers the file itself plus
// filesystem/temp overhead.
function checkDiskSpace(dir, requiredMB) {
  let stats;
  try {
    stats = fs.statfsSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return; // caller will mkdir and the download itself will surface a real fs error
    throw err;
  }
  const freeMB = (stats.bavail * stats.bsize) / (1024 * 1024);
  if (freeMB < requiredMB * 1.15) {
    throw new Error(
      `Not enough disk space: need ~${Math.ceil(requiredMB * 1.15)}MB free, only ${Math.floor(freeMB)}MB available`
    );
  }
}

module.exports = { checkDiskSpace };
