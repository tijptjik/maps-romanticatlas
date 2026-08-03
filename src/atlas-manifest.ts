import { DurableObject } from 'cloudflare:workers'
import { atlasSceneGridRadius, readableCacheVersions, type ContentBounds } from './atlas-protocol.ts'

const manifestShardSize = 16

export type { ContentBounds } from './atlas-protocol.ts'

export type AtlasManifestEntry = {
  zoom: number
  x: number
  y: number
  scene: string
  version: number
  contentType: string
  contentBounds: ContentBounds
}

export type AtlasManifestPosition = Pick<AtlasManifestEntry, 'zoom' | 'x' | 'y'>

const shardCoordinates = ({ x, y }: AtlasManifestPosition) => ({
  x: Math.floor(x / manifestShardSize),
  y: Math.floor(y / manifestShardSize),
})

export const manifestShardName = (position: AtlasManifestPosition) => {
  const shard = shardCoordinates(position)
  return `${position.zoom}/${shard.x}/${shard.y}`
}

export const manifestShardNamesForGrid = (position: AtlasManifestPosition) => {
  const names = new Set<string>()
  for (
    let y = position.y - atlasSceneGridRadius;
    y <= position.y + atlasSceneGridRadius;
    y += 1
  ) {
    if (y < 0) continue
    for (
      let x = position.x - atlasSceneGridRadius;
      x <= position.x + atlasSceneGridRadius;
      x += 1
    ) {
      const tileCount = 2 ** position.zoom
      const wrappedX = (x + tileCount) % tileCount
      if (y >= tileCount) continue
      names.add(manifestShardName({ zoom: position.zoom, x: wrappedX, y }))
    }
  }
  return [...names]
}

export class AtlasManifest extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS atlas_manifest (
          zoom INTEGER NOT NULL,
          x INTEGER NOT NULL,
          y INTEGER NOT NULL,
          scene TEXT NOT NULL,
          version INTEGER NOT NULL,
          content_type TEXT NOT NULL,
          content_bounds TEXT,
          PRIMARY KEY (zoom, x, y, scene, version)
        );
        CREATE INDEX IF NOT EXISTS atlas_manifest_grid
          ON atlas_manifest (zoom, x, y, version);
      `)
    })
  }

  upsert(entries: AtlasManifestEntry[]) {
    for (const entry of entries) {
      this.ctx.storage.sql.exec(
        `INSERT INTO atlas_manifest
          (zoom, x, y, scene, version, content_type, content_bounds)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(zoom, x, y, scene, version) DO UPDATE SET
           content_type = excluded.content_type,
           content_bounds = excluded.content_bounds`,
        entry.zoom,
        entry.x,
        entry.y,
        entry.scene,
        entry.version,
        entry.contentType,
        entry.contentBounds ? JSON.stringify(entry.contentBounds) : null,
      )
    }
  }

  remove(entry: Pick<AtlasManifestEntry, 'zoom' | 'x' | 'y' | 'scene' | 'version'>) {
    this.ctx.storage.sql.exec(
      'DELETE FROM atlas_manifest WHERE zoom = ? AND x = ? AND y = ? AND scene = ? AND version = ?',
      entry.zoom,
      entry.x,
      entry.y,
      entry.scene,
      entry.version,
    )
  }

  entriesForPosition(position: AtlasManifestPosition): AtlasManifestEntry[] {
    return this.ctx.storage.sql
      .exec<{
        zoom: number
        x: number
        y: number
        scene: string
        version: number
        content_type: string
        content_bounds: string | null
      }>(
        `SELECT zoom, x, y, scene, version, content_type, content_bounds
       FROM atlas_manifest
       WHERE zoom = ? AND x = ? AND y = ?
         AND version IN (${readableCacheVersions.map(() => '?').join(', ')})`,
        position.zoom,
        position.x,
        position.y,
        ...readableCacheVersions,
      )
      .toArray()
      .map(entry => ({
        zoom: entry.zoom,
        x: entry.x,
        y: entry.y,
        scene: entry.scene,
        version: entry.version,
        contentType: entry.content_type,
        contentBounds: entry.content_bounds
          ? (JSON.parse(entry.content_bounds) as ContentBounds)
          : null,
      }))
  }

  scenesInGrid(position: AtlasManifestPosition): string[] {
    const tileCount = 2 ** position.zoom
    const xValues = Array.from(
      { length: atlasSceneGridRadius * 2 + 1 },
      (_, offset) =>
        (position.x - atlasSceneGridRadius + offset + tileCount) % tileCount,
    )
    const minimumY = Math.max(0, position.y - atlasSceneGridRadius)
    const maximumY = Math.min(tileCount - 1, position.y + atlasSceneGridRadius)
    return this.ctx.storage.sql
      .exec<{ scene: string }>(
        `SELECT DISTINCT scene FROM atlas_manifest
       WHERE zoom = ? AND x IN (${xValues.map(() => '?').join(', ')})
         AND y BETWEEN ? AND ?
         AND version IN (${readableCacheVersions.map(() => '?').join(', ')})`,
        position.zoom,
        ...xValues,
        minimumY,
        maximumY,
        ...readableCacheVersions,
      )
      .toArray()
      .map(entry => entry.scene)
  }
}
