import { autoUpdater } from 'electron-updater';

export type UpdateChannel = 'latest' | 'beta' | 'alpha'

export function initAutoUpdater(
  channel: UpdateChannel = 'latest'
): void {
  if (channel !== 'latest') {
    autoUpdater.channel = channel
    autoUpdater.allowPrerelease = true
  }

  const update = () => {
    console.log('Checking for update...');
    autoUpdater.checkForUpdatesAndNotify().catch((e) => {
      console.error(`Failed checking for updates:`, e);
    });
  }

  // Check after startup, then periodically
  setTimeout(update, 5_000);
  setInterval(update, 4 * 60 * 60 * 1000);
}
