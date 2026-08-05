import { DurableObject } from 'cloudflare:workers'
import {
  atlasSceneGridRadius,
  defaultAtlasVariant,
  readableCacheVersions,
  type ContentBounds,
} from './atlas-protocol.ts'

const manifestShardSize = 16

export type { ContentBounds } from './atlas-protocol.ts'

export type AtlasManifestEntry = {
  zoom: number
  x: number
  y: number
  scene: string
  version: number
  variant: string
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
        CREATE TABLE IF NOT EXISTS atlas_manifest_schema_migrations (
          id INTEGER PRIMARY KEY
        );
      `)
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
      const current = this.ctx.storage.sql
        .exec<{ version: number }>(
          'SELECT COALESCE(MAX(id), 0) AS version FROM atlas_manifest_schema_migrations',
        )
        .one().version
      if (current < 1)
        this.ctx.storage.sql.exec(
          'INSERT INTO atlas_manifest_schema_migrations (id) VALUES (1)',
        )
      if (current < 2) {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS atlas_manifest_variants (
            zoom INTEGER NOT NULL,
            x INTEGER NOT NULL,
            y INTEGER NOT NULL,
            scene TEXT NOT NULL,
            version INTEGER NOT NULL,
            variant TEXT NOT NULL,
            content_type TEXT NOT NULL,
            content_bounds TEXT,
            PRIMARY KEY (zoom, x, y, scene, version, variant)
          );
          CREATE INDEX IF NOT EXISTS atlas_manifest_variants_grid
            ON atlas_manifest_variants (zoom, x, y, version);
          INSERT OR IGNORE INTO atlas_manifest_variants
            (zoom, x, y, scene, version, variant, content_type, content_bounds)
          SELECT zoom, x, y, scene, version, '${defaultAtlasVariant}', content_type, content_bounds
          FROM atlas_manifest;
          INSERT INTO atlas_manifest_schema_migrations (id) VALUES (2);
        `)
      }
      if (current < 3) {
        this.ctx.storage.sql.exec(`
          ALTER TABLE atlas_manifest_variants ADD COLUMN published_at INTEGER;
          INSERT INTO atlas_manifest_schema_migrations (id) VALUES (3);
        `)
      }
    })
  }

  upsert(entries: AtlasManifestEntry[], publishedAt = Date.now()) {
    for (const entry of entries) {
      this.ctx.storage.sql.exec(
        `INSERT INTO atlas_manifest_variants
          (zoom, x, y, scene, version, variant, content_type, content_bounds, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(zoom, x, y, scene, version, variant) DO UPDATE SET
           content_type = excluded.content_type,
           content_bounds = excluded.content_bounds,
           published_at = excluded.published_at`,
        entry.zoom,
        entry.x,
        entry.y,
        entry.scene,
        entry.version,
        entry.variant,
        entry.contentType,
        entry.contentBounds ? JSON.stringify(entry.contentBounds) : null,
        publishedAt,
      )
    }
  }

  // A rebuild is based on an R2 listing, so its first batch removes stale rows
  // from this shard while retaining entries written after the listing began.
  replaceFromRebuild(
    entries: AtlasManifestEntry[],
    rebuildStartedAt: number,
    removeStale = false,
  ) {
    if (removeStale)
      this.ctx.storage.sql.exec(
        'DELETE FROM atlas_manifest_variants WHERE published_at IS NULL OR published_at < ?',
        rebuildStartedAt,
      )
    this.upsert(entries, rebuildStartedAt)
  }

  remove(entry: Pick<AtlasManifestEntry, 'zoom' | 'x' | 'y' | 'scene' | 'version' | 'variant'>) {
    this.ctx.storage.sql.exec(
      'DELETE FROM atlas_manifest_variants WHERE zoom = ? AND x = ? AND y = ? AND scene = ? AND version = ? AND variant = ?',
      entry.zoom,
      entry.x,
      entry.y,
      entry.scene,
      entry.version,
      entry.variant,
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
        variant: string
        content_type: string
        content_bounds: string | null
      }>(
        `SELECT zoom, x, y, scene, version, variant, content_type, content_bounds
       FROM atlas_manifest_variants
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
        variant: entry.variant,
        contentType: entry.content_type,
        contentBounds: entry.content_bounds
          ? (JSON.parse(entry.content_bounds) as ContentBounds)
          : null,
      }))
  }

  // Cache-status requests are made for every visible tile. Keeping the SQL
  // work inside one Durable Object invocation avoids a round trip per tile.
  entriesForPositions(positions: AtlasManifestPosition[]): AtlasManifestEntry[] {
    return positions.flatMap(position => this.entriesForPosition(position))
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
        `SELECT DISTINCT scene FROM atlas_manifest_variants
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

  scenesInGrids(positions: AtlasManifestPosition[]) {
    return positions.map(position => ({
      ...position,
      scenes: this.scenesInGrid(position),
    }))
  }
}
