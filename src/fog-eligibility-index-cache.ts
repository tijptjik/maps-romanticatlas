import { DurableObject } from 'cloudflare:workers'
import type { FogEligibility } from './fog-eligibility.ts'

export class FogEligibilityIndexCache extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS fog_eligibility_indexes (
          cache_version TEXT PRIMARY KEY,
          eligibility_json TEXT NOT NULL
        );
      `)
    })
  }

  fogIndex(cacheVersion: string): FogEligibility[] | null {
    const record = this.ctx.storage.sql
      .exec<{ eligibility_json: string }>(
        'SELECT eligibility_json FROM fog_eligibility_indexes WHERE cache_version = ?',
        cacheVersion,
      )
      .toArray()[0]
    if (!record) return null
    try {
      const entries = JSON.parse(record.eligibility_json) as FogEligibility[]
      return Array.isArray(entries) ? entries : null
    } catch {
      return null
    }
  }

  putFogIndex(cacheVersion: string, entries: FogEligibility[]) {
    this.ctx.storage.sql.exec(
      `INSERT INTO fog_eligibility_indexes (cache_version, eligibility_json)
       VALUES (?, ?)
       ON CONFLICT(cache_version) DO NOTHING`,
      cacheVersion,
      JSON.stringify(entries),
    )
  }
}
