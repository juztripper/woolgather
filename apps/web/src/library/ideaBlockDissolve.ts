// Partition the original visual into scattered patches. Masks stay static;
// only a few layers move/fade, without rasterising or changing editor content.
export function blockDissolveMasks(
  width: number,
  height: number,
  count: number,
) {
  const paths = Array.from({ length: count }, () => "");
  const size = Math.max(4, Math.ceil(Math.sqrt((width * height) / 6000)));
  for (let y = 0, row = 0; y < height; y += size, row++) {
    for (let x = 0, col = 0; x < width; x += size, col++) {
      // Deterministic scatter avoids visible stripes and changes on replay.
      const hash =
        Math.imul(col + 1, 374761393) ^ Math.imul(row + 1, 668265263);
      const layer = ((hash ^ (hash >>> 13)) >>> 0) % count;
      paths[layer] += `M${x} ${y}h${size}v${size}h-${size}z`;
    }
  }
  return paths.map((path) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path fill="white" d="${path}"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  });
}
