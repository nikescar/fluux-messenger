import { parse as parseToml } from 'smol-toml'

/**
 * Webxdc manifest metadata from manifest.toml
 */
export interface WebxdcManifest {
  name: string
  icon?: string
  min_api?: number
  source_code_url?: string
}

/**
 * Parse webxdc manifest.toml file.
 *
 * Returns defaults for missing/malformed manifests (manifest is optional
 * per webxdc spec). Uses filename as fallback app name.
 *
 * @param tomlContent - Raw TOML file content
 * @param filename - Original .xdc filename (fallback for app name)
 * @returns Parsed manifest with defaults
 */
export function parseManifest(tomlContent: string, filename: string): WebxdcManifest {
  try {
    const parsed = parseToml(tomlContent) as Partial<WebxdcManifest>
    return {
      name: parsed.name || filename,
      icon: parsed.icon,
      min_api: parsed.min_api,
      source_code_url: parsed.source_code_url
    }
  } catch (error) {
    console.warn('[webxdc] Failed to parse manifest.toml, using defaults:', error)
    return {
      name: filename
    }
  }
}
