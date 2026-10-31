// NOTE Chrome rejects response.arrayBuffer() for files near 2 GiB and larger. Read the stream into one array.
// Content-Length is the compressed size for compressed responses. Then the bytes after it go to "extraChunks".
const readBody = async (response) => {
  if (!response.body) {
    return new Uint8Array();
  }

  const length = Number(response.headers.get('content-length'));
  const target = new Uint8Array(Number.isSafeInteger(length) ? length : 0);
  const extraChunks = [];
  const reader = response.body.getReader();
  let offset = 0;
  let extraLength = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (extraChunks.length === 0 && offset + value.length <= target.length) {
      target.set(value, offset);
      offset += value.length;
    } else {
      extraChunks.push(value);
      extraLength += value.length;
    }
  }

  if (extraChunks.length === 0) {
    return target.subarray(0, offset);
  }

  const bytes = new Uint8Array(offset + extraLength);
  let position = offset;

  bytes.set(target.subarray(0, offset));

  for (const chunk of extraChunks) {
    bytes.set(chunk, position);
    position += chunk.length;
  }

  return bytes;
};

export const fetchBytes = async (url) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP status ${response.status}.`);
  }

  return readBody(response);
};
