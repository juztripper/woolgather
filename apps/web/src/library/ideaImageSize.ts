export const imagePreviewBounds = { width: 320, height: 280 };

/** Choose a reading-sized preview without altering the original image bytes. */
export async function initialImageWidth(file: File, availableWidth: number) {
  const widthLimit = Math.min(imagePreviewBounds.width, availableWidth);
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    return Math.max(
      32,
      Math.floor(
        Math.min(
          image.naturalWidth,
          widthLimit,
          (imagePreviewBounds.height * image.naturalWidth) /
            image.naturalHeight,
        ),
      ),
    );
  } catch {
    // A readable attachment may still lack a browser-decodable preview.
    return Math.max(32, Math.floor(widthLimit));
  } finally {
    URL.revokeObjectURL(source);
  }
}
