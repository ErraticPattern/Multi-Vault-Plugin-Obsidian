'use strict';

const lockfile = require('proper-lockfile');

const manifestPath = process.argv[2];
let release;

async function close() {
  if (release) {
    const ownedRelease = release;
    release = undefined;
    await ownedRelease();
  }
}

process.on('message', (message) => {
  if (message === 'release') {
    close()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  }
});

process.on('disconnect', () => {
  close().finally(() => process.exit(0));
});

lockfile.lock(manifestPath, {
  stale: 30_000,
  update: 5_000,
  realpath: false,
  retries: 0,
}).then((ownedRelease) => {
  release = ownedRelease;
  if (process.send) process.send('locked');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
