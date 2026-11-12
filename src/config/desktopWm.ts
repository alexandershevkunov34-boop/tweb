const STORAGE_KEY = 'desktop-wm';

/**
 * The window-manager layout: the left column is a strip of chat icons and every chat opens in a
 * floating window on the desktop beside it. On unless `localStorage['desktop-wm'] = '0'`.
 */
export function isDesktopWmEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch(err) {
    return true;
  }
}
