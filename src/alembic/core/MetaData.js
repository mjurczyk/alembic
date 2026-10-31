// NOTE "key=value;key=value". A repeated key keeps its first value. Reading stops at a pair with no "=" (FORMAT.md 2.3).
export const parseMetaData = (text) => {
  const metadata = Object.create(null);

  if (!text) {
    return metadata;
  }

  for (const pair of text.split(';')) {
    const assign = pair.indexOf('=');

    if (assign === -1) {
      break;
    }

    const key = pair.slice(0, assign);

    if (!(key in metadata)) {
      metadata[key] = pair.slice(assign + 1);
    }
  }

  return metadata;
};
