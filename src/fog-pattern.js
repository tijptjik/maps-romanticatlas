import { cloudDraw, studyCloudSeed } from './study-cloud-seed.ts'

export const defaultCloudCoverage = 0.75
const seed = studyCloudSeed(null)

// Shared by rendering, diagnostics and reveal hit testing. No checkerboard.
export const isFogPatternSelected = ({ x, y }) =>
  cloudDraw(seed, x, y, 0xc10d) < defaultCloudCoverage

export const fogShapeSeed = ({ x, y }) => cloudDraw(seed, x, y, 3) * 65536
