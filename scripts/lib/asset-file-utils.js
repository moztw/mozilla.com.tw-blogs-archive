import { stat, writeFile } from 'node:fs/promises';

export async function writeAssetFile(filePath, buffer) {
  const incomingSize = Buffer.byteLength(buffer);
  try {
    const existing = await stat(filePath);
    if (existing.isFile() && existing.size >= incomingSize) {
      return { written: false, keptExisting: true, existingSize: existing.size, incomingSize };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await writeFile(filePath, buffer);
  return { written: true, keptExisting: false, incomingSize };
}
