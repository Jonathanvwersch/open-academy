import { readBrowserStorage, writeBrowserStorage } from './browser-storage.js';

const APP_SHELL_HINT_KEY = 'academy.shell-hint';

export function hasAppShellHint() {
  return readBrowserStorage('localStorage', APP_SHELL_HINT_KEY) === '1';
}

export function setAppShellHint(shouldShow: boolean) {
  writeBrowserStorage('localStorage', APP_SHELL_HINT_KEY, shouldShow ? '1' : null);
}
