/**
 * Copy a generated file to the project's configured asset save folder.
 * Returns the new path + URL if successful, or the originals as fallback.
 */
export async function copyToAssetFolder(
  origPath: string,
  origUrl: string,
  assetSavePath: string | undefined | null,
): Promise<{ path: string; url: string }> {
  if (!assetSavePath || !window.electronAPI) return { path: origPath, url: origUrl }
  try {
    await window.electronAPI.ensureDirectory(assetSavePath)
    const sep = origPath.includes('\\') ? '\\' : '/'
    const fileName = origPath.split(sep).pop() || origPath.split('/').pop() || 'asset'
    const destPath = `${assetSavePath}${sep}${fileName}`
    const result = await window.electronAPI.copyFile(origPath, destPath)
    if (result.success) {
      const normalized = destPath.replace(/\\/g, '/')
      const fileUrl = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
      return { path: destPath, url: fileUrl }
    }
  } catch (e) {
    console.warn('Failed to copy asset to project folder:', e)
  }
  return { path: origPath, url: origUrl }
}
