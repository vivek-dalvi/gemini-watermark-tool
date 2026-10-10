export const GWR_ORIGINAL_ASSET_REFRESH_MESSAGE = 'Unable to retrieve original image. Please refresh the page and try again.';

export function showUserNotice(targetWindow = globalThis, message = '') {
  const normalizedMessage = typeof message === 'string' ? message.trim() : '';
  if (!normalizedMessage) {
    return false;
  }

  try {
    if (typeof targetWindow?.alert === 'function') {
      targetWindow.alert(normalizedMessage);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}
