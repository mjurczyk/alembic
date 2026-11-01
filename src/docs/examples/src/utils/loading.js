// NOTE Shows the loading indicator while one or more keys load.
// The spinner is a CSS transform animation. It keeps moving when the main thread is busy.
const loadingElement = document.querySelector('#loading');
const loadingText = loadingElement.querySelector('.loading-text');
const defaultText = loadingText.textContent;
const loadingKeys = new Set();

export const setLoading = (key, loading) => {
  if (loading) {
    loadingKeys.add(key);
  } else {
    loadingKeys.delete(key);
  }

  if (loadingKeys.size === 0) {
    loadingText.textContent = defaultText;
  }

  loadingElement.style.display = loadingKeys.size > 0 ? '' : 'none';
};

// NOTE Download progress in MB. Without a known total, only the loaded size shows.
export const setLoadingProgress = (loaded, total) => {
  const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(1);

  loadingText.textContent =
    total > 0
      ? `Loading Alembic - ${Math.min(Math.round((loaded / total) * 100), 100)}% (${toMB(loaded)} / ${toMB(total)} MB)`
      : `Loading Alembic - ${toMB(loaded)} MB`;
};

// NOTE Reads the bytes of a URL and gives the progress to onProgress( loaded, total )
export const fetchWithProgress = async (url, onProgress) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Could not load ${url}. HTTP status ${response.status}.`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
};
